import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { SessionTracker, countLineChanges, countCharacterChanges, localDateKey, PrivacyPolicy, queryTelemetry, compareTelemetry, filterTelemetry } from "@stack-stats/core";
import { telemetryQuerySchema, telemetryEventSchema, type TelemetryData, type TelemetryQuery } from "@stack-stats/protocol";
import { LocalSessionStore } from "./local-store.js";
import { SessionDelivery, type LocalConfig } from "./delivery.js";
import { DocumentMetadata, hash } from "./metadata.js";
import { DocumentCollector } from "./collector.js";
import { SessionSummaryCache, inactivityMinutes } from "./stats-model.js";
import { StatsSidebar } from "./sidebar.js";
import type { SidebarState } from "./sidebar-model.js";
import { TelemetryBuffer } from "./telemetry-buffer.js";
import { TelemetryJournal, TelemetryPersistence } from "./telemetry-journal.js";
import { HourlyAggregateStore } from "./hourly-aggregates.js";
import { WorkflowCollectors } from "./workflow-collectors.js";
import { GitObserver } from "./git-observer.js";
import { ProfileSyncService, stableInstallation, stableSyncSalt } from "./profile-sync.js";
import { createAccountService } from "./vscode-account.js";
import { ProvenanceLedger } from "./provenance-ledger.js";
import { AgentInbox, agentHome } from "./agent-inbox.js";
import { ExternalChangeObserver } from "./external-observer.js";
import { formatAgentActivity } from "./agent-report.js";
import { hookTools, type HookTool } from "./agent-adapters.js";
import { AgentIntegrationManager, EDITOR_EXTENSIONS, IntegrationError, connectPrompt, disconnectPrompt, statusSummary, type ChangePreview, type IntegrationStatus } from "./agent-integrations.js";
import { EXTERNAL_CHANGES_MESSAGE } from "./sidebar-model.js";
import { CAPABILITIES, RECOMMENDED_LEVEL, agentLabelsNote, formatPrivacy } from "./tracking-levels.js";
import { TrackingControls, readSetting, readTracking } from "./tracking-controls.js";

const CHECKPOINT_MS = 15_000;
/** The hook fails closed on stale state; refresh it well inside that window. */
const AGENT_STATE_REFRESH_MS = 6 * 3_600_000;
const CONNECTED_AT_KEY = "agentIntegrationsConnectedAt";
let shutdown: (() => Promise<void>) | undefined;

async function readConfig(): Promise<LocalConfig | undefined> {
  try {
    const path = join(process.env.STACK_STATS_HOME ?? join(homedir(), ".stackstats"), "config.json");
    const config = JSON.parse(await readFile(path, "utf8")) as LocalConfig;
    if (typeof config.token === "string" && config.token.length >= 16 && Number.isInteger(config.port) && config.port > 0 && config.port <= 65535) return config;
  } catch { /* Local tracking works without CLI setup or a running daemon. */ }
  return undefined;
}

export async function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("Stack Stats");
  context.subscriptions.push(output);
  const account = createAccountService(context);
  const log = (message: string) => output.appendLine(`${new Date().toISOString()} ${message}`);
  const config = await readConfig();
  let syncIdentityReady = true;
  const installationId = await stableInstallation(context.globalStorageUri.fsPath, context.globalState.get<string>("installationId")).catch(() => {
    syncIdentityReady = false;
    log("Installation identity storage is unavailable; local tracking continues. Profile Sync may need attention.");
    return context.globalState.get<string>("installationId") ?? randomUUID();
  });
  // Derive a separate stable salt when CLI setup exists; never copy its bearer
  // credential into activity storage or extension state. Legacy records stay intact.
  const salt = context.globalState.get<string>("privacySalt") ?? (config ? hash(config.token, "stack-stats:identity:v1") : randomUUID());
  await context.globalState.update("installationId", installationId);
  await context.globalState.update("privacySalt", salt);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const buffer = new TelemetryBuffer(installationId);
  const hourly = new HourlyAggregateStore(join(context.globalStorageUri.fsPath, "hourly-v1"), installationId);
  const telemetry = new TelemetryPersistence(new TelemetryJournal(join(context.globalStorageUri.fsPath, "telemetry-v2"), log, hourly), buffer, config);
  const readPolicy = () => new PrivacyPolicy(vscode.workspace.getConfiguration("stackStats").get<string[]>("excludeFiles", []), vscode.workspace.getConfiguration("stackStats").get<string[]>("excludeProjects", []));
  let policy: PrivacyPolicy;
  let idleMinutes = inactivityMinutes(vscode.workspace.getConfiguration("stackStats").get("inactivityTimeoutMinutes"));
  try { policy = readPolicy(); } catch { policy = new PrivacyPolicy(["**"], ["**"]); log("Invalid exclusion settings: collection is disabled until corrected."); }
  // Immutable capability snapshot, rebuilt only when settings change. Collectors read
  // its fields; nothing on the edit path reads configuration.
  let tracking = readTracking();
  const tracker = new SessionTracker({
    createId: randomUUID, timeZone, idleTimeoutMs: idleMinutes * 60_000,
    source: { adapter: "vscode", adapterVersion: context.extension.packageJSON.version as string, editorName: vscode.env.appName, editorVersion: vscode.version, installationId },
    onInterval: (identity, from, to, sessionId) => { if (tracking.capabilities.activity_timeline) buffer.interval(identity, from, to, sessionId); },
    onLifecycle: (sessionId, at, state, reason) => { if (tracking.capabilities.activity_timeline) buffer.emit("session.lifecycle", { state, reason }, { sessionId }, at); }
  });
  const metadata = new DocumentMetadata(salt, () => policy);
  // Sessions (coding activity) always run while tracking is on; the timeline and the
  // save-participant subset are separate capabilities.
  const collector = new DocumentCollector(tracker, (event) => {
    if (tracking.capabilities.activity_timeline) buffer.edit(event, tracker.sessionId);
    if (tracking.capabilities.editor_events) observer.editorEdit(event);
  });
  let historyWarning = false;
  const store = new LocalSessionStore(join(context.globalStorageUri.fsPath, "sessions-v1"), message => { historyWarning = true; log(message); });
  // A missing/unreadable privacy salt must fail sync closed, never tracking.
  const syncSalt = await stableSyncSalt(context.globalStorageUri.fsPath).catch(() => undefined);
  const profileSync = new ProfileSyncService({ directory: join(context.globalStorageUri.fsPath, "profile-sync-v1"),
    installationId, projectSalt: syncSalt ?? "", account, sessions: () => {
      if (!syncSalt || !syncIdentityReady) return Promise.reject(new Error("Sync privacy salt unavailable"));
      return store.list(true);
    }, today: () => localDateKey(Date.now(), timeZone),
    hourlyAllowed: () => vscode.workspace.getConfiguration("stackStats").get("syncHourlyActivity", false),
    hourlyDays: () => vscode.workspace.getConfiguration("stackStats").get("syncHourlyActivity", false) ? telemetry.hourlyDays() : Promise.resolve(new Map()) });
  context.subscriptions.push(profileSync);
  const history = new SessionSummaryCache();
  const delivery = new SessionDelivery(store, config);
  let storageError = false;
  let stopped = false;
  let enabled = vscode.workspace.getConfiguration("stackStats").get("enabled", true);
  let lastStatusUpdate = 0;
  let uiUpdate: ReturnType<typeof setTimeout> | undefined;
  let saves: Promise<void> = Promise.resolve();
  const settings = () => vscode.workspace.getConfiguration("stackStats");
  const integrationSettings = () => ({ "claude-code": settings().get("agentIntegrations.claudeCode", false), codex: settings().get("agentIntegrations.codex", false) });
  /** Connections gated by the tracking level's agent capability. The hook state and the
   * inbox only ever see this, so a level can pause labels but never disconnect. */
  const agentLabels = () => {
    const connected = integrationSettings(), on = tracking.capabilities.agent_activity;
    return { "claude-code": on && connected["claude-code"], codex: on && connected.codex };
  };
  const ledger = new ProvenanceLedger(join(context.globalStorageUri.fsPath, "provenance-v1"), log);
  const inbox = new AgentInbox(agentHome());
  const bundledHook = join(context.extensionPath, "dist", "agent-hook.cjs");
  const settingKeys: Record<HookTool, string> = { "claude-code": "agentIntegrations.claudeCode", codex: "agentIntegrations.codex" };
  // One-click Connect/Disconnect owns both sides: the vendor hook entries and this
  // setting. Status is derived from the vendor config, not from the setting alone.
  const agents = new AgentIntegrationManager({ bundledHook, runtime: process.execPath,
    enabled: (tool) => integrationSettings()[tool],
    setEnabled: async (tool, on) => { await settings().update(settingKeys[tool], on, vscode.ConfigurationTarget.Global); },
    syncState: () => syncAgentState(true),
    editorExtension: (tool) => vscode.extensions.getExtension(EDITOR_EXTENSIONS[tool]) !== undefined,
    connectedAt: (tool) => context.globalState.get<Partial<Record<HookTool, number>>>(CONNECTED_AT_KEY)?.[tool],
    setConnectedAt: async (tool, at) => {
      const next = { ...context.globalState.get<Partial<Record<HookTool, number>>>(CONNECTED_AT_KEY) };
      if (at === undefined) delete next[tool]; else next[tool] = at;
      await context.globalState.update(CONNECTED_AT_KEY, next);
    } });
  let agentStatuses: IntegrationStatus[] | undefined;
  let agentStatusRequest = 0;
  // Agent/external provenance is local-only and never extends human sessions.
  const observer = new ExternalChangeObserver({ installationId, metadata, hash: (value) => hash(value, salt), policy: () => policy, ledger, inbox,
    collecting: () => enabled && !stopped, filesystem: () => tracking.capabilities.external_changes,
    integrations: () => new Set(hookTools.filter((tool) => agentLabels()[tool])), telemetry: () => telemetry.events(), log });
  context.subscriptions.push(observer);
  const workflows = new WorkflowCollectors(buffer, metadata, (value) => hash(value, salt), () => policy, () => enabled && !stopped, () => tracking.capabilities,
    (uri, operation) => observer.watcher(uri, operation));
  const git = new GitObserver(buffer, (value) => hash(value, salt));
  context.subscriptions.push(workflows);

  function uiState(): SidebarState {
    return {
      summary: history.summarize(localDateKey(Date.now(), timeZone), tracker.snapshot(), tracker.pending()),
      enabled, ready: history.ready, refreshing: history.refreshing, historyError: history.error || historyWarning,
      storageError, idleMinutes, syncConfigured: config !== undefined, account: account.getState(), profileSync: profileSync.getState(), trackingMode: tracking.mode,
      agents: { external: !enabled ? "paused" : tracking.capabilities.external_changes ? "tracked" : "off", labels: tracking.capabilities.agent_activity, integrations: agentStatuses }
    };
  }
  const sidebar = new StatsSidebar(uiState());
  context.subscriptions.push(sidebar);
  context.subscriptions.push(account.onDidChange(() => { profileSync.accountChanged(); scheduleRefresh(); }), profileSync.onDidChange(scheduleRefresh));
  void vscode.commands.executeCommand("setContext", "stackStats.trackingEnabled", enabled);

  function refresh(): void {
    if (stopped) return;
    if (uiUpdate) clearTimeout(uiUpdate);
    uiUpdate = undefined;
    sidebar.update(uiState());
    lastStatusUpdate = Date.now();
  }

  function scheduleRefresh(): void {
    const delay = Math.max(0, 1000 - (Date.now() - lastStatusUpdate));
    if (delay === 0) refresh();
    else if (!uiUpdate) uiUpdate = setTimeout(refresh, delay);
  }

  async function loadHistory(): Promise<void> {
    const loading = history.load(async () => { historyWarning = false; return store.list(); }, localDateKey(Date.now(), timeZone));
    refresh();
    await loading;
    refresh();
  }

  function checkpoint(): Promise<void> {
    saves = saves.then(async () => {
      try {
        if (storageError) await store.initialize();
        for (const session of tracker.pending()) {
          await store.save(session);
          history.remember(session);
          tracker.acknowledge(session);
          delivery.enqueue([session]);
        }
        workflows.flush();
        await telemetry.checkpoint();
        storageError = false;
      } catch {
        storageError = true;
        log("Could not checkpoint activity. Pending changes remain in memory; check local storage permissions and disk space.");
      }
    });
    return saves;
  }

  /** The hook reads this file and writes nothing unless tracking is on, the user
   * connected that agent and the file is fresh. No files are created before an
   * opt-in. Installing refreshes the hook, launcher and runtime hint (the editor's
   * own runtime, so no system Node.js is required). */
  let agentStateWrittenAt = 0;
  async function syncAgentState(install = false): Promise<void> {
    // The runtime stays installed while any agent is connected; the hook itself
    // records only for connections the tracking level currently accepts.
    const any = hookTools.some((tool) => integrationSettings()[tool]);
    if (!any && !install && !(await inbox.exists())) return;
    try {
      await inbox.writeState({ stateVersion: 1, collecting: enabled, integrations: agentLabels(), excludeFiles: settings().get<string[]>("excludeFiles", []).slice(0, 256), updatedAt: new Date().toISOString() });
      agentStateWrittenAt = Date.now();
      if (any || install) await agents.installRuntime();
    } catch { log("Agent integration state could not be written; agent hooks will not record until this is fixed."); }
  }
  /** Reads vendor configs only to find Stack Stats entries; the latest request wins. */
  async function refreshAgents(): Promise<void> {
    const request = ++agentStatusRequest;
    try {
      const statuses = await agents.statuses();
      if (request === agentStatusRequest) agentStatuses = statuses;
    } catch { log("Agent integration status could not be checked. Local tracking continues."); }
    scheduleRefresh();
  }

  try {
    await store.initialize();
    await telemetry.initialize(vscode.workspace.getConfiguration("stackStats").get("rawRetentionDays", 30));
    await ledger.initialize(vscode.workspace.getConfiguration("stackStats").get("rawRetentionDays", 30));
    delivery.enqueue(await store.pending());
  } catch {
    storageError = true;
    log("Local storage could not be opened. Check storage permissions before relying on recorded history.");
  }
  void loadHistory();
  void syncAgentState();
  void refreshAgents();
  log("Session collector loaded. History contains metadata only; checkpoints run every 15 seconds.");
  if (!config) log("Daemon sync is not configured. Local history and all reports work. To enable CLI summaries, initialize the CLI and reload this window.");
  function coverage() {
    // The v2 protocol's fixed coverage vocabulary; "editor" covers the edit timeline.
    for (const [kind, id] of [["editor", "activity_timeline"], ["filesystem", "external_changes"], ["git", "git_activity"],
      ["workflows", "tasks_debugging"], ["diagnostics", "problem_counts"], ["attribution", "extension_reports"]] as const) {
      buffer.emit("collector.coverage", { capability: kind, state: enabled && tracking.capabilities[id] ? "enabled" : "disabled", reason: "settings" });
    }
  }
  coverage();

  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((event) => {
    const { document, contentChanges, reason } = event;
    if (!stopped) observer.documentChanged(event);
    if (stopped || !enabled) return;
    const identity = metadata.get(document);
    if (!identity) { tracker.breakInterval(); return; }
    const wasActive = tracker.isActive;
    collector.change({
      documentId: document.uri.toString(), version: document.version, at: Date.now(),
      dirty: document.isDirty, focused: vscode.window.state.focused,
      visible: vscode.window.visibleTextEditors.some((editor) => editor.document === document),
      undoRedo: reason !== undefined, untitled: document.isUntitled, context: identity, counts: countLineChanges(contentChanges),
      characters: countCharacterChanges(contentChanges), reason: reason === vscode.TextDocumentChangeReason.Undo ? "undo" : reason === vscode.TextDocumentChangeReason.Redo ? "redo" : undefined
    });
    if (!wasActive && tracker.isActive) refresh();
    else scheduleRefresh();
  }));
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(() => {
    // Auto-save is not activity; its writes are coalesced with the next checkpoint.
    if (!stopped) { tracker.expire(Date.now()); scheduleRefresh(); }
  }));
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => tracker.breakInterval()));
  context.subscriptions.push(vscode.window.onDidChangeWindowState((state) => {
    tracker.breakInterval();
    // Reload other windows' durable snapshots on focus, never on each edit.
    if (!stopped && state.focused) { tracker.expire(Date.now()); void loadHistory(); account.checkIfDue(); void refreshAgents(); }
  }));
  context.subscriptions.push(vscode.workspace.onDidCloseTextDocument((document) => { metadata.close(document); collector.close(document.uri.toString()); }));
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => { metadata.clear(); tracker.breakInterval(); workflows.reset(); git.reset(); }));
  // Settings that change what is observed. Agent labels, upload policy and display
  // preferences are deliberately absent: they must not interrupt the human session.
  const collectionKeys = ["enabled", "inactivityTimeoutMinutes", "excludeFiles", "excludeProjects", "includeProjectNames", "rawRetentionDays",
    ...CAPABILITIES.filter((item) => item.setting && item.id !== "agent_activity").map((item) => item.setting!)];
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
    if (!event.affectsConfiguration("stackStats")) return;
    const affects = (key: string) => event.affectsConfiguration(`stackStats.${key}`);
    // Every window receives application-scoped changes, including level changes made in another window.
    tracking = readTracking();
    if (affects("agentIntegrations") || affects("collectAgentActivity")) void syncAgentState().then(refreshAgents);
    if (affects("syncHourlyActivity")) {
      // Only upload policy changed.
      profileSync.accountChanged();
      void profileSync.tick(true);
    }
    if (!collectionKeys.some(affects)) { refresh(); return; }
    const next = vscode.workspace.getConfiguration("stackStats").get("enabled", true);
    if (enabled && !next) { collector.clear(); tracker.end("paused"); void checkpoint(); }
    enabled = next;
    void vscode.commands.executeCommand("setContext", "stackStats.trackingEnabled", enabled);
    idleMinutes = inactivityMinutes(vscode.workspace.getConfiguration("stackStats").get("inactivityTimeoutMinutes"));
    tracker.setIdleTimeout(idleMinutes * 60_000);
    tracker.expire(Date.now());
    try { policy = readPolicy(); } catch { policy = new PrivacyPolicy(["**"], ["**"]); log("Invalid exclusions: collection is disabled until corrected."); }
    tracker.breakInterval(); collector.clear(); workflows.reset(); git.reset(); coverage();
    metadata.clear(); observer.reset(); void syncAgentState();
    refresh();
  }));

  function command(name: string, action: (...args: unknown[]) => void | Promise<void>): void {
    context.subscriptions.push(vscode.commands.registerCommand(`stackStats.${name}`, async (...args: unknown[]) => {
      try { await action(...args); } catch { log("The command could not complete. Check local storage permissions; existing history was preserved."); output.show(true); }
    }));
  }
  const show = (text: string) => { output.appendLine(`\n${text}\n`); output.show(true); };
  const syncStatus = () => { const status = profileSync.getState().status; return status === "not-connected" ? "no-account" as const : status === "disabled" ? "off" as const : "on" as const; };

  // ── Tracking levels: local collection only; sync, publication and connections untouched ──
  const trackingControls = new TrackingControls({ paused: () => !enabled, log,
    syncSummary: () => ({ "no-account": "Private sync: off (no account)", off: "Private sync: off", on: "Private sync: on" })[syncStatus()],
    agents: () => ({ connected: (agentStatuses ?? []).filter((status) => status.enabled).map((status) => status.displayName),
      available: (agentStatuses ?? []).filter((status) => status.state === "available").map((status) => status.displayName) }) });
  command("changeTrackingLevel", (level) => trackingControls.changeLevel(level));
  command("openAdvancedTracking", () => trackingControls.advanced());
  command("restoreRecommendedTracking", async () => { await trackingControls.applyLevel(RECOMMENDED_LEVEL); });
  // Sidebar actions and tests; hidden from the Command Palette.
  command("setTrackingCapability", async (id, on) => {
    const target = CAPABILITIES.find((item) => item.setting && item.id === id);
    if (target && typeof on === "boolean") await trackingControls.setCapability(target.id, on);
  });
  command("showStatus", () => show(`Stack Stats — Status\n\nCollection: ${enabled ? "enabled" : "paused"}\n${delivery.state}\nPending deliveries: ${delivery.pendingCount}\nLocal history: ${store.directory}\nCheckpoint: every 15s\nSession idle timeout: ${idleMinutes}m; active edit gap: at most 60s\n${storageError ? "WARNING: checkpoint failed; recent activity is only in memory." : "Local storage ready."}`));
  command("showCurrentSession", async () => { tracker.expire(Date.now()); refresh(); await sidebar.focus("currentSession"); });
  for (const period of ["Today", "ThisWeek"] as const) command(`show${period}`, async () => {
    tracker.expire(Date.now());
    await checkpoint();
    await loadHistory();
    await sidebar.focus(period === "Today" ? "today" : "thisWeek");
  });
  command("refreshStats", async () => {
    tracker.expire(Date.now());
    await checkpoint();
    await loadHistory();
  });
  command("openDashboard", async () => {
    const opened = await vscode.env.openExternal(vscode.Uri.parse("https://stackstats.dev"));
    if (!opened) await vscode.window.showWarningMessage("Could not open stackstats.dev. Local tracking and statistics are still available.");
  });
  command("openSettings", async () => { await vscode.commands.executeCommand("workbench.action.openSettings", "stackStats"); });
  command("connectAccount", () => account.connect());
  command("disconnectAccount", async () => { await profileSync.disable(); await account.disconnect(); });
  command("enableProfileSync", async () => {
    profileSync.consentRequested();
    await account.connect("stats:write");
  });
  command("disableProfileSync", () => profileSync.disable());
  command("syncNow", async () => { await checkpoint(); await profileSync.tick(true); await sidebar.focus("trackingStatus"); });
  command("syncPrivacy", async () => { await vscode.env.openExternal(vscode.Uri.parse(`${account.getOrigin()}/settings/sync`)); });
  command("cancelAccountConnection", () => account.cancelConnect());
  command("openProfile", async () => {
    const state = account.getState();
    if (state.status !== "connected" || !state.account) { await account.connect(); return; }
    const opened = await vscode.env.openExternal(vscode.Uri.parse(state.account.profileUrl));
    if (!opened) await vscode.window.showWarningMessage("Could not open your profile. Local tracking continues.");
  });
  command("pause", async () => { await vscode.workspace.getConfiguration("stackStats").update("enabled", false, vscode.ConfigurationTarget.Global); });
  command("resume", async () => { await vscode.workspace.getConfiguration("stackStats").update("enabled", true, vscode.ConfigurationTarget.Global); });
  command("retrySync", async () => {
    await checkpoint();
    delivery.enqueue(await store.pending());
    await delivery.sync(true);
    await telemetry.retry();
    refresh();
    show(`Stack Stats — Sync\n\n${delivery.state}\nPending deliveries: ${delivery.pendingCount}`);
  });
  const todayRange = (): TelemetryQuery => {
    const from = new Date(); from.setHours(0, 0, 0, 0);
    const to = new Date(from); to.setDate(to.getDate() + 1);
    return { from: from.toISOString(), to: to.toISOString(), limit: 200 };
  };
  command("showTelemetry", async () => {
    await checkpoint();
    show(JSON.stringify(queryTelemetry(await telemetry.events(), todayRange()), null, 2));
  });
  command("compareTelemetry", async () => {
    const from = new Date(); from.setHours(0, 0, 0, 0); from.setDate(from.getDate() - (from.getDay() + 6) % 7);
    const to = new Date(from); to.setDate(to.getDate() + 7);
    const previousFrom = new Date(from); previousFrom.setDate(previousFrom.getDate() - 7);
    await checkpoint();
    show(JSON.stringify(compareTelemetry(await telemetry.events(), { from: from.toISOString(), to: to.toISOString() },
      { from: previousFrom.toISOString(), to: from.toISOString() }), null, 2));
  });
  command("showAgentActivity", async () => {
    await checkpoint(); await observer.flush(true); await refreshAgents();
    const now = Date.now();
    const connections = Object.fromEntries((agentStatuses ?? []).map((status) => [status.tool, statusSummary(status, now)])) as Partial<Record<HookTool, string>>;
    show(formatAgentActivity(await observer.summary(todayRange()), { integrations: integrationSettings(), connections, filesystem: tracking.capabilities.external_changes,
      labels: tracking.capabilities.agent_activity, collecting: enabled, now, title: "Agent & external activity today" }));
  });

  // ── Agent integrations: one click + explicit confirmation ──────────────────────
  const toolArgument = (value: unknown): HookTool | undefined => hookTools.find((tool) => tool === value);
  async function pickAgent(value: unknown, placeHolder: string, eligible: (status: IntegrationStatus) => boolean, none: string): Promise<HookTool | undefined> {
    const tool = toolArgument(value);
    if (tool) return tool;
    await refreshAgents();
    const candidates = (agentStatuses ?? []).filter(eligible);
    if (!candidates.length) { void vscode.window.showInformationMessage(none); return undefined; }
    const picked = await vscode.window.showQuickPick(candidates.map((status) => ({ label: status.displayName, description: statusSummary(status), tool: status.tool })), { placeHolder });
    return picked?.tool;
  }
  async function reportIntegrationError(tool: HookTool, error: unknown, prefix: string): Promise<void> {
    const known = error instanceof IntegrationError;
    // Codes only: messages can carry paths, and vendor settings can hold secrets.
    log(`Agent integration ${tool}: ${known ? error.code : (error as NodeJS.ErrnoException | undefined)?.code ?? "unexpected error"}.`);
    const open = known && (error.code === "malformed" || error.code === "structure") ? "Open File" : undefined;
    const choice = await vscode.window.showErrorMessage(`${prefix} ${known ? error.message : "An unexpected error occurred; see the Stack Stats output."}`, ...(open ? [open] : []));
    if (open && choice === open) await vscode.window.showTextDocument(vscode.Uri.file(agents.paths.config[tool]));
  }
  async function connectAgent(value?: unknown): Promise<void> {
    const tool = await pickAgent(value, "Connect an agent to label its activity", (status) => status.state !== "connected" && status.state !== "not_detected",
      "No agents are waiting to be connected. Supported: Claude Code and Codex.");
    if (!tool) return;
    const name = agents.displayName(tool);
    const status = await agents.status(tool);
    if (status.state === "not_detected") { void vscode.window.showInformationMessage(`${name} wasn't found on this device. Install ${name}, then connect it here. ${EXTERNAL_CHANGES_MESSAGE}`); return; }
    let preview: ChangePreview;
    try { preview = await agents.previewConnect(tool); } catch (error) { await reportIntegrationError(tool, error, `Couldn't connect ${name}.`); return; }
    // A level without agent activity ignores every agent. Connecting turns it back on,
    // and the confirmation says so; the tracking level never connects anything itself.
    const labels = tracking.capabilities.agent_activity ? undefined : trackingControls.plan("agent_activity", true);
    const labelsNote = labels && agentLabelsNote(tracking, labels, readSetting);
    if (preview.changed) {
      const prompt = connectPrompt(preview, name);
      if (await vscode.window.showInformationMessage(prompt.message, { modal: true, detail: labelsNote ? `${prompt.detail}\n\n${labelsNote}` : prompt.detail }, prompt.confirm) !== prompt.confirm) return;
    } else if (status.state === "connected") {
      if (!labelsNote) { void vscode.window.showInformationMessage(`${name} is already connected.`); return; }
      if (await vscode.window.showInformationMessage(`Resume labeling ${name}?`, { modal: true, detail: `${name} is connected, but Stack Stats ignores it at this tracking level. ${labelsNote}` }, "Resume") === "Resume") {
        await trackingControls.setCapability("agent_activity", true);
      }
      return;
    } else if (labelsNote && await vscode.window.showInformationMessage(`Connect ${name}?`, { modal: true, detail: labelsNote }, "Connect") !== "Connect") return;
    if (labels && !(await trackingControls.apply(labels.changes))) return;
    try {
      const result = await agents.connect(tool);
      await refreshAgents();
      if (result.state !== "connected") { void vscode.window.showWarningMessage(`${name}: ${result.problem ?? "the connection could not be verified."}`); return; }
      void vscode.window.showInformationMessage(tool === "codex"
        ? "Codex hooks are installed. Start Codex and approve the Stack Stats hooks when it asks; its activity is labeled after that."
        : `${name} is connected. New ${name} sessions are labeled automatically; restart a session that is already open to include it.`);
    } catch (error) { await refreshAgents(); await reportIntegrationError(tool, error, `Couldn't connect ${name}.`); }
  }
  async function disconnectAgent(value?: unknown): Promise<void> {
    const tool = await pickAgent(value, "Disconnect an agent", (status) => status.enabled || status.hooks.owned > 0, "No agent integrations are connected.");
    if (!tool) return;
    const name = agents.displayName(tool);
    let prompt: { message: string; detail: string; confirm: string };
    try { prompt = disconnectPrompt(await agents.previewDisconnect(tool), name); } catch (error) {
      prompt = { message: `Disconnect ${name}?`, confirm: "Disconnect", detail: `Stack Stats will stop labeling ${name} activity. ${error instanceof IntegrationError ? error.message.replace(/ Nothing was changed\..*$/, "") : "Its settings can't be read right now"}, so any Stack Stats hooks there stay until the file can be edited.\n\nPast activity stays in your local history. External changes are still tracked automatically.` };
    }
    if (await vscode.window.showInformationMessage(prompt.message, { modal: true, detail: prompt.detail }, prompt.confirm) !== prompt.confirm) return;
    try {
      await agents.disconnect(tool);
      await refreshAgents();
      void vscode.window.showInformationMessage(`${name} is disconnected. ${EXTERNAL_CHANGES_MESSAGE}`);
    } catch (error) { await refreshAgents(); await reportIntegrationError(tool, error, `Stack Stats stopped labeling ${name}, but couldn't remove its hooks.`); }
  }
  function showManualSetup(): void {
    show(["Stack Stats — Manual agent integration setup (advanced)", "",
      "Most people should use Connect in the Stack Stats Agents view instead: it makes these exact changes after asking, and Disconnect removes them.",
      "Use this only when the tool's settings are managed elsewhere (dotfiles, MDM) and Stack Stats should not edit them.", "",
      "1. Run Connect once, or turn on the matching stackStats.agentIntegrations setting, so the hook runtime is installed.",
      "2. Merge the entries below into the tool's configuration without removing anything else.", "",
      `Hook runtime: ${agents.paths.hooks} (launcher, hook and runtime hint; no system Node.js needed)`,
      ...hookTools.flatMap((tool) => {
        const setup = agents.manualSetup(tool);
        return ["", `── ${agents.displayName(tool)} → ${setup.file}`, setup.snippet];
      }), "",
      "The hooks report metadata only: no prompts, responses, source code, commands or command output. UserPromptSubmit is deliberately not used because its payload contains your prompt.",
      "Codex asks you to approve new hooks before they run. Agent time is reported separately and never counts as coding time."].join("\n"));
  }
  async function manageAgents(): Promise<void> {
    await refreshAgents();
    type Item = vscode.QuickPickItem & { run?: () => unknown };
    const items: Item[] = [{ label: "$(eye) External changes", description: !enabled ? "Paused" : tracking.capabilities.external_changes ? "Tracked automatically" : "Off at your tracking level",
      detail: EXTERNAL_CHANGES_MESSAGE, run: tracking.capabilities.external_changes ? undefined : () => trackingControls.changeLevel() }];
    if (!tracking.capabilities.agent_activity && (agentStatuses ?? []).some((status) => status.enabled)) {
      items.push({ label: "$(play) Resume agent labels", description: "Agent activity is off at your tracking level", detail: "Turns agent activity back on. Your connections were never removed.",
        run: () => trackingControls.setCapability("agent_activity", true) });
    }
    for (const status of agentStatuses ?? []) {
      const summary = statusSummary(status);
      if (status.state === "not_detected") items.push({ label: `$(circle-slash) ${status.displayName}`, description: summary, detail: `Install ${status.displayName} to connect it.` });
      else if (status.state === "available") items.push({ label: `$(plug) Connect ${status.displayName}`, description: summary, detail: "Optional. Labels its changes and runs. Stack Stats shows what it will change and asks first.", run: () => connectAgent(status.tool) });
      else {
        if (status.state !== "connected") items.push({ label: `$(tools) Repair ${status.displayName}`, description: summary, run: () => connectAgent(status.tool) });
        if (status.enabled || status.hooks.owned > 0) items.push({ label: `$(debug-disconnect) Disconnect ${status.displayName}`, description: status.state === "connected" ? summary : undefined, run: () => disconnectAgent(status.tool) });
      }
    }
    items.push({ label: "", kind: vscode.QuickPickItemKind.Separator }, { label: "$(output) Show agent activity", run: () => vscode.commands.executeCommand("stackStats.showAgentActivity") },
      { label: "$(gear) Advanced: show manual setup", run: showManualSetup });
    const picked = await vscode.window.showQuickPick(items, { placeHolder: "Agent integrations are optional. Connect an agent to label its changes." });
    await picked?.run?.();
  }
  command("manageAgentIntegrations", manageAgents);
  command("connectAgent", connectAgent);
  command("disconnectAgent", disconnectAgent);
  command("disconnectAllAgents", async () => {
    await refreshAgents();
    const targets = (agentStatuses ?? []).filter((status) => status.enabled || status.hooks.owned > 0);
    if (!targets.length) { void vscode.window.showInformationMessage("No agent integrations are connected."); return; }
    const names = targets.map((status) => status.displayName).join(" and ");
    if (await vscode.window.showInformationMessage(`Disconnect ${names}?`, { modal: true, detail: "Stack Stats will remove only its own hooks from each tool's settings and stop labeling agent activity. Other settings and hooks stay as they are.\n\nPast activity stays in your local history. External changes are still tracked automatically.\n\nRun this before uninstalling Stack Stats so no hooks are left behind." }, "Disconnect All") !== "Disconnect All") return;
    const failed: string[] = [];
    for (const { tool } of targets) {
      try { await agents.disconnect(tool); } catch (error) { failed.push(`${agents.displayName(tool)}: ${error instanceof IntegrationError ? error.message : "unexpected error"}`); }
    }
    await refreshAgents();
    if (failed.length) void vscode.window.showErrorMessage(`Stack Stats stopped labeling agent activity, but couldn't remove every hook. ${failed.join(" ")}`);
    else void vscode.window.showInformationMessage(`Disconnected ${names}. ${EXTERNAL_CHANGES_MESSAGE}`);
  });
  command("verifyAgentIntegrations", async () => {
    await refreshAgents();
    // Checks configuration, hook runtime and the last received signal; never runs an agent.
    void vscode.window.showInformationMessage((agentStatuses ?? []).map((status) => `${status.displayName}: ${statusSummary(status)}.`).join(" ") || "Agent integration status is unavailable.");
  });
  command("showAgentIntegrationSetup", showManualSetup);
  // Pre-9E.1 command ID, kept for keybindings and scripts: installs the hook runtime
  // (as before) and shows the advanced setup without opening a picker.
  command("setupAgentIntegrations", async () => {
    await syncAgentState(true);
    showManualSetup();
    void vscode.window.showInformationMessage("Connect agents with one click from the Stack Stats Agents view.", "Manage Agent Integrations")
      .then((choice) => { if (choice) void vscode.commands.executeCommand("stackStats.manageAgentIntegrations"); });
  });
  command("showPrivacy", async () => {
    await refreshAgents();
    const state = account.getState();
    show(formatPrivacy({ snapshot: tracking, paused: !enabled, excludedFiles: settings().get<string[]>("excludeFiles", []).length, excludedProjects: settings().get<string[]>("excludeProjects", []).length,
      account: { connected: state.status === "connected", username: state.account?.username }, sync: syncStatus(), hourlySync: settings().get<unknown>("syncHourlyActivity") === true,
      agents: (agentStatuses ?? []).map((status) => ({ name: status.displayName, connected: status.enabled })), publicSettingsUrl: `${account.getOrigin()}/settings/sync`,
      storage: [`Local history: ${store.directory}`, `Local activity records: ${telemetry.journal.directory}`, `Optional local daemon: ${config ? telemetry.state : "not set up"}`] }));
  });

  // A single low-frequency timer handles expiry, persistence, delivery and status.
  // HTTP retries run separately so an offline daemon cannot block checkpointing.
  let ticks = 0;
  const timer = setInterval(() => {
    tracker.expire(Date.now());
    // Agent status reads two small config files; once a minute is plenty.
    if (++ticks % 4 === 0) void refreshAgents();
    if (Date.now() - agentStateWrittenAt > AGENT_STATE_REFRESH_MS && hookTools.some((tool) => integrationSettings()[tool])) void syncAgentState();
    account.checkIfDue();
    void checkpoint().then(() => { void delivery.sync().then(refresh); void profileSync.tick(); refresh(); });
    void telemetry.sync();
    void observer.flush();
    if (enabled && vscode.workspace.isTrusted && tracking.capabilities.git_activity) {
      void git.poll((vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath), policy);
    }
  }, CHECKPOINT_MS);
  context.subscriptions.push({ dispose: () => { clearInterval(timer); if (uiUpdate) clearTimeout(uiUpdate); } });
  shutdown = async () => {
    clearInterval(timer);
    if (uiUpdate) clearTimeout(uiUpdate);
    tracker.end("shutdown");
    workflows.flush(); git.reset();
    stopped = true;
    profileSync.dispose();
    account.dispose();
    await checkpoint(); // Returning this promise lets VS Code await the durable write.
    await telemetry.checkpoint();
    await observer.flush(true).catch(() => undefined);
  };
  refresh();
  void delivery.sync().then(refresh);
  void telemetry.sync();
  // SecretStorage and network requests must never gate activation/collection.
  void account.initialize();
  // An explicit annotation API lets cooperating adapters attach provenance to
  // known edit batches. Claims never alter observed counters or become proof.
  return {
    apiVersion: "2.0" as const,
    account: { getState: () => account.getState(), onDidChange: account.onDidChange.bind(account) },
    profileSync: { getState: () => profileSync.getState(), onDidChange: profileSync.onDidChange.bind(profileSync) },
    /** Read only: the current tracking level and what is collected locally. */
    tracking: { getState: () => ({ mode: tracking.mode, paused: !enabled, capabilities: { ...tracking.capabilities } }) },
    query: async (input: unknown) => {
      const query = telemetryQuerySchema.parse(input);
      await checkpoint(); return queryTelemetry(await telemetry.events(), query);
    },
    /** Local-only agent/external provenance analytics (never uploaded). */
    agentActivity: async (input: unknown) => {
      const query = telemetryQuerySchema.parse(input);
      await checkpoint(); await observer.flush(true);
      return observer.summary(query);
    },
    provenance: async (input: unknown) => {
      const query = telemetryQuerySchema.parse(input);
      await observer.flush(true);
      const from = Date.parse(query.from), to = Date.parse(query.to);
      return (await observer.records()).filter((record) => {
        const at = Date.parse(record.kind === "change" ? record.observedAt : record.at);
        return at >= from && at < to;
      });
    },
    events: async (input: unknown) => {
      const query = telemetryQuerySchema.parse(input);
      await checkpoint();
      const events = filterTelemetry(await telemetry.events(), query);
      const index = query.after ? events.findIndex((event) => event.eventId === query.after) + 1 : 0;
      if (query.after && index === 0) throw new Error("Unknown event cursor");
      const page = events.slice(index, index + query.limit);
      return { events: page, next: index + query.limit < events.length ? page.at(-1)!.eventId : null };
    },
    reportAttribution: async (data: TelemetryData<"attribution.report">) => {
      if (!enabled || !tracking.capabilities.extension_reports) throw new Error("Attribution reports are disabled");
      const event = telemetryEventSchema.parse({ schemaVersion: "2.0", eventId: randomUUID(), occurredAt: new Date().toISOString(),
        source: { collector: "adapter", instanceId: buffer.instanceId, installationId }, context: {}, evidence: "reported", eventType: "attribution.report", data });
      if (event.eventType !== "attribution.report") throw new Error("Expected attribution report");
      const payload = event.data;
      const existing = new Map((await telemetry.events()).filter((item) => item.eventType === "editor.edit").map((item) => [item.eventId, item]));
      if (payload.targetEventIds.some((id) => !existing.has(id))) throw new Error("Reports must target known complete editor.edit batches");
      const id = buffer.emit("attribution.report", payload, {}, Date.now(), "adapter", "reported");
      if (!id) throw new Error("Telemetry buffer is full");
      await telemetry.checkpoint();
      return id;
    }
  };
}

export async function deactivate(): Promise<void> { await shutdown?.(); shutdown = undefined; }

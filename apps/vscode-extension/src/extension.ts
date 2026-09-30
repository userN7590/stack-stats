import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import { access, constants, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
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
import { agentAdapters, hookTools, type HookCommand } from "./agent-adapters.js";

const CHECKPOINT_MS = 15_000;
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
  const tracker = new SessionTracker({
    createId: randomUUID, timeZone, idleTimeoutMs: idleMinutes * 60_000,
    source: { adapter: "vscode", adapterVersion: context.extension.packageJSON.version as string, editorName: vscode.env.appName, editorVersion: vscode.version, installationId },
    onInterval: (identity, from, to, sessionId) => buffer.interval(identity, from, to, sessionId),
    onLifecycle: (sessionId, at, state, reason) => { buffer.emit("session.lifecycle", { state, reason }, { sessionId }, at); }
  });
  const metadata = new DocumentMetadata(salt, () => policy);
  const collector = new DocumentCollector(tracker, (event) => { buffer.edit(event, tracker.sessionId); observer.editorEdit(event); });
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
  const ledger = new ProvenanceLedger(join(context.globalStorageUri.fsPath, "provenance-v1"), log);
  const inbox = new AgentInbox(agentHome());
  const bundledHook = join(context.extensionPath, "dist", "agent-hook.cjs");
  // Agent/external provenance is local-only and never extends human sessions.
  const observer = new ExternalChangeObserver({ installationId, metadata, hash: (value) => hash(value, salt), policy: () => policy, ledger, inbox,
    collecting: () => enabled && !stopped, filesystem: () => settings().get("collectFilesystem", true),
    integrations: () => new Set(hookTools.filter((tool) => integrationSettings()[tool])), telemetry: () => telemetry.events(), log });
  context.subscriptions.push(observer);
  const workflows = new WorkflowCollectors(buffer, metadata, (value) => hash(value, salt), () => policy, () => enabled && !stopped, (uri, operation) => observer.watcher(uri, operation));
  const git = new GitObserver(buffer, (value) => hash(value, salt));
  context.subscriptions.push(workflows);

  function uiState(): SidebarState {
    return {
      summary: history.summarize(localDateKey(Date.now(), timeZone), tracker.snapshot(), tracker.pending()),
      enabled, ready: history.ready, refreshing: history.refreshing, historyError: history.error || historyWarning,
      storageError, idleMinutes, syncConfigured: config !== undefined, account: account.getState(), profileSync: profileSync.getState()
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

  /** The hook reads this file and writes nothing unless tracking is on and the
   * user enabled that integration. No files are created before an opt-in. */
  async function syncAgentState(install = false): Promise<void> {
    const integrations = integrationSettings();
    const any = hookTools.some((tool) => integrations[tool]);
    if (!any && !install && !(await inbox.exists())) return;
    try {
      await inbox.writeState({ stateVersion: 1, collecting: enabled, integrations, excludeFiles: settings().get<string[]>("excludeFiles", []).slice(0, 256), updatedAt: new Date().toISOString() });
      if (any || install) await inbox.installHook(bundledHook);
    } catch { log("Agent integration state could not be written; agent hooks will not record until this is fixed."); }
  }
  async function hookCommand(script: string): Promise<HookCommand> {
    for (const directory of (process.env.PATH ?? "").split(delimiter)) {
      if (!directory) continue;
      const candidate = join(directory, process.platform === "win32" ? "node.exe" : "node");
      try { await access(candidate, constants.X_OK); return { executable: candidate, script }; } catch { /* Try the next PATH entry. */ }
    }
    // The editor's own runtime can run the hook when Node.js is not installed.
    return { executable: process.execPath, script, env: { ELECTRON_RUN_AS_NODE: "1" } };
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
  log("Session collector loaded. History contains metadata only; checkpoints run every 15 seconds.");
  if (!config) log("Daemon sync is not configured. Local history and all reports work. To enable CLI summaries, initialize the CLI and reload this window.");
  function coverage() {
    for (const [capability, setting, fallback] of [["editor", "enabled", true], ["filesystem", "collectFilesystem", true], ["git", "collectGit", true],
      ["workflows", "collectWorkflows", true], ["diagnostics", "collectDiagnostics", false], ["attribution", "allowAttributionReports", false]] as const) {
      buffer.emit("collector.coverage", { capability, state: enabled && vscode.workspace.getConfiguration("stackStats").get(setting, fallback) ? "enabled" : "disabled", reason: "settings" });
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
    if (!stopped && state.focused) { tracker.expire(Date.now()); void loadHistory(); account.checkIfDue(); }
  }));
  context.subscriptions.push(vscode.workspace.onDidCloseTextDocument((document) => { metadata.close(document); collector.close(document.uri.toString()); }));
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => { metadata.clear(); tracker.breakInterval(); workflows.reset(); git.reset(); }));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
    if (!event.affectsConfiguration("stackStats")) return;
    if (event.affectsConfiguration("stackStats.agentIntegrations")) {
      // Opting in/out of agent hooks must not interrupt the human session.
      void syncAgentState();
      if (!["enabled", "inactivityTimeoutMinutes", "excludeFiles", "excludeProjects", "includeProjectNames", "collectFilesystem", "collectGit", "collectWorkflows",
        "collectDiagnostics", "allowAttributionReports", "rawRetentionDays", "showStatusBar", "syncHourlyActivity"].some(key => event.affectsConfiguration(`stackStats.${key}`))) return;
    }
    if (event.affectsConfiguration("stackStats.syncHourlyActivity")) {
      // Only upload policy changed; it must not manufacture a session break.
      profileSync.accountChanged();
      void profileSync.tick(true);
      if (!["enabled", "inactivityTimeoutMinutes", "excludeFiles", "excludeProjects", "includeProjectNames", "collectFilesystem", "collectGit", "collectWorkflows", "collectDiagnostics", "allowAttributionReports", "rawRetentionDays", "showStatusBar"]
        .some(key => event.affectsConfiguration(`stackStats.${key}`))) return;
    }
    // Display preferences must not interrupt the active-time evidence interval.
    if (event.affectsConfiguration("stackStats.showStatusBar") && ![
      "enabled", "inactivityTimeoutMinutes", "excludeFiles", "excludeProjects", "includeProjectNames",
      "collectFilesystem", "collectGit", "collectWorkflows", "collectDiagnostics", "allowAttributionReports", "rawRetentionDays"
    ].some(key => event.affectsConfiguration(`stackStats.${key}`))) { refresh(); return; }
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

  function command(name: string, action: () => void | Promise<void>): void {
    context.subscriptions.push(vscode.commands.registerCommand(`stackStats.${name}`, async () => {
      try { await action(); } catch { log("The command could not complete. Check local storage permissions; existing history was preserved."); output.show(true); }
    }));
  }
  const show = (text: string) => { output.appendLine(`\n${text}\n`); output.show(true); };
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
    await checkpoint(); await observer.flush(true);
    show(formatAgentActivity(await observer.summary(todayRange()), { integrations: integrationSettings(), filesystem: settings().get("collectFilesystem", true),
      collecting: enabled, now: Date.now(), title: "Agent & external activity today" }));
  });
  command("setupAgentIntegrations", async () => {
    await syncAgentState(true);
    const hook = await hookCommand(await inbox.installHook(bundledHook));
    const enabledTools = integrationSettings();
    show([`Stack Stats — Agent integrations (optional, local only)`, "",
      "Stack Stats never edits Claude Code or Codex configuration. To opt in:",
      "  1. Enable stackStats.agentIntegrations.claudeCode and/or stackStats.agentIntegrations.codex.",
      "  2. Add the matching hook configuration below to that tool.",
      "  3. Run Stack Stats: Show Agent Activity after an agent turn to verify signals arrived.", "",
      `Hook script (version-stable copy): ${hook.script}`,
      `Agent inbox: ${inbox.paths.records} (transient; records are deleted once ingested)`,
      ...hookTools.flatMap((tool) => {
        const setup = agentAdapters[tool].setup(hook);
        return ["", `── ${setup.displayName}: ${enabledTools[tool] ? "enabled in Stack Stats" : "not enabled in Stack Stats (the hook writes nothing until you enable it)"}`,
          `Add to ${setup.file}:`, setup.snippet, ...setup.notes.map((note) => `• ${note}`)];
      }),
      "", "Remove the hook entries from the tool's settings (or turn the Stack Stats setting off) to stop. Agent runtime is reported separately and never counts as coding time."].join("\n"));
  });
  command("showPrivacy", () => show(`Telemetry privacy\n\nNo source, prompts, command lines, debug configuration, diagnostic messages, commit messages, authors or remote URLs are collected.\nAI/manual attribution requires explicit reports and is never inferred from editor brand.\nAgent integrations (off by default) keep hashed run IDs, tool kinds, durations, salted file IDs and diff-line counts locally; prompts, responses, commands and file contents are never stored. Agent and external-change records are local-only and are not synced.\nExcluded files: ${vscode.workspace.getConfiguration("stackStats").get<string[]>("excludeFiles", []).length} custom pattern(s) plus built-in exclusions.\nExcluded projects: ${vscode.workspace.getConfiguration("stackStats").get<string[]>("excludeProjects", []).length} pattern(s).\nTelemetry journal: ${telemetry.journal.directory}\n${telemetry.state}`));

  // A single low-frequency timer handles expiry, persistence, delivery and status.
  // HTTP retries run separately so an offline daemon cannot block checkpointing.
  const timer = setInterval(() => {
    tracker.expire(Date.now());
    account.checkIfDue();
    void checkpoint().then(() => { void delivery.sync().then(refresh); void profileSync.tick(); refresh(); });
    void telemetry.sync();
    void observer.flush();
    if (enabled && vscode.workspace.isTrusted && vscode.workspace.getConfiguration("stackStats").get("collectGit", true)) {
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
      if (!enabled || !vscode.workspace.getConfiguration("stackStats").get("allowAttributionReports", false)) throw new Error("Attribution reports are disabled");
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

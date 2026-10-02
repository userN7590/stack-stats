const assert = require("node:assert/strict");
const { writeFile, readFile, readdir, rename, mkdir, stat } = require("node:fs/promises");
const { spawnSync } = require("node:child_process");
const { join } = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const vscode = require("vscode");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Phase 9E: external/agent changes are observed, deduplicated and attributed only
 * with explicit hook evidence, without ever touching human session time. */
async function agentAndExternalActivity(api, root, range) {
  const ws = join(root, "workspace"), home = join(root, "daemon");
  const settings = () => vscode.workspace.getConfiguration("stackStats");
  // Closed-document writes, twice across a quiet gap: two unknown changes.
  await writeFile(join(ws, "closed.ts"), "export const a = 1;\n");
  await sleep(2500);
  await writeFile(join(ws, "closed.ts"), "export const a = 2;\nexport const b = 3;\n");
  // Open-document write: VS Code reloads the clean model; its line diff is used.
  await writeFile(join(ws, "open.ts"), "const kept = 0;\nconst changed = 1;\n");
  await sleep(1500);
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(join(ws, "open.ts")));
  await sleep(500);
  await writeFile(join(ws, "open.ts"), "const kept = 0;\nconst changed = 'external';\nconst added = 2;\n");
  // Multi-file burst: one aggregate record, never 30 claims. Near-simultaneous
  // writes are indistinguishable by design, so the burst is kept apart here.
  await sleep(2500);
  await mkdir(join(ws, "burst"));
  await Promise.all(Array.from({ length: 30 }, (_, i) => writeFile(join(ws, "burst", `f${i}.ts`), `export const f${i} = ${i};\n`)));
  await sleep(2500);
  let summary = await api.agentActivity(range);
  assert(summary.external.unknown.events >= 3, "External writes are observed as unknown-writer changes");
  assert(summary.external.unknown.linesAdded >= 2 && summary.external.unknown.deltaUnknown >= 2, "Open documents supply diff lines; closed files stay without line counts");
  assert.equal(summary.external.bulk.operations, 1, "A 30-file burst is one bulk operation");
  assert(summary.external.bulk.files >= 30);
  assert.equal(summary.agent.runs.total, 0, "No agent runs without hook evidence");
  assert.equal(summary.agent.explicit.events + summary.agent.correlated.events, 0, "Nothing is attributed to an agent without evidence");
  const stats = await api.query(range);
  assert.equal(stats.edits.editCount, 0, "External writes never become editor edits");
  assert.equal(stats.activeMs, 0, "External writes never earn active time");
  const storage = join(root, "user-data", "User", "globalStorage", vscode.extensions.all.find((item) => item.packageJSON.name === "stack-stats-vscode").id.toLowerCase());
  assert.equal((await readdir(join(storage, "sessions-v1")).catch(() => [])).filter((file) => file.endsWith(".json")).length, 0, "External writes never start a coding session");

  const unknownBefore = summary.external.unknown.events;
  // Adapter lifecycle through the real bundled hook, run by the editor's own runtime.
  await settings().update("agentIntegrations.claudeCode", true, vscode.ConfigurationTarget.Global);
  await settings().update("agentIntegrations.codex", true, vscode.ConfigurationTarget.Global);
  await vscode.commands.executeCommand("stackStats.setupAgentIntegrations");
  const hook = join(home, "hooks", "stack-stats-agent-hook-v1.cjs");
  const runHook = (tool, payload) => {
    const result = spawnSync(process.execPath, [hook, tool], { input: JSON.stringify(payload), encoding: "utf8", timeout: 15000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", STACK_STATS_HOME: home } });
    assert.equal(result.status, 0, `hook exit ${result.stderr}`);
    assert.equal(result.stdout, "", "Hooks print nothing");
  };
  const claude = (event, extra) => ({ session_id: "smoke-claude-session", transcript_path: "/private/transcript.jsonl", cwd: ws, prompt_id: "smoke-prompt", hook_event_name: event, ...extra });
  // Claude Code's observed write: temp file + rename over the target.
  await writeFile(join(ws, "agent.ts.tmp.1.abcdef123456"), "export const agent = 1;\n");
  await rename(join(ws, "agent.ts.tmp.1.abcdef123456"), join(ws, "agent.ts"));
  runHook("claude-code", claude("PostToolUse", { tool_name: "Write", tool_use_id: "toolu_smoke_1", duration_ms: 3,
    tool_input: { file_path: join(ws, "agent.ts"), content: "export const agent = 1;\n" }, tool_response: { type: "create", structuredPatch: [], originalFile: null } }));
  await writeFile(join(ws, "script-output.ts"), "export const generated = true;\n");
  runHook("claude-code", claude("PostToolUse", { tool_name: "Bash", tool_use_id: "toolu_smoke_2", duration_ms: 1500, tool_input: { command: "node generate.js" }, tool_response: { stdout: "PRIVATE_STDOUT" } }));
  runHook("claude-code", claude("Stop", { last_assistant_message: "PRIVATE_REPLY" }));
  await sleep(2000);
  // Codex apply_patch writes in place.
  await writeFile(join(ws, "codex.ts"), "export const codex = 1;\nexport const more = 2;\n");
  runHook("codex", { session_id: "smoke-codex-session", turn_id: "smoke-turn", transcript_path: null, cwd: ws, hook_event_name: "PostToolUse", model: "m", permission_mode: "default",
    tool_name: "apply_patch", tool_use_id: "call_smoke", tool_input: { command: "*** Begin Patch\n*** Add File: codex.ts\n+export const codex = 1;\n+export const more = 2;\n*** End Patch" },
    tool_response: "Exit code: 0\nWall time: 0.1 seconds\nOutput:\nSuccess." });
  runHook("codex", { session_id: "smoke-codex-session", turn_id: "smoke-turn", transcript_path: null, cwd: ws, hook_event_name: "Stop", model: "m", permission_mode: "default", last_assistant_message: "PRIVATE_REPLY" });
  await sleep(2000);
  summary = await api.agentActivity(range);
  // After opting out, the hook writes nothing (and unread records would be purged).
  await settings().update("agentIntegrations.codex", false, vscode.ConfigurationTarget.Global);
  await sleep(500);
  runHook("codex", { session_id: "disabled", cwd: ws, hook_event_name: "Stop", model: "m", permission_mode: "default" });
  assert.equal((await readdir(join(home, "agent-inbox-v1", "records")).catch(() => [])).length, 0, "A disabled integration writes no inbox record");
  const byTool = Object.fromEntries(summary.agent.byTool.map((entry) => [entry.tool, entry]));
  assert.equal(byTool["claude-code"].runs, 1, "One Claude Code run");
  assert.equal(byTool["claude-code"].explicit.events, 1, "Claude Code Write reported explicitly");
  assert.equal(byTool["claude-code"].explicit.linesAdded, 1);
  assert.equal(byTool["claude-code"].correlated.events, 1, "Change during the agent's shell command is correlated, not explicit");
  assert.equal(byTool.codex.runs, 1, "One Codex run; the disabled integration wrote nothing");
  assert.equal(byTool.codex.explicit.events, 1, "Codex apply_patch reported explicitly");
  assert.equal(byTool.codex.explicit.linesAdded, 2);
  const records = await api.provenance(range);
  const serialized = JSON.stringify(records);
  for (const secret of [root, "PRIVATE_STDOUT", "PRIVATE_REPLY", "smoke-claude-session", "toolu_smoke", "node generate.js", "export const"]) assert(!serialized.includes(secret), `${secret} not stored`);
  assert.equal(summary.external.unknown.events, unknownBefore, "Agent-written files are not double counted as unknown external changes");
  assert.equal((await readdir(join(home, "agent-inbox-v1", "records"))).length, 0, "Claimed hook records are deleted after ingestion");
  const after = await api.query(range);
  assert.equal(after.edits.editCount, 0, "Agent activity never becomes editor edits");
  assert.equal(after.activeMs, 0, "Agent runtime never becomes coding time");
  const telemetry = await api.events({ ...range, limit: 1000 });
  assert(!telemetry.events.some((event) => ["agent", "change"].includes(event.kind)), "Provenance never enters telemetry-v2");
  assert.equal(api.profileSync.getState().status, "not-connected", "Agent integration does not enable sync");
  await vscode.commands.executeCommand("stackStats.showAgentActivity");
  await settings().update("agentIntegrations.claudeCode", false, vscode.ConfigurationTarget.Global);
  await sleep(500); // The state file is rewritten asynchronously after a settings change.
  const state = JSON.parse(await readFile(join(home, "agent-inbox-v1", "state.json"), "utf8"));
  assert.deepEqual(state.integrations, { "claude-code": false, codex: false }, "Disabling integrations tells the hook to stop writing");
}

/** Phase 9F: tracking levels change local collection only. Sync, publication, the
 * account and agent connections (including the vendors' own files) stay untouched. */
async function trackingLevels(api, root, range) {
  const ws = join(root, "workspace"), home = join(root, "daemon");
  const settings = () => vscode.workspace.getConfiguration("stackStats");
  const until = async (check, message) => {
    for (let i = 0; i < 40; i++) { if (await check()) return; await sleep(100); }
    assert.fail(message);
  };
  const level = async (mode, ...args) => {
    await vscode.commands.executeCommand(...args);
    await until(() => api.tracking.getState().mode === mode, `Tracking level becomes ${mode}`);
  };
  const hookState = async () => JSON.parse(await readFile(join(home, "agent-inbox-v1", "state.json"), "utf8")).integrations;
  const external = async () => (await api.agentActivity(range)).external.unknown.events;
  const fsEvents = async () => (await api.events({ ...range, limit: 1000 })).events.filter((event) => event.eventType === "filesystem.changed").length;
  // Vendor files as a user would have them; a level must never rewrite them.
  const claudeConfig = join(process.env.CLAUDE_CONFIG_DIR, "settings.json"), codexConfig = join(process.env.CODEX_HOME, "hooks.json");
  await mkdir(process.env.CLAUDE_CONFIG_DIR, { recursive: true }); await mkdir(process.env.CODEX_HOME, { recursive: true });
  await writeFile(claudeConfig, '{\n  "model": "user-choice",\n  "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "echo mine" }] }] }\n}\n');
  await writeFile(codexConfig, '{"hooks":{}}\n');
  const vendor = async () => [await readFile(claudeConfig, "utf8"), await readFile(codexConfig, "utf8"), (await stat(claudeConfig)).mtimeMs, (await stat(codexConfig)).mtimeMs];
  const vendorBefore = await vendor();
  // A connected agent, as far as Stack Stats' own switch is concerned.
  await settings().update("agentIntegrations.claudeCode", true, vscode.ConfigurationTarget.Global);
  await until(async () => (await hookState())["claude-code"] === true, "Connected agent is accepted at Moderate");
  const unrelated = () => ({ sync: settings().get("syncHourlyActivity"), claude: settings().get("agentIntegrations.claudeCode"), codex: settings().get("agentIntegrations.codex"),
    enabled: settings().get("enabled"), retention: settings().get("rawRetentionDays"), account: api.account.getState().status, profileSync: api.profileSync.getState().status });
  const before = unrelated();
  assert.equal(api.tracking.getState().mode, "moderate");

  await level("minimal", "stackStats.changeTrackingLevel", "minimal");
  await until(async () => (await hookState())["claude-code"] === false, "Minimal pauses agent labels in the hook state");
  assert.equal(settings().get("agentIntegrations.claudeCode"), true, "…without disconnecting the agent");
  const [externalAtMinimal, fsAtMinimal] = [await external(), await fsEvents()];
  await writeFile(join(ws, "minimal-external.ts"), "export const minimal = 1;\n");
  await sleep(2500);
  assert.equal(await external(), externalAtMinimal, "Minimal records no external changes");
  assert.equal(await fsEvents(), fsAtMinimal, "Minimal records no filesystem notifications");

  await level("moderate", "stackStats.changeTrackingLevel", "moderate");
  await until(async () => (await hookState())["claude-code"] === true, "Moderate resumes labels for the still-connected agent");
  await writeFile(join(ws, "moderate-external.ts"), "export const moderate = 1;\n");
  await sleep(2500);
  assert(await external() > externalAtMinimal, "Moderate tracks external changes automatically");

  await level("extensive", "stackStats.changeTrackingLevel", "extensive");
  assert.deepEqual(api.tracking.getState().capabilities, { coding_activity: true, activity_timeline: true, editor_events: true, tasks_debugging: true, problem_counts: true,
    external_changes: true, git_activity: true, agent_activity: true, extension_reports: true });
  await level("custom", "stackStats.setTrackingCapability", "git_activity", false);
  await level("moderate", "stackStats.restoreRecommendedTracking");
  for (const key of ["collectActivityTimeline", "collectEditorEvents", "collectWorkflows", "collectDiagnostics", "collectFilesystem", "collectGit", "collectAgentActivity", "allowAttributionReports"]) {
    assert.equal(settings().inspect(key).globalValue, undefined, `${key}: the recommended level leaves no override behind`);
  }
  // Pause is separate from the level.
  await vscode.commands.executeCommand("stackStats.pause");
  await until(() => api.tracking.getState().paused, "Pause is reflected");
  assert.equal(api.tracking.getState().mode, "moderate", "Pausing does not change the tracking level");
  await vscode.commands.executeCommand("stackStats.resume");
  await until(() => !api.tracking.getState().paused, "Resume is reflected");
  await vscode.commands.executeCommand("stackStats.showPrivacy");

  assert.deepEqual(unrelated(), before, "Levels never change sync, publication, account, connections or retention");
  assert.deepEqual(await vendor(), vendorBefore, "Levels never touch Claude Code or Codex configuration");
  await settings().update("agentIntegrations.claudeCode", false, vscode.ConfigurationTarget.Global);
}

exports.run = async () => {
  const root = process.env.STACK_STATS_SMOKE_DIR;
  try {
    const extension = vscode.extensions.all.find((item) => item.packageJSON.name === "stack-stats-vscode");
    assert(extension);
    const api = await extension.activate();
    assert.equal(api.apiVersion, "2.0");
    assert.equal(api.account.getState().status, "disconnected", "New profile remains local-only");
    assert.equal(api.profileSync.getState().status, "not-connected", "New installation has no sync consent");
    assert.deepEqual(api.tracking.getState(), { mode: "moderate", paused: false, capabilities: { coding_activity: true, activity_timeline: true, editor_events: true,
      tasks_debugging: true, problem_counts: false, external_changes: true, git_activity: true, agent_activity: true, extension_reports: false } }, "A clean profile starts at the recommended level");
    await vscode.commands.executeCommand("stackStats.syncNow");
    await vscode.commands.executeCommand("stackStats.disableProfileSync");
    assert.equal(api.profileSync.getState().status, "not-connected", "Sync commands cannot authorize uploads");
    const accountCallback = vscode.Uri.from({ scheme: vscode.env.uriScheme, authority: extension.id, path: "/auth/callback" });
    const routedCallback = await vscode.env.asExternalUri(accountCallback);
    assert.equal(routedCallback.with({ query: "" }).toString(true), accountCallback.toString(true), "Desktop account callback uses the exact allowed native destination");
    const routing = new URLSearchParams(routedCallback.query);
    assert([...routing.keys()].every(key => key === "windowId"), "Only native window routing is added");
    if (routing.has("windowId")) assert(/^[0-9]{1,10}$/.test(routing.get("windowId")) && routing.getAll("windowId").length === 1);
    await vscode.commands.executeCommand("stackStats.disconnectAccount");
    await vscode.commands.executeCommand("stackStats.cancelAccountConnection");
    assert.equal(api.account.getState().status, "disconnected");
    const commands = await vscode.commands.getCommands(true);
    for (const { command } of extension.packageJSON.contributes.commands) assert(commands.includes(command), `${command} registered`);
    const views = extension.packageJSON.contributes.views.stackStats;
    assert.deepEqual(views.map(view => view.name), ["Activity", "Agents", "Account"], "Three focused native sidebar panels");
    for (const section of ["currentSession", "thisWeek", "languages", "projects", "streak"]) {
      assert(commands.includes(`stackStats.${section}.focus`), "Legacy focus command preserved");
      await vscode.commands.executeCommand(`stackStats.${section}.focus`);
    }
    for (const view of views) await vscode.commands.executeCommand(`${view.id}.focus`);
    const settings = vscode.workspace.getConfiguration("stackStats");
    assert.equal(settings.get("showStatusBar"), true);
    assert.equal(settings.get("inactivityTimeoutMinutes"), 5);
    assert.equal(settings.get("syncHourlyActivity"), false, "Hourly uploads require an explicit setting");
    await settings.update("syncHourlyActivity", true, vscode.ConfigurationTarget.Global);
    assert.equal(api.profileSync.getState().status, "not-connected", "Hourly opt-in alone cannot authorize uploads");
    await settings.update("syncHourlyActivity", false, vscode.ConfigurationTarget.Global);
    await settings.update("showStatusBar", false, vscode.ConfigurationTarget.Global);
    assert.equal(vscode.workspace.getConfiguration("stackStats").get("enabled"), true, "Hiding UI does not pause tracking");
    await settings.update("showStatusBar", true, vscode.ConfigurationTarget.Global);
    await settings.update("inactivityTimeoutMinutes", 10, vscode.ConfigurationTarget.Global);
    await settings.update("inactivityTimeoutMinutes", 5, vscode.ConfigurationTarget.Global);
    const range = { from: new Date(Date.now() - 3600_000).toISOString(), to: new Date(Date.now() + 3600_000).toISOString() };
    const initial = await api.query(range);
    assert.equal(initial.edits.editCount, 0, "Activation creates no edits");
    const original = vscode.Uri.file(join(root, "workspace", "lifecycle.ts"));
    const renamed = vscode.Uri.file(join(root, "workspace", "renamed.ts"));
    const create = new vscode.WorkspaceEdit(); create.createFile(original); await vscode.workspace.applyEdit(create);
    const rename = new vscode.WorkspaceEdit(); rename.renameFile(original, renamed); await vscode.workspace.applyEdit(rename);
    const remove = new vscode.WorkspaceEdit(); remove.deleteFile(renamed); await vscode.workspace.applyEdit(remove);
    const secret = new vscode.WorkspaceEdit(); secret.createFile(vscode.Uri.file(join(root, "workspace", ".env"))); await vscode.workspace.applyEdit(secret);
    const task = new vscode.Task({ type: "stack-stats-smoke" }, vscode.workspace.workspaceFolders[0], "private-task-name", "smoke", new vscode.ShellExecution("exit 0"));
    task.group = vscode.TaskGroup.Test;
    let listener, timeout;
    const finished = new Promise((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error("Task lifecycle timeout")), 15000);
      listener = vscode.tasks.onDidEndTask((event) => {
        if (event.execution.task.name === task.name) { clearTimeout(timeout); listener.dispose(); resolve(); }
      });
    });
    await vscode.tasks.executeTask(task); await finished;
    await writeFile(join(root, "workspace", "external.txt"), "PRIVATE_SOURCE_NEVER_READ");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const stats = await api.query(range);
    assert.deepEqual(stats.fileOperations, { created: 1, renamed: 1, deleted: 1 }, "File operations and exclusions");
    assert.equal(stats.workflows.tests, 1, "VS Code task group captured");
    assert.equal(stats.workflows.completedTasks, 1);
    assert.equal(stats.edits.editCount, 0, "File/task observations do not invent coding");
    // macOS can deliver the watcher notification seconds later under load.
    let raw = await api.events({ ...range, limit: 1000 });
    for (let i = 0; i < 20 && !raw.events.some((event) => event.eventType === "filesystem.changed"); i++) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      raw = await api.events({ ...range, limit: 1000 });
    }
    assert(raw.events.some((event) => event.eventType === "filesystem.changed"), "Real filesystem watcher observed a change");
    const serialized = JSON.stringify(raw);
    for (const value of ["PRIVATE_SOURCE_NEVER_READ", "private-task-name", "external.txt", root]) assert(!serialized.includes(value), `${value} not in telemetry`);
    const claim = { targetEventIds: [randomUUID()], actor: "ai", agent: "codex", providerId: createHash("sha256").update("test").digest("hex") };
    await assert.rejects(api.reportAttribution(claim), /disabled/);
    await vscode.workspace.getConfiguration("stackStats").update("allowAttributionReports", true, vscode.ConfigurationTarget.Global);
    await assert.rejects(api.reportAttribution(claim), /known/);
    for (const command of ["showStatus", "showToday", "showThisWeek", "showCurrentSession", "refreshStats", "openSettings", "showTelemetry", "compareTelemetry", "showPrivacy", "retrySync", "pause", "resume"]) {
      await vscode.commands.executeCommand(`stackStats.${command}`);
    }
    assert.equal((await api.query(range)).edits.editCount, 0, "Navigating/refreshing the UI does not manufacture activity");
    await agentAndExternalActivity(api, root, range);
    // The attribution check above opted into reports; start the level checks from the default.
    await vscode.workspace.getConfiguration("stackStats").update("allowAttributionReports", undefined, vscode.ConfigurationTarget.Global);
    await trackingLevels(api, root, range);
    await writeFile(join(root, "passed"), "passed");
  } catch (error) {
    await writeFile(join(root, "failed"), error.stack ?? String(error)); throw error;
  }
};

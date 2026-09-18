const assert = require("node:assert/strict");
const { writeFile } = require("node:fs/promises");
const { join } = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const vscode = require("vscode");

exports.run = async () => {
  const root = process.env.STACK_STATS_SMOKE_DIR;
  try {
    const extension = vscode.extensions.all.find((item) => item.packageJSON.name === "stack-stats-vscode");
    assert(extension);
    const api = await extension.activate();
    assert.equal(api.apiVersion, "2.0");
    assert.equal(api.account.getState().status, "disconnected", "New profile remains local-only");
    assert.equal(api.profileSync.getState().status, "not-connected", "New installation has no sync consent");
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
    assert.deepEqual(views.map(view => view.name), ["Activity", "Account"], "Two focused native sidebar panels");
    for (const section of ["currentSession", "thisWeek", "languages", "projects", "streak"]) {
      assert(commands.includes(`stackStats.${section}.focus`), "Legacy focus command preserved");
      await vscode.commands.executeCommand(`stackStats.${section}.focus`);
    }
    for (const view of views) await vscode.commands.executeCommand(`${view.id}.focus`);
    const settings = vscode.workspace.getConfiguration("stackStats");
    assert.equal(settings.get("showStatusBar"), true);
    assert.equal(settings.get("inactivityTimeoutMinutes"), 5);
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
    const raw = await api.events({ ...range, limit: 1000 });
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
    await writeFile(join(root, "passed"), "passed");
  } catch (error) {
    await writeFile(join(root, "failed"), error.stack ?? String(error)); throw error;
  }
};

const assert = require("node:assert/strict");
const { readFile, readdir, writeFile } = require("node:fs/promises");
const { join } = require("node:path");
const vscode = require("vscode");

async function run() {
  const root = process.env.STACK_STATS_SMOKE_DIR;
  assert(root, "Use pnpm test:vscode to run in an isolated profile");
  const extension = vscode.extensions.all.find((item) => item.packageJSON.name === "stack-stats-vscode");
  assert(extension, "Extension discovered");
  await extension.activate();
  assert(extension.isActive, "Extension activated");
  const observations = [];
  const observer = vscode.workspace.onDidChangeTextDocument((event) => observations.push({
    at: Date.now(), dirty: event.document.isDirty, changes: event.contentChanges.length,
    reason: event.reason, focused: vscode.window.state.focused,
    scheme: event.document.uri.scheme, version: event.document.version,
    visible: vscode.window.visibleTextEditors.some((editor) => editor.document === event.document)
  }));
  const registered = await vscode.commands.getCommands(true);
  async function focus() {
    // Native focus notifications arrive asynchronously after the command resolves.
    for (let i = 0; i < 20; i++) {
      if (registered.includes("workbench.action.focusWindow")) await vscode.commands.executeCommand("workbench.action.focusWindow");
      await new Promise((resolve) => setTimeout(resolve, 150));
      if (vscode.window.state.focused) return;
    }
    assert.fail("Keep the isolated VS Code test window focused");
  }
  for (const { command } of extension.packageJSON.contributes.commands) assert(registered.includes(command), `${command} registered`);
  const directory = join(root, "user-data", "User", "globalStorage", extension.id.toLowerCase(), "sessions-v1");
  const snapshots = async () => Promise.all((await readdir(directory)).filter((file) => file.endsWith(".json"))
    .map(async (file) => JSON.parse(await readFile(join(directory, file), "utf8")).session));
  await vscode.commands.executeCommand("stackStats.showToday");
  assert.equal((await snapshots()).length, 0, "Startup must not invent activity");
  const document = await vscode.workspace.openTextDocument(join(root, "workspace", "sample.ts"));
  const editor = await vscode.window.showTextDocument(document);
  await focus();
  await editor.edit((builder) => builder.insert(new vscode.Position(0, 0), "const first = 1;\n"));
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await focus();
  await editor.edit((builder) => builder.insert(new vscode.Position(1, 0), "const second = 2;\n"));
  await document.save();
  await writeFile(join(root, "observations.json"), JSON.stringify(observations, null, 2));
  await vscode.commands.executeCommand("stackStats.showToday");
  const recorded = await snapshots();
  assert.equal(recorded.length, 1, "Edits group into one durable session");
  const row = recorded[0].days[0].contributions[0];
  assert.equal(row.linesAdded, 2);
  assert.equal(row.linesRemoved, 0);
  assert.equal(row.editCount, 2, "Save does not duplicate edits");
  assert(row.activeMs >= 0 && row.activeMs < 5000, "No invented minute of activity from a few seconds of editing");
  assert(!JSON.stringify(recorded).includes("const first"), "No source contents persisted");
  await vscode.commands.executeCommand("stackStats.pause");
  await new Promise((resolve) => setTimeout(resolve, 100));
  await focus();
  await editor.edit((builder) => builder.insert(new vscode.Position(2, 0), "// paused\n"));
  await vscode.commands.executeCommand("stackStats.showThisWeek");
  assert.equal((await snapshots())[0].days[0].contributions[0].editCount, 2, "Pause stops collection");
  await vscode.commands.executeCommand("stackStats.resume");
  await new Promise((resolve) => setTimeout(resolve, 100));
  const untitled = await vscode.workspace.openTextDocument({ language: "sql" });
  const unsavedEditor = await vscode.window.showTextDocument(untitled);
  await focus();
  await unsavedEditor.edit((builder) => builder.insert(new vscode.Position(0, 0), "SELECT 1;\n"));
  await vscode.commands.executeCommand("stackStats.showToday");
  await writeFile(join(root, "observations.json"), JSON.stringify(observations, null, 2));
  assert.equal((await snapshots()).length, 2, "Resume and untitled editing start a new session");
  for (const command of ["showStatus", "showCurrentSession", "retrySync", "showTelemetry", "compareTelemetry", "showPrivacy"]) await vscode.commands.executeCommand(`stackStats.${command}`);
  const api = extension.exports;
  assert.equal(api.apiVersion, "2.0");
  const range = { from: new Date(Date.now() - 3600_000).toISOString(), to: new Date(Date.now() + 3600_000).toISOString() };
  const beforeExcluded = await api.query(range);
  assert(beforeExcluded.edits.charactersAdded > 0, "Character telemetry is recorded");
  assert.equal(beforeExcluded.attribution.unknownShare, 1, "Editor brand does not imply authorship");
  const excludedPath = join(root, "workspace", ".env");
  await writeFile(excludedPath, "");
  const excluded = await vscode.workspace.openTextDocument(excludedPath);
  const excludedEditor = await vscode.window.showTextDocument(excluded);
  await focus();
  await excludedEditor.edit((builder) => builder.insert(new vscode.Position(0, 0), "PRIVATE_TOKEN=do_not_collect\n"));
  assert.equal((await api.query(range)).edits.charactersAdded, beforeExcluded.edits.charactersAdded, "Excluded files do not enter telemetry");
  const workspace = vscode.workspace.workspaceFolders[0];
  const createdUri = vscode.Uri.file(join(root, "workspace", "lifecycle.ts"));
  const renamedUri = vscode.Uri.file(join(root, "workspace", "renamed.ts"));
  const create = new vscode.WorkspaceEdit(); create.createFile(createdUri); await vscode.workspace.applyEdit(create);
  const rename = new vscode.WorkspaceEdit(); rename.renameFile(createdUri, renamedUri); await vscode.workspace.applyEdit(rename);
  const remove = new vscode.WorkspaceEdit(); remove.deleteFile(renamedUri); await vscode.workspace.applyEdit(remove);
  const task = new vscode.Task({ type: "stack-stats-smoke" }, workspace, "private-task-label", "smoke", new vscode.ShellExecution("exit 0"));
  task.group = vscode.TaskGroup.Test;
  let disposeTask;
  const taskFinished = new Promise((resolve) => { disposeTask = vscode.tasks.onDidEndTask((event) => {
    if (event.execution.task.name === "private-task-label") { disposeTask.dispose(); resolve(); }
  }); });
  await vscode.tasks.executeTask(task);
  await Promise.race([taskFinished, new Promise((_, reject) => setTimeout(() => reject(new Error("Task lifecycle timed out")), 15000))]);
  await writeFile(join(root, "workspace", "external.txt"), "not read by telemetry");
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const measured = await api.query(range);
  assert(measured.fileOperations.created >= 1 && measured.fileOperations.renamed >= 1 && measured.fileOperations.deleted >= 1, "File lifecycle observed");
  assert.equal(measured.workflows.tests, 1, "Task group identifies one test invocation");
  assert.equal(measured.workflows.completedTasks, 1);
  assert(!JSON.stringify(measured).includes("private-task-label"));
  const events = await api.events({ ...range, limit: 1000 });
  const target = events.events.find((event) => event.eventType === "editor.edit");
  const providerId = require("node:crypto").createHash("sha256").update("test-provider").digest("hex");
  await assert.rejects(api.reportAttribution({ targetEventIds: [target.eventId], actor: "ai", agent: "codex", providerId }), /disabled/);
  await vscode.workspace.getConfiguration("stackStats").update("allowAttributionReports", true, vscode.ConfigurationTarget.Global);
  await api.reportAttribution({ targetEventIds: [target.eventId], actor: "ai", agent: "codex", providerId });
  const annotated = await api.query(range);
  assert.equal(annotated.edits.editCount, measured.edits.editCount, "Provenance annotations do not create extra edits");
  assert(annotated.attribution.reportedAiShare > 0, "Explicit provider report is reflected");
  await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
  observer.dispose();
  console.log("Stack Stats real VS Code smoke test passed: activation, commands/API, edits/save, sessions, exclusions, lifecycle, tasks, provenance and persistence.");
  await writeFile(join(root, "passed"), "passed");
}

exports.run = async () => {
  try { await run(); } catch (error) {
    await writeFile(join(process.env.STACK_STATS_SMOKE_DIR, "failed"), error.stack ?? String(error));
    throw error;
  }
};

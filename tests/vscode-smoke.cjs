const assert = require("node:assert/strict");
const { readFile, readdir, writeFile, rename: moveFile } = require("node:fs/promises");
const { join } = require("node:path");
const vscode = require("vscode");

async function run() {
  const root = process.env.STACK_STATS_SMOKE_DIR;
  assert(root, "Use pnpm test:vscode to run in an isolated profile");
  const extension = vscode.extensions.all.find((item) => item.packageJSON.name === "stack-stats-vscode");
  assert(extension, "Extension discovered");
  await extension.activate();
  assert(extension.isActive, "Extension activated");
  assert.equal(extension.exports.tracking.getState().mode, "moderate", "A clean profile starts at the recommended tracking level");
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
  const hourlyDirectory = join(directory, "..", "hourly-v1");
  const hourlyRows = await Promise.all((await readdir(hourlyDirectory)).filter((file) => /^\d{4}-\d{2}-\d{2}\.json$/.test(file))
    .map(async (file) => JSON.parse(await readFile(join(hourlyDirectory, file), "utf8"))));
  assert.equal(hourlyRows.reduce((sum, day) => sum + day.editCountByHour.reduce((a, b) => a + b, 0), 0),
    annotated.edits.editCount, "Real collected edits reach the durable hourly projection exactly once");
  assert(!JSON.stringify(hourlyRows).includes("PRIVATE_TOKEN"), "Hourly projection excludes source contents");
  // Phase 9E: agent-style writes while the user is idle must not extend, credit or
  // start a session; a later human edit of the agent-changed file counts normally.
  const agentFile = join(root, "workspace", "agent-open.ts");
  await writeFile(agentFile, "const kept = 0;\nconst changed = 1;\n");
  const agentEditor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(agentFile));
  await vscode.commands.executeCommand("stackStats.showToday");
  const latest = async () => (await snapshots()).sort((a, b) => a.endedAt.localeCompare(b.endedAt)).at(-1);
  const beforeAgent = await latest();
  const countEdits = (session) => session.days.flatMap((day) => day.contributions).reduce((sum, row) => sum + row.editCount, 0);
  const activeTime = (session) => session.days.flatMap((day) => day.contributions).reduce((sum, row) => sum + row.activeMs, 0);
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    // Claude Code's observed write pattern: temp file, then rename over the target.
    await writeFile(`${agentFile}.tmp.9.abcdef${i}0`, `const kept = 0;\nconst changed = ${i + 2};\nconst added${i} = true;\n`);
    await moveFile(`${agentFile}.tmp.9.abcdef${i}0`, agentFile);
    await writeFile(join(root, "workspace", "agent-closed.ts"), `export const run = ${i};\n`);
  }
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await vscode.commands.executeCommand("stackStats.showToday");
  const afterAgent = await latest();
  assert.equal(afterAgent.sessionId, beforeAgent.sessionId, "Agent writes do not start a session");
  assert.equal(afterAgent.endedAt, beforeAgent.endedAt, "Agent writes do not extend the session");
  assert.equal(countEdits(afterAgent), countEdits(beforeAgent), "Disk reloads of an open document are not editor edits");
  assert.equal(activeTime(afterAgent), activeTime(beforeAgent), "Agent writes earn no active time");
  assert(agentEditor.document.getText().includes("added2"), "The open document reloaded the agent's change");
  const agentSummary = await api.agentActivity(range);
  assert(agentSummary.external.unknown.events >= 2, "External writes are observed without an integration");
  assert(agentSummary.external.unknown.linesAdded >= 1, "Open-document reloads provide diff lines");
  assert.equal(agentSummary.agent.explicit.events + agentSummary.agent.correlated.events, 0, "No agent attribution without hook evidence");
  await focus();
  await agentEditor.edit((builder) => builder.insert(new vscode.Position(0, 0), "// human follow-up\n"));
  await vscode.commands.executeCommand("stackStats.showToday");
  assert.equal(countEdits(await latest()), countEdits(afterAgent) + 1, "A human edit after agent work counts normally");
  // Phase 9F: a level changes future local collection only. Coding activity keeps
  // working at every level and existing history is never removed.
  const setLevel = async (mode, ...command) => {
    await vscode.commands.executeCommand(...command);
    for (let i = 0; i < 40 && api.tracking.getState().mode !== mode; i++) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(api.tracking.getState().mode, mode, `Tracking level is ${mode}`);
  };
  const hourlyEdits = async () => (await Promise.all((await readdir(hourlyDirectory)).filter((file) => /^\d{4}-\d{2}-\d{2}\.json$/.test(file))
    .map(async (file) => JSON.parse(await readFile(join(hourlyDirectory, file), "utf8"))))).reduce((sum, day) => sum + day.editCountByHour.reduce((a, b) => a + b, 0), 0);
  const humanEdit = async (text) => {
    await focus();
    await agentEditor.edit((builder) => builder.insert(new vscode.Position(0, 0), text));
    await vscode.commands.executeCommand("stackStats.showToday");
  };
  const sessionsBefore = (await snapshots()).length;
  await setLevel("minimal", "stackStats.changeTrackingLevel", "minimal");
  const timelineAtMinimal = (await api.query(range)).edits.editCount, hourlyAtMinimal = await hourlyEdits();
  const editsAtMinimal = countEdits(await latest());
  await humanEdit("// minimal\n");
  assert.equal(countEdits(await latest()), editsAtMinimal + 1, "Minimal still records coding activity");
  assert.equal((await api.query(range)).edits.editCount, timelineAtMinimal, "Minimal records no activity timeline");
  assert.equal(await hourlyEdits(), hourlyAtMinimal, "Minimal adds nothing to hourly patterns");
  const externalAtMinimal = (await api.agentActivity(range)).external.unknown.events;
  await writeFile(join(root, "workspace", "minimal-external.ts"), "export const minimal = true;\n");
  await new Promise((resolve) => setTimeout(resolve, 2000));
  assert.equal((await api.agentActivity(range)).external.unknown.events, externalAtMinimal, "Minimal records no external changes");
  await setLevel("moderate", "stackStats.changeTrackingLevel", "moderate");
  await writeFile(join(root, "workspace", "moderate-external.ts"), "export const moderate = true;\n");
  await new Promise((resolve) => setTimeout(resolve, 2000));
  assert((await api.agentActivity(range)).external.unknown.events > externalAtMinimal, "Moderate tracks external changes again");
  await humanEdit("// moderate\n");
  assert.equal((await api.query(range)).edits.editCount, timelineAtMinimal + 1, "Moderate records the activity timeline again");
  await setLevel("extensive", "stackStats.changeTrackingLevel", "extensive");
  const agentSettings = vscode.workspace.getConfiguration("stackStats");
  assert.deepEqual([agentSettings.get("agentIntegrations.claudeCode"), agentSettings.get("agentIntegrations.codex")], [false, false], "Extensive never connects an agent");
  await setLevel("custom", "stackStats.setTrackingCapability", "activity_timeline", false);
  await setLevel("moderate", "stackStats.restoreRecommendedTracking");
  await humanEdit("// restored\n");
  assert.equal(countEdits(await latest()), editsAtMinimal + 3, "Stats stay coherent across level changes");
  assert((await snapshots()).length >= sessionsBefore, "Changing levels never removes history");
  await agentEditor.document.save();
  await vscode.window.showTextDocument(excluded);
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

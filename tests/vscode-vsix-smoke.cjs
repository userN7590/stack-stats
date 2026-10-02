const assert = require("node:assert/strict");
const { access, readFile, stat, writeFile, mkdir } = require("node:fs/promises");
const { join, relative, isAbsolute } = require("node:path");
const vscode = require("vscode");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Hands the workbench to scripts/test-vsix.mjs, which inspects the real UI through
 * the DevTools protocol and saves a screenshot, then continues with its verdict. */
async function checkpoint(root, name) {
  await sleep(1200); // Tree views and pickers render asynchronously.
  await writeFile(join(root, `checkpoint-${name}`), "ready");
  for (let i = 0; i < 600; i++) {
    const verdict = await readFile(join(root, `checkpoint-${name}.done`), "utf8").catch(() => undefined);
    if (verdict) {
      const { errors } = JSON.parse(verdict);
      assert.deepEqual(errors, [], `UI checkpoint "${name}"`);
      return;
    }
    await sleep(100);
  }
  assert.fail(`UI checkpoint "${name}" was not inspected; run this through pnpm test:vsix`);
}

/** Clean-install checks against the packaged VSIX (not a development folder), then the
 * existing API smoke against that same installed build. */
async function run() {
  const root = process.env.STACK_STATS_SMOKE_DIR;
  assert(root, "Run through pnpm test:vsix");
  const extension = vscode.extensions.all.find((item) => item.packageJSON.name === "stack-stats-vscode");
  assert(extension, "The installed VSIX is discovered");
  assert.equal(extension.id, process.env.STACK_STATS_VSIX_ID, "Extension identity is the packaged one");
  const fromInstall = relative(join(root, "extensions"), extension.extensionPath);
  assert(!fromInstall.startsWith("..") && !isAbsolute(fromInstall), "Loaded from the isolated VSIX install, not a source folder");
  const containers = extension.packageJSON.contributes.viewsContainers.activitybar;
  for (const asset of [extension.packageJSON.icon, ...containers.map((item) => item.icon)]) await access(join(extension.extensionPath, asset));

  const api = await extension.activate();
  assert.equal(api.tracking.getState().mode, "moderate", "A clean install resolves to Moderate");
  assert.equal(api.tracking.getState().paused, false, "Tracking is on after install");
  assert.equal(api.account.getState().status, "disconnected", "No account is required");
  assert.equal(api.profileSync.getState().status, "not-connected", "Nothing syncs without an account and consent");
  const settings = () => vscode.workspace.getConfiguration("stackStats");
  const keys = extension.packageJSON.contributes.configuration.flatMap((section) => Object.keys(section.properties)).map((key) => key.slice("stackStats.".length));
  const overrides = () => keys.filter((key) => settings().inspect(key)?.globalValue !== undefined);
  assert.deepEqual(overrides(), [], "Install writes no settings");

  // Detected but unconnected agents, configured the way a user would have them.
  const claudeConfig = join(process.env.CLAUDE_CONFIG_DIR, "settings.json"), codexHooks = join(process.env.CODEX_HOME, "hooks.json");
  await mkdir(process.env.CLAUDE_CONFIG_DIR, { recursive: true }); await mkdir(process.env.CODEX_HOME, { recursive: true });
  await writeFile(claudeConfig, '{\n  "model": "user-choice"\n}\n');
  await writeFile(codexHooks, '{"hooks":{}}\n');
  const vendor = async () => Promise.all([claudeConfig, codexHooks].map(async (file) => [await readFile(file, "utf8"), (await stat(file)).mtimeMs]));
  const vendorBefore = await vendor();
  await vscode.commands.executeCommand("stackStats.verifyAgentIntegrations");

  await vscode.commands.executeCommand("workbench.view.extension.stackStats");
  for (const view of ["today", "agents", "trackingStatus"]) await vscode.commands.executeCommand(`stackStats.${view}.focus`);
  await checkpoint(root, "sidebar");
  // The product icon as VS Code shows it for the installed extension.
  await vscode.commands.executeCommand("workbench.extensions.search", "@installed Stack Stats");
  await checkpoint(root, "extensions");
  await vscode.commands.executeCommand("workbench.view.extension.stackStats");

  // Connect asks before writing anything. VS Code's test host refuses modal dialogs,
  // which stops Connect at its confirmation exactly as Cancel does.
  for (const tool of ["claude-code", "codex"]) await vscode.commands.executeCommand("stackStats.connectAgent", tool);
  assert.deepEqual(await vendor(), vendorBefore, "Declining Connect leaves Claude Code and Codex settings byte- and mtime-identical");
  assert.deepEqual([settings().get("agentIntegrations.claudeCode"), settings().get("agentIntegrations.codex")], [false, false], "Declining Connect connects nothing");
  await assert.rejects(access(join(process.env.STACK_STATS_HOME, "hooks")), "No hook runtime is installed before confirmation");

  // Pickers render in the real workbench; dismissing them changes nothing.
  for (const [name, command] of [["levels", "stackStats.changeTrackingLevel"], ["advanced", "stackStats.openAdvancedTracking"], ["agents", "stackStats.manageAgentIntegrations"]]) {
    const picker = vscode.commands.executeCommand(command);
    await checkpoint(root, name);
    await vscode.commands.executeCommand("workbench.action.closeQuickOpen");
    await picker;
    assert.equal(api.tracking.getState().mode, "moderate", `Dismissing ${name} keeps Moderate`);
    assert.deepEqual(overrides(), [], `Dismissing ${name} writes no settings`);
  }
  assert.deepEqual(await vendor(), vendorBefore, "The pickers never touch agent settings");

  // A connection whose hooks are gone (removed by hand, say) needs attention and offers Repair.
  await settings().update("agentIntegrations.claudeCode", true, vscode.ConfigurationTarget.Global);
  await vscode.commands.executeCommand("stackStats.verifyAgentIntegrations");
  await checkpoint(root, "attention");
  await settings().update("agentIntegrations.claudeCode", undefined, vscode.ConfigurationTarget.Global);
  await vscode.commands.executeCommand("stackStats.verifyAgentIntegrations");
  assert.deepEqual(await vendor(), vendorBefore, "Status checks never write agent settings");

  await vscode.commands.executeCommand("stackStats.pause");
  for (let i = 0; i < 40 && !api.tracking.getState().paused; i++) await sleep(100);
  assert(api.tracking.getState().paused, "Pause is reflected");
  await checkpoint(root, "paused");
  await vscode.commands.executeCommand("stackStats.resume");
  for (let i = 0; i < 40 && api.tracking.getState().paused; i++) await sleep(100);
  assert(!api.tracking.getState().paused, "Resume is reflected");
  await vscode.commands.executeCommand("stackStats.showPrivacy");

  // Connect account asks VS Code to open stackstats.dev. Link protection asks before
  // opening a site that isn't trusted yet, and the test host refuses that prompt: the
  // declined path must return to local-only with nothing pending. No browser opens.
  await vscode.commands.executeCommand("stackStats.connectAccount");
  assert.equal(api.account.getState().status, "disconnected", "Declining the browser prompt returns to local-only");
  assert.match(api.account.getState().message ?? "", /Could not open account sign-in/);
  await vscode.commands.executeCommand("stackStats.cancelAccountConnection");
  assert.equal(api.profileSync.getState().status, "not-connected", "No sync without an account");
  await require("./vscode-api-smoke.cjs").run();
}

exports.run = async () => {
  try { await run(); } catch (error) {
    await writeFile(join(process.env.STACK_STATS_SMOKE_DIR, "failed"), error.stack ?? String(error));
    throw error;
  }
};

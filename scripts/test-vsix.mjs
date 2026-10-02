import { mkdtemp, mkdir, writeFile, readFile, readdir, rename, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { checkVsix } from "./check-vsix.mjs";

// Clean-install test of the packaged extension. The VSIX is installed into isolated
// profiles with VS Code's own CLI and the smokes run against that installed copy: Stack
// Stats is never loaded from the source folder. User data, extensions, the Stack Stats
// home and Claude Code / Codex configuration are temporary; nothing is published.
//   pnpm test:vsix [--vsix file.vsix] [--artifacts dir] [--keep] [--skip-interactive]
// The real workbench is inspected through the DevTools protocol at each checkpoint and
// screenshotted into the artifacts folder. No browser is opened and nothing is sent to
// stackstats.dev: VS Code's link protection stops Connect account in a test host.
const args = process.argv.slice(2);
const option = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const executable = process.env.VSCODE_EXECUTABLE ?? (process.platform === "darwin" ? "/Applications/Visual Studio Code.app/Contents/MacOS/Code" : "code");
const app = process.platform === "darwin" && executable.includes(".app/") ? `${executable.split(".app/")[0]}.app` : undefined;
const cli = app ? join(app, "Contents/Resources/app/bin/code") : "code";
// Editor-internal variables leak in when this runs from an editor's extension host
// (ELECTRON_RUN_AS_NODE, VSCODE_ESM_ENTRYPOINT, ...) and break a fresh editor process.
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(VSCODE|ELECTRON)_/.test(key)));
const work = await mkdtemp(join(tmpdir(), "stack-stats-vsix-"));

let vsix = option("--vsix");
if (!vsix) {
  vsix = join(work, "stack-stats.vsix");
  const packaged = spawnSync("pnpm", ["--filter", "stack-stats-vscode", "package", "--out", vsix], { stdio: "inherit" });
  if (packaged.status !== 0) throw new Error("Packaging failed");
}
const check = await checkVsix(vsix);
console.log(`VSIX ${check.id}@${check.version}: ${check.files.length} files, ${(check.archiveBytes / 1024).toFixed(2)} KB`);
for (const warning of check.warnings) console.log(`  warning: ${warning}`);
if (check.errors.length) throw new Error(`VSIX check failed:\n  ${check.errors.join("\n  ")}`);

const freePort = () => new Promise((done, fail) => {
  const server = createServer().once("error", fail).listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => done(port)); });
});

/** One DevTools session per checkpoint against the workbench page. */
async function devtools(port) {
  for (let i = 0; i < 100; i++) {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json()).catch(() => []);
    const page = targets.find((target) => target.type === "page" && /workbench/.test(target.url));
    if (page) {
      const socket = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((done, fail) => { socket.onopen = done; socket.onerror = fail; });
      let next = 0; const pending = new Map();
      socket.onmessage = (event) => { const message = JSON.parse(event.data); pending.get(message.id)?.(message); pending.delete(message.id); };
      const send = (method, params = {}) => new Promise((done, fail) => {
        const id = ++next; pending.set(id, (message) => message.error ? fail(new Error(message.error.message)) : done(message.result));
        socket.send(JSON.stringify({ id, method, params }));
      });
      return { send, close: () => socket.close() };
    }
    await sleep(200);
  }
  throw new Error("The workbench DevTools endpoint did not appear");
}

// Runs inside the workbench renderer: what a person would see, plus whether the
// Activity Bar mask image actually decodes.
const snapshot = `(async () => {
  const text = (element) => (element?.textContent ?? "").replace(/\\s+/g, " ").trim();
  const visible = (element) => element && element.offsetParent !== null;
  const item = [...document.querySelectorAll(".part.activitybar .action-label, .composite-bar .action-label")].find((element) => /^Stack Stats/.test(element.getAttribute("aria-label") ?? ""));
  const mask = item ? getComputedStyle(item).webkitMaskImage || getComputedStyle(item).maskImage : undefined;
  let iconPixels = 0;
  const url = /url\\("?([^")]+)"?\\)/.exec(mask ?? "")?.[1];
  if (url) {
    const image = new Image(); image.src = url; await image.decode();
    const canvas = Object.assign(document.createElement("canvas"), { width: 48, height: 48 });
    const context = canvas.getContext("2d"); context.drawImage(image, 0, 0, 48, 48);
    const data = context.getImageData(0, 0, 48, 48).data;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) iconPixels++;
  }
  const rect = item?.getBoundingClientRect();
  const quick = document.querySelector(".quick-input-widget");
  const extensionIcon = [...document.querySelectorAll(".extension-list-item")].filter((row) => /Stack Stats/.test(text(row.querySelector(".name")))).map((row) => row.querySelector("img.icon")).find(Boolean);
  return {
    activityBar: { found: !!item, mask, iconPixels, rect: rect && { x: rect.x, y: rect.y, width: rect.width, height: rect.height } },
    panes: [...document.querySelectorAll(".part.sidebar .pane-header")].map((header) => [text(header.querySelector(".title")), text(header.querySelector(".description"))].join(" | ")),
    rows: [...document.querySelectorAll(".part.sidebar .monaco-list-row")].map((row) => row.getAttribute("aria-label") || text(row)),
    status: [...document.querySelectorAll(".part.statusbar .statusbar-item")].map(text).filter((value) => /Stack Stats/.test(value)),
    quickInput: visible(quick) ? { title: text(quick.querySelector(".quick-input-title")), rows: [...quick.querySelectorAll(".monaco-list-row")].map((row) => row.getAttribute("aria-label") || text(row)) } : undefined,
    extensionIcon: extensionIcon && { src: extensionIcon.getAttribute("src"), width: extensionIcon.naturalWidth, height: extensionIcon.naturalHeight, complete: extensionIcon.complete }
  };
})()`;

const has = (list, pattern) => (list ?? []).some((value) => pattern.test(value));
const expectations = {
  sidebar: (ui) => [
    [ui.activityBar.found, "Stack Stats is missing from the Activity Bar"],
    [/stack-stats-activity-bar\.svg/.test(ui.activityBar.mask ?? ""), `Activity Bar icon is not the packaged SVG: ${ui.activityBar.mask}`],
    [ui.activityBar.iconPixels > 50, "Activity Bar icon did not decode"],
    [["Activity", "Agents", "Account"].every((title) => has(ui.panes, new RegExp(`^${title} `, "i"))), `Panels: ${ui.panes.join("; ")}`],
    [has(ui.panes, /^Activity \| Tracking · Moderate$/i), "The Activity panel does not show Moderate tracking"],
    [has(ui.rows, /External changes: Tracked automatically/), "Agents: external changes are not shown as tracked automatically"],
    [has(ui.rows, /^Claude Code: Not connected/) && has(ui.rows, /^Codex: Not connected/), "Agents: Claude Code and Codex are not offered"],
    [has(ui.rows, /^Connect Claude Code/) && has(ui.rows, /^Connect Codex/), "Agents: Connect actions are missing"],
    [has(ui.rows, /^Today/), "Activity: Today is missing"],
    [has(ui.rows, /^Connect account: Optional/), "Account: the optional connection is missing"],
    [has(ui.status, /^Stack Stats • Idle$/), `Status bar: ${ui.status.join("; ")}`]
  ],
  extensions: (ui) => [
    [/stack-stats-icon\.png/.test(ui.extensionIcon?.src ?? ""), `Extensions view icon: ${JSON.stringify(ui.extensionIcon)}`],
    [ui.extensionIcon?.complete && ui.extensionIcon.width >= 128 && ui.extensionIcon.width === ui.extensionIcon.height, "Extensions view icon did not load as a square ≥128 px PNG"]
  ],
  levels: (ui) => [
    [ui.quickInput?.title === "How much would you like Stack Stats to track?", `Level picker title: ${ui.quickInput?.title}`],
    [["Minimal", "Moderate — Recommended", "Extensive", "Advanced settings"].every((label) => has(ui.quickInput?.rows, new RegExp(label))), `Level picker rows: ${ui.quickInput?.rows.join("; ")}`],
    [has(ui.quickInput?.rows, /Moderate — Recommended.*Current/), "The current level is not marked"]
  ],
  advanced: (ui) => [
    [ui.quickInput?.title === "Advanced tracking · Moderate", `Advanced title: ${ui.quickInput?.title}`],
    [["Coding activity", "Hourly activity patterns", "External file changes", "Git activity", "Agent activity", "Reports from other extensions"].every((label) => has(ui.quickInput?.rows, new RegExp(label))), `Advanced rows: ${ui.quickInput?.rows.join("; ")}`]
  ],
  agents: (ui) => [
    [["External changes", "Connect Claude Code", "Connect Codex", "Advanced: show manual setup"].every((label) => has(ui.quickInput?.rows, new RegExp(label))), `Agent picker rows: ${ui.quickInput?.rows.join("; ")}`],
    [!has(ui.quickInput?.rows, /"hooks"|\{/), "The agent picker shows raw configuration"]
  ],
  attention: (ui) => [
    [has(ui.rows, /^Claude Code: Needs attention/), "Agents: a connection with missing hooks is not flagged"],
    [has(ui.rows, /^Repair connection/), "Agents: Repair is not offered"],
    [has(ui.panes, /^Agents \| Needs attention$/i), "The Agents panel title does not say Needs attention"]
  ],
  paused: (ui) => [
    [has(ui.status, /^Stack Stats • Paused$/), `Status bar while paused: ${ui.status.join("; ")}`],
    [has(ui.panes, /^Activity \| Paused$/i), "The Activity panel does not show Paused"]
  ]
};

async function inspect(port, name, root) {
  const session = await devtools(port);
  try {
    const { result } = await session.send("Runtime.evaluate", { expression: snapshot, awaitPromise: true, returnByValue: true });
    const ui = result.value;
    const shot = await session.send("Page.captureScreenshot", { format: "png" });
    await writeFile(join(root, "artifacts", `${name}.png`), Buffer.from(shot.data, "base64"));
    if (name === "sidebar" && ui.activityBar.rect) {
      const icon = await session.send("Page.captureScreenshot", { format: "png", clip: { ...ui.activityBar.rect, scale: 4 } });
      await writeFile(join(root, "artifacts", "activity-bar-icon.png"), Buffer.from(icon.data, "base64"));
    }
    await writeFile(join(root, "artifacts", `${name}.json`), JSON.stringify(ui, null, 2));
    return { errors: (expectations[name]?.(ui) ?? [[false, `No expectations for ${name}`]]).filter(([ok]) => !ok).map(([, message]) => message) };
  } catch (error) {
    return { errors: [`${name}: ${error.message}`] };
  } finally { session.close(); }
}

/** Swallowed command failures and activation errors only show up in the logs. */
async function scanLogs(root, expectedCommandFailures) {
  const problems = [], files = [];
  const walk = async (directory) => { for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path); else files.push(path);
  } };
  await walk(join(root, "user-data", "logs"));
  let output = "", commandFailures = 0;
  for (const file of files) {
    const content = await readFile(file, "utf8");
    if (/Stack Stats\.log$/.test(file)) {
      output += content;
      commandFailures += (content.match(/The command could not complete/g) ?? []).length;
    }
    for (const line of content.split("\n")) {
      if (/stack-stats/i.test(line) && /\[error\]|Activating extension .* failed|Cannot register|already exists|rejected promise/i.test(line)) problems.push(`${file.slice(root.length + 1)}: ${line.slice(0, 240)}`);
    }
  }
  if (commandFailures !== expectedCommandFailures) problems.push(`Stack Stats output: ${commandFailures} command failure(s), expected ${expectedCommandFailures}`);
  return { problems, output };
}

async function scenario(name, tests, { devtoolsChecks, expectedCommandFailures }) {
  // Short root: VS Code's IPC socket lives in the user data folder, and macOS socket
  // paths are limited to 103 characters.
  const root = await mkdtemp(join(tmpdir(), `ssv-${name}-`));
  for (const directory of ["workspace", "user-data", "extensions", "harness", "artifacts"]) await mkdir(join(root, directory), { recursive: true });
  await writeFile(join(root, "workspace", "sample.ts"), "");
  // The test runner needs a development extension; this one is empty, so the only
  // Stack Stats code that runs is the installed VSIX.
  await writeFile(join(root, "harness", "package.json"), JSON.stringify({ name: "stack-stats-vsix-harness", publisher: "stack-stats-test", version: "0.0.0", engines: { vscode: "*" } }));
  const profile = ["--user-data-dir", join(root, "user-data"), "--extensions-dir", join(root, "extensions")];
  // VS Code's CLI runs the extension's vscode:uninstall hook with the CLI's environment:
  // pin the isolated Stack Stats home so the real ~/.stackstats is never touched.
  const home = join(root, "daemon");
  const code = (...flags) => spawnSync(cli, [...profile, ...flags], { encoding: "utf8", env: { ...cleanEnv, STACK_STATS_HOME: home } });
  const installed = () => code("--list-extensions", "--show-versions").stdout.trim().split("\n");
  // VS Code's CLI prints lowercase IDs; package.json and Extension.id retain the
  // confirmed publisher spelling, checked independently by the archive/host tests.
  const installedRelease = () => installed().some((line) => line.toLowerCase() === `${check.id}@${check.version}`.toLowerCase());
  const install = code("--install-extension", resolve(vsix), "--force");
  if (install.status !== 0) throw new Error(`Install failed: ${install.stdout}${install.stderr}`);
  if (!installedRelease()) throw new Error(`Installed extensions: ${installed().join(", ")}`);
  console.log(`[${name}] installed ${check.id}@${check.version} into a clean profile`);

  const port = devtoolsChecks ? await freePort() : undefined;
  const env = { ...cleanEnv, STACK_STATS_SMOKE_DIR: root, STACK_STATS_HOME: home, CLAUDE_CONFIG_DIR: join(root, "claude"), CODEX_HOME: join(root, "codex"), STACK_STATS_VSIX_ID: check.id };
  const launch = async (testsPath, debugPort) => {
    const vscodeArgs = ["--new-window", "--skip-welcome", "--skip-release-notes", "--disable-workspace-trust", ...profile,
      `--extensionDevelopmentPath=${join(root, "harness")}`, `--extensionTestsPath=${testsPath}`, ...(debugPort ? [`--remote-debugging-port=${debugPort}`] : []), join(root, "workspace")];
    if (!app) {
      let exited = false;
      spawn(executable, vscodeArgs, { env, stdio: "inherit" }).on("close", () => { exited = true; });
      return () => !exited;
    }
    // As in test-vscode.mjs, LaunchServices brings the window to the foreground. `open -W`
    // cannot always track the new instance, so wait on the editor's own main process.
    const forwarded = ["STACK_STATS_SMOKE_DIR", "STACK_STATS_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "STACK_STATS_VSIX_ID"].flatMap((key) => ["--env", `${key}=${env[key]}`]);
    const opened = spawnSync("/usr/bin/open", ["-n", "-a", app, ...forwarded, "--args", ...vscodeArgs], { env, encoding: "utf8" });
    if (opened.status !== 0) throw new Error(`Could not launch VS Code: ${opened.stderr}`);
    const main = `MacOS/Code .*--user-data-dir ${join(root, "user-data").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( |$)`;
    const running = () => spawnSync("/usr/bin/pgrep", ["-f", main], { encoding: "utf8" }).stdout.trim() !== "";
    for (let i = 0; i < 150 && !running(); i++) await sleep(100);
    return running;
  };
  const running = await launch(resolve(tests), port);
  const deadline = Date.now() + 300_000;
  const inspected = new Set();
  while (running() && Date.now() < deadline) {
    for (const file of port ? await readdir(root) : []) {
      const checkpoint = /^checkpoint-([a-z]+)$/.exec(file)?.[1];
      if (!checkpoint || inspected.has(checkpoint)) continue;
      inspected.add(checkpoint);
      const verdict = await inspect(port, checkpoint, root);
      console.log(`[${name}] UI ${checkpoint}: ${verdict.errors.length ? verdict.errors.join(" / ") : "ok"}`);
      await writeFile(join(root, `${file}.tmp`), JSON.stringify(verdict));
      await rename(join(root, `${file}.tmp`), join(root, `${file}.done`));
    }
    await sleep(200);
  }
  if (running()) { console.error(`[${name}] timed out; closing the test editor`); spawnSync("/usr/bin/pkill", ["-f", join(root, "user-data")]); }
  const passed = await readFile(join(root, "passed"), "utf8").then((value) => value === "passed").catch(() => false);
  const logs = await scanLogs(root, expectedCommandFailures);
  if (devtoolsChecks && !/1\. Local collection \(this device\)[\s\S]*2\. Private sync[\s\S]*3\. Public profile/.test(logs.output)) logs.problems.push("Show Telemetry Privacy did not print the three layers");
  if (devtoolsChecks && !/Tracking level: Moderate \(recommended\)/.test(logs.output)) logs.problems.push("The privacy report does not show Moderate");
  if (devtoolsChecks && passed) {
    // Uninstall, let VS Code finish removing the extension on its next start (that is when
    // it runs vscode:uninstall and deletes the extension's storage), then reinstall.
    const exists = (path) => readdir(path).then(() => true, () => false);
    const storage = join(root, "user-data", "User", "globalStorage", check.id.toLowerCase());
    const state = () => readFile(join(home, "agent-inbox-v1", "state.json"), "utf8").then(JSON.parse);
    const collecting = (await state()).collecting;
    const removed = code("--uninstall-extension", check.id);
    if (removed.status !== 0 || installed().some((line) => line.toLowerCase().startsWith(`${check.id.toLowerCase()}@`))) logs.problems.push(`Uninstall failed: ${removed.stdout}${removed.stderr}`);
    // The first start marks the extension as removed; a later start deletes it.
    await writeFile(join(root, "settle.cjs"), "exports.run = () => new Promise((done) => setTimeout(done, 5000));\n");
    const leftovers = async () => (await readdir(join(root, "extensions"))).filter((entry) => entry.toLowerCase().startsWith(check.id.toLowerCase()));
    for (let start = 0; start < 3 && (await leftovers()).length; start++) {
      const settling = await launch(join(root, "settle.cjs"));
      for (let i = 0; i < 300 && settling(); i++) await sleep(200);
    }
    console.log(`[${name}] after uninstall: extension folder ${(await leftovers()).length ? "kept" : "removed"}, local history ${await exists(storage) ? "kept" : "deleted by VS Code"}, agent hooks ${(await state()).collecting ? "still collecting" : "paused"}`);
    if (await exists(storage)) logs.problems.push("VS Code kept the extension's storage after removing it; update the uninstall documentation");
    if (collecting && (await state()).collecting !== false) logs.problems.push("The vscode:uninstall hook did not pause Stack Stats' agent hook state");
    const again = code("--install-extension", resolve(vsix), "--force");
    if (again.status !== 0 || !installedRelease()) logs.problems.push(`Reinstall failed: ${again.stdout}${again.stderr}`);
    else console.log(`[${name}] reinstalled ${check.id}@${check.version}`);
  }
  for (const problem of logs.problems) console.error(`[${name}] log: ${problem}`);
  if (!passed) console.error(await readFile(join(root, "failed"), "utf8").catch(() => "VS Code did not complete the smoke test."));
  return { name, root, ok: passed && logs.problems.length === 0, checkpoints: [...inspected] };
}

const results = [await scenario("installed", "tests/vscode-vsix-smoke.cjs", { devtoolsChecks: true, expectedCommandFailures: 2 })];
if (!args.includes("--skip-interactive")) results.push(await scenario("interactive", "tests/vscode-smoke.cjs", { devtoolsChecks: false, expectedCommandFailures: 0 }));
const artifacts = option("--artifacts");
if (artifacts) for (const { name, root } of results) await cp(join(root, "artifacts"), join(resolve(artifacts), name), { recursive: true });
const ok = results.every((result) => result.ok);
for (const result of results) console.log(`[${result.name}] ${result.ok ? "passed" : "FAILED"}${result.checkpoints.length ? ` (UI checkpoints: ${result.checkpoints.join(", ")})` : ""}`);
if (ok && !args.includes("--keep")) for (const directory of [work, ...results.map((result) => result.root)]) await rm(directory, { recursive: true, force: true });
else for (const result of results) console.log(`[${result.name}] artifacts and editor logs: ${result.root}`);
process.exitCode = ok ? 0 : 1;

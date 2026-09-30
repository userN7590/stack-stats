import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { HookTool } from "../apps/vscode-extension/src/agent-adapters.js";
import { AgentIntegrationManager, IntegrationError, POSIX_LAUNCHER, connectPrompt, disconnectPrompt, installHookRuntime, integrationPaths, managedHooks, ownershipTest,
  planConnect, planDisconnect, preservesUnrelated, serializeLike, statusSummary, type IntegrationEnvironment } from "../apps/vscode-extension/src/agent-integrations.js";
import { AGENT_STATE_MAX_AGE_MS, inboxPaths, markSignal } from "../apps/vscode-extension/src/agent-inbox.js";
import { EXTERNAL_CHANGES_MESSAGE, agentRows, type AgentIntegrationView, type SidebarState } from "../apps/vscode-extension/src/sidebar-model.js";

const roots: string[] = [];
const posixOnly = process.platform === "win32" ? it.skip : it;
const unprivileged = process.platform === "win32" || process.getuid?.() === 0 ? it.skip : it;
afterEach(() => {
  for (const root of roots.splice(0)) {
    spawnSync("chmod", ["-R", "u+rwX", root]);
    rmSync(root, { recursive: true, force: true });
  }
});

/** Isolated homes: nothing here can reach the developer's real agent settings. The
 * path deliberately contains a space and an apostrophe. */
function sandbox(options: { claude?: boolean; codex?: boolean; path?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "stack stats it's-"));
  roots.push(root);
  const home = join(root, "home");
  const env = { STACK_STATS_HOME: join(home, ".stackstats"), CLAUDE_CONFIG_DIR: join(home, ".claude"), CODEX_HOME: join(home, ".codex"), PATH: options.path ?? join(root, "empty-bin") };
  mkdirSync(home);
  if (options.claude !== false) mkdirSync(env.CLAUDE_CONFIG_DIR);
  if (options.codex !== false) mkdirSync(env.CODEX_HOME);
  const environment: IntegrationEnvironment = { platform: process.platform, home, env };
  const bundled = join(root, "bundled-hook.cjs");
  writeFileSync(bundled, "// bundled hook\n");
  const settings: Record<HookTool, boolean> = { "claude-code": false, codex: false };
  const connected: Partial<Record<HookTool, number>> = {};
  const extensions = new Set<HookTool>();
  const clock = { now: 1_800_000_000_000, syncs: 0 };
  const manager = new AgentIntegrationManager({ environment, bundledHook: bundled, runtime: process.execPath,
    enabled: (tool) => settings[tool], setEnabled: async (tool, on) => { settings[tool] = on; }, syncState: async () => { clock.syncs++; },
    editorExtension: (tool) => extensions.has(tool), connectedAt: (tool) => connected[tool],
    setConnectedAt: async (tool, at) => { if (at === undefined) delete connected[tool]; else connected[tool] = at; }, now: () => clock.now });
  const paths = integrationPaths(environment);
  const read = (tool: HookTool) => readFileSync(paths.config[tool], "utf8");
  return { root, home, env, environment, paths, manager, settings, connected, extensions, clock, read, json: (tool: HookTool) => JSON.parse(read(tool)) };
}
const userSettings = {
  model: "opus", env: { API_TOKEN: "sk-PRIVATE-VALUE" }, permissions: { allow: ["Bash(ls)"] },
  hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "~/bin/guard.sh" }] }], Stop: [{ hooks: [{ type: "command", command: "say done" }] }] },
  statusLine: { type: "command", command: "~/bin/status.sh" }
};
const rejection = async (promise: Promise<unknown>) => { try { await promise; } catch (error) { return error as IntegrationError; } throw new Error("expected a rejection"); };

describe("agent integration detection and status", () => {
  it("reports Not detected without evidence, and Available from a config directory, CLI or editor extension", async () => {
    const empty = sandbox({ claude: false, codex: false });
    expect((await empty.manager.statuses()).map((status) => status.state)).toEqual(["not_detected", "not_detected"]);
    empty.extensions.add("codex");
    expect((await empty.manager.status("codex")).state).toBe("available");
    const bin = join(empty.root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "claude"), "#!/bin/sh\n", { mode: 0o755 });
    empty.env.PATH = bin;
    expect((await empty.manager.status("claude-code")).state).toBe(process.platform === "win32" ? "not_detected" : "available");
    const withDirectories = sandbox();
    expect((await withDirectories.manager.statuses()).map((status) => [status.state, status.enabled, status.hooks.owned])).toEqual([["available", false, 0], ["available", false, 0]]);
    // Detection never creates anything.
    expect(existsSync(withDirectories.env.STACK_STATS_HOME)).toBe(false);
    expect(readdirSync(withDirectories.env.CLAUDE_CONFIG_DIR)).toEqual([]);
  });

  it("derives status from the real configuration, not from the setting alone", async () => {
    const s = sandbox();
    s.settings["claude-code"] = true;
    expect(await s.manager.status("claude-code")).toMatchObject({ state: "needs_attention", problem: expect.stringContaining("missing") });
    await s.manager.connect("claude-code");
    expect((await s.manager.status("claude-code")).state).toBe("connected");
    s.settings["claude-code"] = false;
    expect(await s.manager.status("claude-code")).toMatchObject({ state: "needs_attention", problem: expect.stringContaining("Paused") });
    s.settings["claude-code"] = true;
    rmSync(s.paths.launcher);
    expect(await s.manager.status("claude-code")).toMatchObject({ state: "needs_attention", problem: expect.stringContaining("runtime") });
    await s.manager.installRuntime();
    const config = s.json("claude-code");
    delete config.hooks.SessionEnd;
    writeFileSync(s.paths.config["claude-code"], JSON.stringify(config, null, 2));
    expect(await s.manager.status("claude-code")).toMatchObject({ state: "needs_attention", hooks: { owned: 5, exact: 5, expected: 6 } });
    expect(await s.manager.previewConnect("claude-code")).toMatchObject({ changed: true, added: 1, updated: 0 });
    await s.manager.connect("claude-code");
    expect((await s.manager.status("claude-code")).state).toBe("connected");
    config.disableAllHooks = true;
    config.hooks = s.json("claude-code").hooks;
    writeFileSync(s.paths.config["claude-code"], JSON.stringify(config, null, 2));
    expect(await s.manager.status("claude-code")).toMatchObject({ state: "needs_attention", problem: expect.stringContaining("disableAllHooks") });
  });

  it("keeps connected and verified separate: verified needs a signal after connecting", async () => {
    const s = sandbox();
    await s.manager.connect("claude-code");
    expect(await s.manager.status("claude-code")).toMatchObject({ state: "connected", verified: false, approvalPending: false });
    mkdirSync(inboxPaths(s.env.STACK_STATS_HOME).directory, { recursive: true });
    markSignal(s.env.STACK_STATS_HOME, "claude-code", s.clock.now - 60_000);
    expect((await s.manager.status("claude-code")).verified).toBe(false);
    markSignal(s.env.STACK_STATS_HOME, "claude-code", s.clock.now + 5_000);
    const status = await s.manager.status("claude-code");
    expect(status).toMatchObject({ state: "connected", verified: true, lastSignalAt: s.clock.now + 5_000 });
    expect(statusSummary(status, s.clock.now + 65_000)).toBe("Connected · last activity 1m ago");
  });
});

describe("Claude Code one-click connect", () => {
  it("merges only Stack Stats entries, keeps formatting, installs the runtime and enables the setting", async () => {
    const s = sandbox();
    const original = `${JSON.stringify(userSettings, null, 4)}\n`;
    writeFileSync(s.paths.config["claude-code"], original, { mode: 0o644 });
    const preview = await s.manager.previewConnect("claude-code");
    expect(preview).toMatchObject({ changed: true, createsFile: false, added: 6, updated: 0, removed: 0, shifted: 0 });
    const status = await s.manager.connect("claude-code");
    expect(status).toMatchObject({ state: "connected", enabled: true, runtimeReady: true, verified: false });
    expect(s.settings["claude-code"]).toBe(true);
    expect(s.clock.syncs).toBeGreaterThan(0);
    expect(s.connected["claude-code"]).toBe(s.clock.now);
    const text = s.read("claude-code"), config = JSON.parse(text);
    expect(text.startsWith('{\n    "model"')).toBe(true);
    expect(text.endsWith("}\n")).toBe(true);
    expect(statSync(s.paths.config["claude-code"]).mode & 0o777).toBe(0o644);
    expect(Object.keys(config)).toEqual(Object.keys(userSettings));
    expect({ ...config, hooks: undefined }).toEqual({ ...userSettings, hooks: undefined });
    expect(config.hooks.PreToolUse).toEqual(userSettings.hooks.PreToolUse);
    expect(config.hooks.Stop[0]).toEqual(userSettings.hooks.Stop[0]);
    const wanted = managedHooks("claude-code", s.environment);
    for (const hook of wanted) expect(config.hooks[hook.event].at(-1)).toEqual({ ...(hook.matcher ? { matcher: hook.matcher } : {}), hooks: [hook.handler] });
    expect(JSON.stringify(config.hooks)).not.toMatch(/UserPromptSubmit|\/node"/);
    expect(readFileSync(s.paths.launcher, "utf8")).toBe(POSIX_LAUNCHER);
    expect(readFileSync(s.paths.runtimeFile, "utf8")).toBe(`${process.execPath}\n`);
    expect(existsSync(s.paths.hookScript)).toBe(true);
    const backup = join(s.paths.backups, "claude-code-settings.json.bak");
    expect(readFileSync(backup, "utf8")).toBe(original);
    expect(statSync(backup).mode & 0o077).toBe(0);
  });

  it("is idempotent: a second connect changes nothing on disk", async () => {
    const s = sandbox();
    writeFileSync(s.paths.config["claude-code"], JSON.stringify(userSettings, null, 2));
    await s.manager.connect("claude-code");
    const text = s.read("claude-code"), mtime = statSync(s.paths.config["claude-code"]).mtimeMs;
    expect(await s.manager.previewConnect("claude-code")).toMatchObject({ changed: false, added: 0, updated: 0, removed: 0 });
    await s.manager.connect("claude-code");
    expect(s.read("claude-code")).toBe(text);
    expect(statSync(s.paths.config["claude-code"]).mtimeMs).toBe(mtime);
    expect(planConnect(JSON.parse(text), managedHooks("claude-code", s.environment), ownershipTest("claude-code", s.environment), "x").changed).toBe(false);
  });

  it("creates settings.json when Claude Code has none yet", async () => {
    const s = sandbox();
    expect(await s.manager.previewConnect("claude-code")).toMatchObject({ createsFile: true, added: 6 });
    await s.manager.connect("claude-code");
    expect(Object.keys(s.json("claude-code"))).toEqual(["hooks"]);
    expect(statSync(s.paths.config["claude-code"]).mode & 0o077).toBe(0);
  });

  it("disconnect removes only Stack Stats entries and restores the original bytes", async () => {
    const s = sandbox();
    const original = `${JSON.stringify(userSettings, null, 2)}\n`;
    writeFileSync(s.paths.config["claude-code"], original);
    await s.manager.connect("claude-code");
    expect(await s.manager.previewDisconnect("claude-code")).toMatchObject({ changed: true, removed: 6, shifted: 0 });
    const status = await s.manager.disconnect("claude-code");
    expect(s.read("claude-code")).toBe(original);
    expect(status).toMatchObject({ state: "available", enabled: false });
    expect(s.settings["claude-code"]).toBe(false);
    expect(s.connected["claude-code"]).toBeUndefined();
    // Local history and the inbox are not Disconnect's to delete.
    expect(existsSync(s.paths.hookScript)).toBe(true);
    const bare = sandbox();
    writeFileSync(bare.paths.config["claude-code"], '{\n  "model": "opus"\n}\n');
    await bare.manager.connect("claude-code");
    await bare.manager.disconnect("claude-code");
    expect(bare.read("claude-code")).toBe('{\n  "model": "opus"\n}\n');
  });

  it("refuses malformed JSON without touching the file, and never echoes its contents", async () => {
    const s = sandbox();
    const broken = '{\n  "model": "opus",\n  "env": { "API_TOKEN": "sk-PRIVATE-VALUE" }\n  "hooks": {}\n}\n';
    writeFileSync(s.paths.config["claude-code"], broken);
    const status = await s.manager.status("claude-code");
    expect(status).toMatchObject({ state: "error", problem: expect.stringContaining("line 4") });
    expect(status.problem).not.toContain("PRIVATE");
    const error = await rejection(s.manager.connect("claude-code"));
    expect(error).toBeInstanceOf(IntegrationError);
    expect(error.code).toBe("malformed");
    expect(error.message).not.toContain("PRIVATE");
    expect(s.read("claude-code")).toBe(broken);
    expect(s.settings["claude-code"]).toBe(false);
    expect(existsSync(s.paths.backups)).toBe(false);
    writeFileSync(s.paths.config["claude-code"], '{ "hooks": [] }');
    expect((await rejection(s.manager.connect("claude-code"))).code).toBe("structure");
    writeFileSync(s.paths.config["claude-code"], "[1, 2]");
    expect((await rejection(s.manager.connect("claude-code"))).code).toBe("structure");
  });

  unprivileged("respects a read-only file and an unwritable directory; the setting is rolled back", async () => {
    const s = sandbox();
    writeFileSync(s.paths.config["claude-code"], JSON.stringify(userSettings));
    chmodSync(s.paths.config["claude-code"], 0o444);
    expect((await rejection(s.manager.connect("claude-code"))).code).toBe("read_only");
    expect(s.read("claude-code")).toBe(JSON.stringify(userSettings));
    expect(s.settings["claude-code"]).toBe(false);
    const locked = sandbox();
    chmodSync(locked.env.CLAUDE_CONFIG_DIR, 0o555);
    expect((await rejection(locked.manager.connect("claude-code"))).code).toBe("permission");
    expect(readdirSync(locked.env.CLAUDE_CONFIG_DIR)).toEqual([]);
    expect(locked.settings["claude-code"]).toBe(false);
    // Disconnect still stops recording even when the file cannot be edited.
    const stuck = sandbox();
    await stuck.manager.connect("claude-code");
    chmodSync(stuck.paths.config["claude-code"], 0o444);
    expect((await rejection(stuck.manager.disconnect("claude-code"))).code).toBe("read_only");
    expect(stuck.settings["claude-code"]).toBe(false);
  });

  it("upgrades Phase 9E manual entries in place, removes duplicates and keeps look-alike user hooks", async () => {
    const s = sandbox();
    const script = s.paths.hookScript;
    const legacy = (runtime: string) => ({ type: "command", command: runtime, args: [script, "claude-code"], timeout: 5 });
    const lookAlike = { type: "command", command: "node", args: ["/Users/someone/my-hooks/stack-stats-agent-hook-v1.cjs", "claude-code"] };
    const lookAlikeString = { type: "command", command: `node "${script}" claude-code` };
    writeFileSync(s.paths.config["claude-code"], JSON.stringify({ hooks: {
      SessionStart: [{ hooks: [legacy("/usr/local/bin/node")] }],
      PostToolUse: [{ matcher: "Bash|Edit|Write|MultiEdit|NotebookEdit", hooks: [legacy("/usr/local/bin/node")] }, { matcher: "Write", hooks: [{ type: "command", command: "prettier --write" }] }],
      Stop: [{ hooks: [{ type: "command", command: `ELECTRON_RUN_AS_NODE=1 "/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)" "${script}" claude-code`, timeout: 5 },
        { type: "command", command: "say done" }] }, { hooks: [legacy("/opt/homebrew/bin/node")] }],
      Notification: [{ hooks: [lookAlike, lookAlikeString] }]
    } }, null, 2));
    expect(await s.manager.status("claude-code")).toMatchObject({ state: "needs_attention", hooks: { owned: 4, exact: 0 } });
    const preview = await s.manager.previewConnect("claude-code");
    expect(preview).toMatchObject({ updated: 3, removed: 1, added: 3, shifted: 0 });
    expect(connectPrompt(preview, "Claude Code").confirm).toBe("Connect");
    await s.manager.connect("claude-code");
    const hooks = s.json("claude-code").hooks, wanted = new Map(managedHooks("claude-code", s.environment).map((hook) => [hook.event, hook.handler]));
    expect(hooks.SessionStart).toEqual([{ hooks: [wanted.get("SessionStart")] }]);
    expect(hooks.PostToolUse[0].hooks).toEqual([wanted.get("PostToolUse")]);
    expect(hooks.PostToolUse[1]).toEqual({ matcher: "Write", hooks: [{ type: "command", command: "prettier --write" }] });
    expect(hooks.Stop).toEqual([{ hooks: [wanted.get("Stop"), { type: "command", command: "say done" }] }]);
    expect(hooks.Notification).toEqual([{ hooks: [lookAlike, lookAlikeString] }]);
    expect((await s.manager.status("claude-code")).state).toBe("connected");
    await s.manager.disconnect("claude-code");
    expect(s.json("claude-code").hooks).toEqual({ PostToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "prettier --write" }] }],
      Stop: [{ hooks: [{ type: "command", command: "say done" }] }], Notification: [{ hooks: [lookAlike, lookAlikeString] }] });
  });

  posixOnly("edits a symlinked settings file at its real location and keeps the link", async () => {
    const s = sandbox();
    const dotfiles = join(s.root, "dotfiles");
    mkdirSync(dotfiles);
    writeFileSync(join(dotfiles, "settings.json"), '{ "model": "opus" }');
    symlinkSync(join(dotfiles, "settings.json"), s.paths.config["claude-code"]);
    await s.manager.connect("claude-code");
    expect(lstatSync(s.paths.config["claude-code"]).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(join(dotfiles, "settings.json"), "utf8")).model).toBe("opus");
    expect((await s.manager.status("claude-code")).state).toBe("connected");
    const dangling = sandbox();
    symlinkSync(join(dangling.root, "missing.json"), dangling.paths.config["claude-code"]);
    expect((await rejection(dangling.manager.connect("claude-code"))).code).toBe("io");
    expect(lstatSync(dangling.paths.config["claude-code"]).isSymbolicLink()).toBe(true);
  });
});

describe("Codex one-click connect", () => {
  const userHooks = { hooks: { Stop: [{ hooks: [{ type: "command", command: "notify-send done", timeout: 3 }] }] } };

  it("appends string-command entries after the user's hooks and waits for approval in Codex", async () => {
    const s = sandbox();
    writeFileSync(s.paths.config.codex, JSON.stringify(userHooks, null, 2));
    const preview = await s.manager.previewConnect("codex");
    expect(preview).toMatchObject({ added: 6, shifted: 0 });
    expect(connectPrompt(preview, "Codex").detail).toContain("approve the Stack Stats hooks");
    const status = await s.manager.connect("codex");
    expect(status).toMatchObject({ state: "connected", verified: false, approvalPending: true });
    expect(statusSummary(status)).toBe("Hooks installed · approve them in Codex");
    const hooks = s.json("codex").hooks;
    expect(hooks.Stop[0]).toEqual(userHooks.hooks.Stop[0]);
    for (const { event, handler } of managedHooks("codex", s.environment)) {
      expect(hooks[event].at(-1).hooks).toEqual([handler]);
      expect(handler).not.toHaveProperty("args");
      if (process.platform !== "win32") expect(handler.command).toBe(`/bin/sh '${s.paths.launcher.replace(/'/g, "'\\''")}' codex`);
    }
    // A Codex signal after connecting proves the user approved the hooks.
    s.clock.now += 1_000;
    mkdirSync(inboxPaths(s.env.STACK_STATS_HOME).directory, { recursive: true });
    markSignal(s.env.STACK_STATS_HOME, "codex", s.clock.now);
    expect(await s.manager.status("codex")).toMatchObject({ state: "connected", verified: true, approvalPending: false });
    const text = s.read("codex");
    await s.manager.connect("codex");
    expect(s.read("codex")).toBe(text);
  });

  it("warns that removing its hooks moves later user hooks, then removes only its own", async () => {
    const s = sandbox();
    writeFileSync(s.paths.config.codex, JSON.stringify(userHooks, null, 2));
    await s.manager.connect("codex");
    const config = s.json("codex");
    config.hooks.Stop.push({ hooks: [{ type: "command", command: "echo later" }] });
    writeFileSync(s.paths.config.codex, JSON.stringify(config, null, 2));
    const preview = await s.manager.previewDisconnect("codex");
    expect(preview).toMatchObject({ removed: 6, shifted: 1 });
    expect(disconnectPrompt(preview, "Codex").detail).toContain("approve 1 other hook listed after Stack Stats again");
    await s.manager.disconnect("codex");
    expect(s.json("codex")).toEqual({ hooks: { Stop: [userHooks.hooks.Stop[0], { hooks: [{ type: "command", command: "echo later" }] }] } });
    expect(s.settings.codex).toBe(false);
  });

  it("fails safely on a malformed hooks.json", async () => {
    const s = sandbox();
    writeFileSync(s.paths.config.codex, '{ "hooks": { "Stop": [ }');
    expect((await s.manager.status("codex")).state).toBe("error");
    expect((await rejection(s.manager.connect("codex"))).code).toBe("malformed");
    expect(s.read("codex")).toBe('{ "hooks": { "Stop": [ }');
    expect(s.settings.codex).toBe(false);
  });

  it("never edits config.toml, but flags Stack Stats entries found there", async () => {
    const s = sandbox();
    const toml = `model = "gpt-5"\n\n[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = '"/usr/local/bin/node" "${s.paths.hookScript}" codex'\n`;
    writeFileSync(s.paths.codexToml, toml);
    expect(await s.manager.status("codex")).toMatchObject({ state: "needs_attention", problem: expect.stringContaining("config.toml") });
    await s.manager.connect("codex");
    await s.manager.disconnect("codex");
    expect(readFileSync(s.paths.codexToml, "utf8")).toBe(toml);
  });
});

describe("planning, formatting and ownership", () => {
  const environment: IntegrationEnvironment = { platform: "darwin", home: "/Users/a b", env: {} };
  const owned = ownershipTest("claude-code", environment), wanted = managedHooks("claude-code", environment);

  it("round-trips connect → disconnect for arbitrary unrelated content, and detects drift", () => {
    const before = { a: 1, hooks: { PreToolUse: [{ matcher: "x", hooks: [] }], Weird: "keep" }, z: [1, { b: 2 }] };
    const connected = planConnect(before, wanted, owned, "f").root;
    expect(preservesUnrelated(before, connected, owned)).toBe(true);
    expect(planDisconnect(connected, owned, "f").root).toEqual(before);
    expect(preservesUnrelated(before, { ...connected, a: 2 }, owned)).toBe(false);
    // A pre-existing *empty* event list Stack Stats filled is removed with its entry
    // on disconnect: semantically identical, and the only non-byte-exact case.
    const empty = { hooks: { Stop: [] } };
    const roundTrip = planDisconnect(planConnect(empty, wanted, owned, "f").root, owned, "f").root;
    expect(roundTrip).toEqual({});
    expect(preservesUnrelated(empty, roundTrip, owned)).toBe(true);
  });

  it("preserves indentation, CRLF, BOM, minified style and a missing final newline", () => {
    expect(serializeLike({ a: 1 }, "\uFEFF{\r\n\t\"a\": 0\r\n}")).toBe("\uFEFF{\r\n\t\"a\": 1\r\n}");
    expect(serializeLike({ a: 1 }, '{"a":0}')).toBe('{"a":1}');
    expect(serializeLike({ a: 1 }, "")).toBe('{\n  "a": 1\n}\n');
    expect(serializeLike({ a: 1 }, "{}\n")).toBe('{\n  "a": 1\n}\n');
  });

  it("builds Windows entries with PowerShell and path quoting, no shell-less .cmd and no Node path", () => {
    const windows: IntegrationEnvironment = { platform: "win32", home: "C:\\Users\\A B", env: { SystemRoot: "C:\\Windows" } };
    const paths = integrationPaths(windows);
    expect(paths.launcher).toBe("C:\\Users\\A B\\.stackstats\\hooks\\stack-stats-hook-v1.ps1");
    expect(paths.config.codex).toBe("C:\\Users\\A B\\.codex\\hooks.json");
    const claude = managedHooks("claude-code", windows)[0]!.handler;
    expect(claude).toEqual({ type: "command", command: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", paths.launcher, "claude-code"], timeout: 5 });
    const codex = managedHooks("codex", windows);
    expect(codex[0]!.handler.command).toBe(`powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${paths.launcher}" codex`);
    expect(Math.min(...codex.map((hook) => hook.handler.timeout as number))).toBe(3);
    expect(integrationPaths({ ...windows, env: { CODEX_HOME: "D:\\codex" } }).config.codex).toBe("D:\\codex\\hooks.json");
  });

  it("never exposes vendor settings through status, and confirmation copy states the privacy limits", async () => {
    const s = sandbox();
    writeFileSync(s.paths.config["claude-code"], JSON.stringify(userSettings));
    await s.manager.connect("claude-code");
    expect(JSON.stringify(await s.manager.statuses())).not.toMatch(/PRIVATE|guard\.sh|status\.sh/);
    const detail = connectPrompt(await s.manager.previewConnect("claude-code"), "Claude Code").detail;
    expect(detail).toContain("never reports prompts, responses, source code, commands or command output");
    expect(detail).toContain("never synced");
    expect(s.manager.manualSetup("codex").snippet).not.toMatch(/UserPromptSubmit|bin\/node/);
    // The manager has no path to sync, accounts or the network.
    const source = readFileSync(resolve("apps/vscode-extension/src/agent-integrations.ts"), "utf8");
    expect(source).not.toMatch(/from "\.\/(?:profile-sync|delivery|account-service|vscode-account|telemetry-[a-z]+)\.js"|node:https?|fetch\(/);
  });
});

describe("sidebar Agents panel", () => {
  const base = { summary: {} as SidebarState["summary"], enabled: true, ready: true, refreshing: false, historyError: false, storageError: false, idleMinutes: 5, syncConfigured: false };
  const view = (state: AgentIntegrationView["state"], extra: Partial<AgentIntegrationView> = {}): AgentIntegrationView => ({ tool: "claude-code", displayName: "Claude Code", state, verified: false, approvalPending: false, ...extra });

  it("says external changes are tracked with no setup, and offers only applicable actions", () => {
    const rows = agentRows({ ...base, agents: { external: "tracked", integrations: [view("available"), { ...view("not_detected"), tool: "codex", displayName: "Codex" }] } }, 0);
    expect(rows[0]).toMatchObject({ label: "External changes", description: "Tracked automatically", tooltip: expect.stringContaining(EXTERNAL_CHANGES_MESSAGE) });
    expect(rows[1]!.children).toEqual([expect.objectContaining({ label: "Connect Claude Code", command: "stackStats.connectAgent", arguments: ["claude-code"] })]);
    expect(rows[2]).toMatchObject({ description: "Not detected" });
    expect(rows[2]!.children).toBeUndefined();
    const connected = agentRows({ ...base, agents: { external: "tracked", integrations: [view("connected"), { ...view("connected", { approvalPending: true }), tool: "codex", displayName: "Codex" }] } }, 0);
    expect(connected[1]!.children!.map((row) => row.label)).toEqual(["Last activity", "Disconnect"]);
    expect(connected[1]!.children![0]!.description).toBe("No activity received yet");
    expect(connected[2]).toMatchObject({ description: "Approve in Codex" });
    expect(agentRows({ ...base, enabled: false }, 0)[0]!.description).toBe("Paused");
  });
});

describe("hook launcher and hook runtime", () => {
  function launcherHome(tools: Partial<Record<HookTool, boolean>>, updatedAt = new Date().toISOString(), collecting = true) {
    const s = sandbox();
    const state = { stateVersion: 1, collecting, integrations: { "claude-code": false, codex: false, ...tools }, excludeFiles: [], updatedAt };
    mkdirSync(inboxPaths(s.env.STACK_STATS_HOME).directory, { recursive: true });
    writeFileSync(inboxPaths(s.env.STACK_STATS_HOME).state, JSON.stringify(state));
    return s;
  }
  const probe = `const fs = require("node:fs"); let input = ""; process.stdin.on("data", (d) => input += d).on("end", () => {
    fs.writeFileSync(require("node:path").join(process.env.STACK_STATS_HOME, "ran.json"), JSON.stringify({ tool: process.argv[2], input, home: process.env.STACK_STATS_HOME, electron: process.env.ELECTRON_RUN_AS_NODE }));
    process.stdout.write("must not reach the agent"); });`;
  const run = (s: ReturnType<typeof sandbox>, args: string[], env: Record<string, string> = { PATH: "/usr/bin:/bin" }) =>
    spawnSync("/bin/sh", args, { input: '{"hook_event_name":"Stop"}', env, encoding: "utf8", timeout: 20_000 });
  const ran = (s: ReturnType<typeof sandbox>) => { try { return JSON.parse(readFileSync(join(s.env.STACK_STATS_HOME, "ran.json"), "utf8")); } catch { return undefined; } };

  posixOnly("runs the recorded runtime with stdin, pins STACK_STATS_HOME, prints nothing and exits 0", async () => {
    const s = launcherHome({ "claude-code": true });
    writeFileSync(join(s.root, "probe.cjs"), probe);
    await installHookRuntime(s.paths, process.platform, join(s.root, "probe.cjs"), process.execPath);
    const result = run(s, [s.paths.launcher, "claude-code"], { PATH: "/usr/bin:/bin", STACK_STATS_HOME: "/somewhere/else" });
    expect(result).toMatchObject({ status: 0, stdout: "", stderr: "" });
    expect(ran(s)).toEqual({ tool: "claude-code", input: '{"hook_event_name":"Stop"}', home: s.env.STACK_STATS_HOME, electron: "1" });
  });

  posixOnly("does nothing when disconnected, paused, missing state or given an unknown tool", async () => {
    for (const s of [launcherHome({ codex: true }), launcherHome({ "claude-code": true }, undefined, false)]) {
      writeFileSync(join(s.root, "probe.cjs"), probe);
      await installHookRuntime(s.paths, process.platform, join(s.root, "probe.cjs"), process.execPath);
      expect(run(s, [s.paths.launcher, "claude-code"])).toMatchObject({ status: 0, stdout: "", stderr: "" });
      expect(run(s, [s.paths.launcher, "cursor"])).toMatchObject({ status: 0, stdout: "" });
      expect(ran(s)).toBeUndefined();
    }
    const s = launcherHome({ "claude-code": true });
    writeFileSync(join(s.root, "probe.cjs"), probe);
    await installHookRuntime(s.paths, process.platform, join(s.root, "probe.cjs"), process.execPath);
    rmSync(inboxPaths(s.env.STACK_STATS_HOME).state);
    expect(run(s, [s.paths.launcher, "claude-code"])).toMatchObject({ status: 0, stdout: "" });
    expect(ran(s)).toBeUndefined();
  });

  posixOnly("falls back to node on PATH when the recorded editor runtime is gone, and exits quietly with neither", async () => {
    const s = launcherHome({ codex: true });
    writeFileSync(join(s.root, "probe.cjs"), probe);
    await installHookRuntime(s.paths, process.platform, join(s.root, "probe.cjs"), "/nonexistent/Code Helper");
    const command = managedHooks("codex", s.environment)[0]!.handler.command as string;
    expect(run(s, ["-c", command])).toMatchObject({ status: 0, stdout: "", stderr: "" });
    expect(ran(s)).toBeUndefined();
    const withNode = run(s, ["-c", command], { PATH: `${dirname(process.execPath)}:/usr/bin:/bin` });
    expect(withNode).toMatchObject({ status: 0, stdout: "", stderr: "" });
    expect(ran(s)).toMatchObject({ tool: "codex", input: '{"hook_event_name":"Stop"}' });
  });

  posixOnly("runs the real bundled hook end to end: record, activity mark, stale-state fail-closed", async () => {
    const s = launcherHome({ "claude-code": true });
    const bundle = join(s.root, "agent-hook.cjs");
    const esbuild = createRequire(resolve("apps/vscode-extension/package.json"))("esbuild") as { buildSync(options: Record<string, unknown>): unknown };
    esbuild.buildSync({ entryPoints: [resolve("apps/vscode-extension/src/agent-hook.ts")], bundle: true, platform: "node", target: "node18", format: "cjs", outfile: bundle, logLevel: "silent" });
    await installHookRuntime(s.paths, process.platform, bundle, process.execPath);
    const handler = managedHooks("claude-code", s.environment).find((hook) => hook.event === "PostToolUse")!.handler as { command: string; args: string[] };
    const payload = JSON.stringify({ session_id: "private-session", cwd: "/work/project", prompt_id: "private-turn", hook_event_name: "PostToolUse", tool_name: "Edit", tool_use_id: "toolu_x",
      duration_ms: 3, tool_input: { file_path: "/work/project/a.ts", old_string: "PRIVATE_OLD", new_string: "PRIVATE_NEW" }, tool_response: { structuredPatch: [{ lines: ["-PRIVATE_OLD", "+PRIVATE_NEW"] }] } });
    const result = spawnSync(handler.command, handler.args, { input: payload, env: { PATH: "/usr/bin:/bin" }, encoding: "utf8", timeout: 20_000 });
    expect(result).toMatchObject({ status: 0, stdout: "", stderr: "" });
    const records = readdirSync(inboxPaths(s.env.STACK_STATS_HOME).records);
    expect(records).toHaveLength(1);
    const record = readFileSync(join(inboxPaths(s.env.STACK_STATS_HOME).records, records[0]!), "utf8");
    expect(JSON.parse(record)).toMatchObject({ tool: "claude-code", signal: "tool_finished", files: [{ path: "/work/project/a.ts", linesAdded: 1, linesRemoved: 1 }] });
    expect(record).not.toMatch(/PRIVATE|private-session|private-turn/);
    expect((await s.manager.status("claude-code")).lastSignalAt).toBeGreaterThan(0);
    // A state file older than the refresh window means the extension is gone: fail closed.
    const stale = launcherHome({ "claude-code": true }, new Date(Date.now() - AGENT_STATE_MAX_AGE_MS - 60_000).toISOString());
    await installHookRuntime(stale.paths, process.platform, bundle, process.execPath);
    expect(spawnSync(handler.command, [stale.paths.launcher, "claude-code"], { input: payload, env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" })).toMatchObject({ status: 0, stdout: "" });
    expect(existsSync(inboxPaths(stale.env.STACK_STATS_HOME).records)).toBe(false);
  });

  it("the uninstall hook pauses only Stack Stats' own state", () => {
    const s = launcherHome({ "claude-code": true });
    writeFileSync(s.paths.config["claude-code"], '{ "keep": true }');
    const result = spawnSync(process.execPath, ["--import", "tsx", resolve("apps/vscode-extension/src/uninstall.ts")], { env: { ...process.env, STACK_STATS_HOME: s.env.STACK_STATS_HOME }, encoding: "utf8", timeout: 20_000 });
    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(inboxPaths(s.env.STACK_STATS_HOME).state, "utf8"))).toMatchObject({ collecting: false, integrations: { "claude-code": true } });
    expect(s.read("claude-code")).toBe('{ "keep": true }');
    const none = sandbox();
    spawnSync(process.execPath, ["--import", "tsx", resolve("apps/vscode-extension/src/uninstall.ts")], { env: { ...process.env, STACK_STATS_HOME: none.env.STACK_STATS_HOME }, timeout: 20_000 });
    expect(existsSync(none.env.STACK_STATS_HOME)).toBe(false);
  });
});

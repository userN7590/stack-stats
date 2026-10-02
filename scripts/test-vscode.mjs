import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";

// Uses an existing VS Code installation and isolated user data, extensions and
// workspace. No marketplace downloads or changes to the developer's editor profile.
const executable = process.env.VSCODE_EXECUTABLE ?? (process.platform === "darwin"
  ? "/Applications/Visual Studio Code.app/Contents/MacOS/Code" : "code");
const root = await mkdtemp(join(tmpdir(), "stack-stats-vscode-"));
const authOnly = process.argv.includes("--auth-only");
await mkdir(join(root, "workspace"));
await writeFile(join(root, "workspace", "sample.ts"), "");
// Agent configuration is isolated too: the extension never reads or writes the
// developer's real Claude Code or Codex settings during a smoke run.
const env = { ...process.env, STACK_STATS_SMOKE_DIR: root, STACK_STATS_HOME: join(root, "daemon"), CLAUDE_CONFIG_DIR: join(root, "claude"), CODEX_HOME: join(root, "codex") };
if (authOnly) {
  const port = await new Promise((done, fail) => {
    const server = createServer().once("error", fail).listen(0, "127.0.0.1", () => {
      const { port } = server.address(); server.close(() => done(port));
    });
  });
  env.STACK_STATS_AUTH_ORIGIN = `http://127.0.0.1:${port}`;
  const manifest = JSON.parse(await readFile(resolve("apps/vscode-extension/package.json"), "utf8"));
  const extensionId = `${manifest.publisher ?? "undefined_publisher"}.${manifest.name}`;
  await mkdir(join(root, "user-data", "User"), { recursive: true });
  // Trust only the tested URI handler in this throwaway profile, so the local
  // cancellation callback can return without a modal confirmation.
  await writeFile(join(root, "user-data", "User", "settings.json"), JSON.stringify({
    "extensions.confirmedUriHandlerExtensionIds": [extensionId.toLowerCase()]
  }));
  // --extensionTestsPath sets ExtensionMode.Test. The auth origin override is
  // deliberately limited to Development, so run a tiny development driver.
  await mkdir(join(root, "auth-driver"));
  await writeFile(join(root, "auth-driver", "package.json"), JSON.stringify({
    name: "stack-stats-auth-smoke", publisher: "stack-stats-test", version: "0.0.0",
    engines: { vscode: "^1.95.0" }, main: "./main.cjs", activationEvents: ["onStartupFinished"]
  }));
  await writeFile(join(root, "auth-driver", "main.cjs"), `exports.activate = async () => {
    try { await require(${JSON.stringify(resolve("tests/vscode-auth-smoke.cjs"))}).run(); }
    catch (error) { console.error(error); }
    finally { await require("vscode").commands.executeCommand("workbench.action.quit"); }
  };`);
}
delete env.ELECTRON_RUN_AS_NODE;
const args = [
  "--new-window", "--disable-extensions", "--skip-welcome", "--skip-release-notes", "--disable-workspace-trust",
  "--user-data-dir", join(root, "user-data"), "--extensions-dir", join(root, "extensions"),
  `--extensionDevelopmentPath=${resolve("apps/vscode-extension")}`,
  ...(authOnly ? [`--extensionDevelopmentPath=${join(root, "auth-driver")}`]
    : [`--extensionTestsPath=${resolve(process.argv.includes("--api-only") ? "tests/vscode-api-smoke.cjs" : "tests/vscode-smoke.cjs")}`]), join(root, "workspace")
];
// LaunchServices brings the isolated macOS test window to the foreground. Direct
// spawning can leave it unfocused, which correctly prevents activity collection.
const macBundle = process.platform === "darwin" && executable.includes(".app/") ? executable.split(".app/")[0] + ".app" : undefined;
const child = macBundle ? spawn("/usr/bin/open", [
  "-n", "-W", "-a", macBundle, "--env", `STACK_STATS_SMOKE_DIR=${root}`,
  "--env", `STACK_STATS_HOME=${env.STACK_STATS_HOME}`, "--env", `CLAUDE_CONFIG_DIR=${env.CLAUDE_CONFIG_DIR}`, "--env", `CODEX_HOME=${env.CODEX_HOME}`,
  ...(authOnly ? ["--env", `STACK_STATS_AUTH_ORIGIN=${env.STACK_STATS_AUTH_ORIGIN}`] : []), "--args", ...args
], { env, stdio: "inherit" }) : spawn(executable, args, { env, stdio: "inherit" });
const timeout = setTimeout(() => child.kill(), 90_000);
child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.on("close", async (code) => {
  clearTimeout(timeout);
  const passed = await readFile(join(root, "passed"), "utf8").then((value) => value === "passed").catch(() => false);
  process.exitCode = code === 0 && passed ? 0 : 1;
  if (process.exitCode === 0) {
    if (authOnly) console.log(await readFile(join(root, "auth-results.json"), "utf8"));
    console.log("Real VS Code smoke test passed."); await rm(root, { recursive: true, force: true });
  }
  else {
    console.error(await readFile(join(root, "failed"), "utf8").catch(() => "VS Code did not complete the smoke test."));
    console.error(`VS Code smoke test failed; artifacts and editor logs: ${root}`);
  }
});

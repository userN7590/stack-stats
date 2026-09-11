import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

// Uses an existing VS Code installation and isolated user data, extensions and
// workspace. No marketplace downloads or changes to the developer's editor profile.
const executable = process.env.VSCODE_EXECUTABLE ?? (process.platform === "darwin"
  ? "/Applications/Visual Studio Code.app/Contents/MacOS/Code" : "code");
const root = await mkdtemp(join(tmpdir(), "stack-stats-vscode-"));
await mkdir(join(root, "workspace"));
await writeFile(join(root, "workspace", "sample.ts"), "");
const env = { ...process.env, STACK_STATS_SMOKE_DIR: root, STACK_STATS_HOME: join(root, "daemon") };
delete env.ELECTRON_RUN_AS_NODE;
const args = [
  "--new-window", "--disable-extensions", "--skip-welcome", "--skip-release-notes", "--disable-workspace-trust",
  "--user-data-dir", join(root, "user-data"), "--extensions-dir", join(root, "extensions"),
  `--extensionDevelopmentPath=${resolve("apps/vscode-extension")}`,
  `--extensionTestsPath=${resolve(process.argv.includes("--api-only") ? "tests/vscode-api-smoke.cjs" : "tests/vscode-smoke.cjs")}`, join(root, "workspace")
];
// LaunchServices brings the isolated macOS test window to the foreground. Direct
// spawning can leave it unfocused, which correctly prevents activity collection.
const macBundle = process.platform === "darwin" && executable.includes(".app/") ? executable.split(".app/")[0] + ".app" : undefined;
const child = macBundle ? spawn("/usr/bin/open", [
  "-n", "-W", "-a", macBundle, "--env", `STACK_STATS_SMOKE_DIR=${root}`,
  "--env", `STACK_STATS_HOME=${env.STACK_STATS_HOME}`, "--args", ...args
], { env, stdio: "inherit" }) : spawn(executable, args, { env, stdio: "inherit" });
const timeout = setTimeout(() => child.kill(), 90_000);
child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.on("close", async (code) => {
  clearTimeout(timeout);
  const passed = await readFile(join(root, "passed"), "utf8").then((value) => value === "passed").catch(() => false);
  process.exitCode = code === 0 && passed ? 0 : 1;
  if (process.exitCode === 0) { console.log("Real VS Code smoke test passed."); await rm(root, { recursive: true, force: true }); }
  else {
    console.error(await readFile(join(root, "failed"), "utf8").catch(() => "VS Code did not complete the smoke test."));
    console.error(`VS Code smoke test failed; artifacts and editor logs: ${root}`);
  }
});

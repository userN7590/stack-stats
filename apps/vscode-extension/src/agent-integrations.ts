import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, open, readFile, realpath, rename, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { agentAdapters, hookTools, type HookTool } from "./agent-adapters.js";
import { HOOK_SCRIPT_NAME, readSignal } from "./agent-inbox.js";
import { atomicWrite } from "./local-store.js";
import { exclusive } from "./exclusive.js";
import { formatAgo } from "./presentation.js";

/** One-click agent integrations (Phase 9E.1). Stack Stats adds, repairs and removes
 * ONLY its own hook entries: Claude Code user settings and Codex user hooks.json.
 * Vendor configuration is read solely to manage those entries; nothing from it is
 * logged, synced or uploaded (one local pre-change backup is kept, see §7 of the
 * phase doc). No VS Code dependency, so everything runs against temporary homes. */

export const LAUNCHER_POSIX = "stack-stats-hook-v1.sh";
export const LAUNCHER_WINDOWS = "stack-stats-hook-v1.ps1";
export const RUNTIME_FILE = "hook-runtime-v1";
/** Marketplace IDs of the vendors' own VS Code extensions (installation evidence). */
export const EDITOR_EXTENSIONS: Readonly<Record<HookTool, string>> = { "claude-code": "anthropic.claude-code", codex: "openai.chatgpt" };
const CLI_NAMES: Record<HookTool, string> = { "claude-code": "claude", codex: "codex" };
const MAX_CONFIG_BYTES = 4 * 1024 * 1024;
const POWERSHELL_ARGS = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"] as const;

export interface IntegrationEnvironment { platform: NodeJS.Platform; home: string; env: NodeJS.ProcessEnv }
export const currentEnvironment = (): IntegrationEnvironment => ({ platform: process.platform, home: homedir(), env: process.env });

export interface IntegrationPaths {
  stackStatsHome: string; hooks: string; launcher: string; runtimeFile: string; hookScript: string; lock: string; backups: string;
  configDirectory: Record<HookTool, string>; config: Record<HookTool, string>; codexToml: string;
}
/** Tool locations honour the vendors' own overrides (CLAUDE_CONFIG_DIR, CODEX_HOME)
 * and STACK_STATS_HOME; path syntax follows the target platform, not the host. */
export function integrationPaths({ platform, home, env }: IntegrationEnvironment): IntegrationPaths {
  const path = platform === "win32" ? win32 : posix;
  const stackStatsHome = env.STACK_STATS_HOME ?? path.join(home, ".stackstats");
  const hooks = path.join(stackStatsHome, "hooks");
  const claude = env.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude"), codex = env.CODEX_HOME ?? path.join(home, ".codex");
  return {
    stackStatsHome, hooks, launcher: path.join(hooks, platform === "win32" ? LAUNCHER_WINDOWS : LAUNCHER_POSIX), runtimeFile: path.join(hooks, RUNTIME_FILE),
    hookScript: path.join(hooks, HOOK_SCRIPT_NAME), lock: path.join(stackStatsHome, "integrations"), backups: path.join(stackStatsHome, "integrations", "backups"),
    configDirectory: { "claude-code": claude, codex }, config: { "claude-code": path.join(claude, "settings.json"), codex: path.join(codex, "hooks.json") },
    codexToml: path.join(codex, "config.toml")
  };
}
export const displayPath = (path: string, { platform, home }: IntegrationEnvironment) =>
  platform !== "win32" && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;

// ── Hook runtime ────────────────────────────────────────────────────────────────

/** POSIX launcher. The vendor entry runs `/bin/sh <launcher> <tool>`, so no exec bit,
 * shebang or globally installed Node is needed. It prefers the editor runtime the
 * extension last recorded (always present where the extension host runs; Electron
 * acts as Node under ELECTRON_RUN_AS_NODE) and falls back to `node` on PATH. The
 * state pre-check keeps disconnected/paused hooks at a shell's startup cost; the
 * hook re-validates everything. STACK_STATS_HOME is pinned to the launcher's own
 * home so the agent's environment cannot redirect records. */
export const POSIX_LAUNCHER = `#!/bin/sh
# Stack Stats agent hook launcher (v1). Managed by the Stack Stats VS Code extension;
# rewritten on upgrade. Prints nothing and always exits 0: it can never block or fail
# the calling agent. Remove Stack Stats hooks with "Stack Stats: Disconnect All Agent
# Integrations".
case "$1" in claude-code|codex) ;; *) exit 0 ;; esac
dir=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd) || exit 0
home=$(dirname -- "$dir")
script="$dir/${HOOK_SCRIPT_NAME}"
state="$home/agent-inbox-v1/state.json"
[ -f "$script" ] && [ -f "$state" ] || exit 0
contents=$(cat -- "$state" 2>/dev/null) || exit 0
case "$contents" in *'"collecting":true'*) ;; *) exit 0 ;; esac
case "$contents" in *"\\"$1\\":true"*) ;; *) exit 0 ;; esac
runtime=
[ -f "$dir/${RUNTIME_FILE}" ] && IFS= read -r runtime < "$dir/${RUNTIME_FILE}"
if [ -z "$runtime" ] || [ ! -x "$runtime" ]; then runtime=$(command -v node 2>/dev/null) || exit 0; fi
STACK_STATS_HOME="$home" ELECTRON_RUN_AS_NODE=1 "$runtime" "$script" "$1" >/dev/null 2>&1
exit 0
`;

/** Windows launcher (Windows PowerShell 5.1+, present on every supported Windows).
 * Standard input is copied as raw bytes so non-ASCII paths survive. */
export const WINDOWS_LAUNCHER = `# Stack Stats agent hook launcher (v1). Managed by the Stack Stats VS Code extension;
# rewritten on upgrade. Prints nothing and always exits 0.
param([string]$Tool)
try {
  if ($Tool -ne 'claude-code' -and $Tool -ne 'codex') { exit 0 }
  $dir = $PSScriptRoot
  $home_ = Split-Path -Parent $dir
  $script = Join-Path $dir '${HOOK_SCRIPT_NAME}'
  $state = Join-Path $home_ 'agent-inbox-v1\\state.json'
  if (-not (Test-Path -LiteralPath $script) -or -not (Test-Path -LiteralPath $state)) { exit 0 }
  $contents = [System.IO.File]::ReadAllText($state)
  if (-not $contents.Contains('"collecting":true') -or -not $contents.Contains('"' + $Tool + '":true')) { exit 0 }
  $runtime = $null
  $hint = Join-Path $dir '${RUNTIME_FILE}'
  if (Test-Path -LiteralPath $hint) { $runtime = [System.IO.File]::ReadAllLines($hint) | Select-Object -First 1 }
  if (-not $runtime -or -not (Test-Path -LiteralPath $runtime)) {
    $node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($node) { $runtime = $node.Source } else { exit 0 }
  }
  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = $runtime
  $info.Arguments = '"' + $script + '" ' + $Tool
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardInput = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $info.EnvironmentVariables['ELECTRON_RUN_AS_NODE'] = '1'
  $info.EnvironmentVariables['STACK_STATS_HOME'] = $home_
  $process = [System.Diagnostics.Process]::Start($info)
  $null = $process.StandardOutput.ReadToEndAsync()
  $null = $process.StandardError.ReadToEndAsync()
  [Console]::OpenStandardInput().CopyTo($process.StandardInput.BaseStream)
  $process.StandardInput.Close()
  $null = $process.WaitForExit(4500)
} catch { }
exit 0
`;

async function writeIfChanged(path: string, text: string): Promise<void> {
  if (await readFile(path, "utf8").catch(() => undefined) !== text) await atomicWrite(path, text);
}
/** Installs or refreshes everything the vendor entries point at: the bundled hook,
 * the version-stable launcher and the runtime hint. Vendor entries never change when
 * these do, so extension, editor and Node upgrades need no reconnect (and no Codex
 * re-approval). Content-identical files are not rewritten. */
export async function installHookRuntime(paths: IntegrationPaths, platform: NodeJS.Platform, bundledHook: string, runtime: string): Promise<void> {
  await mkdir(paths.hooks, { recursive: true, mode: 0o700 });
  await writeIfChanged(paths.hookScript, await readFile(bundledHook, "utf8"));
  await writeIfChanged(paths.launcher, platform === "win32" ? WINDOWS_LAUNCHER.replace(/\n/g, "\r\n") : POSIX_LAUNCHER);
  await writeIfChanged(paths.runtimeFile, `${runtime}\n`);
}

// ── Managed entries and ownership ───────────────────────────────────────────────

type Json = Record<string, unknown>;
export interface ManagedHook { event: string; matcher?: string; handler: Json }
const shQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
const powershell = ({ env }: IntegrationEnvironment) => win32.join(env.SystemRoot ?? env.windir ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

function launcherHandler(tool: HookTool, timeout: number, environment: IntegrationEnvironment, launcher: string): Json {
  const windows = environment.platform === "win32";
  // Claude Code runs `command` + `args` without a shell: no quoting at all.
  if (tool === "claude-code") return windows ? { type: "command", command: powershell(environment), args: [...POWERSHELL_ARGS, launcher, tool], timeout }
    : { type: "command", command: "/bin/sh", args: [launcher, tool], timeout };
  // Codex hooks.json has no argument vector: `command` is a shell string.
  return { type: "command", command: windows ? `powershell.exe ${POWERSHELL_ARGS.join(" ")} "${launcher}" ${tool}` : `/bin/sh ${shQuote(launcher)} ${tool}`, timeout };
}
/** The exact entries Stack Stats owns for a tool on this machine. */
export function managedHooks(tool: HookTool, environment: IntegrationEnvironment, paths = integrationPaths(environment)): ManagedHook[] {
  // PowerShell's cold start can exceed Codex's 1 s exit-time hook budget.
  const minimum = environment.platform === "win32" ? 3 : 0;
  return agentAdapters[tool].hooks.map(({ event, matcher, timeout }) =>
    ({ event, ...(matcher ? { matcher } : {}), handler: launcherHandler(tool, Math.max(timeout, minimum), environment, paths.launcher) }));
}

const plainObject = (value: unknown): Json | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export type OwnershipTest = (handler: unknown) => boolean;
/** Ownership is an exact command signature, never a fuzzy match: the current launcher
 * invocation, or the Phase 9E manual snippet that ran this home's versioned hook
 * script (`"<runtime>" "<home>/hooks/stack-stats-agent-hook-v1.cjs" <tool>`, with an
 * optional ELECTRON_RUN_AS_NODE=1 prefix, or its argv form). A user's own hook with
 * another path, wrapper or shape is never recognised, so never modified. */
export function ownershipTest(tool: HookTool, environment: IntegrationEnvironment, paths = integrationPaths(environment)): OwnershipTest {
  const signature = (handler: Json) => JSON.stringify([handler.type, handler.command, handler.args ?? null]);
  const current = new Set(managedHooks(tool, environment, paths).map((hook) => signature(hook.handler)));
  const legacy = new RegExp(`^(?:ELECTRON_RUN_AS_NODE=1 )?"[^"]+" "${escapeRegex(paths.hookScript)}" ${escapeRegex(tool)}$`);
  return (value) => {
    const handler = plainObject(value);
    if (!handler || handler.type !== "command" || typeof handler.command !== "string" || !handler.command) return false;
    if (current.has(signature(handler))) return true;
    if (handler.args !== undefined) return Array.isArray(handler.args) && handler.args.length === 2 && handler.args[0] === paths.hookScript && handler.args[1] === tool;
    return legacy.test(handler.command);
  };
}

// ── Pure planning over parsed configuration ─────────────────────────────────────

export class IntegrationError extends Error {
  constructor(readonly code: "malformed" | "structure" | "permission" | "read_only" | "too_large" | "changed" | "io", message: string) { super(message); }
}
type Group = Json & { hooks: unknown[] };
const isGroup = (value: unknown): value is Group => Array.isArray(plainObject(value)?.hooks);
const sameMatcher = (a: unknown, b: string | undefined) => (a === undefined || a === "") ? !b : a === b;
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : plainObject(value) ? `{${Object.keys(value as Json).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Json)[key])}`).join(",")}}` : JSON.stringify(value);
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function hooksObject(root: Json, file: string): Json | undefined {
  if (root.hooks === undefined) return undefined;
  const hooks = plainObject(root.hooks);
  if (!hooks) throw new IntegrationError("structure", `${file} has an unexpected "hooks" value. Nothing was changed.`);
  return hooks;
}
/** Codex keys hook approval by position (`<file>:<event>:<group>:<handler>`), so any
 * edit that moves someone else's hook costs a re-approval. Track positions of every
 * handler Stack Stats does not own, by identity. */
function positions(hooks: Json | undefined, owned: OwnershipTest): Map<object, string> {
  const map = new Map<object, string>();
  for (const [event, list] of Object.entries(hooks ?? {})) if (Array.isArray(list)) list.forEach((group, g) => {
    if (isGroup(group)) group.hooks.forEach((handler, h) => { if (handler && typeof handler === "object" && !owned(handler)) map.set(handler, `${event}:${g}:${h}`); });
  });
  return map;
}
const shiftedCount = (before: Map<object, string>, hooks: Json | undefined, owned: OwnershipTest) => {
  const after = positions(hooks, owned);
  let shifted = 0;
  for (const [handler, position] of before) if (after.get(handler) !== position) shifted++;
  return shifted;
};

export interface HookPlan { root: Json; changed: boolean; added: number; updated: number; removed: number; kept: number; shifted: number }

/** Idempotent connect/upgrade. Existing Stack Stats entries (current or legacy) are
 * updated in place so no other hook moves; missing ones are appended at the end of
 * the event's list; duplicates are removed. Nothing else is touched. */
export function planConnect(before: Json, wanted: ManagedHook[], owned: OwnershipTest, file: string): HookPlan {
  const root = clone(before);
  const existing = hooksObject(root, file);
  const hooks = existing ?? {};
  const prior = positions(hooks, owned);
  const counts = { added: 0, updated: 0, removed: 0, kept: 0 };
  const targets = new Map(wanted.map((hook) => [hook.event, hook]));
  const group = (hook: ManagedHook): Group => ({ ...(hook.matcher ? { matcher: hook.matcher } : {}), hooks: [clone(hook.handler)] });
  for (const event of Object.keys(hooks)) {
    const list = hooks[event], target = targets.get(event);
    if (!Array.isArray(list)) {
      if (target) throw new IntegrationError("structure", `${file} has an unexpected value for the ${event} hooks. Nothing was changed.`);
      continue;
    }
    const length = list.length;
    let placed = false;
    for (let g = 0; g < list.length; g++) {
      const entry = list[g];
      if (!isGroup(entry)) continue;
      const size = entry.hooks.length;
      for (let h = 0; h < entry.hooks.length; h++) {
        if (!owned(entry.hooks[h])) continue;
        const matcherOk = target ? sameMatcher(entry.matcher, target.matcher) : false;
        // Reuse this slot when its matcher fits, or when the group holds only ours.
        if (target && !placed && (matcherOk || entry.hooks.length === 1)) {
          const handlerOk = canonical(entry.hooks[h]) === canonical(target.handler);
          if (!matcherOk) { if (target.matcher) entry.matcher = target.matcher; else delete entry.matcher; }
          if (!handlerOk) entry.hooks[h] = clone(target.handler);
          if (matcherOk && handlerOk) counts.kept++; else counts.updated++;
          placed = true;
        } else { entry.hooks.splice(h--, 1); counts.removed++; }
      }
      if (size > 0 && entry.hooks.length === 0) list.splice(g--, 1);
    }
    if (target && !placed) { list.push(group(target)); counts.added++; }
    if (length > 0 && list.length === 0) delete hooks[event];
  }
  for (const target of wanted) if (!Object.hasOwn(hooks, target.event)) { hooks[target.event] = [group(target)]; counts.added++; }
  if (!existing) root.hooks = hooks;
  const changed = counts.added + counts.updated + counts.removed > 0;
  return { root: changed ? root : clone(before), changed, ...counts, shifted: shiftedCount(prior, hooks, owned) };
}

/** Removes every Stack Stats-owned entry and only the containers that became empty
 * because of that removal. */
export function planDisconnect(before: Json, owned: OwnershipTest, file: string): HookPlan {
  const root = clone(before);
  const hooks = hooksObject(root, file);
  const prior = positions(hooks, owned);
  let removed = 0;
  for (const event of Object.keys(hooks ?? {})) {
    const list = hooks![event];
    if (!Array.isArray(list)) continue;
    const length = list.length;
    for (let g = 0; g < list.length; g++) {
      const entry = list[g];
      if (!isGroup(entry)) continue;
      const size = entry.hooks.length;
      for (let h = 0; h < entry.hooks.length; h++) if (owned(entry.hooks[h])) { entry.hooks.splice(h--, 1); removed++; }
      if (size > 0 && entry.hooks.length === 0) list.splice(g--, 1);
    }
    if (length > 0 && list.length === 0) delete hooks![event];
  }
  if (hooks && removed && Object.keys(hooks).length === 0) delete root.hooks;
  return { root: removed ? root : clone(before), changed: removed > 0, added: 0, updated: 0, removed, kept: 0, shifted: shiftedCount(prior, hooks, owned) };
}

export function inspectHooks(root: Json, wanted: ManagedHook[], owned: OwnershipTest): { owned: number; exact: number } {
  const hooks = plainObject(root.hooks);
  const targets = new Map(wanted.map((hook) => [hook.event, hook]));
  const exact = new Set<string>();
  let count = 0;
  for (const [event, list] of Object.entries(hooks ?? {})) if (Array.isArray(list)) for (const group of list) {
    if (!isGroup(group)) continue;
    for (const handler of group.hooks) if (owned(handler)) {
      count++;
      const target = targets.get(event);
      if (target && sameMatcher(group.matcher, target.matcher) && canonical(handler) === canonical(target.handler)) exact.add(event);
    }
  }
  return { owned: count, exact: exact.size };
}

/** Everything except Stack Stats entries (and containers left empty) must survive a
 * write unchanged. Checked on the re-parsed output before anything touches disk. */
export function preservesUnrelated(before: Json, after: Json, owned: OwnershipTest): boolean {
  const normalize = (root: Json) => {
    const stripped = planDisconnect(root, owned, "").root;
    const hooks = plainObject(stripped.hooks);
    if (hooks) {
      for (const [event, list] of Object.entries(hooks)) {
        if (!Array.isArray(list)) continue;
        const kept = list.filter((group) => !isGroup(group) || group.hooks.length > 0);
        if (kept.length) hooks[event] = kept; else delete hooks[event];
      }
      if (!Object.keys(hooks).length) delete stripped.hooks;
    }
    return canonical(stripped);
  };
  return normalize(before) === normalize(after);
}

/** Re-serializes with the file's own indentation, line endings, BOM and final newline.
 * Key order is preserved (JSON.parse keeps insertion order). */
export function serializeLike(root: Json, original: string): string {
  const bom = original.startsWith("\uFEFF");
  const body = bom ? original.slice(1) : original, trimmed = body.trim();
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  const indent = !trimmed || trimmed === "{}" ? "  " : /\n([ \t]+)\S/.exec(body)?.[1] ?? (trimmed.includes("\n") ? "  " : "");
  let text = indent ? JSON.stringify(root, null, indent) : JSON.stringify(root);
  if (eol !== "\n") text = text.replace(/\n/g, eol);
  return `${bom ? "\uFEFF" : ""}${text}${!trimmed || /\n$/.test(body) ? eol : ""}`;
}

// ── Safe file access ────────────────────────────────────────────────────────────

interface ConfigFile { target: string; exists: boolean; text: string; root: Json; mode: number }
const errorCode = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code ?? "";
function ioError(error: unknown, file: string, verb: "read" | "change"): IntegrationError {
  if (error instanceof IntegrationError) return error;
  const code = errorCode(error);
  if (code === "EACCES" || code === "EPERM") return new IntegrationError("permission", `Stack Stats doesn't have permission to ${verb} ${file}. Nothing was changed.`);
  if (code === "EROFS") return new IntegrationError("read_only", `${file} is on a read-only file system. Nothing was changed.`);
  return new IntegrationError("io", `${file} couldn't be ${verb === "read" ? "read" : "changed"}${code ? ` (${code})` : ""}. Nothing was changed.`);
}
/** Only a line number is reported for syntax errors: V8's messages can quote file
 * text, and settings files can hold secrets. */
function parseRoot(text: string, file: string): Json {
  const body = text.startsWith("\uFEFF") ? text.slice(1) : text;
  if (!body.trim()) return {};
  let value: unknown;
  try { value = JSON.parse(body); } catch (error) {
    const position = /position (\d+)/.exec(String((error as Error).message))?.[1];
    const line = position === undefined ? "" : ` (line ${body.slice(0, Number(position)).split("\n").length})`;
    throw new IntegrationError("malformed", `${file} isn't valid JSON${line}. Nothing was changed. Fix the file, then try again.`);
  }
  const root = plainObject(value);
  if (!root) throw new IntegrationError("structure", `${file} doesn't contain a JSON object. Nothing was changed.`);
  return root;
}
/** Symlinked configs (dotfile managers) are edited at their real location so the link
 * survives the atomic replace. A missing file is an empty configuration. */
async function readConfig(path: string, file: string): Promise<ConfigFile> {
  let link: boolean;
  try { link = (await lstat(path)).isSymbolicLink(); } catch (error) {
    if (errorCode(error) === "ENOENT") return { target: path, exists: false, text: "", root: {}, mode: 0o600 };
    throw ioError(error, file, "read");
  }
  let target = path;
  if (link) {
    try { target = await realpath(path); } catch (error) {
      throw errorCode(error) === "ENOENT" ? new IntegrationError("io", `${file} links to a file that doesn't exist. Nothing was changed.`) : ioError(error, file, "read");
    }
  }
  try {
    const info = await stat(target);
    if (!info.isFile()) throw new IntegrationError("structure", `${file} isn't a regular file. Nothing was changed.`);
    if (info.size > MAX_CONFIG_BYTES) throw new IntegrationError("too_large", `${file} is unexpectedly large. Nothing was changed.`);
    const text = await readFile(target, "utf8");
    return { target, exists: true, text, root: parseRoot(text, file), mode: info.mode & 0o777 };
  } catch (error) { throw ioError(error, file, "read"); }
}
async function replaceFile(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await rename(from, to); return; } catch (error) {
      // Windows refuses to replace a file another process (antivirus, indexer) holds open.
      if (process.platform !== "win32" || attempt >= 4 || !["EPERM", "EBUSY", "EACCES"].includes(errorCode(error))) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}
/** Validate → compare-and-swap → single backup → temp file in the same directory →
 * fsync → atomic rename. A read-only file is respected, never replaced. */
async function writeConfig(config: ConfigFile, text: string, backup: string, file: string, platform: NodeJS.Platform): Promise<void> {
  const path = platform === "win32" ? win32 : posix;
  const current = await readFile(config.target, "utf8").catch((error) => errorCode(error) === "ENOENT" ? undefined : Promise.reject(ioError(error, file, "read")));
  if (config.exists ? current !== config.text : current !== undefined) throw new IntegrationError("changed", `${file} changed while Stack Stats was updating it. Nothing was changed; try again.`);
  const directory = path.dirname(config.target);
  const temporary = path.join(directory, `.${path.basename(config.target)}.stack-stats-${randomUUID()}.tmp`);
  try {
    if (config.exists) {
      try { await access(config.target, constants.W_OK); } catch { throw new IntegrationError("read_only", `${file} is read-only. Nothing was changed.`); }
      await mkdir(path.dirname(backup), { recursive: true, mode: 0o700 });
      await atomicWrite(backup, config.text);
    } else await mkdir(directory, { recursive: true, mode: 0o700 });
    const handle = await open(temporary, "wx", config.mode);
    try { await handle.writeFile(text, "utf8"); await handle.sync(); } finally { await handle.close(); }
    await chmod(temporary, config.mode).catch(() => undefined);
    await replaceFile(temporary, config.target);
  } catch (error) { throw ioError(error, file, "change"); }
  finally { await unlink(temporary).catch(() => undefined); }
}

async function isDirectory(path: string): Promise<boolean> { try { return (await stat(path)).isDirectory(); } catch { return false; } }
async function isFile(path: string): Promise<boolean> { try { return (await stat(path)).isFile(); } catch { return false; } }
/** PATH lookup without spawning anything (PATHEXT on Windows). */
export async function onPath(name: string, { platform, env }: IntegrationEnvironment): Promise<boolean> {
  const path = platform === "win32" ? win32 : posix;
  const directories = (env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : ":").filter(Boolean);
  const extensions = platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean) : [""];
  for (const directory of directories) for (const extension of extensions) {
    try { await access(path.join(directory, name + extension), constants.X_OK); return true; } catch { /* Next candidate. */ }
  }
  return false;
}
/** Read-only: Codex also accepts [[hooks.*]] tables in config.toml. Stack Stats never
 * edits TOML; it only notices its own entries there so it can warn about duplicates. */
async function tomlMentionsStackStats(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_CONFIG_BYTES) return false;
    const text = await readFile(path, "utf8");
    return [HOOK_SCRIPT_NAME, LAUNCHER_POSIX, LAUNCHER_WINDOWS].some((name) => text.includes(name));
  } catch { return false; }
}

// ── Manager ─────────────────────────────────────────────────────────────────────

/** not_detected: no evidence the tool is installed. available: detected, not connected.
 * connected: setting on, every managed entry exact, hook runtime present; `verified`
 * additionally means a signal arrived since connecting. needs_attention: partial,
 * paused, outdated or conflicting. error: the tool's config cannot be read. */
export type IntegrationState = "not_detected" | "available" | "connected" | "needs_attention" | "error";
export interface IntegrationStatus {
  tool: HookTool; displayName: string; state: IntegrationState;
  configPath: string; displayConfigPath: string;
  detected: boolean; enabled: boolean; runtimeReady: boolean;
  hooks: { expected: number; exact: number; owned: number };
  lastSignalAt?: number; connectedAt?: number;
  verified: boolean;
  /** Codex runs new hooks only after the user approves them in Codex. */
  approvalPending: boolean;
  problem?: string;
}
export interface ChangePreview { tool: HookTool; displayConfigPath: string; createsFile: boolean; changed: boolean; added: number; updated: number; removed: number; shifted: number }
export interface IntegrationManagerOptions {
  environment?: IntegrationEnvironment;
  bundledHook: string;
  /** JavaScript runtime recorded for the launcher (the extension host's own). */
  runtime: string;
  enabled(tool: HookTool): boolean;
  setEnabled(tool: HookTool, on: boolean): Promise<void>;
  /** Rewrites the hook state file (tracking + per-tool opt-in) from current settings. */
  syncState(): Promise<void>;
  editorExtension(tool: HookTool): boolean;
  connectedAt(tool: HookTool): number | undefined;
  setConnectedAt(tool: HookTool, at: number | undefined): Promise<void>;
  now?: () => number;
}

export class AgentIntegrationManager {
  readonly environment: IntegrationEnvironment;
  readonly paths: IntegrationPaths;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  constructor(private readonly o: IntegrationManagerOptions) {
    this.environment = o.environment ?? currentEnvironment();
    this.paths = integrationPaths(this.environment);
    this.now = o.now ?? Date.now;
  }

  displayName(tool: HookTool): string { return agentAdapters[tool].displayName; }
  private file(tool: HookTool) { return displayPath(this.paths.config[tool], this.environment); }
  private wanted(tool: HookTool) { return managedHooks(tool, this.environment, this.paths); }
  private owned(tool: HookTool) { return ownershipTest(tool, this.environment, this.paths); }
  private backup(tool: HookTool) { return (this.environment.platform === "win32" ? win32 : posix).join(this.paths.backups, `${tool}-${tool === "codex" ? "hooks" : "settings"}.json.bak`); }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => undefined).then(work);
    this.queue = next;
    return next;
  }

  /** Installation evidence, without executing anything: the vendor's VS Code
   * extension, its user config directory, or its CLI on PATH. */
  async detect(tool: HookTool): Promise<boolean> {
    return this.o.editorExtension(tool) || await isDirectory(this.paths.configDirectory[tool]) || await onPath(CLI_NAMES[tool], this.environment);
  }
  async runtimeReady(): Promise<boolean> { return await isFile(this.paths.hookScript) && await isFile(this.paths.launcher); }
  installRuntime(): Promise<void> { return installHookRuntime(this.paths, this.environment.platform, this.o.bundledHook, this.o.runtime); }

  /** Derived from the tool's real configuration, not from the Stack Stats setting. */
  async status(tool: HookTool): Promise<IntegrationStatus> {
    const wanted = this.wanted(tool);
    const [detected, runtimeReady, lastSignalAt] = await Promise.all([this.detect(tool), this.runtimeReady(), readSignal(this.paths.stackStatsHome, tool)]);
    const enabled = this.o.enabled(tool), connectedAt = this.o.connectedAt(tool);
    const base = { tool, displayName: this.displayName(tool), configPath: this.paths.config[tool], displayConfigPath: this.file(tool), detected, enabled, runtimeReady, lastSignalAt, connectedAt, verified: false, approvalPending: false };
    let config: ConfigFile;
    try { config = await readConfig(this.paths.config[tool], this.file(tool)); }
    catch (error) { return { ...base, state: "error", hooks: { expected: wanted.length, exact: 0, owned: 0 }, problem: (error as Error).message }; }
    const hooks = { expected: wanted.length, ...inspectHooks(config.root, wanted, this.owned(tool)) };
    const complete = hooks.owned === wanted.length && hooks.exact === wanted.length;
    const conflict = tool === "claude-code" && hooks.owned && config.root.disableAllHooks === true ? "Claude Code hooks are turned off in its settings (disableAllHooks), so no activity can be labeled."
      : tool === "codex" && await tomlMentionsStackStats(this.paths.codexToml) ? `Stack Stats hooks are also listed in ${displayPath(this.paths.codexToml, this.environment)}. Remove them there; Stack Stats manages ${this.file(tool)} only.` : undefined;
    if (!hooks.owned && !enabled && !conflict) return { ...base, hooks, state: detected || config.exists ? "available" : "not_detected" };
    if (complete && enabled && runtimeReady && !conflict) {
      const verified = lastSignalAt !== undefined && lastSignalAt >= (connectedAt ?? 0);
      return { ...base, hooks, state: "connected", verified, approvalPending: tool === "codex" && !verified };
    }
    const problem = conflict ?? (!enabled ? "Paused: the hooks are installed but Stack Stats ignores them. Connect to resume, or Disconnect to remove them."
      : !hooks.owned ? `The Stack Stats hooks are missing from ${this.file(tool)}. Connect again to repair.`
      : !complete ? "The Stack Stats hooks need an update. Connect to update them."
      : "The Stack Stats hook runtime is missing. Connect again to repair.");
    return { ...base, hooks, state: "needs_attention", problem };
  }
  statuses(): Promise<IntegrationStatus[]> { return Promise.all(hookTools.map((tool) => this.status(tool))); }

  async previewConnect(tool: HookTool): Promise<ChangePreview> {
    const config = await readConfig(this.paths.config[tool], this.file(tool));
    const plan = planConnect(config.root, this.wanted(tool), this.owned(tool), this.file(tool));
    return { tool, displayConfigPath: this.file(tool), createsFile: !config.exists, changed: plan.changed, added: plan.added, updated: plan.updated, removed: plan.removed, shifted: plan.shifted };
  }
  async previewDisconnect(tool: HookTool): Promise<ChangePreview> {
    const config = await readConfig(this.paths.config[tool], this.file(tool));
    const plan = planDisconnect(config.root, this.owned(tool), this.file(tool));
    return { tool, displayConfigPath: this.file(tool), createsFile: false, changed: plan.changed, added: 0, updated: 0, removed: plan.removed, shifted: plan.shifted };
  }

  /** Stack Stats side first (hook, launcher, runtime hint, setting, state), then the
   * vendor entries, so a session starting mid-connect never runs a missing launcher.
   * A failed vendor write restores the previous setting. */
  connect(tool: HookTool): Promise<IntegrationStatus> {
    return this.serial(async () => {
      const wasEnabled = this.o.enabled(tool);
      let changed = false;
      try {
        await this.installRuntime();
        if (!wasEnabled) await this.o.setEnabled(tool, true);
        await this.o.syncState();
        await exclusive(this.paths.lock, async (check) => {
          const file = this.file(tool), owned = this.owned(tool), wanted = this.wanted(tool);
          const config = await readConfig(this.paths.config[tool], file);
          const plan = planConnect(config.root, wanted, owned, file);
          if (!plan.changed) return;
          const text = serializeLike(plan.root, config.text);
          const written = parseRoot(text, file), result = inspectHooks(written, wanted, owned);
          if (!preservesUnrelated(config.root, written, owned) || result.owned !== wanted.length || result.exact !== wanted.length) {
            throw new IntegrationError("io", `Stack Stats stopped before changing ${file} because the result could not be verified. Nothing was changed.`);
          }
          check();
          await writeConfig(config, text, this.backup(tool), file, this.environment.platform);
          changed = true;
        });
      } catch (error) {
        if (!wasEnabled) await this.o.setEnabled(tool, false).then(() => this.o.syncState()).catch(() => undefined);
        throw error;
      }
      if (changed || this.o.connectedAt(tool) === undefined) await this.o.setConnectedAt(tool, this.now());
      return this.status(tool);
    });
  }

  /** Removes only Stack Stats entries. Even when the vendor file cannot be edited,
   * the Stack Stats side is switched off so the hook records nothing further. */
  disconnect(tool: HookTool): Promise<IntegrationStatus> {
    return this.serial(async () => {
      let failure: unknown;
      try {
        await exclusive(this.paths.lock, async (check) => {
          const file = this.file(tool), owned = this.owned(tool);
          const config = await readConfig(this.paths.config[tool], file);
          const plan = planDisconnect(config.root, owned, file);
          if (!plan.changed) return;
          const text = serializeLike(plan.root, config.text);
          const written = parseRoot(text, file);
          if (!preservesUnrelated(config.root, written, owned) || inspectHooks(written, [], owned).owned) {
            throw new IntegrationError("io", `Stack Stats stopped before changing ${file} because the result could not be verified. Nothing was changed.`);
          }
          check();
          await writeConfig(config, text, this.backup(tool), file, this.environment.platform);
        });
      } catch (error) { failure = error; }
      if (this.o.enabled(tool)) await this.o.setEnabled(tool, false);
      await this.o.syncState();
      await this.o.setConnectedAt(tool, undefined);
      if (failure) throw failure;
      return this.status(tool);
    });
  }

  /** Advanced fallback for managed or read-only configurations. */
  manualSetup(tool: HookTool): { file: string; snippet: string } {
    const hooks: Record<string, unknown[]> = {};
    for (const { event, matcher, handler } of this.wanted(tool)) (hooks[event] ??= []).push({ ...(matcher ? { matcher } : {}), hooks: [handler] });
    return { file: this.file(tool), snippet: JSON.stringify({ hooks }, null, 2) };
  }
}

// ── User-facing copy (pure, so privacy wording is testable) ─────────────────────

export function statusSummary(status: IntegrationStatus, now = Date.now()): string {
  switch (status.state) {
    case "not_detected": return "Not detected on this device";
    case "available": return "Not connected";
    case "connected": return status.approvalPending ? `Hooks installed · approve them in ${status.displayName}`
      : status.verified && status.lastSignalAt !== undefined ? `Connected · last activity ${formatAgo(status.lastSignalAt, now)}` : "Connected · waiting for first activity";
    case "needs_attention": return `Needs attention · ${status.problem ?? "repair the connection"}`;
    case "error": return `Can't read its settings · ${status.problem ?? ""}`.trim();
  }
}

const REPORTS = ["The hook reports:", "• when agent sessions and turns start and end", "• edit and shell tool activity: tool type, duration, lines changed",
  "• file paths, used only on this device to match changes, then discarded", "",
  "It never reports prompts, responses, source code, commands or command output."].join("\n");
export function connectPrompt(preview: ChangePreview, name: string): { message: string; detail: string; confirm: string } {
  const upgrading = preview.updated > 0 && preview.added === 0;
  const where = `${preview.displayConfigPath}${preview.createsFile ? ", which will be created" : ""}`;
  return {
    message: `${upgrading ? "Update" : "Connect"} ${name}?`,
    detail: [`Stack Stats will ${upgrading ? "update its local hook in" : "add a small local hook to"} ${name} (${where}). Your other settings and hooks stay exactly as they are.`, "",
      REPORTS, "", "Everything stays on this device and is never synced. Agent time never counts as your coding time.",
      ...(preview.tool === "codex" ? ["", "Codex asks you to approve new hooks before they run. After connecting, open Codex and approve the Stack Stats hooks when it asks."] : []),
      ...(preview.tool === "codex" && preview.shifted ? ["", `Codex tracks approvals by position, so it will ask you to approve ${preview.shifted} other hook${preview.shifted === 1 ? "" : "s"} again.`] : [])].join("\n"),
    confirm: upgrading ? "Update" : "Connect"
  };
}
export function disconnectPrompt(preview: ChangePreview, name: string): { message: string; detail: string; confirm: string } {
  return {
    message: `Disconnect ${name}?`,
    detail: [preview.changed ? `Stack Stats will remove only its own hooks from ${preview.displayConfigPath} and stop labeling ${name} activity. Your other settings and hooks stay as they are.`
      : `Stack Stats will stop labeling ${name} activity. No Stack Stats hooks were found in ${preview.displayConfigPath}.`, "",
      "Past activity stays in your local history. External changes are still tracked automatically.",
      ...(preview.tool === "codex" && preview.shifted ? ["", `Codex tracks approvals by position, so it will ask you to approve ${preview.shifted} other hook${preview.shifted === 1 ? "" : "s"} listed after Stack Stats again.`] : [])].join("\n"),
    confirm: "Disconnect"
  };
}

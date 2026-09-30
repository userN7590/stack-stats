import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { countDiffLines } from "@stack-stats/core";
import { agentInboxRecordSchema, type AgentInboxRecord } from "@stack-stats/protocol";

/** Vendor hook payload adapters. They run inside the short-lived hook process and
 * reduce each payload to metadata before anything touches disk: prompts, model
 * responses, transcripts, command text, tool output and file contents are read
 * only transiently (to count diff lines or classify a VCS command) and discarded.
 * Core telemetry never sees vendor payload shapes. No VS Code dependency. */
export type HookTool = "claude-code" | "codex";
export const hookTools: readonly HookTool[] = ["claude-code", "codex"];
export interface HookCommand { executable: string; script: string; env?: Record<string, string> }
export interface AgentSetupInstructions { tool: HookTool; displayName: string; file: string; snippet: string; notes: string[] }
export interface AgentHookAdapter {
  readonly id: HookTool;
  readonly displayName: string;
  /** Hook events (and tool matchers) the adapter consumes. */
  readonly hooks: ReadonlyArray<{ event: string; matcher?: string; timeout: number }>;
  normalize(payload: unknown, observedAt: number, recordId: string): AgentInboxRecord | undefined;
  setup(command: HookCommand): AgentSetupInstructions;
}
type Payload = Record<string, unknown>;
type FileReport = NonNullable<AgentInboxRecord["files"]>[number];

/** Unsalted pseudonym of a random vendor identifier; the extension salts it again
 * before persistence. Vendor IDs never leave the hook process. */
export const vendorHash = (tool: HookTool, kind: string, value: string) => createHash("sha256").update(`stack-stats:agent:${tool}:${kind}:${value}`).digest("hex");
const text = (value: unknown, max = 4096) => typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined;
const object = (value: unknown): Payload | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Payload : undefined;
const lineCount = (value: string) => value === "" ? 0 : value.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n").length;
const resolvePath = (cwd: string, path: string) => isAbsolute(path) ? path : resolve(cwd, path);

/** True when a shell command runs a working-tree-replacing VCS operation. Only this
 * boolean survives: it lets the reconciler refuse to attribute checkout churn to
 * the agent. The command itself is never stored. */
export function isVcsCommand(command: string): boolean {
  return command.split(/&&|\|\||;|\||\n/).some((segment) => {
    const words = segment.trim().replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*/, "").replace(/^(?:sudo|command|exec|time)\s+/, "").split(/\s+/);
    const [tool, first, second] = words;
    if (tool === "git" || tool === "jj" || tool === "hg" || tool === "svn") {
      let sub: string | undefined;
      for (let i = 1; i < words.length && !sub; i++) {
        if (["-C", "-c", "-R", "--git-dir", "--work-tree", "--repository", "--cwd"].includes(words[i]!)) i++;
        else if (!words[i]!.startsWith("-")) sub = words[i];
      }
      return ["checkout", "switch", "pull", "merge", "rebase", "reset", "stash", "restore", "cherry-pick", "revert", "am", "apply", "clone",
        "worktree", "bisect", "update", "unshelve", "undo", "abandon", "new", "edit"].includes(sub ?? "");
    }
    return tool === "gh" && ((first === "pr" && second === "checkout") || (first === "repo" && second === "clone"));
  });
}

/** Count +/- lines in a unified-diff-like hunk list without retaining them. */
function hunkCounts(hunks: unknown): { linesAdded: number; linesRemoved: number } | undefined {
  if (!Array.isArray(hunks)) return undefined;
  let linesAdded = 0, linesRemoved = 0;
  for (const hunk of hunks) {
    const lines = object(hunk)?.lines;
    if (!Array.isArray(lines)) return undefined;
    for (const line of lines) {
      if (typeof line !== "string") return undefined;
      if (line.startsWith("+")) linesAdded++; else if (line.startsWith("-")) linesRemoved++;
    }
  }
  return { linesAdded, linesRemoved };
}

function base(tool: HookTool, payload: Payload, observedAt: number, recordId: string, turnField: string) {
  const session = text(payload.session_id, 256), cwd = text(payload.cwd);
  if (!session || !cwd || !isAbsolute(cwd)) return undefined;
  const turn = text(payload[turnField], 256);
  return { inboxVersion: 1 as const, recordId, tool, observedAt: new Date(observedAt).toISOString(), sessionHash: vendorHash(tool, "session", session),
    ...(turn ? { turnHash: vendorHash(tool, "turn", turn) } : {}), cwd };
}
function call(tool: HookTool, payload: Payload) {
  const id = text(payload.tool_use_id, 512);
  return id ? { callHash: vendorHash(tool, "call", id) } : {};
}
function finish(record: Record<string, unknown>): AgentInboxRecord | undefined {
  const parsed = agentInboxRecordSchema.safeParse(record);
  return parsed.success ? parsed.data : undefined;
}
const hookEntry = (command: HookCommand, tool: HookTool, timeout: number, exec: boolean) => {
  const quoted = `${Object.entries(command.env ?? {}).map(([key, value]) => `${key}=${value} `).join("")}"${command.executable}" "${command.script}" ${tool}`;
  return exec && !command.env ? { type: "command", command: command.executable, args: [command.script, tool], timeout } : { type: "command", command: quoted, timeout };
};
function hooksJson(adapter: AgentHookAdapter, command: HookCommand, exec: boolean) {
  const hooks: Record<string, unknown[]> = {};
  for (const { event, matcher, timeout } of adapter.hooks) {
    (hooks[event] ??= []).push({ ...(matcher ? { matcher } : {}), hooks: [hookEntry(command, adapter.id, timeout, exec)] });
  }
  return JSON.stringify({ hooks }, null, 2);
}

const CLAUDE_EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
function claudeFiles(payload: Payload, cwd: string): FileReport[] | undefined {
  const name = payload.tool_name, input = object(payload.tool_input), response = object(payload.tool_response);
  if (!input) return undefined;
  const path = text(input.file_path) ?? text(input.notebook_path);
  if (!path) return undefined;
  const file = (operation: FileReport["operation"], delta?: { linesAdded: number; linesRemoved: number } | null): FileReport =>
    ({ path: resolvePath(cwd, path), operation, ...(delta ? delta : {}) });
  // structuredPatch is Claude Code's own diff of the write (observed in 2.1.x);
  // it covers replace_all and Write-over-existing precisely. Fall back conservatively.
  const patch = hunkCounts(response?.structuredPatch);
  if (name === "Write") {
    if (response?.type === "create") return [file("created", { linesAdded: typeof input.content === "string" ? lineCount(input.content) : 0, linesRemoved: 0 })];
    return [file(response?.type === "update" ? "modified" : "unknown", response?.type === "update" ? patch : undefined)];
  }
  if (name === "Edit") {
    const fallback = input.replace_all === true || typeof input.old_string !== "string" || typeof input.new_string !== "string" ? null : countDiffLines(input.old_string, input.new_string);
    return [file("modified", patch ?? fallback)];
  }
  if (name === "MultiEdit") {
    let fallback: { linesAdded: number; linesRemoved: number } | null = { linesAdded: 0, linesRemoved: 0 };
    for (const edit of Array.isArray(input.edits) ? input.edits : [null]) {
      const value = object(edit);
      const counts = !value || value.replace_all === true || typeof value.old_string !== "string" || typeof value.new_string !== "string" ? null : countDiffLines(value.old_string, value.new_string);
      fallback = counts && fallback ? { linesAdded: fallback.linesAdded + counts.linesAdded, linesRemoved: fallback.linesRemoved + counts.linesRemoved } : null;
    }
    return [file("modified", patch ?? fallback)];
  }
  return [file("modified")];
}

export const claudeCodeAdapter: AgentHookAdapter = {
  id: "claude-code",
  displayName: "Claude Code",
  // No UserPromptSubmit (it carries the prompt) and no PreToolUse: PostToolUse
  // reports duration_ms, which bounds a shell command's execution window.
  hooks: [
    { event: "SessionStart", timeout: 5 },
    { event: "PostToolUse", matcher: "Bash|Edit|Write|MultiEdit|NotebookEdit", timeout: 5 },
    { event: "PostToolUseFailure", matcher: "Bash|Edit|Write|MultiEdit|NotebookEdit", timeout: 5 },
    { event: "Stop", timeout: 5 },
    { event: "StopFailure", timeout: 5 },
    { event: "SessionEnd", timeout: 5 }
  ],
  normalize(input, observedAt, recordId) {
    const payload = object(input);
    const event = text(payload?.hook_event_name, 64);
    if (!payload || !event) return undefined;
    const common = base("claude-code", payload, observedAt, recordId, "prompt_id");
    if (!common) return undefined;
    const name = text(payload.tool_name, 256);
    const kind = name === "Bash" ? "shell" : name && CLAUDE_EDIT_TOOLS.has(name) ? "edit" : undefined;
    const command = text(object(payload.tool_input)?.command, 1_000_000);
    const shell = kind === "shell" ? { vcs: command ? isVcsCommand(command) : false } : {};
    switch (event) {
      case "SessionStart": return finish({ ...common, signal: "session_started" });
      case "PostToolUse": {
        if (!kind) return undefined;
        const duration = typeof payload.duration_ms === "number" && Number.isSafeInteger(payload.duration_ms) && payload.duration_ms >= 0 && payload.duration_ms <= 86_400_000 ? { durationMs: payload.duration_ms } : {};
        const files = kind === "edit" ? claudeFiles(payload, common.cwd) : undefined;
        return finish({ ...common, ...call("claude-code", payload), signal: "tool_finished", toolKind: kind, success: true, ...duration, ...shell, ...(files ? { files } : {}) });
      }
      case "PostToolUseFailure":
        return kind ? finish({ ...common, ...call("claude-code", payload), signal: "tool_finished", toolKind: kind, success: false, ...shell }) : undefined;
      case "Stop": return finish({ ...common, signal: "turn_stopped", endReason: "completed" });
      case "StopFailure": return finish({ ...common, signal: "turn_stopped", endReason: "error" });
      case "SessionEnd": return finish({ ...common, signal: "session_ended", endReason: "session_ended" });
      default: return undefined;
    }
  },
  setup(command) {
    return { tool: "claude-code", displayName: "Claude Code", file: "~/.claude/settings.json (merge into the existing \"hooks\" object)",
      snippet: hooksJson(this, command, true),
      notes: ["Hooks receive metadata on stdin; Stack Stats keeps only hashed session/turn/call IDs, tool kind, duration, file paths (resolved locally, never stored) and diff-line counts.",
        "UserPromptSubmit is deliberately not used because its payload contains your prompt. Run time is therefore measured from the first observed tool call to the end of the turn.",
        "Signals are written only while Stack Stats tracking is enabled and stackStats.agentIntegrations.claudeCode is on; otherwise the hook exits without writing."] };
  }
};

/** Codex apply_patch grammar: *** Add/Update/Delete File headers, *** Move to,
 * @@ hunks with ' ', '+', '-' lines. Only headers and line prefixes are read. */
export function parseApplyPatch(patch: string, cwd: string): FileReport[] | undefined {
  const files: FileReport[] = [];
  let current: FileReport | undefined;
  for (const line of patch.split(/\r?\n/)) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (header) {
      const operation = header[1] === "Add" ? "created" : header[1] === "Delete" ? "deleted" : "modified";
      current = { path: resolvePath(cwd, header[2]!.trim()), operation, ...(operation === "deleted" ? {} : { linesAdded: 0, linesRemoved: 0 }) };
      files.push(current);
      if (files.length > 200) return undefined;
      continue;
    }
    const move = /^\*\*\* Move to: (.+)$/.exec(line);
    if (move && current) {
      files.push({ path: current.path, operation: "deleted" });
      current.path = resolvePath(cwd, move[1]!.trim());
      continue;
    }
    if (!current || current.operation === "deleted" || line.startsWith("***") || line.startsWith("@@")) continue;
    if (line.startsWith("+")) current.linesAdded! += 1; else if (line.startsWith("-")) current.linesRemoved! += 1;
  }
  return files.length ? files.slice(0, 200) : undefined;
}
const exitCode = (response: unknown) => { const match = typeof response === "string" ? /^Exit code: (-?\d+)/.exec(response) : null; return match ? Number(match[1]) : undefined; };

export const codexAdapter: AgentHookAdapter = {
  id: "codex",
  displayName: "Codex",
  // Codex PostToolUse has no duration, so a PreToolUse bound is needed for shells.
  hooks: [
    { event: "SessionStart", timeout: 5 },
    { event: "PreToolUse", matcher: "^Bash$", timeout: 5 },
    { event: "PostToolUse", matcher: "^(Bash|apply_patch)$", timeout: 5 },
    { event: "Stop", timeout: 5 },
    { event: "Interrupt", timeout: 1 },
    { event: "SessionEnd", timeout: 1 }
  ],
  normalize(input, observedAt, recordId) {
    const payload = object(input);
    const event = text(payload?.hook_event_name, 64);
    if (!payload || !event) return undefined;
    const common = base("codex", payload, observedAt, recordId, "turn_id");
    if (!common) return undefined;
    const name = text(payload.tool_name, 256), toolInput = payload.tool_input;
    const command = typeof toolInput === "string" ? toolInput : text(object(toolInput)?.command, 8_000_000);
    switch (event) {
      case "SessionStart": return finish({ ...common, signal: "session_started" });
      case "PreToolUse":
        return name === "Bash" ? finish({ ...common, ...call("codex", payload), signal: "tool_started", toolKind: "shell", vcs: command ? isVcsCommand(command) : false }) : undefined;
      case "PostToolUse": {
        const code = exitCode(payload.tool_response);
        const success = code === undefined ? undefined : code === 0;
        if (name === "Bash") return finish({ ...common, ...call("codex", payload), signal: "tool_finished", toolKind: "shell", vcs: command ? isVcsCommand(command) : false, ...(success === undefined ? {} : { success }) });
        if (name !== "apply_patch") return undefined;
        // Files are reported only with explicit evidence the patch applied.
        const files = success && command ? parseApplyPatch(command, common.cwd) : undefined;
        return finish({ ...common, ...call("codex", payload), signal: "tool_finished", toolKind: "edit", ...(success === undefined ? {} : { success }), ...(files ? { files } : {}) });
      }
      case "Stop": return finish({ ...common, signal: "turn_stopped", endReason: "completed" });
      case "Interrupt": return finish({ ...common, signal: "interrupted", endReason: "interrupted" });
      case "SessionEnd": return finish({ ...common, signal: "session_ended", endReason: "session_ended" });
      default: return undefined;
    }
  },
  setup(command) {
    return { tool: "codex", displayName: "Codex", file: "~/.codex/hooks.json (or [[hooks.<Event>]] tables in ~/.codex/config.toml)",
      snippet: hooksJson(this, command, false),
      notes: ["Codex requires you to trust new hooks before they run (review them with /hooks in Codex). Hooks are enabled by default in Codex 0.155+; [features] hooks = false disables them.",
        "UserPromptSubmit is deliberately not used because its payload contains your prompt; Stop's last_assistant_message is ignored.",
        "Signals are written only while Stack Stats tracking is enabled and stackStats.agentIntegrations.codex is on; otherwise the hook exits without writing."] };
  }
};

export const agentAdapters: Readonly<Record<HookTool, AgentHookAdapter>> = { "claude-code": claudeCodeAdapter, codex: codexAdapter };

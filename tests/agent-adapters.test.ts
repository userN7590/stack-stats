import { describe, expect, it } from "vitest";
import { countDiffLines, countReloadDiffLines } from "@stack-stats/core";
import { agentInboxRecordSchema } from "@stack-stats/protocol";
import { claudeCodeAdapter, codexAdapter, isVcsCommand, parseApplyPatch, vendorHash } from "../apps/vscode-extension/src/agent-adapters.js";

// Field names and shapes mirror payloads captured from real Claude Code 2.1.284 and
// Codex 0.155 runs (values here are synthetic).
const cwd = "/work/project";
const secret = { prompt: "PRIVATE PROMPT TEXT", reply: "PRIVATE MODEL REPLY", source: "const PRIVATE_SOURCE = 1;", command: "cat PRIVATE_COMMAND_ARG", stdout: "PRIVATE STDOUT",
  transcript: "/Users/me/.claude/projects/x/PRIVATE_TRANSCRIPT.jsonl", session: "5c0f6f8e-private-session-id", tool: "toolu_PRIVATE_CALL_ID", turn: "0198-private-turn-id" };
const claude = (event: string, extra: Record<string, unknown> = {}) => ({ session_id: secret.session, transcript_path: secret.transcript, cwd, prompt_id: secret.turn,
  permission_mode: "acceptEdits", effort: { level: "high" }, hook_event_name: event, ...extra });
const codex = (event: string, extra: Record<string, unknown> = {}) => ({ session_id: secret.session, turn_id: secret.turn, transcript_path: null, cwd,
  hook_event_name: event, model: "gpt-x", permission_mode: "bypassPermissions", ...extra });
const at = Date.parse("2026-09-29T12:00:00Z"), id = "7b0f0f4e-1111-4222-8333-444455556666";
const leaks = (value: unknown) => Object.values(secret).filter((needle) => JSON.stringify(value).includes(needle));

describe("Claude Code hook adapter", () => {
  it("maps lifecycle hooks to metadata-only signals keyed by hashed session/turn IDs", () => {
    const start = claudeCodeAdapter.normalize(claude("SessionStart", { source: "startup" }), at, id)!;
    expect(start).toMatchObject({ tool: "claude-code", signal: "session_started", sessionHash: vendorHash("claude-code", "session", secret.session), turnHash: vendorHash("claude-code", "turn", secret.turn) });
    expect(claudeCodeAdapter.normalize(claude("Stop", { stop_hook_active: false, last_assistant_message: secret.reply, background_tasks: [] }), at, id)).toMatchObject({ signal: "turn_stopped", endReason: "completed" });
    expect(claudeCodeAdapter.normalize(claude("StopFailure"), at, id)).toMatchObject({ signal: "turn_stopped", endReason: "error" });
    expect(claudeCodeAdapter.normalize(claude("SessionEnd", { reason: "other" }), at, id)).toMatchObject({ signal: "session_ended" });
    // Hooks that carry prompts or are not used produce nothing.
    for (const event of ["UserPromptSubmit", "PreToolUse", "Notification"]) expect(claudeCodeAdapter.normalize(claude(event, { prompt: secret.prompt, tool_name: "Bash" }), at, id)).toBeUndefined();
    expect(claudeCodeAdapter.normalize({ hook_event_name: "Stop", cwd: "relative/path", session_id: "x" }, at, id)).toBeUndefined();
  });

  it("reports explicit file changes with exact diff lines from structuredPatch, falling back conservatively", () => {
    const write = claudeCodeAdapter.normalize(claude("PostToolUse", { tool_name: "Write", tool_use_id: secret.tool, duration_ms: 4,
      tool_input: { file_path: `${cwd}/notes.txt`, content: `${secret.source}\nline two\n` },
      tool_response: { type: "create", filePath: `${cwd}/notes.txt`, content: secret.source, structuredPatch: [], originalFile: null, userModified: false } }), at, id)!;
    expect(write).toMatchObject({ signal: "tool_finished", toolKind: "edit", success: true, durationMs: 4, callHash: vendorHash("claude-code", "call", secret.tool),
      files: [{ path: `${cwd}/notes.txt`, operation: "created", linesAdded: 2, linesRemoved: 0 }] });
    const edit = claudeCodeAdapter.normalize(claude("PostToolUse", { tool_name: "Edit", tool_use_id: secret.tool,
      tool_input: { file_path: "src/a.ts", old_string: "beta", new_string: "gamma", replace_all: false },
      tool_response: { filePath: "src/a.ts", oldString: "beta", newString: "gamma", originalFile: secret.source, structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: [" alpha", "-beta", "+gamma", "+delta"] }] } }), at, id)!;
    expect(edit.files).toEqual([{ path: `${cwd}/src/a.ts`, operation: "modified", linesAdded: 2, linesRemoved: 1 }]);
    const fallback = claudeCodeAdapter.normalize(claude("PostToolUse", { tool_name: "Edit", tool_input: { file_path: `${cwd}/b.ts`, old_string: "a\nb\n", new_string: "a\nc\nd\n" }, tool_response: {} }), at, id)!;
    expect(fallback.files![0]).toMatchObject({ linesAdded: 2, linesRemoved: 1 });
    const replaceAll = claudeCodeAdapter.normalize(claude("PostToolUse", { tool_name: "Edit", tool_input: { file_path: `${cwd}/b.ts`, old_string: "x", new_string: "y", replace_all: true }, tool_response: {} }), at, id)!;
    expect(replaceAll.files![0]).toEqual({ path: `${cwd}/b.ts`, operation: "modified" });
    const overwrite = claudeCodeAdapter.normalize(claude("PostToolUse", { tool_name: "Write", tool_input: { file_path: `${cwd}/c.ts`, content: "x" }, tool_response: { type: "update", structuredPatch: [{ lines: ["-old", "+x"] }] } }), at, id)!;
    expect(overwrite.files![0]).toMatchObject({ operation: "modified", linesAdded: 1, linesRemoved: 1 });
    const multi = claudeCodeAdapter.normalize(claude("PostToolUse", { tool_name: "MultiEdit", tool_input: { file_path: `${cwd}/d.ts`, edits: [{ old_string: "a", new_string: "b\nc" }, { old_string: "q", new_string: "" }] }, tool_response: {} }), at, id)!;
    expect(multi.files![0]).toMatchObject({ linesAdded: 2, linesRemoved: 2 });
    for (const record of [write, edit, fallback, replaceAll, overwrite, multi]) { expect(leaks(record)).toEqual([]); expect(agentInboxRecordSchema.safeParse(record).success).toBe(true); }
  });

  it("records shell commands as duration-bounded windows with only a VCS boolean, and failures without files", () => {
    const bash = claudeCodeAdapter.normalize(claude("PostToolUse", { tool_name: "Bash", tool_use_id: secret.tool, duration_ms: 74,
      tool_input: { command: secret.command, description: "List" }, tool_response: { stdout: secret.stdout, stderr: "", interrupted: false } }), at, id)!;
    expect(bash).toMatchObject({ toolKind: "shell", durationMs: 74, vcs: false, success: true });
    expect(bash.files).toBeUndefined();
    expect(claudeCodeAdapter.normalize(claude("PostToolUse", { tool_name: "Bash", tool_input: { command: "git checkout -b feature" } }), at, id)).toMatchObject({ vcs: true });
    expect(claudeCodeAdapter.normalize(claude("PostToolUseFailure", { tool_name: "Edit", tool_input: { file_path: `${cwd}/x.ts` } }), at, id)).toMatchObject({ success: false });
    expect(claudeCodeAdapter.normalize(claude("PostToolUseFailure", { tool_name: "Edit", tool_input: { file_path: `${cwd}/x.ts` } }), at, id)!.files).toBeUndefined();
    expect(claudeCodeAdapter.normalize(claude("PostToolUse", { tool_name: "Read", tool_input: { file_path: `${cwd}/x.ts` } }), at, id)).toBeUndefined();
    expect(leaks(bash)).toEqual([]);
  });

  it("generates a settings snippet without prompt-bearing hooks", () => {
    const setup = claudeCodeAdapter.setup({ executable: "/usr/local/bin/node", script: "/home/me/.stackstats/hooks/hook.cjs" });
    const hooks = JSON.parse(setup.snippet).hooks;
    expect(Object.keys(hooks)).toEqual(["SessionStart", "PostToolUse", "PostToolUseFailure", "Stop", "StopFailure", "SessionEnd"]);
    expect(hooks.PostToolUse[0]).toEqual({ matcher: "Bash|Edit|Write|MultiEdit|NotebookEdit", hooks: [{ type: "command", command: "/usr/local/bin/node", args: ["/home/me/.stackstats/hooks/hook.cjs", "claude-code"], timeout: 5 }] });
    expect(setup.snippet).not.toContain("UserPromptSubmit");
    const electron = JSON.parse(claudeCodeAdapter.setup({ executable: "/Applications/Code Helper", script: "/h.cjs", env: { ELECTRON_RUN_AS_NODE: "1" } }).snippet);
    expect(electron.hooks.Stop[0].hooks[0].command).toBe('ELECTRON_RUN_AS_NODE=1 "/Applications/Code Helper" "/h.cjs" claude-code');
  });
});

describe("Codex hook adapter", () => {
  const patch = (body: string) => `*** Begin Patch\n${body}\n*** End Patch`;
  it("reports apply_patch files only after an exit code proves success", () => {
    const success = codexAdapter.normalize(codex("PostToolUse", { tool_name: "apply_patch", tool_use_id: secret.tool,
      tool_input: { command: patch(`*** Add File: ${cwd}/notes.txt\n+${secret.source}\n+beta\n*** Update File: src/a.ts\n@@\n alpha\n-beta\n+gamma\n+delta`) },
      tool_response: "Exit code: 0\nWall time: 0.1 seconds\nOutput:\nSuccess. Updated the following files:\nA notes.txt\nM src/a.ts\n" }), at, id)!;
    expect(success).toMatchObject({ tool: "codex", signal: "tool_finished", toolKind: "edit", success: true, turnHash: vendorHash("codex", "turn", secret.turn),
      files: [{ path: `${cwd}/notes.txt`, operation: "created", linesAdded: 2, linesRemoved: 0 }, { path: `${cwd}/src/a.ts`, operation: "modified", linesAdded: 2, linesRemoved: 1 }] });
    const failed = codexAdapter.normalize(codex("PostToolUse", { tool_name: "apply_patch", tool_input: { command: patch(`*** Update File: ${cwd}/a.ts\n-x\n+y`) }, tool_response: "Exit code: 1\nOutput: patch failed" }), at, id)!;
    expect(failed).toMatchObject({ success: false });
    expect(failed.files).toBeUndefined();
    const unknownOutcome = codexAdapter.normalize(codex("PostToolUse", { tool_name: "apply_patch", tool_input: patch(`*** Update File: ${cwd}/a.ts\n-x\n+y`), tool_response: {} }), at, id)!;
    expect(unknownOutcome.files).toBeUndefined();
    expect(leaks(success)).toEqual([]);
  });

  it("bounds shell commands with PreToolUse/PostToolUse and maps turn/session lifecycle", () => {
    expect(codexAdapter.normalize(codex("PreToolUse", { tool_name: "Bash", tool_use_id: secret.tool, tool_input: { command: "git pull --rebase" } }), at, id))
      .toMatchObject({ signal: "tool_started", toolKind: "shell", vcs: true, callHash: vendorHash("codex", "call", secret.tool) });
    expect(codexAdapter.normalize(codex("PreToolUse", { tool_name: "apply_patch", tool_input: { command: "x" } }), at, id)).toBeUndefined();
    expect(codexAdapter.normalize(codex("PostToolUse", { tool_name: "Bash", tool_input: { command: secret.command }, tool_response: `Exit code: 2\n${secret.stdout}` }), at, id))
      .toMatchObject({ signal: "tool_finished", toolKind: "shell", success: false, vcs: false });
    expect(codexAdapter.normalize(codex("Stop", { stop_hook_active: false, last_assistant_message: secret.reply }), at, id)).toMatchObject({ signal: "turn_stopped" });
    expect(codexAdapter.normalize(codex("Interrupt"), at, id)).toMatchObject({ signal: "interrupted", endReason: "interrupted" });
    expect(codexAdapter.normalize(codex("SessionEnd", { reason: "other", turn_id: undefined }), at, id)).toMatchObject({ signal: "session_ended" });
    expect(codexAdapter.normalize(codex("UserPromptSubmit", { prompt: secret.prompt }), at, id)).toBeUndefined();
    const hooks = JSON.parse(codexAdapter.setup({ executable: "/usr/bin/node", script: "/h.cjs" }).snippet).hooks;
    expect(hooks.PreToolUse[0]).toEqual({ matcher: "^Bash$", hooks: [{ type: "command", command: '"/usr/bin/node" "/h.cjs" codex', timeout: 5 }] });
    expect(Object.keys(hooks)).not.toContain("UserPromptSubmit");
  });

  it("parses patch headers, moves and deletions without reading content semantics", () => {
    expect(parseApplyPatch(patch(`*** Update File: a.ts\n*** Move to: b.ts\n@@\n-x\n+y\n*** Delete File: c.ts`), cwd)).toEqual([
      { path: `${cwd}/b.ts`, operation: "modified", linesAdded: 1, linesRemoved: 1 }, { path: `${cwd}/a.ts`, operation: "deleted" }, { path: `${cwd}/c.ts`, operation: "deleted" }]);
    expect(parseApplyPatch(patch(Array.from({ length: 201 }, (_, i) => `*** Add File: f${i}.ts\n+x`).join("\n")), cwd)).toBeUndefined();
    expect(parseApplyPatch("no headers", cwd)).toBeUndefined();
  });
});

describe("content-free counters", () => {
  it("detects working-tree-replacing VCS commands only", () => {
    for (const command of ["git checkout main", "cd repo && git pull", "GIT_TRACE=1 git reset --hard HEAD~1", "git -C ../repo switch -c x", "gh pr checkout 12", "git stash pop", "jj new"]) expect(isVcsCommand(command), command).toBe(true);
    for (const command of ["git status", "git diff", "git log --oneline", "echo git checkout", "npm test", "git commit -m checkout", "ls"]) expect(isVcsCommand(command), command).toBe(false);
  });

  it("counts Git-style diff lines, returning null instead of guessing past its budget", () => {
    expect(countDiffLines("a\nb\nc\n", "a\nx\nc\n")).toEqual({ linesAdded: 1, linesRemoved: 1 });
    expect(countDiffLines("", "a\nb\n")).toEqual({ linesAdded: 2, linesRemoved: 0 });
    expect(countDiffLines("a\r\nb\r\n", "a\nb\n")).toEqual({ linesAdded: 0, linesRemoved: 0 });
    const big = Array.from({ length: 5_000 }, (_, i) => `line ${i}`).join("\n");
    expect(countDiffLines(big, big.split("\n").reverse().join("\n"), 20_000, 10_000)).toBeNull();
  });

  it("derives diff lines from VS Code's whole-line reload edits (shapes observed in real VS Code)", () => {
    // G2 experiment: line 1 replaced by two lines; K2: one line replaced.
    expect(countReloadDiffLines([{ range: { start: { line: 1, character: 0 }, end: { line: 2, character: 0 } }, rangeLength: 19, text: "a\nb\n" }])).toEqual({ linesAdded: 2, linesRemoved: 1 });
    expect(countReloadDiffLines([{ range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } }, rangeLength: 18, text: "x\n" }])).toEqual({ linesAdded: 1, linesRemoved: 1 });
    // A partially covered final line without a newline counts as one replaced line.
    expect(countReloadDiffLines([{ range: { start: { line: 3, character: 0 }, end: { line: 3, character: 4 } }, rangeLength: 4, text: "done" }])).toEqual({ linesAdded: 1, linesRemoved: 1 });
  });
});

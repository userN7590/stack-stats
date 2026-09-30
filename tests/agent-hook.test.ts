import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { agentInboxRecordSchema } from "@stack-stats/protocol";
import { AGENT_INBOX_MAX_RECORDS, inboxPaths } from "../apps/vscode-extension/src/agent-inbox.js";

const hook = resolve("apps/vscode-extension/src/agent-hook.ts");
const payload = (extra: Record<string, unknown> = {}) => JSON.stringify({ session_id: "private-session", transcript_path: "/private/transcript.jsonl", cwd: "/work/project", prompt_id: "private-turn",
  hook_event_name: "PostToolUse", tool_name: "Edit", tool_use_id: "toolu_private", duration_ms: 3,
  tool_input: { file_path: "/work/project/src/a.ts", old_string: "PRIVATE_OLD", new_string: "PRIVATE_NEW\nline" },
  tool_response: { structuredPatch: [{ lines: ["-PRIVATE_OLD", "+PRIVATE_NEW", "+line"] }], originalFile: "PRIVATE_ORIGINAL" }, ...extra });
function home(state?: unknown) {
  const directory = mkdtempSync(join(tmpdir(), "stack-stats-hook-"));
  if (state !== undefined) { mkdirSync(inboxPaths(directory).directory, { recursive: true }); writeFileSync(inboxPaths(directory).state, typeof state === "string" ? state : JSON.stringify(state)); }
  return directory;
}
const state = (patch: Record<string, unknown> = {}) => ({ stateVersion: 1, collecting: true, integrations: { "claude-code": true, codex: false }, excludeFiles: [], updatedAt: new Date().toISOString(), ...patch });
function run(directory: string, input: string, tool = "claude-code") {
  const result = spawnSync(process.execPath, ["--import", "tsx", hook, tool], { input, env: { ...process.env, STACK_STATS_HOME: directory }, encoding: "utf8", timeout: 20_000 });
  return { status: result.status, stdout: result.stdout, records: (() => { try { return readdirSync(inboxPaths(directory).records).filter((name) => name.endsWith(".json")); } catch { return []; } })() };
}

describe("agent hook executable", () => {
  it("fails closed: no state, a disabled integration or paused tracking writes nothing", () => {
    for (const directory of [home(), home("{corrupt"), home(state({ integrations: { "claude-code": false, codex: true } })), home(state({ collecting: false }))]) {
      expect(run(directory, payload())).toEqual({ status: 0, stdout: "", records: [] });
    }
  });

  it("writes one validated, content-free inbox record when opted in, and prints nothing", () => {
    const directory = home(state());
    const result = run(directory, payload());
    expect(result).toMatchObject({ status: 0, stdout: "" });
    expect(result.records).toHaveLength(1);
    const text = readFileSync(join(inboxPaths(directory).records, result.records[0]!), "utf8");
    const record = agentInboxRecordSchema.parse(JSON.parse(text));
    expect(record).toMatchObject({ tool: "claude-code", signal: "tool_finished", toolKind: "edit", durationMs: 3, files: [{ path: "/work/project/src/a.ts", operation: "modified", linesAdded: 2, linesRemoved: 1 }] });
    for (const secret of ["PRIVATE", "private-session", "private-turn", "toolu_private", "transcript"]) expect(text).not.toContain(secret);
  });

  it("drops excluded, binary and scratch paths before anything reaches disk", () => {
    const directory = home(state({ excludeFiles: ["**/generated/**"] }));
    for (const file of ["/work/project/.env", "/work/project/generated/x.ts", "/work/project/logo.png", "/work/project/a.ts.tmp.123.abcdef12"]) {
      run(directory, payload({ tool_input: { file_path: file, old_string: "a", new_string: "b" }, tool_response: {} }));
    }
    const records = readdirSync(inboxPaths(directory).records).map((name) => JSON.parse(readFileSync(join(inboxPaths(directory).records, name), "utf8")));
    expect(records).toHaveLength(4);
    expect(records.every((record) => record.files === undefined)).toBe(true);
  });

  it("exits cleanly on malformed input, unknown tools and unsupported events", () => {
    const directory = home(state());
    expect(run(directory, "{not json")).toEqual({ status: 0, stdout: "", records: [] });
    expect(run(directory, payload(), "unknown-agent")).toEqual({ status: 0, stdout: "", records: [] });
    expect(run(directory, payload({ hook_event_name: "UserPromptSubmit", prompt: "PRIVATE" }))).toEqual({ status: 0, stdout: "", records: [] });
  });

  it("counts drops instead of growing past the inbox bound", () => {
    const directory = home(state());
    mkdirSync(inboxPaths(directory).records, { recursive: true });
    for (let i = 0; i < AGENT_INBOX_MAX_RECORDS; i++) writeFileSync(join(inboxPaths(directory).records, `${i}.placeholder`), "");
    run(directory, payload());
    expect(readFileSync(inboxPaths(directory).dropped, "utf8")).toBe("1");
  });
});

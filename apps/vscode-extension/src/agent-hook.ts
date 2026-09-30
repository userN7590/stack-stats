import { randomUUID } from "node:crypto";
import { PrivacyPolicy, isBinaryPath, isTransientArtifact } from "@stack-stats/core";
import { agentAdapters, type HookTool } from "./agent-adapters.js";
import { AGENT_STATE_MAX_AGE_MS, agentHome, markSignal, readIntegrationState, writeInboxRecord } from "./agent-inbox.js";

/** Executable invoked by Claude Code / Codex hooks through the Stack Stats launcher
 * (`stack-stats-hook-v1.sh|.ps1 <tool>` → `<runtime> stack-stats-agent-hook-v1.cjs <tool>`).
 * It must never slow down or break the agent: it prints nothing (stdout can be
 * parsed as a hook decision), bounds its input and runtime, and always exits 0.
 * It writes only when the user enabled this integration in Stack Stats and the
 * extension refreshed its state recently. */
const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const exit = () => process.exit(0);
setTimeout(exit, 4_000);

function run(input: string, tool: HookTool, observedAt: number): void {
  const home = agentHome();
  const state = readIntegrationState(home);
  if (!state?.collecting || !state.integrations[tool]) return;
  if (!(observedAt - Date.parse(state.updatedAt) <= AGENT_STATE_MAX_AGE_MS)) return;
  const record = agentAdapters[tool].normalize(JSON.parse(input), observedAt, randomUUID());
  if (!record) return;
  markSignal(home, tool, observedAt);
  if (record.files) {
    // Defense in depth: the extension re-applies exclusions against the real
    // workspace root. Excluded, binary and scratch paths never reach the inbox.
    let policy: PrivacyPolicy;
    try { policy = new PrivacyPolicy(state.excludeFiles); } catch { return; }
    const files = record.files.filter((file) => policy.allows(record.cwd, file.path) && !isBinaryPath(file.path) && !isTransientArtifact(file.path));
    if (files.length) record.files = files; else delete record.files;
  }
  writeInboxRecord(home, record);
}

const tool = process.argv[2];
if (tool !== "claude-code" && tool !== "codex") exit();
else {
  const observedAt = Date.now();
  const chunks: Buffer[] = [];
  let size = 0;
  process.stdin.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_INPUT_BYTES) exit();
    chunks.push(chunk);
  });
  process.stdin.on("error", exit);
  process.stdin.on("end", () => {
    try { run(Buffer.concat(chunks).toString("utf8"), tool, observedAt); } catch { /* Never fail the agent. */ }
    exit();
  });
}

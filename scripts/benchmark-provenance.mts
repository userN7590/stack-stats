import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { ChangeReconciler, summarizeAgentActivity, toChangeRecord, type FileRef } from "@stack-stats/core";
import type { ProvenanceRecord } from "@stack-stats/protocol";
import { claudeCodeAdapter, codexAdapter } from "../apps/vscode-extension/src/agent-adapters.js";

// Synthetic, in-memory only. Checks its own expected canonical counts so a speedup
// can never come from silently dropping or double counting observations.
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const file = (name: string, workspace = "ws"): FileRef => ({ key: `file:///${workspace}/${name}`, workspaceKey: `file:///${workspace}`, projectId: hash(workspace), fileId: hash(name), languageId: "typescript" });
const gc = (globalThis as { gc?: () => void }).gc;
const heap = () => { gc?.(); return process.memoryUsage().heapUsed; };
const results: Array<Record<string, unknown>> = [];
function measure(name: string, expected: Record<string, number>, run: () => Record<string, number>) {
  const before = heap(), start = performance.now();
  const actual = run();
  const ms = performance.now() - start, growth = heap() - before;
  for (const [key, value] of Object.entries(expected)) if (actual[key] !== value) throw new Error(`${name}: expected ${key}=${value}, got ${actual[key]}`);
  results.push({ scenario: name, ms: Number(ms.toFixed(1)), heapGrowthKiB: Math.round(growth / 1024), ...actual });
}
const t = Date.parse("2026-09-29T12:00:00Z");
const reconciler = (options = {}) => new ChangeReconciler({ createId: randomUUID, ...options });

measure("100 files, 2 watcher notifications each, 50 explicitly reported", { canonicalChanges: 50, explicit: 50, absorbed: 100 }, () => {
  const r = reconciler();
  const explicit = [];
  for (let i = 0; i < 100; i++) { r.observe({ kind: "watcher", file: file(`f${i}.ts`), operation: "changed", at: t + i * 3_000 }); r.observe({ kind: "watcher", file: file(`f${i}.ts`), operation: "changed", at: t + i * 3_000 + 80 }); }
  for (let i = 0; i < 50; i++) explicit.push(r.agentChange({ id: randomUUID(), tool: "claude-code", sessionKey: hash("s"), at: t + i * 3_000 + 100, file: file(`f${i}.ts`), operation: "modified", delta: { linesAdded: 3, linesRemoved: 1 } }));
  const { changes, stats } = r.reconcile(t + 1_000_000);
  return { canonicalChanges: changes.length, explicit: explicit.length, absorbed: stats.watcherAbsorbed, duplicatesMerged: stats.duplicateNotificationsMerged, pendingAfter: stats.pending };
});

measure("1,000 file events in one burst (branch switch)", { canonicalChanges: 1, bulkFiles: 1_000, attributedToAgent: 0 }, () => {
  const r = reconciler();
  r.toolStarted({ callKey: hash("c"), tool: "codex", sessionKey: hash("s"), workspaceKey: "file:///ws", at: t - 1_000 });
  for (let i = 0; i < 1_000; i++) r.observe({ kind: "watcher", file: file(`tracked/${i}.ts`), operation: "changed", at: t + (i % 200) });
  r.toolFinished({ callKey: hash("c"), tool: "codex", sessionKey: hash("s"), workspaceKey: "file:///ws", at: t + 1_000 });
  const { changes } = r.reconcile(t + 60_000);
  return { canonicalChanges: changes.length, bulkFiles: changes[0]?.bulk?.files ?? 0, attributedToAgent: changes.filter((change) => change.actor === "agent").length };
});

// 20 files stays below the 25-file bulk threshold, isolating duplicate merging.
measure("10,000 duplicate notifications over 20 files", { canonicalChanges: 20, duplicatesMerged: 9_980 }, () => {
  const r = reconciler({ maxPending: 20_000 });
  for (let i = 0; i < 10_000; i++) r.observe({ kind: "watcher", file: file(`d${i % 20}.ts`), operation: "changed", at: t + Math.floor(i / 20) * 2 });
  const { changes, stats } = r.reconcile(t + 60_000);
  return { canonicalChanges: changes.length, duplicatesMerged: stats.duplicateNotificationsMerged };
});

measure("200 agent shell commands x 5 files, rapid writes inside correlation windows", { canonicalChanges: 1_000, correlated: 1_000 }, () => {
  const r = reconciler();
  for (let c = 0; c < 200; c++) {
    const at = t + c * 10_000, callKey = hash(`call${c}`);
    r.toolStarted({ callKey, tool: "claude-code", sessionKey: hash("s"), workspaceKey: "file:///ws", at });
    for (let f = 0; f < 5; f++) r.observe({ kind: "watcher", file: file(`c${c}-${f}.ts`), operation: "changed", at: at + 100 + f * 10 });
    r.toolFinished({ callKey, tool: "claude-code", sessionKey: hash("s"), workspaceKey: "file:///ws", at: at + 500 });
  }
  const { changes } = r.reconcile(t + 3_000_000);
  return { canonicalChanges: changes.length, correlated: changes.filter((change) => change.confidence === "correlated").length };
});

measure("20,000 observations against the 5,000 pending cap", { accepted: 5_000, dropped: 15_000 }, () => {
  const r = reconciler();
  let accepted = 0;
  for (let i = 0; i < 20_000; i++) if (r.observe({ kind: "watcher", file: file(`o${i}.ts`), operation: "changed", at: t })) accepted++;
  const { stats } = r.reconcile(t + 60_000);
  return { accepted, dropped: stats.droppedObservations };
});

measure("simulated hour: 1 write/s over 20 files, reconcile every 15 s", { pendingAfter: 0 }, () => {
  const r = reconciler();
  let produced = 0, maxPending = 0;
  for (let second = 0; second < 3_600; second++) {
    r.observe({ kind: "watcher", file: file(`h${second % 20}.ts`), operation: "changed", at: t + second * 1_000 });
    r.observe({ kind: "editor_write", file: file(`h${(second + 7) % 20}.ts`), at: t + second * 1_000 });
    if (second % 15 === 0) { const { changes, stats } = r.reconcile(t + second * 1_000); produced += changes.length; maxPending = Math.max(maxPending, stats.pending); }
  }
  const final = r.reconcile(t + 3_700_000, true);
  return { canonicalChanges: produced + final.changes.length, maxPending, pendingAfter: final.stats.pending };
});

const records: ProvenanceRecord[] = [];
for (let i = 0; i < 50_000; i++) {
  const change = reconciler().agentChange({ id: randomUUID(), tool: i % 2 ? "claude-code" : "codex", sessionKey: hash(`s${i % 40}`), turnKey: hash(`t${i % 400}`), at: t + i * 1_000,
    file: file(`s${i % 500}.ts`), operation: "modified", delta: { linesAdded: 2, linesRemoved: 1 } });
  records.push(toChangeRecord(change, "bench"));
  if (i % 10 === 0) records.push({ kind: "agent", recordId: randomUUID(), installationId: "bench", at: new Date(t + i * 1_000).toISOString(), tool: i % 2 ? "claude-code" : "codex",
    signal: i % 20 ? "tool_finished" : "turn_stopped", sessionKey: hash(`s${i % 40}`), turnKey: hash(`t${i % 400}`), toolKind: "edit" });
}
measure("summary over 55,000 local records", { explicitEvents: 50_000 }, () => {
  const summary = summarizeAgentActivity({ records, range: { from: new Date(t).toISOString(), to: new Date(t + 60 * 86_400_000).toISOString() }, now: t + 60 * 86_400_000 });
  return { explicitEvents: summary.agent.explicit.events, runs: summary.agent.runs.total };
});

const patch = Array.from({ length: 1_000 }, (_, i) => (i % 3 ? ` context ${i}` : i % 2 ? `+added ${i}` : `-removed ${i}`)).join("\n");
measure("normalize 1,000 hook payloads (1,000-line patches)", { records: 2_000 }, () => {
  let produced = 0;
  for (let i = 0; i < 1_000; i++) {
    if (claudeCodeAdapter.normalize({ session_id: "s", cwd: "/w", prompt_id: "p", hook_event_name: "PostToolUse", tool_name: "Edit", tool_use_id: `c${i}`,
      tool_input: { file_path: "/w/a.ts", old_string: "x", new_string: "y" }, tool_response: { structuredPatch: [{ lines: patch.split("\n") }] } }, t, randomUUID())) produced++;
    if (codexAdapter.normalize({ session_id: "s", cwd: "/w", turn_id: "t", hook_event_name: "PostToolUse", tool_name: "apply_patch", tool_use_id: `c${i}`,
      tool_input: { command: `*** Begin Patch\n*** Update File: a.ts\n@@\n${patch}\n*** End Patch` }, tool_response: "Exit code: 0\nOutput: Success." }, t, randomUUID())) produced++;
  }
  return { records: produced };
});

console.table(results);
console.log(`Node ${process.version}; GC ${gc ? "exposed" : "not exposed (heap growth is approximate)"}.`);

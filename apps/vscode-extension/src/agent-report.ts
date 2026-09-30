import type { AgentActivitySummary } from "@stack-stats/core";
import type { AgentTool } from "@stack-stats/protocol";
import { formatDuration } from "./presentation.js";

const names: Record<AgentTool, string> = { "claude-code": "Claude Code", codex: "Codex", cursor: "Cursor", other: "Other agent" };
const n = (value: number) => value.toLocaleString("en-US");
const lines = (counters: { linesAdded: number; linesRemoved: number; deltaUnknown: number; events: number }) =>
  counters.events ? `diff lines +${n(counters.linesAdded)} / −${n(counters.linesRemoved)}${counters.deltaUnknown ? ` (${n(counters.deltaUnknown)} without line counts)` : ""}` : "";
const ago = (iso: string | null, now: number) => iso ? `last signal ${formatDuration(Math.max(0, now - Date.parse(iso)))} ago` : "no signals yet";

export interface AgentReportContext { integrations: Record<"claude-code" | "codex", boolean>; filesystem: boolean; collecting: boolean; now: number; title?: string }

/** Plain-text local inspection. Categories are listed side by side with their own
 * units; nothing is combined into an "AI-written" percentage. */
export function formatAgentActivity(summary: AgentActivitySummary, context: AgentReportContext): string {
  const { agent, external, editor } = summary;
  const byTool = new Map(agent.byTool.map((entry) => [entry.tool, entry]));
  const out: string[] = [`Stack Stats — ${context.title ?? "Agent & external activity"} (local only, never uploaded)`, ""];
  out.push("Sources");
  for (const tool of ["claude-code", "codex"] as const) {
    const entry = byTool.get(tool);
    out.push(`  ${names[tool]} integration: ${context.integrations[tool] ? `enabled · ${ago(entry?.lastSignalAt ?? null, context.now)}` : "off (Set Up Agent Integrations)"}`);
  }
  out.push(`  External change observation: ${!context.collecting ? "paused" : context.filesystem ? "on (workspace watcher + open-document reloads)" : "off (stackStats.collectFilesystem)"}`, "");
  out.push("Editor activity (definitions unchanged; agents never extend it)",
    `  Active coding time: ${formatDuration(editor.activeMs)}`,
    `  Editor edits: ${n(editor.edits)} · line boundaries +${n(editor.linesAdded)} / −${n(editor.linesRemoved)}`,
    `  Of which during save participants (format/organize on save, correlated): ${n(editor.saveParticipantEdits)} edit(s)`);
  if (editor.reportedAiEdits || editor.reportedHumanEdits) out.push(`  Provider-reported: ${n(editor.reportedAiEdits)} AI, ${n(editor.reportedHumanEdits)} human edit(s)`);
  out.push("", "Agent runs (turns from hook lifecycle; time = first observed tool call → turn end, a lower bound)");
  const tools = agent.byTool.filter((entry) => entry.runs || entry.explicit.events || entry.correlated.events);
  if (!tools.length) out.push("  None observed.");
  for (const entry of tools) {
    out.push(`  ${names[entry.tool]}: ${n(entry.runs)} run(s), ${n(entry.completedRuns)} completed · observed ${formatDuration(entry.observedRunMs)}`);
  }
  if (agent.runs.total) out.push(`  States: ${Object.entries(agent.runs).filter(([key, value]) => !["total", "withoutFileChanges"].includes(key) && value).map(([key, value]) => `${value} ${key}`).join(", ")}; ${n(agent.runs.withoutFileChanges)} without file changes`,
    `  Agent wall time (overlaps merged): ${formatDuration(agent.wallMs)} · overlapping your editor activity: ${formatDuration(agent.overlapWithEditorActivityMs)}`);
  out.push("", "Agent-reported file changes (explicit hook evidence)");
  if (!agent.explicit.events) out.push("  None.");
  for (const entry of tools) if (entry.explicit.events) out.push(`  ${names[entry.tool]}: ${n(entry.explicit.events)} change(s) to ${n(entry.explicit.files)} file(s) · ${lines(entry.explicit)}`);
  out.push("Changes during agent shell commands (correlated, not explicitly reported)");
  if (!agent.correlated.events) out.push("  None.");
  for (const entry of tools) if (entry.correlated.events) out.push(`  ${names[entry.tool]}: ${n(entry.correlated.events)} change(s) to ${n(entry.correlated.files)} file(s)${entry.correlated.linesAdded || entry.correlated.linesRemoved ? ` · ${lines(entry.correlated)}` : ""}`);
  out.push("", "External changes (writer unknown)",
    `  ${n(external.unknown.events)} change(s) to ${n(external.unknown.files)} file(s)${external.unknown.events ? ` · ${lines(external.unknown)}` : ""}`,
    `  Version-control operations: ${n(external.vcs.events)} file change(s), ${n(external.bulk.vcsOperations)} bulk operation(s)`,
    `  Bulk changes (checkout/install/codegen-sized bursts): ${n(external.bulk.operations)} operation(s) touching ${n(external.bulk.files)} file(s)`,
    `  Overlapping several agents (ambiguous): ${n(external.ambiguous.events)}`,
    `  During agent runs but not attributed: ${n(external.duringAgentRunsUnattributed)}`);
  if (summary.laterEditorEditsInAgentChangedFiles) out.push("", `Editor edits later made in agent-changed files (file-level proxy, not line ownership): ${n(summary.laterEditorEditsInAgentChangedFiles)}`);
  const gaps = Object.entries(summary.coverage);
  if (gaps.length) out.push("", `Coverage gaps: ${gaps.map(([reason, count]) => `${reason} ${n(count)}`).join(", ")}`);
  out.push("", "Limits: activity, not authorship. Line counts show change volume, not code that survived. Unknown stays unknown; no timing, size or speed heuristic assigns an agent.");
  return out.join("\n");
}

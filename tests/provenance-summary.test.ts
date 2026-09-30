import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { deriveAgentRuns, summarizeAgentActivity, queryTelemetry } from "@stack-stats/core";
import { provenanceRecordSchema, telemetryEventSchema, type ProvenanceAgentRecord, type ProvenanceChangeRecord, type ProvenanceRecord, type TelemetryEvent } from "@stack-stats/protocol";
import { hash, source, telemetryContext } from "./telemetry-fixtures.js";

const t = Date.parse("2026-09-29T12:00:00Z");
const iso = (offset: number) => new Date(t + offset).toISOString();
const range = { from: "2026-09-29T00:00:00Z", to: "2026-09-30T00:00:00Z" };
const session = hash("session"), turn = hash("turn");
const signal = (signal: ProvenanceAgentRecord["signal"], offset: number, extra: Partial<ProvenanceAgentRecord> = {}): ProvenanceAgentRecord =>
  provenanceRecordSchema.parse({ kind: "agent", recordId: randomUUID(), installationId: "test-install", at: iso(offset), tool: "claude-code", signal, sessionKey: session,
    turnKey: turn, projectId: telemetryContext.projectId, ...extra }) as ProvenanceAgentRecord;
const change = (offset: number, extra: Partial<ProvenanceChangeRecord> = {}): ProvenanceChangeRecord =>
  provenanceRecordSchema.parse({ kind: "change", recordId: randomUUID(), installationId: "test-install", firstObservedAt: iso(offset), observedAt: iso(offset),
    projectId: telemetryContext.projectId, fileId: telemetryContext.fileId, languageId: "typescript", operation: "modified", origin: "external", actor: "unknown",
    confidence: "none", reason: "no_evidence", delta: null, observations: { watcher: 2, reload: 0, adapter: 0 }, ...extra }) as ProvenanceChangeRecord;
const explicit = (offset: number, fileId = telemetryContext.fileId, delta: ProvenanceChangeRecord["delta"] = { linesAdded: 10, linesRemoved: 2, source: "adapter" }) =>
  change(offset, { origin: "agent_adapter", actor: "agent", tool: "claude-code", confidence: "explicit", reason: undefined, fileId, agent: { sessionKey: session, turnKey: turn },
    delta, observations: { watcher: 0, reload: 0, adapter: 1 } });
const telemetry = (eventType: "editor.edit" | "activity.interval", offset: number, data: Record<string, unknown>, context = telemetryContext): TelemetryEvent =>
  telemetryEventSchema.parse({ schemaVersion: "2.0", eventId: randomUUID(), occurredAt: iso(offset), source, context, evidence: eventType === "editor.edit" ? "observed" : "inferred", eventType, data });
const editorEdit = (offset: number, editCount = 2) => telemetry("editor.edit", offset, { startedAt: iso(offset), firstVersion: 2, lastVersion: 3, editCount,
  linesAdded: 1, linesRemoved: 0, charactersAdded: 10, charactersRemoved: 0, undoCount: 0, redoCount: 0 });
const interval = (from: number, to: number) => telemetry("activity.interval", to, { startedAt: iso(from) });

describe("agent run derivation", () => {
  it("derives one run per turn from the first observed tool call (lower bound) to the Stop hook", () => {
    const records = [signal("session_started", -60_000), signal("tool_finished", 5_000, { toolKind: "shell", durationMs: 2_000, callKey: hash("c1") }),
      signal("tool_finished", 8_000, { toolKind: "edit", callKey: hash("c2"), success: true }), signal("turn_stopped", 20_000, { endReason: "completed" })];
    const [run] = deriveAgentRuns([...records, records[1]!], t + 60_000);
    expect(run).toMatchObject({ state: "completed", startedAt: t + 3_000, endedAt: t + 20_000, toolCalls: 2, shellCalls: 1, editCalls: 1 });
  });

  it("keeps a tool-free turn as a zero-length completed run and separates ended, interrupted, incomplete and running runs", () => {
    const now = t + 3_600_000;
    const records = [
      signal("turn_stopped", 0),
      signal("tool_finished", 1_000, { turnKey: hash("t2"), toolKind: "shell", callKey: hash("x") }), signal("session_ended", 5_000, { turnKey: undefined, endReason: "session_ended" }),
      signal("tool_started", 10_000, { sessionKey: hash("s2"), turnKey: hash("t3"), toolKind: "shell", callKey: hash("y") }), signal("interrupted", 12_000, { sessionKey: hash("s2"), turnKey: undefined, endReason: "interrupted" }),
      signal("tool_finished", 20_000, { sessionKey: hash("s3"), turnKey: hash("t4"), toolKind: "edit", callKey: hash("z") }),
      signal("tool_finished", now - t - 60_000, { sessionKey: hash("s4"), turnKey: hash("t5"), toolKind: "edit", callKey: hash("w") })
    ];
    const states = deriveAgentRuns(records, now).map((run) => [run.state, run.endedAt - run.startedAt]);
    expect(states).toEqual([["completed", 0], ["ended", 4_000], ["interrupted", 2_000], ["incomplete", 0], ["running", 60_000]]);
  });

  it("groups turns without IDs by Stop sequence", () => {
    const records = [signal("tool_finished", 0, { turnKey: undefined, toolKind: "shell", callKey: hash("a") }), signal("turn_stopped", 1_000, { turnKey: undefined }),
      signal("tool_finished", 2_000, { turnKey: undefined, toolKind: "shell", callKey: hash("b") }), signal("turn_stopped", 4_000, { turnKey: undefined })];
    expect(deriveAgentRuns(records, t + 10_000).map((run) => [run.startedAt - t, run.endedAt - t])).toEqual([[0, 1_000], [2_000, 4_000]]);
  });
});

describe("local agent activity summary", () => {
  const records: ProvenanceRecord[] = [
    signal("tool_finished", 0, { toolKind: "edit", callKey: hash("e1"), success: true }), signal("turn_stopped", 600_000),
    explicit(1_000), explicit(2_000, hash("file-2"), null),
    change(3_000, { origin: "external", actor: "agent", tool: "claude-code", confidence: "correlated", reason: undefined, fileId: hash("file-3"), agent: { sessionKey: session, turnKey: turn, callKey: hash("c9") } }),
    change(4_000, { fileId: hash("file-4"), delta: { linesAdded: 3, linesRemoved: 1, source: "document_reload" } }),
    change(900_000, { fileId: hash("file-5") }),
    change(5_000, { fileId: hash("file-6"), reason: "vcs_operation" }),
    change(6_000, { fileId: undefined, operation: "bulk", reason: "vcs_operation", languageId: "unknown", bulk: { files: 40, created: 0, modified: 40, deleted: 0 } }),
    { kind: "save_participant", recordId: randomUUID(), installationId: "test-install", at: iso(7_000), projectId: telemetryContext.projectId, fileId: telemetryContext.fileId, languageId: "typescript", edits: 1, linesAdded: 2, linesRemoved: 0 },
    { kind: "coverage", recordId: randomUUID(), installationId: "test-install", at: iso(8_000), capability: "agent_inbox", reason: "inbox_expired", dropped: 3 }
  ];
  const events = [interval(-30_000, 0), interval(0, 30_000), interval(1_200_000, 1_230_000), editorEdit(-10_000), editorEdit(700_000, 5)];

  it("reports agent time beside, never inside, editor activity time", () => {
    const summary = summarizeAgentActivity({ records, telemetry: events, range, now: t + 3_600_000 });
    expect(summary.editor).toMatchObject({ activeMs: 90_000, edits: 7, linesAdded: 2, saveParticipantEdits: 1, unit: "editor line boundaries" });
    expect(summary.editor.activeMs).toBe(queryTelemetry(events, range).activeMs);
    expect(summary.agent).toMatchObject({ observedRunMs: 600_000, wallMs: 600_000, overlapWithEditorActivityMs: 30_000, unit: "diff lines" });
    expect(summary.agent.runs).toMatchObject({ total: 1, completed: 1, withoutFileChanges: 0 });
    // Same inputs without any provenance: editor edits, lines and time do not move.
    const { edits, linesAdded, linesRemoved, activeMs } = summarizeAgentActivity({ records: [], telemetry: events, range }).editor;
    expect({ edits, linesAdded, linesRemoved, activeMs }).toEqual({ edits: summary.editor.edits, linesAdded: summary.editor.linesAdded, linesRemoved: summary.editor.linesRemoved, activeMs: summary.editor.activeMs });
  });

  it("keeps explicit, correlated, unknown, VCS and bulk populations separate, with honest unknown line counts", () => {
    const summary = summarizeAgentActivity({ records, telemetry: events, range, now: t + 3_600_000 });
    expect(summary.agent.explicit).toEqual({ events: 2, files: 2, linesAdded: 10, linesRemoved: 2, deltaUnknown: 1 });
    expect(summary.agent.correlated).toMatchObject({ events: 1, files: 1, deltaUnknown: 1 });
    expect(summary.external.unknown).toEqual({ events: 2, files: 2, linesAdded: 3, linesRemoved: 1, deltaUnknown: 1 });
    expect(summary.external.vcs.events).toBe(1);
    expect(summary.external.bulk).toEqual({ operations: 1, files: 40, vcsOperations: 1 });
    expect(summary.external.duringAgentRunsUnattributed).toBe(1);
    expect(summary.agent.byTool[0]).toMatchObject({ tool: "claude-code", runs: 1, completedRuns: 1 });
    expect(summary.laterEditorEditsInAgentChangedFiles).toBe(5);
    expect(summary.coverage).toEqual({ inbox_expired: 3 });
    expect(summary.limitations).toMatchObject({ authorshipVerified: false, agentTimeIsNotHumanTime: true, runDurationIsLowerBound: true });
    expect(JSON.stringify(summary)).not.toMatch(/share|percent/i);
  });

  it("drops superseded changes and duplicate records", () => {
    const unknown = change(1_000);
    const late = { ...explicit(1_200), supersedes: [unknown.recordId] };
    const summary = summarizeAgentActivity({ records: [unknown, late, late], range });
    expect(summary.external.unknown.events).toBe(0);
    expect(summary.agent.explicit.events).toBe(1);
  });

  it("counts agent runs without file changes", () => {
    const summary = summarizeAgentActivity({ records: [signal("turn_stopped", 0, { turnKey: hash("chat-only") })], range, now: t + 1 });
    expect(summary.agent.runs).toMatchObject({ total: 1, withoutFileChanges: 1 });
    expect(summary.agent.observedRunMs).toBe(0);
  });
});

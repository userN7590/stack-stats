import { describe, it, expect } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { telemetryEventSchema, telemetryQuerySchema, type TelemetryEvent } from "@stack-stats/protocol";
import { queryTelemetry, compareTelemetry, resolveAttribution, PrivacyPolicy, countCharacterChanges } from "@stack-stats/core";
import { TelemetryBuffer } from "../apps/vscode-extension/src/telemetry-buffer.js";

import { hash, telemetryContext, source, at, range, edit, report } from "./telemetry-fixtures.js";

describe("normalized telemetry contract and attribution", () => {
  it("rejects arbitrary payloads, source text, secrets, invalid intervals and invented verified claims", () => {
    const event = edit();
    expect(telemetryEventSchema.safeParse({ ...event, schemaVersion: "9.0" }).success).toBe(false);
    expect(telemetryEventSchema.safeParse({ ...event, data: { ...event.data, sourceCode: "secret" } }).success).toBe(false);
    expect(telemetryEventSchema.safeParse({ ...event, context: { projectId: "/Users/private" } }).success).toBe(false);
    expect(telemetryEventSchema.safeParse({ ...report(event.eventId), evidence: "observed" }).success).toBe(false);
    expect(telemetryEventSchema.safeParse({ ...event, eventType: "activity.interval", data: { startedAt: "2026-09-07T11:00:00Z" } }).success).toBe(false);
    expect(telemetryQuerySchema.safeParse({ from: range.to, to: range.from }).success).toBe(false);
    expect(telemetryQuerySchema.safeParse({ from: "2020-01-01T00:00:00Z", to: range.to }).success).toBe(false);
  });

  it("keeps unannotated edits unknown, annotates without double counting and retains unknown in ratios", () => {
    const first = edit(), second = edit();
    const stats = queryTelemetry([first, first, second, report(first.eventId)], range);
    expect(stats.edits).toMatchObject({ editCount: 6, charactersAdded: 40, charactersRemoved: 20 });
    expect(stats.attribution).toMatchObject({ reportedAiShare: 0.5, reportedHumanShare: 0, unknownShare: 0.5, exactHumanModifiedAiCharacters: null });
    expect(stats.attribution.agents[0]).toMatchObject({ agent: "codex", editCount: 3 });
    expect(queryTelemetry([], range).attribution.reportedAiShare).toBeNull();
  });

  it("treats contradictory provider reports conservatively, independent of delivery order", () => {
    const event = edit(), one = report(event.eventId), two = report(event.eventId, "ai", "claude-code");
    for (const events of [[one, two], [two, one, one]]) expect(resolveAttribution(events).get(event.eventId)).toMatchObject({ actor: "unknown", conflict: true });
    expect(queryTelemetry([event, one, two], range).attribution).toMatchObject({ unknownShare: 1, conflicts: 1 });
  });

  it("counts later edits to an AI-touched file only as a file-level proxy", () => {
    const first = edit(), second = edit({ occurredAt: "2026-09-07T12:00:10Z" });
    const stats = queryTelemetry([second, report(first.eventId), first], range);
    expect(stats.attribution.laterEditorEditsInAiTouchedFiles).toBe(3);
    expect(stats.attribution.exactHumanModifiedAiCharacters).toBeNull();
  });

  it("clips active intervals to query bounds and splits hourly time exactly", () => {
    const interval = telemetryEventSchema.parse({ ...edit(), eventType: "activity.interval", occurredAt: "2026-09-07T13:00:10Z", data: { startedAt: "2026-09-07T12:59:50Z" }, evidence: "inferred" });
    const stats = queryTelemetry([interval], range);
    expect(stats.activeMs).toBe(20_000);
    expect(stats.hourlyUtc[12]?.activeMs).toBe(10_000);
    expect(stats.hourlyUtc[13]?.activeMs).toBe(10_000);
    expect(queryTelemetry([interval], { from: "2026-09-07T13:00:00Z", to: "2026-09-07T13:00:05Z" }).activeMs).toBe(5000);
    expect(compareTelemetry([interval], range, { from: "2026-08-31T00:00:00Z", to: "2026-09-01T00:00:00Z" }).delta.activeMs).toEqual({ absolute: 20_000, relative: null });
  });

  it("derives switches, task outcomes, debug duration and latest diagnostics without adding snapshots", () => {
    const buffer = new TelemetryBuffer("test");
    const start = Date.parse(at), id = randomUUID();
    buffer.emit("context.switched", { from: telemetryContext, to: { ...telemetryContext, projectId: hash("other"), languageId: "sql" } }, telemetryContext, start);
    buffer.emit("task.lifecycle", { executionId: id, group: "test", state: "started" }, telemetryContext, start);
    buffer.emit("task.lifecycle", { executionId: id, group: "test", state: "process_ended", exitCode: 1 }, telemetryContext, start + 1000);
    buffer.emit("task.lifecycle", { executionId: id, group: "test", state: "ended" }, telemetryContext, start + 1500);
    buffer.emit("debug.lifecycle", { executionId: id, state: "started", debugTypeId: hash("node") }, telemetryContext, start);
    buffer.emit("debug.lifecycle", { executionId: id, state: "ended", debugTypeId: hash("node") }, telemetryContext, start + 2000);
    buffer.emit("diagnostics.snapshot", { errors: 3, warnings: 0, information: 0, hints: 0 }, telemetryContext, start);
    buffer.emit("diagnostics.snapshot", { errors: 1, warnings: 0, information: 0, hints: 0 }, telemetryContext, start + 1000);
    const stats = queryTelemetry(buffer.drain(), range);
    expect(stats.switches).toEqual({ projects: 1, languages: 1, files: 0 });
    expect(stats.workflows).toMatchObject({ tests: 1, builds: 0, taskFailures: 1, completedTasks: 1, taskDurationMs: 1500, debugDurationMs: 2000 });
    expect(stats.latestDiagnostics).toMatchObject([{ errors: 1 }]);
  });
});

describe("privacy and bounded event batching", () => {
  it("excludes secrets/generated files and excluded projects for paths and nested Git observations", () => {
    const policy = new PrivacyPolicy(["**/private/**"], ["secret-project"]);
    for (const path of ["/work/.env", "/work/.env.local", "/work/node_modules/a.ts", "/work/a.key", "/work/private/a.ts", "/work/secret-project/a.ts"]) expect(policy.allows("/work", path)).toBe(false);
    expect(policy.allows("C:\\work", "C:\\work\\.env")).toBe(false);
    expect(policy.allowsProject("/home/secret-project")).toBe(false);
    expect(policy.allowsProject("/home/secret-project/nested")).toBe(false);
    expect(new PrivacyPolicy([], ["/home/private/**"]).allowsProject("/home/private")).toBe(false);
    expect(new PrivacyPolicy([], ["C:\\work\\private"]).allowsProject("C:\\work\\private\\nested")).toBe(false);
    expect(policy.allows("/work", "/work/src/index.ts")).toBe(true);
    expect(policy.allows("/work", "/work/env.ts")).toBe(true);
  });

  it("counts character edits as UTF-16 units and batches rapid edits without retaining text", () => {
    expect(countCharacterChanges([{ text: "a😀\n", rangeLength: 2, range: { start: { line: 0 }, end: { line: 0 } } }])).toEqual({ charactersAdded: 4, charactersRemoved: 2 });
    const buffer = new TelemetryBuffer("test");
    const context = { project: { projectId: telemetryContext.projectId, displayName: "Project", rootKind: "workspace" as const }, file: { fileId: telemetryContext.fileId, languageId: "typescript", category: "source" as const } };
    for (let i = 0; i < 1000; i++) buffer.edit({ documentId: "memory-only", version: i + 1, at: Date.parse(at) + i,
      dirty: true, focused: true, visible: true, undoRedo: false, context, counts: { editCount: 1, linesAdded: 0, linesRemoved: 0 }, characters: { charactersAdded: 1, charactersRemoved: 0 } });
    const events = buffer.drain();
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toMatchObject({ editCount: 1000, charactersAdded: 1000 });
    expect(JSON.stringify(events)).not.toContain("memory-only");
    expect(telemetryEventSchema.safeParse(events[0]).success).toBe(true);
  });

  it("caps observations and emits a coverage gap instead of silently implying completeness", () => {
    const buffer = new TelemetryBuffer("test", 2);
    for (let i = 0; i < 10; i++) buffer.emit("window.focus", { focused: true });
    expect(buffer.drain()).toHaveLength(2);
    expect(buffer.drain()[0]?.data).toMatchObject({ state: "gap", droppedObservations: 8 });
  });
});

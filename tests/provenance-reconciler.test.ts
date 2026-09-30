import { describe, expect, it } from "vitest";
import { ChangeReconciler, toChangeRecord, type FileRef } from "@stack-stats/core";
import { provenanceRecordSchema } from "@stack-stats/protocol";
import { hash } from "./telemetry-fixtures.js";

const t = Date.parse("2026-09-29T12:00:00Z");
const file = (name: string, workspace = "ws1"): FileRef => ({ key: `file:///${workspace}/${name}`, workspaceKey: `file:///${workspace}`,
  projectId: hash(workspace), fileId: hash(`${workspace}/${name}`), languageId: "typescript" });
let ids = 0;
const reconciler = (options: Partial<ConstructorParameters<typeof ChangeReconciler>[0]> = {}) =>
  new ChangeReconciler({ createId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`, ...options });
const session = hash("session-a"), other = hash("session-b");
const shell = (callKey: string, at: number, extra: Partial<Parameters<ChangeReconciler["toolStarted"]>[0]> = {}) =>
  ({ callKey: hash(callKey), tool: "claude-code" as const, sessionKey: session, turnKey: hash("turn-1"), workspaceKey: "file:///ws1", at, ...extra });

describe("canonical change reconciliation", () => {
  it("merges the two watcher notifications of one external write into one unknown change, after the settle window", () => {
    const r = reconciler();
    r.observe({ kind: "watcher", file: file("a.ts"), operation: "changed", at: t });
    r.observe({ kind: "watcher", file: file("a.ts"), operation: "changed", at: t + 60 });
    expect(r.reconcile(t + 5_000).changes).toEqual([]);
    const { changes, stats } = r.reconcile(t + 25_000);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ origin: "external", actor: "unknown", confidence: "none", reason: "no_evidence", operation: "modified", delta: null, observations: { watcher: 2, reload: 0, adapter: 0 } });
    expect(changes[0]!.tool).toBeUndefined();
    expect(stats).toMatchObject({ duplicateNotificationsMerged: 1, pending: 0 });
    expect(provenanceRecordSchema.safeParse(toChangeRecord(changes[0]!, "install")).success).toBe(true);
  });

  it("treats a VS Code save (or file operation) and its disk notifications as editor activity, not an external change", () => {
    const r = reconciler();
    r.observe({ kind: "editor_write", file: file("a.ts"), at: t });
    r.observe({ kind: "watcher", file: file("a.ts"), operation: "created", at: t + 80 });
    r.observe({ kind: "watcher", file: file("a.ts"), operation: "changed", at: t + 180 });
    const { changes, stats } = r.reconcile(t + 60_000);
    expect(changes).toEqual([]);
    expect(stats.editorWritesSuppressed).toBe(2);
  });

  it("uses an open document's reload for exact diff lines, and drops a reload without disk corroboration (File: Revert)", () => {
    const r = reconciler();
    r.observe({ kind: "watcher", file: file("open.ts"), operation: "changed", at: t });
    r.observe({ kind: "reload", file: file("open.ts"), at: t + 5, linesAdded: 2, linesRemoved: 1 });
    r.observe({ kind: "reload", file: file("reverted.ts"), at: t, linesAdded: 0, linesRemoved: 1 });
    const { changes, stats } = r.reconcile(t + 60_000);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ fileId: file("open.ts").fileId, operation: "modified", delta: { linesAdded: 2, linesRemoved: 1, source: "document_reload" } });
    expect(stats.uncorroboratedReloads).toBe(1);
  });

  it("lets an explicit adapter report absorb every duplicate observation of the same write", () => {
    const r = reconciler();
    r.observe({ kind: "watcher", file: file("a.ts"), operation: "created", at: t });
    r.observe({ kind: "reload", file: file("a.ts"), at: t + 4, linesAdded: 3, linesRemoved: 1 });
    r.observe({ kind: "watcher", file: file("a.ts"), operation: "changed", at: t + 100 });
    const explicit = r.agentChange({ id: "11111111-1111-4111-8111-111111111111", tool: "claude-code", sessionKey: session, turnKey: hash("turn-1"), callKey: hash("call"),
      at: t + 150, file: file("a.ts"), operation: "modified", delta: { linesAdded: 3, linesRemoved: 1 } });
    expect(explicit).toMatchObject({ origin: "agent_adapter", actor: "agent", confidence: "explicit", tool: "claude-code", delta: { linesAdded: 3, linesRemoved: 1, source: "adapter" }, observations: { adapter: 1 } });
    const { changes, stats } = r.reconcile(t + 60_000);
    expect(changes).toEqual([]);
    expect(stats).toMatchObject({ watcherAbsorbed: 2, reloadAbsorbed: 1 });
    expect(provenanceRecordSchema.safeParse(toChangeRecord(explicit, "install")).success).toBe(true);
  });

  it("replaces an already-finalized unattributed change when the explicit report arrives late (no double count)", () => {
    const r = reconciler();
    r.observe({ kind: "watcher", file: file("a.ts"), operation: "changed", at: t });
    const [unknown] = r.reconcile(t + 25_000).changes;
    const explicit = r.agentChange({ id: "22222222-2222-4222-8222-222222222222", tool: "codex", sessionKey: session, at: t + 400, file: file("a.ts"), operation: "modified", delta: null });
    expect(explicit.supersedes).toEqual([unknown!.id]);
    // A report for an unrelated time does not supersede anything.
    expect(r.agentChange({ id: "33333333-3333-4333-8333-333333333333", tool: "codex", sessionKey: session, at: t + 200_000, file: file("a.ts"), operation: "modified", delta: null }).supersedes).toBeUndefined();
  });

  it("correlates a change only inside a bounded agent shell-command window in the same workspace", () => {
    const r = reconciler();
    r.toolStarted(shell("c1", t - 1_000));
    r.observe({ kind: "watcher", file: file("in.ts"), operation: "changed", at: t });
    r.toolFinished(shell("c1", t + 2_000));
    r.observe({ kind: "watcher", file: file("after.ts"), operation: "changed", at: t + 10_000 });
    r.observe({ kind: "watcher", file: file("elsewhere.ts", "ws2"), operation: "changed", at: t + 500 });
    const changes = r.reconcile(t + 60_000).changes;
    const by = (name: string, workspace = "ws1") => changes.find((change) => change.fileId === file(name, workspace).fileId)!;
    expect(by("in.ts")).toMatchObject({ origin: "external", actor: "agent", confidence: "correlated", tool: "claude-code", agent: { sessionKey: session, callKey: hash("c1") } });
    expect(by("after.ts")).toMatchObject({ actor: "unknown", reason: "no_evidence" });
    expect(by("elsewhere.ts", "ws2")).toMatchObject({ actor: "unknown", reason: "no_evidence" });
    for (const change of changes) expect(provenanceRecordSchema.safeParse(toChangeRecord(change, "install")).success).toBe(true);
  });

  it("bounds a Claude shell window by duration_ms when no start signal exists", () => {
    const r = reconciler();
    r.observe({ kind: "watcher", file: file("a.ts"), operation: "changed", at: t });
    r.toolFinished({ ...shell("c2", t + 500), durationMs: 2_000 });
    expect(r.reconcile(t + 60_000).changes[0]).toMatchObject({ confidence: "correlated" });
  });

  it("holds observations while an agent command is still running, then correlates when it finishes", () => {
    const r = reconciler();
    r.toolStarted(shell("long", t - 1_000));
    r.observe({ kind: "watcher", file: file("a.ts"), operation: "changed", at: t });
    expect(r.reconcile(t + 30_000).changes).toEqual([]);
    r.toolFinished(shell("long", t + 40_000));
    expect(r.reconcile(t + 70_000).changes[0]).toMatchObject({ confidence: "correlated" });
  });

  it("refuses to pick between overlapping agents", () => {
    const r = reconciler();
    r.toolStarted(shell("a", t - 1_000)); r.toolFinished(shell("a", t + 1_000));
    r.toolStarted(shell("b", t - 1_000, { sessionKey: other, tool: "codex" })); r.toolFinished(shell("b", t + 1_000, { sessionKey: other, tool: "codex" }));
    r.observe({ kind: "watcher", file: file("a.ts"), operation: "changed", at: t });
    expect(r.reconcile(t + 60_000).changes[0]).toMatchObject({ actor: "unknown", confidence: "none", reason: "ambiguous_agents" });
  });

  it("never attributes version-control churn to an agent, whether seen via .git refs or a VCS shell command", () => {
    const r = reconciler();
    r.toolStarted(shell("checkout", t - 1_000)); r.toolFinished(shell("checkout", t + 1_000));
    r.observe({ kind: "vcs", workspaceKey: "file:///ws1", at: t + 50 });
    r.observe({ kind: "watcher", file: file("a.ts"), operation: "changed", at: t });
    expect(r.reconcile(t + 60_000).changes[0]).toMatchObject({ actor: "unknown", reason: "vcs_operation" });
    const flagged = reconciler();
    flagged.toolStarted(shell("git", t - 1_000, { vcs: true })); flagged.toolFinished(shell("git", t + 1_000));
    flagged.observe({ kind: "watcher", file: file("b.ts"), operation: "changed", at: t });
    expect(flagged.reconcile(t + 60_000).changes[0]).toMatchObject({ actor: "unknown", reason: "vcs_operation" });
  });

  it("collapses a branch-switch-sized burst into one unattributed bulk record, even inside an agent window", () => {
    const r = reconciler();
    r.toolStarted(shell("install", t - 1_000));
    for (let i = 0; i < 800; i++) r.observe({ kind: "watcher", file: file(`f${i}.ts`), operation: i % 10 ? "changed" : "created", at: t + i });
    r.toolFinished(shell("install", t + 2_000));
    const { changes } = r.reconcile(t + 60_000);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ operation: "bulk", actor: "unknown", confidence: "none", reason: "bulk_change", bulk: { files: 800, created: 80, modified: 720, deleted: 0 } });
    expect(changes[0]!.fileId).toBeUndefined();
    expect(provenanceRecordSchema.safeParse(toChangeRecord(changes[0]!, "install")).success).toBe(true);
  });

  it("does not swallow separate changes made seconds before a bulk burst", () => {
    const r = reconciler();
    r.observe({ kind: "watcher", file: file("edited.ts"), operation: "changed", at: t });
    r.observe({ kind: "watcher", file: file("also-edited.ts"), operation: "changed", at: t + 2_500 });
    for (let i = 0; i < 40; i++) r.observe({ kind: "watcher", file: file(`gen/${i}.ts`), operation: "created", at: t + 4_000 + i * 5 });
    const { changes } = r.reconcile(t + 60_000);
    expect(changes.map((change) => change.operation).sort()).toEqual(["bulk", "modified", "modified"]);
    expect(changes.find((change) => change.operation === "bulk")!.bulk!.files).toBe(40);
  });

  it("classifies Claude-style atomic replacement as a modification and drops its temporary file", () => {
    const r = reconciler();
    r.observe({ kind: "watcher", file: file("a.ts"), operation: "created", at: t });
    r.observe({ kind: "watcher", file: file("a.ts"), operation: "changed", at: t + 100 });
    r.observe({ kind: "watcher", file: file("scratch.ts"), operation: "created", at: t });
    r.observe({ kind: "watcher", file: file("scratch.ts"), operation: "deleted", at: t + 40 });
    r.observe({ kind: "watcher", file: file("new.ts"), operation: "created", at: t });
    r.observe({ kind: "watcher", file: file("gone.ts"), operation: "deleted", at: t });
    const { changes, stats } = r.reconcile(t + 60_000);
    const operation = (name: string) => changes.find((change) => change.fileId === file(name).fileId)?.operation;
    expect([operation("a.ts"), operation("scratch.ts"), operation("new.ts"), operation("gone.ts")]).toEqual(["modified", undefined, "created", "deleted"]);
    expect(stats.ephemeralDropped).toBe(1);
  });

  it("splits repeated writes to one file only across quiet gaps", () => {
    const r = reconciler();
    for (const offset of [0, 900, 1_800, 2_700]) r.observe({ kind: "watcher", file: file("a.ts"), operation: "changed", at: t + offset });
    r.observe({ kind: "watcher", file: file("a.ts"), operation: "changed", at: t + 10_000 });
    expect(r.reconcile(t + 60_000).changes).toHaveLength(2);
  });

  it("keeps settling under steady streams: continuous writers never grow one endless burst or cluster", () => {
    const r = reconciler();
    let changes = 0, maxPending = 0;
    for (let second = 0; second < 600; second++) {
      r.observe({ kind: "watcher", file: file(`s${second % 20}.ts`), operation: "changed", at: t + second * 1_000 });
      r.observe({ kind: "watcher", file: file("server.log.ts"), operation: "changed", at: t + second * 1_000 + 500 });
      if (second % 15 === 0) { const result = r.reconcile(t + second * 1_000); changes += result.changes.length; maxPending = Math.max(maxPending, result.stats.pending); }
    }
    expect(maxPending).toBeLessThan(200);
    expect(changes).toBeGreaterThan(500);
  });

  it("stops holding observations for an open agent command when the queue is under pressure", () => {
    const r = reconciler({ maxPending: 100 });
    r.toolStarted(shell("never-finishes", t - 1_000));
    for (let i = 0; i < 60; i++) r.observe({ kind: "watcher", file: file(`p${i}.ts`), operation: "changed", at: t + i * 2_000 });
    const { changes, stats } = r.reconcile(t + 200_000);
    expect(changes.length).toBeGreaterThan(0);
    expect(stats.droppedObservations).toBe(0);
  });

  it("bounds pending observations and reports the drop", () => {
    const r = reconciler({ maxPending: 10 });
    let accepted = 0;
    for (let i = 0; i < 25; i++) if (r.observe({ kind: "watcher", file: file(`f${i}.ts`), operation: "changed", at: t })) accepted++;
    expect(accepted).toBe(10);
    expect(r.reconcile(t + 60_000).stats.droppedObservations).toBe(15);
  });

  it("finalizes immediately when forced (shutdown/inspection) and infers creation for an unknown adapter operation", () => {
    const r = reconciler();
    r.observe({ kind: "watcher", file: file("a.ts"), operation: "changed", at: t });
    expect(r.reconcile(t + 10, true).changes).toHaveLength(1);
    r.observe({ kind: "watcher", file: file("b.ts"), operation: "created", at: t + 20 });
    expect(r.agentChange({ id: "44444444-4444-4444-8444-444444444444", tool: "claude-code", sessionKey: session, at: t + 40, file: file("b.ts"), operation: "unknown", delta: null }).operation).toBe("created");
  });
});

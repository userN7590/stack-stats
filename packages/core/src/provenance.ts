import type { AgentTool, ProvenanceAgentRecord, ProvenanceChangeRecord, ProvenanceRecord, TelemetryEvent } from "@stack-stats/protocol";
import { resolveAttribution } from "./telemetry.js";

/** Canonical change/provenance model (Phase 9E). Editor-independent and pure:
 * VS Code, filesystem and vendor hook payloads are normalized before reaching it.
 * Actor "human" is never inferred here; editor.edit batches stay "editor" origin
 * with unknown actor unless an explicit attribution report says otherwise. */
export type ChangeOperation = "created" | "modified" | "deleted";
export type UnknownReason = "no_evidence" | "vcs_operation" | "bulk_change" | "ambiguous_agents";
export type ProvenanceConfidence = "explicit" | "correlated" | "none";

/** `key` and `workspaceKey` are transient in-memory identities (e.g. URI strings)
 * and are never persisted; `projectId`/`fileId` are the salted persisted forms. */
export interface FileRef { key: string; workspaceKey: string; projectId: string; fileId: string; languageId: string }
export type ExternalObservation =
  | { kind: "watcher"; file: FileRef; operation: "created" | "changed" | "deleted"; at: number }
  | { kind: "reload"; file: FileRef; at: number; linesAdded: number; linesRemoved: number }
  | { kind: "editor_write"; file: FileRef; at: number }
  | { kind: "vcs"; workspaceKey: string; at: number };
type FileObservation = Extract<ExternalObservation, { kind: "watcher" | "reload" }>;
export interface AgentKeys { sessionKey: string; turnKey?: string; callKey?: string }
export interface AgentChangeReport extends AgentKeys {
  id: string; tool: AgentTool; at: number; file: FileRef;
  operation: ChangeOperation | "unknown";
  delta: { linesAdded: number; linesRemoved: number } | null;
}
export interface AgentToolWindowInput extends AgentKeys { callKey: string; tool: AgentTool; workspaceKey: string; at: number; durationMs?: number; vcs?: boolean }

export interface CanonicalChange {
  id: string;
  firstObservedAt: number;
  observedAt: number;
  projectId: string;
  fileId?: string;
  languageId: string;
  operation: ChangeOperation | "bulk";
  origin: "external" | "agent_adapter";
  actor: "agent" | "unknown";
  tool?: AgentTool;
  confidence: ProvenanceConfidence;
  reason?: UnknownReason;
  agent?: AgentKeys;
  /** Diff lines. Editor line boundaries are a different unit and never mixed in. */
  delta: { linesAdded: number; linesRemoved: number; source: "adapter" | "document_reload" } | null;
  observations: { watcher: number; reload: number; adapter: number };
  bulk?: { files: number; created: number; modified: number; deleted: number };
  supersedes?: string[];
}
export interface ReconcileStats {
  /** Watcher notifications merged into another notification of the same write burst. */
  duplicateNotificationsMerged: number;
  /** Observations of a write an adapter had already reported explicitly. */
  watcherAbsorbed: number; reloadAbsorbed: number;
  /** Disk writes caused by VS Code saves/file operations, not external changes. */
  editorWritesSuppressed: number;
  /** Created-then-deleted files within one burst (scratch/temporary files). */
  ephemeralDropped: number;
  /** Document reloads with no disk notification (File: Revert, or a missed watcher event). */
  uncorroboratedReloads: number;
  droppedObservations: number;
  pending: number;
}
export interface ReconcilerOptions {
  createId: () => string;
  settleMs?: number; burstGapMs?: number; editorWriteWindowMs?: number; adapterWindowMs?: number;
  toolGraceMs?: number; vcsWindowMs?: number; bulkFiles?: number; bulkGapMs?: number;
  maxPending?: number; maxToolWindowMs?: number; retainMs?: number; maxRetained?: number;
  /** Longest span of one burst/cluster, so continuous writers (logs, watch-mode
   * output, steady agents) still settle instead of growing forever. */
  maxSpanMs?: number;
}
interface ToolWindow extends AgentKeys { callKey: string; tool: AgentTool; workspaceKey: string; startedAt: number; endedAt?: number; vcs: boolean }
interface Burst { file: FileRef; observations: FileObservation[]; first: number; last: number }

const zeroStats = (): Omit<ReconcileStats, "pending"> => ({ duplicateNotificationsMerged: 0, watcherAbsorbed: 0, reloadAbsorbed: 0, editorWritesSuppressed: 0, ephemeralDropped: 0, uncorroboratedReloads: 0, droppedObservations: 0 });

/** One physical write can surface as several observations (two watcher layers,
 * a document reload, a save, an adapter report). The reconciler turns them into at
 * most one canonical change, holding observations for a bounded settle window so a
 * slower channel (the agent inbox is read every 15 seconds) can still be matched.
 * Timing only ever NARROWS provenance: it can suppress or absorb duplicates, but an
 * agent is named only by an explicit report or a bounded agent tool-call window. */
export class ChangeReconciler {
  private pending: FileObservation[] = [];
  private editorWrites: Array<{ key: string; at: number }> = [];
  private vcs: Array<{ workspaceKey: string; at: number }> = [];
  private readonly explicit = new Map<string, number[]>();
  private readonly finalized = new Map<string, Array<{ id: string; first: number; last: number }>>();
  private readonly windows = new Map<string, ToolWindow>();
  private stats = zeroStats();
  private readonly o: Required<ReconcilerOptions>;

  constructor(options: ReconcilerOptions) {
    // Bulk clusters chain only near-simultaneous files (checkout/install/codegen
    // write continuously); separate edits even a second apart are never swallowed.
    // toolGraceMs only covers watcher delivery latency after a command ends (~100 ms
    // observed; FSEvents can lag under load), not "anything soon after".
    this.o = { settleMs: 20_000, burstGapMs: 2_000, editorWriteWindowMs: 2_000, adapterWindowMs: 3_000, toolGraceMs: 1_500, vcsWindowMs: 10_000,
      bulkFiles: 25, bulkGapMs: 500, maxPending: 5_000, maxToolWindowMs: 600_000, retainMs: 600_000, maxRetained: 5_000, maxSpanMs: 30_000, ...options };
  }

  get pendingCount(): number { return this.pending.length; }

  observe(observation: ExternalObservation): boolean {
    if (observation.kind === "vcs") { this.bounded(this.vcs).push({ workspaceKey: observation.workspaceKey, at: observation.at }); return true; }
    if (observation.kind === "editor_write") { this.bounded(this.editorWrites).push({ key: observation.file.key, at: observation.at }); return true; }
    if (this.pending.length >= this.o.maxPending) { this.stats.droppedObservations++; return false; }
    this.pending.push(observation);
    return true;
  }

  toolStarted(input: AgentToolWindowInput): void {
    const existing = this.windows.get(input.callKey);
    this.windows.set(input.callKey, { tool: input.tool, sessionKey: input.sessionKey, turnKey: input.turnKey, callKey: input.callKey, workspaceKey: input.workspaceKey,
      startedAt: Math.min(existing?.startedAt ?? input.at, input.at), endedAt: existing?.endedAt, vcs: Boolean(existing?.vcs || input.vcs) });
  }

  /** Without a start signal, a reported duration bounds the window; otherwise the
   * window is just the completion instant plus grace. */
  toolFinished(input: AgentToolWindowInput): void {
    const existing = this.windows.get(input.callKey);
    const startedAt = existing?.startedAt ?? input.at - (input.durationMs ?? 0);
    this.windows.set(input.callKey, { tool: input.tool, sessionKey: input.sessionKey, turnKey: input.turnKey ?? existing?.turnKey, callKey: input.callKey,
      workspaceKey: input.workspaceKey, startedAt: Math.min(startedAt, input.at), endedAt: input.at, vcs: Boolean(existing?.vcs || input.vcs) });
  }

  /** A finished/interrupted turn closes any tool window it left open. */
  turnStopped(tool: AgentTool, sessionKey: string, at: number): void {
    for (const window of this.windows.values()) if (window.tool === tool && window.sessionKey === sessionKey && window.endedAt === undefined) window.endedAt = Math.max(window.startedAt, at);
  }

  /** Explicit adapter reports are canonical immediately (persisted before the
   * inbox record is deleted). A late report replaces an already-finalized
   * unattributed change of the same write via `supersedes`, never double counting. */
  agentChange(report: AgentChangeReport): CanonicalChange {
    const window = this.o.adapterWindowMs, key = report.file.key, supersedes: string[] = [];
    const remaining = (this.finalized.get(key) ?? []).filter((entry) => {
      const hit = report.at >= entry.first - window && report.at <= entry.last + window;
      if (hit) supersedes.push(entry.id);
      return !hit;
    });
    if (remaining.length) this.finalized.set(key, remaining); else this.finalized.delete(key);
    const times = this.explicit.get(key) ?? [];
    times.push(report.at);
    this.explicit.set(key, times.slice(-this.o.maxRetained));
    let operation: ChangeOperation = report.operation === "unknown" ? "modified" : report.operation;
    if (report.operation === "unknown") {
      const nearby = this.pending.filter((item) => item.file.key === key && Math.abs(item.at - report.at) <= window);
      if (nearby.length && nearby.every((item) => item.kind === "watcher" && item.operation === "created")) operation = "created";
    }
    return { id: report.id, firstObservedAt: report.at, observedAt: report.at, projectId: report.file.projectId, fileId: report.file.fileId,
      languageId: report.file.languageId, operation, origin: "agent_adapter", actor: "agent", tool: report.tool, confidence: "explicit",
      agent: { sessionKey: report.sessionKey, turnKey: report.turnKey, callKey: report.callKey },
      delta: report.delta ? { ...report.delta, source: "adapter" } : null, observations: { watcher: 0, reload: 0, adapter: 1 },
      supersedes: supersedes.length ? supersedes : undefined };
  }

  /** Finalize settled bursts. `force` finalizes everything observed so far (shutdown
   * or an explicit inspection); late explicit reports can still supersede. */
  reconcile(now: number, force = false): { changes: CanonicalChange[]; stats: ReconcileStats } {
    const settledBefore = force ? now : now - this.o.settleMs;
    const byFile = new Map<string, FileObservation[]>();
    for (const item of this.pending) { const list = byFile.get(item.file.key) ?? []; list.push(item); byFile.set(item.file.key, list); }
    const bursts: Burst[] = [];
    for (const list of byFile.values()) {
      list.sort((a, b) => a.at - b.at);
      let current: Burst | undefined;
      for (const item of list) {
        if (!current || item.at - current.last > this.o.burstGapMs || item.at - current.first > this.o.maxSpanMs) { current = { file: item.file, observations: [], first: item.at, last: item.at }; bursts.push(current); }
        current.observations.push(item); current.last = item.at;
      }
    }
    const byWorkspace = new Map<string, Burst[]>();
    for (const burst of bursts) { const list = byWorkspace.get(burst.file.workspaceKey) ?? []; list.push(burst); byWorkspace.set(burst.file.workspaceKey, list); }
    const changes: CanonicalChange[] = [], keep: FileObservation[] = [];
    for (const [workspaceKey, list] of byWorkspace) {
      list.sort((a, b) => a.first - b.first);
      const clusters: Burst[][] = [];
      let last = -Infinity, start = -Infinity;
      for (const burst of list) {
        if (!clusters.length || burst.first - last > this.o.bulkGapMs || burst.first - start > this.o.maxSpanMs) { clusters.push([]); start = burst.first; }
        clusters.at(-1)!.push(burst); last = Math.max(last, burst.last);
      }
      // Under queue pressure, stop waiting for open agent commands rather than drop.
      const pressure = this.pending.length > this.o.maxPending / 2;
      for (const cluster of clusters) {
        const end = Math.max(...cluster.map((burst) => burst.last));
        const held = !force && (end > settledBefore || (!pressure && this.openWindow(workspaceKey, end, now)));
        if (held) { for (const burst of cluster) keep.push(...burst.observations); continue; }
        changes.push(...this.finalizeCluster(cluster, now));
      }
    }
    this.pending = keep;
    this.prune(now);
    const stats = { ...this.stats, pending: this.pending.length };
    this.stats = zeroStats();
    return { changes, stats };
  }

  private openWindow(workspaceKey: string, end: number, now: number): boolean {
    for (const window of this.windows.values()) {
      if (window.workspaceKey === workspaceKey && window.endedAt === undefined && window.startedAt <= end && now - window.startedAt < this.o.maxToolWindowMs) return true;
    }
    return false;
  }

  private finalizeCluster(cluster: Burst[], now: number): CanonicalChange[] {
    const candidates: Array<{ change: CanonicalChange; key: string }> = [];
    for (const burst of cluster) {
      const watcher = burst.observations.filter((item): item is Extract<FileObservation, { kind: "watcher" }> => item.kind === "watcher");
      const reloads = burst.observations.filter((item): item is Extract<FileObservation, { kind: "reload" }> => item.kind === "reload");
      this.stats.duplicateNotificationsMerged += Math.max(0, watcher.length - 1);
      const key = burst.file.key;
      const reported = this.explicit.get(key)?.some((at) => at >= burst.first - this.o.adapterWindowMs && at <= burst.last + this.o.adapterWindowMs);
      if (reported) { this.stats.watcherAbsorbed += watcher.length; this.stats.reloadAbsorbed += reloads.length; continue; }
      // File: Revert produces the same clean reload shape without touching disk.
      if (!watcher.length) { this.stats.uncorroboratedReloads += reloads.length; continue; }
      // A reload means disk content differed from VS Code's saved model, so a
      // matching save cannot explain it.
      if (!reloads.length && watcher.some((item) => this.editorWrites.some((write) => write.key === key && Math.abs(write.at - item.at) <= this.o.editorWriteWindowMs))) {
        this.stats.editorWritesSuppressed += watcher.length; continue;
      }
      const operations = watcher.map((item) => item.operation);
      if (!reloads.length && operations[0] === "created" && operations.at(-1) === "deleted") { this.stats.ephemeralDropped++; continue; }
      const operation: ChangeOperation = operations.at(-1) === "deleted" && !reloads.length ? "deleted"
        : reloads.length || operations.includes("changed") || operations.includes("deleted") ? "modified" : "created";
      const delta = reloads.length ? { linesAdded: reloads.reduce((n, item) => n + item.linesAdded, 0), linesRemoved: reloads.reduce((n, item) => n + item.linesRemoved, 0), source: "document_reload" as const } : null;
      const change: CanonicalChange = { id: this.o.createId(), firstObservedAt: burst.first, observedAt: burst.last, projectId: burst.file.projectId,
        fileId: burst.file.fileId, languageId: burst.file.languageId, operation, origin: "external", actor: "unknown", confidence: "none", reason: "no_evidence",
        delta, observations: { watcher: watcher.length, reload: reloads.length, adapter: 0 } };
      this.attribute(change, burst, now);
      candidates.push({ change, key });
    }
    const files = new Set(candidates.map(({ key }) => key));
    if (files.size > this.o.bulkFiles) {
      // Checkouts, installs, codegen and formatters touch many files at once. One
      // aggregate record states that honestly instead of N per-file claims.
      const all = candidates.map(({ change }) => change);
      const count = (operation: ChangeOperation) => all.filter((change) => change.operation === operation).length;
      return [{ id: this.o.createId(), firstObservedAt: Math.min(...all.map((c) => c.firstObservedAt)), observedAt: Math.max(...all.map((c) => c.observedAt)),
        projectId: all[0]!.projectId, languageId: "unknown", operation: "bulk", origin: "external", actor: "unknown", confidence: "none",
        reason: all.some((change) => change.reason === "vcs_operation") ? "vcs_operation" : "bulk_change", delta: null,
        observations: { watcher: all.reduce((n, c) => n + c.observations.watcher, 0), reload: all.reduce((n, c) => n + c.observations.reload, 0), adapter: 0 },
        bulk: { files: files.size, created: count("created"), modified: count("modified"), deleted: count("deleted") } }];
    }
    for (const { change, key } of candidates) {
      const list = this.finalized.get(key) ?? [];
      list.push({ id: change.id, first: change.firstObservedAt, last: change.observedAt });
      this.finalized.set(key, list.slice(-this.o.maxRetained));
    }
    return candidates.map(({ change }) => change);
  }

  private attribute(change: CanonicalChange, burst: Burst, now: number): void {
    const workspace = burst.file.workspaceKey;
    const vcs = this.vcs.some((signal) => signal.workspaceKey === workspace && signal.at >= burst.first - this.o.vcsWindowMs && signal.at <= burst.last + this.o.vcsWindowMs);
    const windows = [...this.windows.values()].filter((window) => window.workspaceKey === workspace && window.startedAt - 1_000 <= burst.first
      && burst.last <= (window.endedAt ?? Math.min(now, window.startedAt + this.o.maxToolWindowMs)) + this.o.toolGraceMs);
    if (vcs || windows.some((window) => window.vcs)) { change.reason = "vcs_operation"; return; }
    const sessions = new Set(windows.map((window) => `${window.tool}:${window.sessionKey}`));
    if (sessions.size > 1) { change.reason = "ambiguous_agents"; return; }
    if (sessions.size === 1) {
      const window = windows.sort((a, b) => b.startedAt - a.startedAt)[0]!;
      Object.assign(change, { actor: "agent", confidence: "correlated", tool: window.tool, reason: undefined,
        agent: { sessionKey: window.sessionKey, turnKey: window.turnKey, callKey: window.callKey } });
      delete change.reason;
    }
  }

  private bounded<T>(list: T[]): T[] { if (list.length >= this.o.maxRetained) list.splice(0, list.length - this.o.maxRetained + 1); return list; }

  private prune(now: number): void {
    const cutoff = now - this.o.retainMs;
    this.editorWrites = this.editorWrites.filter((item) => item.at >= cutoff);
    this.vcs = this.vcs.filter((item) => item.at >= cutoff);
    for (const [key, times] of this.explicit) { const kept = times.filter((at) => at >= cutoff); if (kept.length) this.explicit.set(key, kept); else this.explicit.delete(key); }
    for (const [key, list] of this.finalized) { const kept = list.filter((entry) => entry.last >= cutoff); if (kept.length) this.finalized.set(key, kept); else this.finalized.delete(key); }
    for (const [key, window] of this.windows) {
      if ((window.endedAt ?? window.startedAt + this.o.maxToolWindowMs) < cutoff) this.windows.delete(key);
    }
    while (this.windows.size > this.o.maxRetained) this.windows.delete(this.windows.keys().next().value!);
  }
}

export function toChangeRecord(change: CanonicalChange, installationId: string): ProvenanceChangeRecord {
  return { kind: "change", recordId: change.id, installationId, firstObservedAt: new Date(change.firstObservedAt).toISOString(), observedAt: new Date(change.observedAt).toISOString(),
    projectId: change.projectId, ...(change.fileId ? { fileId: change.fileId } : {}), languageId: change.languageId, operation: change.operation, origin: change.origin,
    actor: change.actor, ...(change.tool ? { tool: change.tool } : {}), confidence: change.confidence, ...(change.reason ? { reason: change.reason } : {}),
    ...(change.agent ? { agent: Object.fromEntries(Object.entries(change.agent).filter(([, value]) => value !== undefined)) as ProvenanceChangeRecord["agent"] } : {}),
    delta: change.delta, observations: change.observations, ...(change.bulk ? { bulk: change.bulk } : {}), ...(change.supersedes ? { supersedes: change.supersedes } : {}) };
}

export type AgentRunState = "completed" | "interrupted" | "ended" | "incomplete" | "running";
export interface AgentRun {
  key: string; tool: AgentTool; sessionKey: string; turnKey?: string; projectId?: string;
  /** First observed signal of the turn (usually its first tool call): a lower bound. */
  startedAt: number; endedAt: number; state: AgentRunState;
  toolCalls: number; shellCalls: number; editCalls: number; failedCalls: number;
}
export const AGENT_RUN_STALE_MS = 30 * 60_000;

/** A run is one agent turn delimited by the vendor's own lifecycle hooks. Runs are
 * derived from persisted signals, so a restart or crash needs no open-run state.
 * Agent runtime is never human coding time and never touches session tracking. */
export function deriveAgentRuns(records: readonly ProvenanceAgentRecord[], now = Date.now(), staleMs = AGENT_RUN_STALE_MS): AgentRun[] {
  const unique = [...new Map(records.map((record) => [record.recordId, record])).values()]
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.recordId.localeCompare(b.recordId));
  const runs = new Map<string, AgentRun & { calls: Set<string>; shells: Set<string>; edits: Set<string>; lastSignal: number; terminal: boolean }>();
  const sequence = new Map<string, number>();
  for (const record of unique) {
    const at = Date.parse(record.at), session = `${record.tool}:${record.sessionKey}`;
    if (record.signal === "session_started") continue;
    if (record.signal === "session_ended" || record.signal === "interrupted") {
      for (const run of runs.values()) if (`${run.tool}:${run.sessionKey}` === session && !run.terminal) {
        Object.assign(run, { terminal: true, state: record.signal === "interrupted" ? "interrupted" : "ended", endedAt: Math.max(run.startedAt, at) });
      }
      sequence.set(session, (sequence.get(session) ?? 0) + 1);
      continue;
    }
    const key = record.turnKey ? `${session}:${record.turnKey}` : `${session}:#${sequence.get(session) ?? 0}`;
    let run = runs.get(key);
    if (!run) {
      run = { key, tool: record.tool, sessionKey: record.sessionKey, turnKey: record.turnKey, projectId: record.projectId, startedAt: at, endedAt: at, state: "running",
        toolCalls: 0, shellCalls: 0, editCalls: 0, failedCalls: 0, calls: new Set(), shells: new Set(), edits: new Set(), lastSignal: at, terminal: false };
      runs.set(key, run);
    }
    run.projectId ??= record.projectId;
    run.lastSignal = Math.max(run.lastSignal, at);
    if (record.signal === "tool_started" || record.signal === "tool_finished") {
      const start = record.signal === "tool_finished" ? at - (record.durationMs ?? 0) : at;
      run.startedAt = Math.min(run.startedAt, start);
      const call = record.callKey ?? record.recordId;
      run.calls.add(call);
      if (record.toolKind === "shell") run.shells.add(call);
      if (record.toolKind === "edit") run.edits.add(call);
      if (record.signal === "tool_finished" && record.success === false) run.failedCalls++;
      if (!run.terminal) run.endedAt = Math.max(run.endedAt, at);
    } else if (record.signal === "turn_stopped") {
      Object.assign(run, { terminal: true, endedAt: Math.max(run.endedAt, at), state: record.endReason === "error" || record.endReason === "interrupted" ? "interrupted" : "completed" });
      if (!record.turnKey) sequence.set(session, (sequence.get(session) ?? 0) + 1);
    }
  }
  return [...runs.values()].map(({ calls, shells, edits, lastSignal, terminal, ...run }) => {
    // Without a terminal hook the run is either still going or its Stop was lost;
    // after the stale bound it is reported incomplete, ending at its last signal.
    if (!terminal) Object.assign(run, lastSignal < now - staleMs ? { state: "incomplete", endedAt: lastSignal } : { state: "running", endedAt: Math.max(run.endedAt, now) });
    return { ...run, endedAt: Math.max(run.startedAt, run.endedAt), toolCalls: calls.size, shellCalls: shells.size, editCalls: edits.size };
  }).sort((a, b) => a.startedAt - b.startedAt || a.key.localeCompare(b.key));
}

type Interval = [number, number];
function union(intervals: Interval[]): Interval[] {
  const sorted = intervals.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const merged: Interval[] = [];
  for (const [a, b] of sorted) { const last = merged.at(-1); if (last && a <= last[1]) last[1] = Math.max(last[1], b); else merged.push([a, b]); }
  return merged;
}
const total = (intervals: Interval[]) => intervals.reduce((n, [a, b]) => n + b - a, 0);
function intersect(a: Interval[], b: Interval[]): number {
  let i = 0, j = 0, sum = 0;
  while (i < a.length && j < b.length) {
    const lo = Math.max(a[i]![0], b[j]![0]), hi = Math.min(a[i]![1], b[j]![1]);
    if (hi > lo) sum += hi - lo;
    if (a[i]![1] < b[j]![1]) i++; else j++;
  }
  return sum;
}
const changeCounters = () => ({ events: 0, files: 0, linesAdded: 0, linesRemoved: 0, deltaUnknown: 0 });
type ChangeCounters = ReturnType<typeof changeCounters>;

export interface AgentActivityInput {
  records: readonly ProvenanceRecord[];
  /** Local telemetry-v2 events: editor.edit, activity.interval and attribution.report. */
  telemetry?: readonly TelemetryEvent[];
  range: { from: string; to: string };
  now?: number;
}

/** Local inspection analytics. Categories are reported side by side and never
 * collapsed into a single "AI share": editor edits use line boundaries, agent and
 * external changes use diff lines, and unknown provenance stays visible. */
export function summarizeAgentActivity(input: AgentActivityInput) {
  const from = Date.parse(input.range.from), to = Date.parse(input.range.to), now = input.now ?? Date.now();
  const records = [...new Map(input.records.map((record) => [record.recordId, record])).values()];
  const superseded = new Set(records.flatMap((record) => record.kind === "change" ? record.supersedes ?? [] : []));
  const inRange = (at: string) => { const value = Date.parse(at); return value >= from && value < to; };
  const changes = records.filter((record): record is ProvenanceChangeRecord => record.kind === "change" && !superseded.has(record.recordId) && inRange(record.observedAt));
  const agentRecords = records.filter((record): record is ProvenanceAgentRecord => record.kind === "agent");
  const runs = deriveAgentRuns(agentRecords, now).filter((run) => run.startedAt < to && run.endedAt >= from);
  const clip = (run: AgentRun): Interval => [Math.max(run.startedAt, from), Math.min(run.endedAt, to)];
  const agentWall = union(runs.map(clip));

  const telemetry = [...new Map((input.telemetry ?? []).map((event) => [event.eventId, event])).values()];
  const editorIntervals = union(telemetry.filter((event) => event.eventType === "activity.interval")
    .map((event) => [Math.max(Date.parse((event.data as { startedAt: string }).startedAt), from), Math.min(Date.parse(event.occurredAt), to)] as Interval));
  const claims = resolveAttribution(telemetry);
  const editorEdits = telemetry.filter((event): event is Extract<TelemetryEvent, { eventType: "editor.edit" }> => event.eventType === "editor.edit" && inRange(event.occurredAt));
  const editor = { edits: 0, linesAdded: 0, linesRemoved: 0, activeMs: total(editorIntervals), reportedAiEdits: 0, reportedHumanEdits: 0,
    saveParticipantEdits: 0, saveParticipantLinesAdded: 0, saveParticipantLinesRemoved: 0, unit: "editor line boundaries" };
  for (const event of editorEdits) {
    editor.edits += event.data.editCount; editor.linesAdded += event.data.linesAdded; editor.linesRemoved += event.data.linesRemoved;
    const claim = claims.get(event.eventId);
    if (claim?.actor === "ai") editor.reportedAiEdits += event.data.editCount;
    if (claim?.actor === "human") editor.reportedHumanEdits += event.data.editCount;
  }
  for (const record of records) if (record.kind === "save_participant" && inRange(record.at)) {
    editor.saveParticipantEdits += record.edits; editor.saveParticipantLinesAdded += record.linesAdded; editor.saveParticipantLinesRemoved += record.linesRemoved;
  }

  const files = new Map<ChangeCounters, Set<string>>();
  const tally = (target: ChangeCounters, change: ProvenanceChangeRecord) => {
    target.events++;
    if (change.delta) { target.linesAdded += change.delta.linesAdded; target.linesRemoved += change.delta.linesRemoved; } else target.deltaUnknown++;
    const set = files.get(target) ?? new Set<string>(); set.add(`${change.projectId}:${change.fileId}`); files.set(target, set); target.files = set.size;
  };
  const explicit = changeCounters(), correlated = changeCounters(), unknown = changeCounters(), vcs = changeCounters(), ambiguous = changeCounters();
  const bulk = { operations: 0, files: 0, vcsOperations: 0 };
  const tools = new Map<AgentTool, { tool: AgentTool; runs: number; completedRuns: number; observedRunMs: number; explicit: ChangeCounters; correlated: ChangeCounters; lastSignalAt: string | null }>();
  const tool = (id: AgentTool) => { const value = tools.get(id) ?? { tool: id, runs: 0, completedRuns: 0, observedRunMs: 0, explicit: changeCounters(), correlated: changeCounters(), lastSignalAt: null }; tools.set(id, value); return value; };
  const agentChangedFiles = new Map<string, number>();
  let duringAgentRuns = 0;
  const runSpans = runs.map((run) => ({ run, span: [run.startedAt, run.endedAt] as Interval }));
  const changesPerRun = new Map<string, number>();
  for (const change of changes) {
    if (change.operation === "bulk") { bulk.operations++; bulk.files += change.bulk?.files ?? 0; if (change.reason === "vcs_operation") bulk.vcsOperations++; continue; }
    if (change.confidence === "explicit" || change.confidence === "correlated") {
      tally(change.confidence === "explicit" ? explicit : correlated, change);
      tally(tool(change.tool!)[change.confidence], change);
      const fileKey = `${change.projectId}:${change.fileId}`;
      agentChangedFiles.set(fileKey, Math.min(agentChangedFiles.get(fileKey) ?? Infinity, Date.parse(change.observedAt)));
      const run = runSpans.find(({ run }) => run.tool === change.tool && run.sessionKey === change.agent?.sessionKey && (!change.agent?.turnKey || run.turnKey === change.agent.turnKey));
      if (run) changesPerRun.set(run.run.key, (changesPerRun.get(run.run.key) ?? 0) + 1);
    } else if (change.reason === "vcs_operation") tally(vcs, change);
    else if (change.reason === "ambiguous_agents") tally(ambiguous, change);
    else {
      tally(unknown, change);
      const at = Date.parse(change.observedAt);
      if (runSpans.some(({ run, span }) => at >= span[0] && at <= span[1] && (!run.projectId || run.projectId === change.projectId))) duringAgentRuns++;
    }
  }
  const byState = { completed: 0, interrupted: 0, ended: 0, incomplete: 0, running: 0 };
  for (const run of runs) {
    byState[run.state]++;
    const entry = tool(run.tool); entry.runs++; if (run.state === "completed") entry.completedRuns++;
    entry.observedRunMs += Math.max(0, clip(run)[1] - clip(run)[0]);
  }
  for (const record of agentRecords) {
    const entry = tools.get(record.tool);
    if (entry && (!entry.lastSignalAt || record.at > entry.lastSignalAt)) entry.lastSignalAt = record.at;
  }
  let laterEditorEditsInAgentChangedFiles = 0;
  for (const event of editorEdits) {
    const changedAt = agentChangedFiles.get(`${event.context.projectId}:${event.context.fileId}`);
    if (changedAt !== undefined && Date.parse(event.occurredAt) > changedAt) laterEditorEditsInAgentChangedFiles += event.data.editCount;
  }
  const coverage: Record<string, number> = {};
  for (const record of records) if (record.kind === "coverage" && inRange(record.at)) coverage[record.reason] = (coverage[record.reason] ?? 0) + record.dropped;
  return {
    schemaVersion: 1 as const, range: input.range, localOnly: true as const,
    editor,
    agent: {
      runs: { total: runs.length, ...byState, withoutFileChanges: runs.filter((run) => !changesPerRun.has(run.key)).length },
      observedRunMs: runs.reduce((n, run) => n + Math.max(0, clip(run)[1] - clip(run)[0]), 0),
      wallMs: total(agentWall),
      overlapWithEditorActivityMs: intersect(agentWall, editorIntervals),
      explicit, correlated,
      byTool: [...tools.values()].sort((a, b) => a.tool.localeCompare(b.tool)),
      unit: "diff lines"
    },
    external: { unknown, vcs, ambiguous, bulk, duringAgentRunsUnattributed: duringAgentRuns, unit: "diff lines (open documents only)" },
    laterEditorEditsInAgentChangedFiles,
    coverage,
    limitations: {
      runDurationIsLowerBound: true, agentTimeIsNotHumanTime: true, editorActorUnknown: true, saveParticipantSubsetIsCorrelated: true,
      externalDeltaOnlyForOpenDocuments: true, authorshipVerified: false, codeSurvivalMeasured: false, crossDeviceDeduplicated: false
    }
  };
}
export type AgentActivitySummary = ReturnType<typeof summarizeAgentActivity>;

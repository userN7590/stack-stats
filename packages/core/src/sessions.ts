import type { EditorFileChangedEvent, SessionContribution, SessionSnapshot } from "@stack-stats/protocol";
import { localDateKey, splitByDay } from "./dates.js";

export const SESSION_IDLE_MS = 5 * 60_000;
export const ACTIVE_GAP_MS = 60_000;
export type ActivityContext = Pick<SessionContribution, "project" | "file">;
export type EditCounts = Pick<SessionContribution, "linesAdded" | "linesRemoved" | "editCount">;

export interface SessionTrackerOptions {
  source: EditorFileChangedEvent["source"];
  createId: () => string;
  timeZone: string;
  /** Session grouping only; active-time evidence remains capped at 60 seconds. */
  idleTimeoutMs?: number;
  onInterval?: (context: ActivityContext, from: number, to: number, sessionId: string) => void;
  onLifecycle?: (sessionId: string, at: number, state: "started" | "ended", reason?: SessionSnapshot["endReason"]) => void;
}

/** Editor-independent state machine. Only edits start/extend sessions. A session
 * stays grouped across short breaks, but only gaps <=60s between focused edits
 * earn time. No trailing timeout is credited; even one edit can legitimately be 0s.
 */
export class SessionTracker {
  private current?: SessionSnapshot;
  private previous?: { at: number; context: ActivityContext };
  private readonly dirty = new Map<string, SessionSnapshot>();
  private readonly contributions = new Map<string, SessionContribution>();
  private idleTimeoutMs: number;

  constructor(private readonly options: SessionTrackerOptions) {
    this.idleTimeoutMs = SESSION_IDLE_MS;
    this.setIdleTimeout(options.idleTimeoutMs ?? SESSION_IDLE_MS);
  }

  setIdleTimeout(ms: number): void {
    if (!Number.isInteger(ms) || ms < 60_000 || ms > 60 * 60_000) throw new RangeError("Session timeout must be between 1 and 60 minutes");
    this.idleTimeoutMs = ms;
  }

  edit(context: ActivityContext, counts: EditCounts, at: number): void {
    if (counts.editCount === 0) return;
    if (this.current && at < Date.parse(this.current.endedAt)) this.end("clock_changed");
    this.expire(at);
    if (!this.current) {
      this.contributions.clear();
      this.current = {
        schemaVersion: "1.0", eventType: "editor.session_snapshot", sessionId: this.options.createId(), revision: 0,
        source: this.options.source, timeZone: this.options.timeZone,
        startedAt: new Date(at).toISOString(), endedAt: new Date(at).toISOString(), days: []
      };
      this.options.onLifecycle?.(this.current.sessionId, at, "started");
    }
    if (this.previous && at - this.previous.at <= ACTIVE_GAP_MS) {
      if (at > this.previous.at) this.options.onInterval?.(this.previous.context, this.previous.at, at, this.current.sessionId);
      for (const interval of splitByDay(this.previous.at, at, this.options.timeZone)) {
        this.contribution(interval.date, this.previous.context).activeMs += interval.activeMs;
      }
    }
    const row = this.contribution(localDateKey(at, this.options.timeZone), context);
    row.linesAdded += counts.linesAdded;
    row.linesRemoved += counts.linesRemoved;
    row.editCount += counts.editCount;
    this.current.endedAt = new Date(at).toISOString();
    this.previous = { at, context };
    this.markDirty();
  }

  // Saves, tab/language changes and focus changes never manufacture activity.
  // Breaking the evidence interval avoids attributing time spent in another tab
  // or another application to the previously edited file.
  breakInterval(): void { this.previous = undefined; }

  expire(at: number): void {
    if (this.current && at - Date.parse(this.current.endedAt) >= this.idleTimeoutMs) this.end("idle");
  }

  end(reason: NonNullable<SessionSnapshot["endReason"]>): void {
    if (this.current) {
      this.current.endReason = reason;
      this.options.onLifecycle?.(this.current.sessionId, Date.parse(this.current.endedAt), "ended", reason);
      this.markDirty();
    }
    this.current = undefined;
    this.previous = undefined;
  }

  snapshot(): SessionSnapshot | undefined { return this.current ? structuredClone(this.current) : undefined; }
  get isActive(): boolean { return this.current !== undefined; }
  get sessionId(): string | undefined { return this.current?.sessionId; }

  pending(): SessionSnapshot[] { return [...this.dirty.values()].map((session) => structuredClone(session)); }

  acknowledge(session: SessionSnapshot): void {
    if (this.dirty.get(session.sessionId)?.revision === session.revision) this.dirty.delete(session.sessionId);
  }

  private markDirty(): void {
    this.current!.revision++;
    this.dirty.set(this.current!.sessionId, this.current!);
  }

  private contribution(date: string, context: ActivityContext): SessionContribution {
    const key = JSON.stringify([date, context.project.projectId, context.file.fileId, context.file.languageId]);
    const existing = this.contributions.get(key);
    if (existing) return existing;
    let day = this.current!.days.find((candidate) => candidate.date === date);
    if (!day) { day = { date, contributions: [] }; this.current!.days.push(day); }
    const row = { ...structuredClone(context), activeMs: 0, linesAdded: 0, linesRemoved: 0, editCount: 0 };
    day.contributions.push(row);
    this.contributions.set(key, row);
    return row;
  }
}

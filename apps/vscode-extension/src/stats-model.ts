import { activeDates, aggregateSessions, dailyStatistics, latestSessions, weeklyStatistics, weekStart } from "@stack-stats/core";
import type { SessionSnapshot } from "@stack-stats/protocol";

/** A disposable presentation cache, never a second source of truth. Retain this
 * week's snapshots plus historical active dates for the core streak reducer.
 * Refreshing the view never scans raw telemetry or writes activity to disk. */
export class SessionSummaryCache {
  private recent = new Map<string, SessionSnapshot>();
  private dates = new Set<string>();
  private cutoff = "0000-01-01";
  private loading?: Promise<void>;
  private duringLoad: SessionSnapshot[] = [];
  ready = false;
  error = false;
  get refreshing(): boolean { return this.loading !== undefined; }

  load(read: () => Promise<SessionSnapshot[]>, today: string): Promise<void> {
    if (this.loading) return this.loading;
    this.duringLoad = [];
    this.loading = (async () => {
      try {
        const sessions = await Promise.resolve().then(read);
        this.cutoff = weekStart(today);
        this.dates = new Set(activeDates(sessions));
        this.recent.clear();
        for (const session of latestSessions([...sessions, ...this.duringLoad])) this.remember(session);
        this.ready = true;
        this.error = false;
      } catch { this.error = true; }
      finally { this.duringLoad = []; this.loading = undefined; }
    })();
    return this.loading;
  }

  remember(session: SessionSnapshot): void {
    // A checkpoint completing during history I/O must survive the replacement.
    if (this.loading) this.duringLoad.push(session);
    for (const date of activeDates([session])) this.dates.add(date);
    if (!session.days.some(day => day.date >= this.cutoff)) return;
    if ((this.recent.get(session.sessionId)?.revision ?? 0) < session.revision) {
      this.recent.set(session.sessionId, session);
    }
  }

  summarize(today: string, current?: SessionSnapshot, pending: SessionSnapshot[] = []) {
    const sessions = latestSessions([...this.recent.values(), ...pending, ...(current ? [current] : [])]);
    return {
      current: current ? aggregateSessions([current], "0000-01-01", "9999-12-31") : undefined,
      today: dailyStatistics(sessions, today),
      week: weeklyStatistics(sessions, today, [...this.dates, ...activeDates(sessions)]),
      session: current
    };
  }
}

export type SidebarSummary = ReturnType<SessionSummaryCache["summarize"]>;

export function inactivityMinutes(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 60 ? value : 5;
}

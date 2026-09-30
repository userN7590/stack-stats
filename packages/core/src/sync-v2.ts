import { parseSyncDayV2, stackStatsEventSchema, SYNC_COUNTERS, SYNC_LANGUAGES, SYNC_V2_MAX_PROJECTS, SYNC_V2_SESSION_DURATION_BOUNDS_MS,
  type SessionSnapshot, type SyncBreakdown, type SyncCounters, type SyncDayV2, type SyncHourlyUtc, type SyncSessionDurations } from "@stack-stats/protocol";
import { localDateKey } from "./dates.js";

export interface SyncDayV2Options { installationId: string; uploadFromDate: string; hourlyUtc?: SyncHourlyUtc | null }
export type PreparedSyncDayV2Options = Omit<SyncDayV2Options, "installationId">;
const empty = (): SyncCounters => ({ activeMs: 0, editCount: 0, linesAdded: 0, linesRemoved: 0 });
function add(target: SyncCounters, value: SyncCounters): void { for (const key of SYNC_COUNTERS) target[key] += value[key]; }
const alphabetic = (a: { id: string }, b: { id: string }) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
const durationSummary = (): SyncSessionDurations => ({ count: 0, ...empty(), minActiveMs: null, maxActiveMs: null,
  histogram: Array.from({ length: SYNC_V2_SESSION_DURATION_BOUNDS_MS.length + 1 }, () => 0) });
function addDimension(map: Map<string, SyncCounters>, id: string, counters: SyncCounters): void {
  const value = map.get(id) ?? empty(); add(value, counters); map.set(id, value);
}
interface DayIndex {
  totals: SyncCounters;
  sessionIds: Set<string>;
  files: Set<string>;
  languages: Map<string, SyncCounters>;
  projects: Map<string, SyncCounters>;
  sessionStarts: number;
  incompleteSessionStarts: number;
  sessionDurations: SyncSessionDurations;
}
const newDay = (): DayIndex => ({ totals: empty(), sessionIds: new Set(), files: new Set(), languages: new Map(), projects: new Map(),
  sessionStarts: 0, incompleteSessionStarts: 0, sessionDurations: durationSummary() });

/** Index one installation once; account-specific project aliases are applied only at build time.
 * No raw v2 observations are read here. Hourly input is an independent durable projection. */
export function prepareSyncDaysV2(snapshots: readonly SessionSnapshot[], installationId: string): {
  dates: string[];
  build(date: string, projectAlias: (id: string) => string, options: PreparedSyncDayV2Options): SyncDayV2;
} {
  const latest = new Map<string, SessionSnapshot>();
  const parsed: SessionSnapshot[] = [];
  for (const input of snapshots) {
    if (input.source.installationId !== installationId) continue;
    const session = stackStatsEventSchema.parse(input);
    if (session.eventType !== "editor.session_snapshot") throw new Error("Expected session snapshot");
    const previous = latest.get(session.sessionId);
    parsed.push(session);
    if (!previous || previous.revision < session.revision) latest.set(session.sessionId, session);
  }
  for (const session of parsed) {
    const current = latest.get(session.sessionId)!;
    if (current.revision === session.revision && JSON.stringify(current) !== JSON.stringify(session)) throw new Error("Conflicting session revision");
  }
  const days = new Map<string, DayIndex>();
  const day = (date: string) => { const value = days.get(date) ?? newDay(); days.set(date, value); return value; };
  for (const session of latest.values()) {
    const sessionTotals = empty();
    for (const contributionDay of session.days) {
      const value = day(contributionDay.date);
      value.sessionIds.add(session.sessionId);
      for (const row of contributionDay.contributions) {
        add(value.totals, row); add(sessionTotals, row);
        value.files.add(JSON.stringify([row.project.projectId, row.file.fileId]));
        addDimension(value.languages, SYNC_LANGUAGES.includes(row.file.languageId) ? row.file.languageId : "other", row);
        addDimension(value.projects, row.project.projectId, row);
      }
    }
    // The cohort can own a synthetic start-date row even when legacy snapshots
    // contain only later contribution dates. Never allocate it once per touched day.
    const owner = day(localDateKey(Date.parse(session.startedAt), session.timeZone));
    owner.sessionStarts++;
    if (!session.endReason) { owner.incompleteSessionStarts++; continue; }
    const summary = owner.sessionDurations;
    summary.count++; add(summary, sessionTotals);
    summary.minActiveMs = summary.minActiveMs === null ? sessionTotals.activeMs : Math.min(summary.minActiveMs, sessionTotals.activeMs);
    summary.maxActiveMs = summary.maxActiveMs === null ? sessionTotals.activeMs : Math.max(summary.maxActiveMs, sessionTotals.activeMs);
    const bin = SYNC_V2_SESSION_DURATION_BOUNDS_MS.findIndex(bound => sessionTotals.activeMs < bound);
    summary.histogram[bin === -1 ? summary.histogram.length - 1 : bin]!++;
  }
  const dates = [...days.keys()].sort();
  function lastAtOrBefore(date: string): string | null {
    let low = 0, high = dates.length;
    while (low < high) { const middle = (low + high) >>> 1; if (dates[middle]! <= date) low = middle + 1; else high = middle; }
    return low ? dates[low - 1]! : null;
  }
  return { dates: [...dates], build(date, projectAlias, options) {
    const value = days.get(date) ?? newDay();
    const aliased = new Map<string, SyncCounters>();
    for (const [id, counts] of value.projects) addDimension(aliased, projectAlias(id), counts);
    const ranked = [...aliased].map(([id, counts]) => ({ id, ...counts })).sort((a, b) => b.activeMs - a.activeMs || b.editCount - a.editCount
      || b.linesAdded - a.linesAdded || b.linesRemoved - a.linesRemoved || alphabetic(a, b));
    const projectOverflow = { projectCount: Math.max(0, ranked.length - SYNC_V2_MAX_PROJECTS), ...empty() };
    for (const row of ranked.slice(SYNC_V2_MAX_PROJECTS)) add(projectOverflow, row);
    const last = lastAtOrBefore(date);
    return parseSyncDayV2({ schemaVersion: "2", aggregationVersion: 1, date, revision: 1, ...value.totals,
      sessionDays: value.sessionIds.size, sessionStarts: value.sessionStarts, incompleteSessionStarts: value.incompleteSessionStarts,
      fileCount: value.files.size, languageCount: value.languages.size, projectCount: aliased.size,
      languages: [...value.languages].map(([id, counts]): SyncBreakdown => ({ id, ...counts })).sort(alphabetic),
      projects: ranked.slice(0, SYNC_V2_MAX_PROJECTS).sort(alphabetic), projectOverflow,
      sessionDurations: value.sessionDurations, hourlyUtc: options.hourlyUtc ?? null,
      coverage: { source: "sessions-v1", dateBasis: "collector-local", firstObservedDate: last ? dates[0]! : null,
        lastObservedDate: last, uploadFromDate: options.uploadFromDate, historyCompleteness: "unknown", partial: true } });
  } };
}

export function syncDatesV2(snapshots: readonly SessionSnapshot[], installationId: string): string[] {
  return prepareSyncDaysV2(snapshots, installationId).dates;
}
export function syncDayV2(snapshots: readonly SessionSnapshot[], date: string, projectAlias: (id: string) => string, options: SyncDayV2Options): SyncDayV2 {
  return prepareSyncDaysV2(snapshots, options.installationId).build(date, projectAlias, options);
}

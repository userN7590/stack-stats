import { parseSyncDay, SYNC_LANGUAGES, type SessionSnapshot, type SyncBreakdown, type SyncDay } from "@stack-stats/protocol";
import { dailyStatistics, type Breakdown } from "./statistics.js";
const counters = (row: Breakdown) => ({ activeMs: row.activeMs, editCount: row.editCount, linesAdded: row.linesAdded, linesRemoved: row.linesRemoved });
/** Curates existing session aggregates; never reads source or raw telemetry.
 * Project aliases must be salted and scoped to the account + installation. */
export function syncDay(sessions: readonly SessionSnapshot[], date: string, projectAlias: (id: string) => string): SyncDay {
  const stats = dailyStatistics(sessions, date);
  const languages = new Map<string, SyncBreakdown>();
  for (const row of stats.languages) {
    const id = SYNC_LANGUAGES.includes(row.languageId) ? row.languageId : "other";
    const previous = languages.get(id) ?? { id, activeMs: 0, editCount: 0, linesAdded: 0, linesRemoved: 0 };
    for (const key of ["activeMs", "editCount", "linesAdded", "linesRemoved"] as const) previous[key] += row[key];
    languages.set(id, previous);
  }
  const sort = (a: SyncBreakdown, b: SyncBreakdown) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  return parseSyncDay({ schemaVersion: "1", aggregationVersion: 1, date, revision: 1, ...counters(stats),
    sessionCount: stats.sessions, fileCount: stats.filesTouched,
    languages: [...languages.values()].sort(sort),
    projects: stats.projects.map(row => ({ id: projectAlias(row.projectId), ...counters(row) })).sort(sort) });
}

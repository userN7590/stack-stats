import type { SessionSnapshot } from "@stack-stats/protocol";
import { addDays, weekStart } from "./dates.js";

export interface Breakdown {
  activeMs: number;
  editCount: number;
  linesAdded: number;
  linesRemoved: number;
}
export interface SessionStatistics extends Breakdown {
  sessions: number;
  totalLineChanges: number;
  filesTouched: number;
  projectsWorkedOn: number;
  languages: Array<Breakdown & { languageId: string }>;
  projects: Array<Breakdown & { projectId: string; displayName: string }>;
  longestSession: { sessionId: string; activeMs: number } | null;
}

const empty = (): Breakdown => ({ activeMs: 0, editCount: 0, linesAdded: 0, linesRemoved: 0 });
const sum = (target: Breakdown, value: Breakdown) => {
  target.activeMs += value.activeMs;
  target.editCount += value.editCount;
  target.linesAdded += value.linesAdded;
  target.linesRemoved += value.linesRemoved;
};
const rank = (a: Breakdown, b: Breakdown) => b.activeMs - a.activeMs || b.editCount - a.editCount;

export function latestSessions(sessions: readonly SessionSnapshot[]): SessionSnapshot[] {
  const latest = new Map<string, SessionSnapshot>();
  for (const session of sessions) {
    if ((latest.get(session.sessionId)?.revision ?? 0) < session.revision) latest.set(session.sessionId, session);
  }
  return [...latest.values()];
}

/** Date keys refer to the local day recorded by the collector. Existing history
 * does not shift dates if the developer later travels to another time zone. */
export function aggregateSessions(snapshots: readonly SessionSnapshot[], from: string, to: string): SessionStatistics {
  const total = empty();
  const files = new Set<string>();
  const projects = new Map<string, SessionStatistics["projects"][number]>();
  const languages = new Map<string, SessionStatistics["languages"][number]>();
  let sessions = 0;
  let longestSession: SessionStatistics["longestSession"] = null;
  for (const session of latestSessions(snapshots)) {
    const days = session.days.filter((day) => day.date >= from && day.date < to);
    if (!days.length) continue;
    sessions++;
    let activeMs = 0;
    for (const day of days) for (const row of day.contributions) {
      sum(total, row);
      activeMs += row.activeMs;
      files.add(`${row.project.projectId}:${row.file.fileId}`);
      const project = projects.get(row.project.projectId) ?? { ...empty(), projectId: row.project.projectId, displayName: row.project.displayName };
      sum(project, row);
      projects.set(project.projectId, project);
      const language = languages.get(row.file.languageId) ?? { ...empty(), languageId: row.file.languageId };
      sum(language, row);
      languages.set(language.languageId, language);
    }
    if (!longestSession || activeMs > longestSession.activeMs) longestSession = { sessionId: session.sessionId, activeMs };
  }
  return {
    ...total, sessions, totalLineChanges: total.linesAdded + total.linesRemoved,
    filesTouched: files.size, projectsWorkedOn: projects.size,
    projects: [...projects.values()].sort(rank), languages: [...languages.values()].sort(rank), longestSession
  };
}

export function dailyStatistics(sessions: readonly SessionSnapshot[], date: string) {
  return { date, ...aggregateSessions(sessions, date, addDays(date, 1)) };
}

export function activeDates(sessions: readonly SessionSnapshot[]): string[] {
  return [...new Set(latestSessions(sessions).flatMap((session) => session.days
    .filter((day) => day.contributions.some((row) => row.editCount > 0 || row.activeMs > 0)).map((day) => day.date)))];
}

export function currentStreak(dates: readonly string[], today: string): number {
  const active = new Set(dates);
  let day = active.has(today) ? today : addDays(today, -1);
  let streak = 0;
  while (active.has(day)) { streak++; day = addDays(day, -1); }
  return streak;
}

export function weeklyStatistics(sessions: readonly SessionSnapshot[], today: string, historicalDates = activeDates(sessions)) {
  const from = weekStart(today);
  const to = addDays(from, 7);
  const statistics = aggregateSessions(sessions, from, to);
  const days = new Set(activeDates(sessions).filter((date) => date >= from && date < to));
  return {
    from, to, ...statistics, activeDays: days.size,
    averageActiveMs: days.size ? statistics.activeMs / days.size : 0,
    currentStreak: currentStreak(historicalDates, today)
  };
}

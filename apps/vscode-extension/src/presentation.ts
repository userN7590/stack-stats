import { aggregateSessions, type SessionStatistics, type weeklyStatistics } from "@stack-stats/core";
import type { SessionSnapshot } from "@stack-stats/protocol";

export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function formatStatistics(title: string, stats: SessionStatistics): string {
  return [
    `Stack Stats — ${title}`, "", `Active coding time (estimate): ${formatDuration(stats.activeMs)}`,
    `Sessions: ${stats.sessions}`, `Lines: +${stats.linesAdded} / -${stats.linesRemoved} (${stats.totalLineChanges} total boundaries)`,
    `Files touched: ${stats.filesTouched}`, `Projects: ${stats.projectsWorkedOn}`, "", "Languages (share of active time):",
    ...(stats.languages.length ? stats.languages.map((language) =>
      `${language.languageId}: ${stats.activeMs ? `${Math.round(language.activeMs / stats.activeMs * 100)}%` : "no timed interval yet"} — ${formatDuration(language.activeMs)}, +${language.linesAdded}/-${language.linesRemoved}`) : ["No coding activity recorded."]),
    "", "Projects:", ...stats.projects.map((project) => `${project.displayName}: ${formatDuration(project.activeMs)}, ${project.editCount} edits`)
  ].join("\n");
}

export function formatWeek(stats: ReturnType<typeof weeklyStatistics>): string {
  return `${formatStatistics(`This Week (${stats.from}, Monday start)`, stats)}\n\nActive days: ${stats.activeDays}\nAverage per active day: ${formatDuration(stats.averageActiveMs)}\nLongest session (within week): ${formatDuration(stats.longestSession?.activeMs ?? 0)}\nCurrent coding streak: ${stats.currentStreak} day(s)`;
}

export function formatSession(session?: SessionSnapshot): string {
  if (!session) return "Stack Stats — Current Session\n\nNo current session. Editing a document starts one.";
  return `${formatStatistics("Current Session", aggregateSessions([session], "0000-01-01", "9999-12-31"))}\n\nStarted: ${new Date(session.startedAt).toLocaleString()}\nLast edit: ${new Date(session.endedAt).toLocaleString()}\nIdle gaps and time after the last edit are not credited.`;
}

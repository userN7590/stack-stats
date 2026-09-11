import { describe, expect, it } from "vitest";
import { ACTIVE_GAP_MS, SESSION_IDLE_MS, aggregateSessions, countLineChanges, dailyStatistics, weeklyStatistics, currentStreak, localDateKey, splitByDay } from "@stack-stats/core";
import { stackStatsEventSchema } from "@stack-stats/protocol";
import { context, counts, session, tracker } from "./fixtures.js";

const start = Date.parse("2026-09-01T12:00:00Z");
const totals = (value: ReturnType<typeof tracker>) => aggregateSessions(value.pending(), "2026-01-01", "2027-01-01");

describe("session evidence and inactivity", () => {
  it("opening, switching, saving checkpoints and idle ticks do not invent a session", () => {
    const value = tracker();
    value.breakInterval();
    value.expire(start);
    value.edit(context(), { ...counts, editCount: 0 }, start);
    expect(value.snapshot()).toBeUndefined();
    expect(value.pending()).toEqual([]);
  });

  it("groups files, languages and projects while timing only short evidenced gaps", () => {
    const value = tracker();
    value.edit(context(), counts, start);
    value.edit(context(), counts, start + 30_000);
    value.breakInterval();
    value.edit(context("project-b", "file-b", "css"), counts, start + 40_000);
    value.edit(context("project-b", "file-b", "css"), counts, start + 60_000);
    expect(totals(value)).toMatchObject({ sessions: 1, activeMs: 50_000, filesTouched: 2, projectsWorkedOn: 2, linesAdded: 8, linesRemoved: 4 });
    expect(totals(value).languages).toMatchObject([{ languageId: "typescript", activeMs: 30_000 }, { languageId: "css", activeMs: 20_000 }]);
  });

  it("keeps a short break in the session without crediting its idle interval", () => {
    const value = tracker();
    value.edit(context(), counts, start);
    value.edit(context(), counts, start + ACTIVE_GAP_MS);
    value.edit(context(), counts, start + ACTIVE_GAP_MS * 2 + 1);
    expect(totals(value)).toMatchObject({ sessions: 1, activeMs: ACTIVE_GAP_MS });
    value.expire(start + ACTIVE_GAP_MS * 2 + SESSION_IDLE_MS);
    expect(value.snapshot()).toBeDefined();
    value.expire(start + ACTIVE_GAP_MS * 2 + 1 + SESSION_IDLE_MS);
    expect(value.snapshot()).toBeUndefined();
    expect(value.pending()[0]).toMatchObject({ endedAt: new Date(start + ACTIVE_GAP_MS * 2 + 1).toISOString(), endReason: "idle" });
    expect(totals(value).activeMs).toBe(ACTIVE_GAP_MS);
  });

  it("splits at the exact five-minute boundary even without a timer tick", () => {
    const value = tracker();
    value.edit(context(), counts, start);
    value.edit(context(), counts, start + SESSION_IDLE_MS);
    expect(totals(value)).toMatchObject({ sessions: 2, activeMs: 0 });
    expect(value.pending()[0]?.endReason).toBe("idle");
  });

  it("does not count unfocused time or join sessions across shutdown/pause", () => {
    const value = tracker();
    value.edit(context(), counts, start);
    value.breakInterval();
    value.edit(context(), counts, start + 20_000);
    value.end("paused");
    value.edit(context(), counts, start + 30_000);
    value.end("shutdown");
    expect(totals(value)).toMatchObject({ sessions: 2, activeMs: 0 });
    expect(value.snapshot()).toBeUndefined();
  });

  it("handles clock rollback without negative duration", () => {
    const value = tracker();
    value.edit(context(), counts, start);
    value.edit(context(), counts, start - 1000);
    expect(totals(value)).toMatchObject({ sessions: 2, activeMs: 0 });
    expect(value.pending()[0]?.endReason).toBe("clock_changed");
    for (const snapshot of value.pending()) expect(stackStatsEventSchema.safeParse(snapshot).success).toBe(true);
  });

  it("batches rapid edits and retains changes arriving during a checkpoint", () => {
    const value = tracker();
    for (let i = 0; i < 1000; i++) value.edit(context(), counts, start + i * 10);
    const checkpoint = value.pending()[0]!;
    value.edit(context(), counts, start + 10_000);
    value.acknowledge(checkpoint);
    expect(value.pending()).toHaveLength(1);
    expect(value.pending()[0]?.days[0]?.contributions).toHaveLength(1);
    expect(totals(value)).toMatchObject({ activeMs: 10_000, editCount: 1001, linesAdded: 2002 });
    value.acknowledge(value.pending()[0]!);
    expect(value.pending()).toEqual([]);
    expect(value.snapshot()).toBeDefined();
  });
});

describe("editor-observed line boundaries", () => {
  const change = (text: string, from = 0, to = from, length = 0) => ({ text, range: { start: { line: from }, end: { line: to } }, rangeLength: length });
  it("does not count inline typing, character deletion or no-op as full lines", () => {
    expect(countLineChanges([change("abc"), change("", 0, 0, 1), change("")])).toEqual({ linesAdded: 0, linesRemoved: 0, editCount: 2 });
  });
  it("counts multiline paste, deletion, replacement and CRLF without retaining text", () => {
    expect(countLineChanges([change("a\r\nb\nc"), change("", 2, 5, 20), change("x\ny\n", 0, 2, 8)])).toEqual({ linesAdded: 4, linesRemoved: 5, editCount: 3 });
  });
  it("counts undo/redo as observed operations rather than netting them away", () => {
    expect(countLineChanges([change("a\nb"), change("", 0, 1, 3), change("a\nb")])).toEqual({ linesAdded: 2, linesRemoved: 1, editCount: 3 });
  });
});

describe("calendar statistics", () => {
  it("splits midnight time exactly and attributes counters to the edit's day", () => {
    const value = tracker("America/New_York");
    value.edit(context(), counts, Date.parse("2026-09-01T23:59:50-04:00"));
    value.edit(context(), counts, Date.parse("2026-09-02T00:00:10-04:00"));
    expect(dailyStatistics(value.pending(), "2026-09-01")).toMatchObject({ activeMs: 10_000, linesAdded: 2, sessions: 1 });
    expect(dailyStatistics(value.pending(), "2026-09-02")).toMatchObject({ activeMs: 10_000, linesAdded: 2, sessions: 1 });
    expect(weeklyStatistics(value.pending(), "2026-09-02")).toMatchObject({ activeMs: 20_000, sessions: 1, activeDays: 2, averageActiveMs: 10_000 });
  });

  it("handles DST and non-whole-hour timezones using elapsed milliseconds", () => {
    expect(splitByDay(Date.parse("2026-03-08T01:59:50-05:00"), Date.parse("2026-03-08T03:00:10-04:00"), "America/New_York")).toEqual([{ date: "2026-03-08", activeMs: 20_000 }]);
    expect(splitByDay(Date.parse("2026-11-01T01:59:50-04:00"), Date.parse("2026-11-01T01:00:10-05:00"), "America/New_York")).toEqual([{ date: "2026-11-01", activeMs: 20_000 }]);
    expect(localDateKey(Date.parse("2026-08-31T18:30:00Z"), "Asia/Kolkata")).toBe("2026-09-01");
  });

  it("deduplicates revisions and distinct files, ranks languages/projects, and excludes other weeks", () => {
    const first = session();
    const newer = structuredClone(first);
    newer.revision++;
    newer.days[0]!.contributions[0]!.linesAdded = 12;
    const second = session("2026-09-02T12:00:00Z", context("project-b", "file-a", "css"));
    const sameFile = session("2026-09-02T15:00:00Z");
    const outside = session("2026-08-30T12:00:00Z");
    const stats = weeklyStatistics([newer, first, newer, second, sameFile, outside], "2026-09-02");
    expect(stats).toMatchObject({ from: "2026-08-31", to: "2026-09-07", sessions: 3, activeDays: 2, activeMs: 90_000, averageActiveMs: 45_000, filesTouched: 2, projectsWorkedOn: 2, linesAdded: 20, linesRemoved: 6, totalLineChanges: 26, longestSession: { activeMs: 30_000 }, currentStreak: 2 });
    expect(stats.languages[0]).toMatchObject({ languageId: "typescript", activeMs: 60_000 });
    expect(stats.projects[0]).toMatchObject({ projectId: "project-a", activeMs: 60_000 });
  });

  it("handles empty history, Sunday/year boundaries and a streak through yesterday", () => {
    expect(weeklyStatistics([], "2027-01-03")).toMatchObject({ from: "2026-12-28", to: "2027-01-04", activeDays: 0, averageActiveMs: 0, longestSession: null, currentStreak: 0 });
    expect(currentStreak(["2026-12-30", "2026-12-31", "2027-01-01"], "2027-01-02")).toBe(3);
    expect(currentStreak(["2027-01-01"], "2027-01-03")).toBe(0);
  });
});

import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { SessionTracker, prepareSyncDaysV2, syncDay, syncDayV2, syncDatesV2 } from "@stack-stats/core";
import { parseSyncDay, parseSyncDayV2, SYNC_COUNTERS, SYNC_LANGUAGES, SYNC_V2_MAX_BYTES, SYNC_V2_MAX_PROJECTS,
  SYNC_V2_SESSION_DURATION_BOUNDS_MS, type SessionSnapshot, type SyncDayV2, type SyncHourlyUtc } from "@stack-stats/protocol";
import { context, counts, session, source } from "./fixtures.js";
import { randomUUID } from "node:crypto";

const date = "2026-09-01";
const options = { installationId: "test-install", uploadFromDate: "2026-06-04" };
const alias = (id: string) => createHmac("sha256", "account-install-secret").update(id).digest("hex");
function finalized(at = `${date}T12:00:00Z`, identity = context()): SessionSnapshot {
  return { ...session(at, identity), revision: 3, endReason: "shutdown" };
}
function hourly(at = date): SyncHourlyUtc {
  const activeMsByHour = Array<number>(24).fill(0), editCountByHour = Array<number>(24).fill(0);
  const linesAddedByHour = Array<number>(24).fill(0), linesRemovedByHour = Array<number>(24).fill(0);
  activeMsByHour[23] = 5_000; editCountByHour[0] = 10; linesAddedByHour[0] = 4;
  return { source: "telemetry-v2", dateBasis: "UTC", activeMsByHour, editCountByHour, linesAddedByHour, linesRemovedByHour,
    coverage: { firstObservedDate: at, lastObservedDate: at, partial: true, frozen: false, lateInputIgnored: false } };
}
const build = (snapshots: readonly SessionSnapshot[] = [finalized()], day = date) => syncDayV2(snapshots, day, alias, options);

describe("daily sync v2 aggregate", () => {
  it("keeps v1 exact fields and semantics independently accepted", () => {
    const history = [finalized()];
    const v1 = syncDay(history, date, alias), v2 = build(history);
    expect(parseSyncDay(v1)).toEqual(v1);
    expect(v1.schemaVersion).toBe("1");
    expect(Object.keys(v1)).toEqual(["schemaVersion", "aggregationVersion", "date", "revision", "activeMs", "editCount", "linesAdded", "linesRemoved", "sessionCount", "fileCount", "languages", "projects"]);
    for (const key of SYNC_COUNTERS) expect(v2[key]).toBe(v1[key]);
    expect(v2.sessionDays).toBe(v1.sessionCount);
    expect(() => parseSyncDay(v2)).toThrow();
    expect(() => parseSyncDayV2(v1)).toThrow();
  });

  it("builds finalized cohort totals and nullable legacy hourly coverage", () => {
    const value = build();
    expect(value).toMatchObject({ schemaVersion: "2", aggregationVersion: 1, date, revision: 1,
      activeMs: 30_000, editCount: 2, linesAdded: 4, linesRemoved: 2, sessionDays: 1, sessionStarts: 1,
      incompleteSessionStarts: 0, fileCount: 1, projectCount: 1, languageCount: 1, hourlyUtc: null,
      sessionDurations: { count: 1, activeMs: 30_000, editCount: 2, linesAdded: 4, linesRemoved: 2, minActiveMs: 30_000, maxActiveMs: 30_000 },
      coverage: { source: "sessions-v1", dateBasis: "collector-local", firstObservedDate: date, lastObservedDate: date,
        uploadFromDate: options.uploadFromDate, historyCompleteness: "unknown", partial: true } });
    expect(value.sessionDurations.histogram).toEqual([0, 1, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("rebuilds deterministically across reordered inputs and latest revisions", () => {
    const one = finalized(), two = finalized(`${date}T14:00:00Z`, context("project-b", "file-b", "css"));
    const old = { ...one, revision: 2, endReason: undefined };
    expect(JSON.stringify(build([old, two, one, one]))).toBe(JSON.stringify(build([one, two, old])));
    const indexed = prepareSyncDaysV2([one, two], options.installationId);
    const first = indexed.build(date, alias, options); first.sessionDurations.histogram[0] = 999; first.projects[0]!.editCount = 999;
    expect(indexed.build(date, alias, options)).toEqual(build([one, two]));
    expect(indexed.dates).toEqual([date]);
  });

  it("filters installation namespaces before picking the latest session revision", () => {
    const own = finalized();
    const foreign = { ...own, revision: 100, source: { ...own.source, installationId: "other-install" } };
    const result = build([foreign, own]);
    expect(result).toEqual(build([own]));
    expect(syncDatesV2([foreign], options.installationId)).toEqual([]);
    expect(build([foreign]).sessionStarts).toBe(0);
  });

  it("rejects conflicting latest revision contents but ignores superseded collisions deterministically", () => {
    const one = finalized(), conflicting = structuredClone(one);
    conflicting.days[0]!.contributions[0]!.editCount++;
    expect(() => build([one, conflicting])).toThrow("Conflicting session revision");
    const latest = { ...one, revision: one.revision + 1 };
    expect(build([one, conflicting, latest])).toEqual(build([latest, conflicting, one]));
  });

  it("counts session-days twice across midnight but owns finalized distribution once at local start", () => {
    const tracker = new SessionTracker({ source, createId: randomUUID, timeZone: "America/New_York" });
    tracker.edit(context(), counts, Date.parse("2026-09-01T23:59:50-04:00"));
    tracker.edit(context(), counts, Date.parse("2026-09-02T00:00:10-04:00"));
    tracker.end("shutdown");
    const history = tracker.pending(), first = build(history), second = build(history, "2026-09-02");
    expect(first).toMatchObject({ activeMs: 10_000, editCount: 1, sessionDays: 1, sessionStarts: 1,
      sessionDurations: { count: 1, activeMs: 20_000, editCount: 2, linesAdded: 4, linesRemoved: 2 } });
    expect(second).toMatchObject({ activeMs: 10_000, editCount: 1, sessionDays: 1, sessionStarts: 0, sessionDurations: { count: 0, activeMs: 0 } });
    expect(first.sessionDurations.activeMs / first.sessionDurations.count).toBe(20_000);
    expect(first.sessionDurations.editCount / first.sessionDurations.count).toBe(2);
  });

  it("keeps open/censored starts separate and replaces them when finalized", () => {
    const open = session(), finished = { ...open, revision: open.revision + 1, endReason: "idle" as const };
    expect(build([open])).toMatchObject({ sessionStarts: 1, incompleteSessionStarts: 1,
      sessionDurations: { count: 0, minActiveMs: null, maxActiveMs: null, activeMs: 0, editCount: 0 } });
    expect(build([open, finished])).toMatchObject({ incompleteSessionStarts: 0, sessionDurations: { count: 1, activeMs: 30_000 } });
  });

  it("creates a start-date owner row even if an old snapshot only has later contribution dates", () => {
    const value = finalized("2026-09-02T12:00:00Z");
    value.startedAt = "2026-09-01T23:59:59Z";
    expect(syncDatesV2([value], options.installationId)).toEqual(["2026-09-01", "2026-09-02"]);
    expect(build([value])).toMatchObject({ activeMs: 0, editCount: 0, sessionDays: 0, sessionStarts: 1, fileCount: 0,
      sessionDurations: { count: 1, activeMs: 30_000, editCount: 2 } });
  });

  it("uses recorded zones for date ownership across nonwhole-hour zones and DST", () => {
    const tracker = new SessionTracker({ source, createId: randomUUID, timeZone: "Asia/Kolkata" });
    tracker.edit(context(), counts, Date.parse("2026-08-31T18:30:00Z")); tracker.end("shutdown");
    expect(build(tracker.pending())).toMatchObject({ sessionStarts: 1, activeMs: 0, sessionDurations: { count: 1, minActiveMs: 0, maxActiveMs: 0 } });
    const dst = new SessionTracker({ source, createId: randomUUID, timeZone: "America/New_York" });
    dst.edit(context(), counts, Date.parse("2026-11-01T01:59:50-04:00"));
    dst.edit(context(), counts, Date.parse("2026-11-01T01:00:10-05:00")); dst.end("shutdown");
    expect(build(dst.pending(), "2026-11-01").sessionDurations.activeMs).toBe(20_000);
  });

  it("keeps UTC hours independent from local session totals and defaults absence to null", () => {
    const value = syncDayV2([finalized()], date, alias, { ...options, hourlyUtc: hourly() });
    expect(value.activeMs).toBe(30_000);
    expect(value.hourlyUtc!.activeMsByHour.reduce((a, b) => a + b, 0)).toBe(5_000);
    expect(value.hourlyUtc!.editCountByHour.reduce((a, b) => a + b, 0)).toBe(10);
    expect(parseSyncDayV2(value)).toEqual(value);
    const hourlyOnly = syncDayV2([], date, alias, { ...options, hourlyUtc: hourly() });
    expect(hourlyOnly.coverage.firstObservedDate).toBeNull();
    expect(hourlyOnly.hourlyUtc).not.toBeNull();
  });

  it("uses composite file identity and normalizes private language IDs without names or paths", () => {
    const first = finalized(`${date}T12:00:00Z`, context("private/project-a", "same/path", "private-language"));
    const second = finalized(`${date}T13:00:00Z`, context("private/project-b", "same/path", "another-private-language"));
    const value = build([first, second]);
    expect(value.fileCount).toBe(2); expect(value.projectCount).toBe(2); expect(value.languages).toHaveLength(1);
    expect(value.languages[0]).toMatchObject({ id: "other", activeMs: 60_000 });
    expect(JSON.stringify(value)).not.toMatch(/private|same\/path|test-install|displayName|fileId|sourceCode|token/);
  });

  it("caps project identity output with deterministic overflow and reconciled counters", () => {
    const many = finalized();
    many.days[0]!.contributions = Array.from({ length: SYNC_V2_MAX_PROJECTS + 2 }, (_, i) => ({
      ...context(`project-${i}`, "shared-file", "typescript"), activeMs: 0, editCount: i + 1, linesAdded: 4, linesRemoved: 2
    }));
    const value = build([many]);
    expect(value.projects).toHaveLength(SYNC_V2_MAX_PROJECTS);
    expect(value.projectCount).toBe(130); expect(value.fileCount).toBe(130);
    expect(value.projectOverflow).toEqual({ projectCount: 2, activeMs: 0, editCount: 3, linesAdded: 8, linesRemoved: 4 });
    for (const key of SYNC_COUNTERS) expect(value.projects.reduce((sum, row) => sum + row[key], value.projectOverflow[key])).toBe(value[key]);
    const reversed = structuredClone(many); reversed.days[0]!.contributions.reverse();
    expect(build([reversed])).toEqual(value);
    expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThan(SYNC_V2_MAX_BYTES);
  });

  it("accepts every allowed language under the cap and preserves other normalization", () => {
    const many = finalized();
    many.days[0]!.contributions = SYNC_LANGUAGES.map(language => ({ ...context("project", language, language), activeMs: 0, editCount: 1, linesAdded: 0, linesRemoved: 0 }));
    const value = build([many]);
    expect(value.languages).toHaveLength(SYNC_LANGUAGES.length);
    expect(value.languageCount).toBe(SYNC_LANGUAGES.length);
    expect(value.languages.map(row => row.id)).toEqual([...SYNC_LANGUAGES].sort());
  });

  it("represents empty days honestly without manufacturing coverage or finalized sessions", () => {
    const value = build([]);
    expect(value).toMatchObject({ activeMs: 0, editCount: 0, sessionDays: 0, sessionStarts: 0, fileCount: 0, projectCount: 0,
      sessionDurations: { count: 0, minActiveMs: null, maxActiveMs: null }, hourlyUtc: null,
      coverage: { firstObservedDate: null, lastObservedDate: null, partial: true, historyCompleteness: "unknown" } });
    expect(value.languages).toEqual([]); expect(value.projects).toEqual([]);
    const known = build([finalized()], "2026-09-02");
    expect(known.coverage).toMatchObject({ firstObservedDate: date, lastObservedDate: date });
  });

  it("keeps earliest retained date and excludes future metadata churn from older rows", () => {
    const old = finalized("2024-01-01T12:00:00Z"), today = finalized(), future = finalized("2026-09-20T12:00:00Z");
    expect(build([old, today, future])).toEqual(build([old, today]));
    expect(build([old, today]).coverage).toMatchObject({ firstObservedDate: "2024-01-01", lastObservedDate: date, uploadFromDate: options.uploadFromDate });
  });

  it("uses exact duration bin boundaries and mergeable cohort sum/max/histograms", () => {
    const durations = [0, ...SYNC_V2_SESSION_DURATION_BOUNDS_MS];
    const history = durations.map((activeMs, i) => {
      const value = finalized(); value.startedAt = `${date}T00:00:00Z`; value.endedAt = new Date(Date.parse(value.startedAt) + activeMs).toISOString();
      value.days[0]!.contributions[0]!.activeMs = activeMs;
      value.source.installationId = i % 2 ? "second" : "test-install";
      return value;
    });
    const first = build(history), second = syncDayV2(history, date, alias, { ...options, installationId: "second" });
    expect(first.sessionDurations.histogram.map((n, i) => n + second.sessionDurations.histogram[i]!)).toEqual(Array(9).fill(1));
    const sum = first.sessionDurations.activeMs + second.sessionDurations.activeMs;
    const count = first.sessionDurations.count + second.sessionDurations.count;
    expect(sum / count).toBe(durations.reduce((a, b) => a + b, 0) / durations.length);
    expect(Math.max(first.sessionDurations.maxActiveMs!, second.sessionDurations.maxActiveMs!)).toBe(14_400_000);
  });
});

describe("strict canonical sync v2 validation", () => {
  it("rejects sparse arrays before JSON serialization turns holes into nulls", () => {
    const empty = build([]);
    empty.sessionDurations.histogram = Array(9);
    expect(() => parseSyncDayV2(empty)).toThrow();
    for (const key of ["activeMsByHour", "editCountByHour", "linesAddedByHour", "linesRemovedByHour"] as const) {
      const value = syncDayV2([finalized()], date, alias, { ...options, hourlyUtc: hourly() });
      value.hourlyUtc![key] = Array(24);
      expect(() => parseSyncDayV2(value)).toThrow();
    }
  });

  it("returns fixed property order from reordered transport keys", () => {
    const value = build();
    const reversed = Object.fromEntries(Object.entries(value).reverse());
    expect(JSON.stringify(parseSyncDayV2(reversed))).toBe(JSON.stringify(value));
  });

  it.each([
    (v: any) => { v.schemaVersion = "3"; },
    (v: any) => { v.aggregationVersion = 2; },
    (v: any) => { v.sourceCode = "private"; },
    (v: any) => { v.date = "2026-02-30"; },
    (v: any) => { v.revision = 0; },
    (v: any) => { v.editCount = -1; },
    (v: any) => { v.activeMs = 1.5; },
    (v: any) => { v.linesAdded = Number.MAX_SAFE_INTEGER; },
    (v: any) => { v.languages[0].id = "private-language"; },
    (v: any) => { v.projects[0].id = "/private/path"; },
    (v: any) => { v.projectOverflow.editCount = 1; },
    (v: any) => { v.languageCount++; },
    (v: any) => { v.projectCount++; },
    (v: any) => { v.sessionDays = 0; },
    (v: any) => { v.fileCount = 0; },
    (v: any) => { v.sessionStarts++; },
    (v: any) => { v.sessionDurations.histogram[0]++; },
    (v: any) => { v.sessionDurations.minActiveMs = 1; },
    (v: any) => { v.sessionDurations.maxActiveMs = 31_000; },
    (v: any) => { v.sessionDurations.activeMs = 50_000; },
    (v: any) => { v.coverage.partial = false; },
    (v: any) => { v.coverage.historyCompleteness = "complete"; },
    (v: any) => { v.coverage.firstObservedDate = null; },
    (v: any) => { v.coverage.lastObservedDate = "2026-09-20"; },
    (v: any) => { v.coverage.uploadFromDate = "2026-09-02"; }
  ])("rejects malformed or contradictory payload %#", mutate => {
    const value = structuredClone(build()); mutate(value);
    expect(() => parseSyncDayV2(value)).toThrow();
  });

  it("rejects reordered/duplicate/oversized identity arrays and mismatched marginal counters", () => {
    const value = build([finalized(), finalized(`${date}T14:00:00Z`, context("p-b", "f-b", "css"))]);
    const reordered = structuredClone(value); reordered.languages.reverse();
    expect(() => parseSyncDayV2(reordered)).toThrow();
    const duplicate = structuredClone(value); duplicate.projects[1] = duplicate.projects[0]!;
    expect(() => parseSyncDayV2(duplicate)).toThrow();
    const tooMany = structuredClone(value); tooMany.projects = Array(129).fill(value.projects[0]);
    expect(() => parseSyncDayV2(tooMany)).toThrow();
    const wrong = structuredClone(value); wrong.languages[0]!.editCount++;
    expect(() => parseSyncDayV2(wrong)).toThrow();
  });

  it("requires zero daily dimensions without session contributions and a full capped project page before overflow", () => {
    const empty = build([]);
    empty.languages = [{ id: "typescript", activeMs: 0, editCount: 0, linesAdded: 0, linesRemoved: 0 }]; empty.languageCount = 1;
    expect(() => parseSyncDayV2(empty)).toThrow();
    const noIdentities = build([]); noIdentities.sessionDays = 1;
    noIdentities.coverage.firstObservedDate = date; noIdentities.coverage.lastObservedDate = date;
    expect(() => parseSyncDayV2(noIdentities)).toThrow();
    const incompletePage = build();
    incompletePage.projectOverflow.projectCount = 1; incompletePage.projectCount = 2; incompletePage.fileCount = 2;
    expect(() => parseSyncDayV2(incompletePage)).toThrow("full identity page");
    const sparse = build(); sparse.languages = Array(1);
    expect(() => parseSyncDayV2(sparse)).toThrow();
  });

  it("requires the duration sum to be jointly feasible with histogram counts and actual extrema", () => {
    const durations = [59_000, 60_000, 60_000];
    const history = durations.map(activeMs => {
      const value = finalized(); value.endedAt = new Date(Date.parse(value.startedAt) + activeMs).toISOString();
      value.days[0]!.contributions[0]!.activeMs = activeMs; return value;
    });
    const value = build(history);
    expect(value.sessionDurations).toMatchObject({ count: 3, activeMs: 179_000, minActiveMs: 59_000, maxActiveMs: 60_000,
      histogram: [0, 1, 2, 0, 0, 0, 0, 0, 0] });
    value.sessionDurations.activeMs = 178_500;
    expect(() => parseSyncDayV2(value)).toThrow("histogram duration");
  });

  it.each([[0], [100], [100, 100], [100, 200], [100, 150, 200], [14_400_000, 20_000_000]])(
    "accepts feasible zero, single-sample, same-bin and open-ended extrema %#", (...durations) => {
      const history = durations.map(activeMs => {
        const value = finalized(); value.endedAt = new Date(Date.parse(value.startedAt) + activeMs).toISOString();
        value.days[0]!.contributions[0]!.activeMs = activeMs; return value;
      });
      const value = build(history);
      expect(parseSyncDayV2(value)).toEqual(value);
      value.sessionDurations.activeMs = Math.min(...durations) * durations.length - 1;
      expect(() => parseSyncDayV2(value)).toThrow();
    }
  );

  it("bounds payload bytes before parsing and independently validates UTC array coverage", () => {
    expect(() => parseSyncDayV2({ ...build(), accidentalSource: "x".repeat(SYNC_V2_MAX_BYTES) })).toThrow("size limit");
    const base = syncDayV2([finalized()], date, alias, { ...options, hourlyUtc: hourly() });
    const mutators: Array<(value: SyncDayV2) => void> = [
      value => value.hourlyUtc!.activeMsByHour.pop(),
      value => { value.hourlyUtc!.editCountByHour[0] = -1; },
      value => { value.hourlyUtc!.activeMsByHour.fill(604_800_000); },
      value => { value.hourlyUtc!.coverage.firstObservedDate = "2026-08-31"; },
      value => { value.hourlyUtc!.coverage.lateInputIgnored = true; }
    ];
    for (const mutate of mutators) { const value = structuredClone(base); mutate(value); expect(() => parseSyncDayV2(value)).toThrow(); }
    base.hourlyUtc!.coverage.frozen = true; base.hourlyUtc!.coverage.lateInputIgnored = true;
    expect(parseSyncDayV2(base).hourlyUtc!.coverage.lateInputIgnored).toBe(true);
  });
});

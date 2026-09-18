import { describe, expect, it, vi } from "vitest";
import { SessionTracker, dailyStatistics, weeklyStatistics } from "@stack-stats/core";
import { randomUUID } from "node:crypto";
import { SessionSummaryCache, inactivityMinutes } from "../apps/vscode-extension/src/stats-model.js";
import { rowsForView, rowsForPanel, sidebarViews, statusBarPresentation, type SidebarState } from "../apps/vscode-extension/src/sidebar-model.js";
import { context, counts, session, source, tracker } from "./fixtures.js";

async function state(): Promise<SidebarState> {
  const history = new SessionSummaryCache();
  await history.load(async () => [], "2026-09-02");
  return { summary: history.summarize("2026-09-02"), enabled: true, ready: true, refreshing: false,
    historyError: false, storageError: false, idleMinutes: 5, syncConfigured: false };
}

describe("sidebar summary cache", () => {
  it("reuses core reducers, merges current revisions once, and keeps checkpointed totals", async () => {
    const history = new SessionSummaryCache();
    const value = tracker();
    const start = Date.parse("2026-09-02T12:00:00Z");
    value.edit(context(), counts, start);
    const old = value.snapshot()!;
    const read = vi.fn(async () => [old]);
    await history.load(read, "2026-09-02");
    value.edit(context(), counts, start + 30_000);
    const fresh = value.snapshot()!;
    const result = history.summarize("2026-09-02", fresh, value.pending());
    expect(result.today).toEqual(dailyStatistics([fresh], "2026-09-02"));
    expect(result.week).toEqual(weeklyStatistics([fresh], "2026-09-02"));
    history.remember(fresh);
    value.acknowledge(fresh);
    expect(history.summarize("2026-09-02").today.editCount).toBe(2);
    for (let i = 0; i < 20; i++) history.summarize("2026-09-02", fresh);
    expect(read).toHaveBeenCalledTimes(1); // UI refreshes perform no history I/O.
  });

  it("keeps historical streak dates outside the cached week and rolls over dates without inventing activity", async () => {
    const history = new SessionSummaryCache();
    const sessions = [29, 30, 31].map(day => session(`2026-08-${day}T12:00:00Z`));
    sessions.push(session("2026-09-01T12:00:00Z"));
    await history.load(async () => sessions, "2026-09-02");
    expect(history.summarize("2026-09-02").week).toEqual(weeklyStatistics(sessions, "2026-09-02"));
    expect(history.summarize("2026-09-02").week.currentStreak).toBe(4);
    expect(history.summarize("2026-09-03").week.currentStreak).toBe(0);
    expect(history.summarize("2026-09-07").week.sessions).toBe(0);
  });

  it("coalesces concurrent history loads and retains checkpoints saved during a stale read", async () => {
    const history = new SessionSummaryCache();
    let finish!: (sessions: ReturnType<typeof session>[]) => void;
    const read = vi.fn(() => new Promise<ReturnType<typeof session>[]>(resolve => { finish = resolve; }));
    const first = history.load(read, "2026-09-02");
    const second = history.load(read, "2026-09-02");
    expect(first).toBe(second);
    await Promise.resolve();
    const saved = session();
    history.remember(saved);
    finish([]);
    await first;
    expect(history.refreshing).toBe(false);
    expect(history.summarize("2026-09-02").week.sessions).toBe(1);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("preserves usable cached history on errors, retries synchronous failures, and reloads deletions", async () => {
    const history = new SessionSummaryCache();
    await history.load(() => { throw new Error("disk unavailable"); }, "2026-09-02");
    expect(history.ready).toBe(false);
    expect(history.error).toBe(true);
    expect(history.refreshing).toBe(false);
    await history.load(async () => [session()], "2026-09-02");
    await history.load(async () => { throw new Error("disk unavailable"); }, "2026-09-02");
    expect(history.ready).toBe(true);
    expect(history.error).toBe(true);
    expect(history.summarize("2026-09-02").week.sessions).toBe(1);
    await history.load(async () => [], "2026-09-02");
    expect(history.error).toBe(false);
    expect(history.summarize("2026-09-02").week.sessions).toBe(0);
  });
});

describe("human-readable sidebar presentation", () => {
  it("renders all seven sections with honest empty, loading, paused and error states", async () => {
    const view = await state();
    for (const id of sidebarViews) expect(rowsForView(id, view).length).toBeGreaterThan(0);
    expect(rowsForView("currentSession", view)[0]?.label).toBe("No current session");
    expect(rowsForView("today", { ...view, ready: false })[0]?.label).toContain("Loading");
    expect(rowsForView("today", { ...view, historyError: true })[0]?.command).toBe("stackStats.refreshStats");
    expect(rowsForView("currentSession", { ...view, enabled: false })).toContainEqual(expect.objectContaining({ command: "stackStats.resume" }));
    expect(rowsForView("thisWeek", view).find(row => row.id === "longest")?.description).toBe("No sessions yet");
    expect(statusBarPresentation(view).text).toContain("Idle");
    const pausedError = statusBarPresentation({ ...view, enabled: false, storageError: true });
    expect(pausedError.text).toContain("Paused");
    expect(pausedError.tooltip).toContain("storage needs attention");
  });

  it("shows existing counts and project labels without guessing authorship or zero-time percentages", async () => {
    const view = await state();
    const value = tracker();
    value.edit(context("Project abcd", "private-id", "typescript"), counts, Date.parse("2026-09-02T12:00:00Z"));
    const cache = new SessionSummaryCache();
    view.summary = cache.summarize("2026-09-02", value.snapshot(), value.pending());
    const language = rowsForView("languages", view)[0]!;
    expect(language.description).toBe("0s");
    expect(language.children?.find(row => row.id === "edits")?.description).toBe("1");
    expect(rowsForView("projects", view)[0]?.label).toBe("Project abcd");
    expect(rowsForView("today", view).find(row => row.id === "added")?.description).toBe("+2");
    expect(statusBarPresentation(view).text).toContain("0s");
    expect(JSON.stringify(sidebarViews.flatMap(id => rowsForView(id, view)))).not.toMatch(/private-id|manual code|AI code/);
  });
});

describe("configurable session grouping", () => {
  it("keeps the default and rejects unsafe settings", () => {
    for (const invalid of [undefined, null, "10", 0, 61, 1.5, NaN, Infinity]) expect(inactivityMinutes(invalid)).toBe(5);
    expect(inactivityMinutes(1)).toBe(1);
    expect(inactivityMinutes(60)).toBe(60);
    const value = tracker();
    expect(() => value.setIdleTimeout(0)).toThrow(RangeError);
    expect(() => value.setIdleTimeout(Infinity)).toThrow(RangeError);
  });

  it("changes session grouping without extending active-time credit or rewriting old sessions", () => {
    const value = new SessionTracker({ source, createId: randomUUID, timeZone: "UTC", idleTimeoutMs: 10 * 60_000 });
    const start = Date.parse("2026-09-02T12:00:00Z");
    value.edit(context(), counts, start);
    value.edit(context(), counts, start + 6 * 60_000);
    expect(weeklyStatistics(value.pending(), "2026-09-02")).toMatchObject({ sessions: 1, activeMs: 0 });
    value.setIdleTimeout(60_000);
    value.expire(start + 7 * 60_000 - 1);
    expect(value.isActive).toBe(true);
    value.expire(start + 7 * 60_000);
    expect(value.isActive).toBe(false);
    expect(value.pending()[0]).toMatchObject({ endedAt: new Date(start + 6 * 60_000).toISOString(), endReason: "idle" });
  });
});


describe("simplified Activity and Account panels", () => {
  it("keeps every existing metric accessible while opening only today's details by default", async () => {
    const view = await state(); const snapshot = session("2026-09-02T12:00:00Z");
    view.summary = new SessionSummaryCache().summarize("2026-09-02", snapshot);
    const activity = rowsForPanel("today", view);
    expect(activity.map(row => row.label)).toEqual(["Today", "Current session", "This week", "Languages", "Projects", "Coding streak"]);
    expect(activity.filter(row => row.expanded).map(row => row.id)).toEqual(["today"]);
    const today = activity[0]!;
    expect(today.description).toBe("30s");
    expect(today.children).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "changes", description: "+4 / −2" }),
      expect.objectContaining({ id: "files", description: "1" }),
      expect.objectContaining({ id: "edits", description: "2" }),
      expect.objectContaining({ id: "sessions", description: "1" })
    ]));
    expect(activity.find(row => row.id === "thisWeek")?.children?.map(row => row.id)).toEqual(expect.arrayContaining(["longest", "days", "average"]));
    expect(activity.find(row => row.id === "languages")?.children?.[0]?.label).toBe("TypeScript");
    expect(activity.find(row => row.id === "currentSession")?.children?.map(row => row.id)).toEqual(expect.arrayContaining(["started", "lastEdit"]));
  });
  it("shows one optional account invitation and keeps operational detail collapsed", async () => {
    const view = await state(); const account = rowsForPanel("trackingStatus", view);
    expect(account.map(row => row.id)).toEqual(["account", "local"]);
    expect(account[0]).toMatchObject({ label: "Connect account", description: "Optional", command: "stackStats.connectAccount" });
    expect(account.every(row => !row.expanded)).toBe(true);
    const diagnostics = account[1]?.children?.find(row => row.id === "diagnostics");
    expect(diagnostics?.children?.map(row => row.id)).toEqual(expect.arrayContaining(["storage", "history", "timeout", "sync"]));
  });
  it("keeps account errors and pending sync actionable without changing consent", async () => {
    const view = await state();
    const rows = rowsForPanel("trackingStatus", { ...view, account: { status: "error", message: "Network unavailable; credentials retained." }, profileSync: { status: "pending", pendingDays: 3, message: "Retrying later." } });
    expect(rows[0]).toMatchObject({ expanded: true, icon: "warning" });
    expect(rows[0]?.children).toContainEqual(expect.objectContaining({ command: "stackStats.connectAccount" }));
    expect(rows.find(row => row.id === "profileSync")).toMatchObject({ description: "3 days pending" });
    expect(rows.find(row => row.id === "profileSync")?.children).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: "stackStats.disableProfileSync" }), expect.objectContaining({ command: "stackStats.syncNow" }), expect.objectContaining({ command: "stackStats.syncPrivacy" })
    ]));
  });
  it("shows a single error per issue and never presents unloaded history as zero", async () => {
    const view = await state();
    const rows = rowsForPanel("today", { ...view, ready: false, historyError: true, storageError: true });
    expect(rows.map(row => row.id)).toEqual(["storageWarning", "historyWarning", "loading", "currentSession"]);
    const paused = rowsForPanel("today", { ...view, enabled: false });
    expect(paused.find(row => row.id === "today")?.children).toContainEqual(expect.objectContaining({ command: "stackStats.resume" }));
  });
});

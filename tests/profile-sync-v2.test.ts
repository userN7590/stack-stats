import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addDays } from "@stack-stats/core";
import { parseSyncDayV2, type SyncDayV2, type SyncHourlyUtc } from "@stack-stats/protocol";
import { ProfileSyncService, supportsSyncV2 } from "../apps/vscode-extension/src/profile-sync.js";
import type { AccountState } from "../apps/vscode-extension/src/account-service.js";
import { session } from "./fixtures.js";

const install = "11111111-1111-4111-8111-111111111111";
const identity = { userId: "22222222-2222-4222-8222-222222222222", username: "owner", displayName: null, profileUrl: "https://stackstats.dev/u/owner" };
const dirs: string[] = [], services: ProfileSyncService[] = [];
afterEach(async () => { services.splice(0).forEach(service => service.dispose()); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
function hours(date: string): SyncHourlyUtc {
  const activeMsByHour = Array<number>(24).fill(0); activeMsByHour[12] = 30_000;
  const editCountByHour = Array<number>(24).fill(0); editCountByHour[12] = 2;
  return { source: "telemetry-v2", dateBasis: "UTC", activeMsByHour, editCountByHour,
    linesAddedByHour: Array<number>(24).fill(0), linesRemovedByHour: Array<number>(24).fill(0),
    coverage: { firstObservedDate: date, lastObservedDate: date, partial: true, frozen: false, lateInputIgnored: false } };
}
async function harness() {
  const directory = await mkdtemp(join(tmpdir(), "stack-stats-sync-v2-")); dirs.push(directory);
  let time = Date.parse("2026-09-27T12:00:00Z"), today = "2026-09-27", hourlyAllowed = false;
  let state: AccountState = { status: "connected", account: identity, syncGrant: "grant-v2" };
  const rows = [session("2026-09-27T12:00:00Z")]; rows[0]!.source.installationId = install; rows[0]!.endReason = "idle";
  const hourly = new Map<string, SyncHourlyUtc>([[today, hours(today)]]);
  const capabilities = vi.fn(async (): Promise<Response> => Response.json({ schemaVersion: "1", dailyVersions: ["1", "2"] }));
  const upload = vi.fn<typeof fetch>(async (_url, options) => {
    const value = JSON.parse(options!.body as string);
    return Response.json({ schemaVersion: value.schemaVersion, installationId: install, date: value.date, revision: value.revision });
  });
  const transport: typeof fetch = async (url, options) => String(url).endsWith("/capabilities") ? capabilities() : upload(url, options);
  const account = { getState: () => state, getAccessToken: vi.fn(async () => "private-access"), refreshAccessToken: vi.fn(async () => "private-refresh"), getOrigin: () => "https://stackstats.dev" };
  const hourlyDays = vi.fn(async () => hourly);
  const ports = { directory, installationId: install, projectSalt: "local-private-salt", account, sessions: async () => rows,
    today: () => today, now: () => time, fetch: transport, random: () => 0, hourlyAllowed: () => hourlyAllowed, hourlyDays };
  const restore = () => { const service = new ProfileSyncService(ports); services.push(service); return service; };
  const service = restore();
  const bodies = () => upload.mock.calls.map(([, options]) => JSON.parse(options!.body as string) as SyncDayV2);
  const queueFile = async () => join(directory, (await readdir(directory)).find(name => !name.endsWith(".lock"))!, "queue.json");
  return { service, restore, ports, rows, hourly, hourlyDays, upload, capabilities, account, bodies, queueFile,
    advance: (ms: number) => { time += ms; }, setToday: (value: string) => { today = value; },
    setState: (value: AccountState) => { state = value; service.accountChanged(); },
    setHourly: (value: boolean) => { hourlyAllowed = value; service.accountChanged(); } };
}

describe("v2 capability negotiation and consent", () => {
  it("accepts only bounded, explicit, known capability contracts", () => {
    expect(supportsSyncV2({ schemaVersion: "1", dailyVersions: ["1", "2"] })).toBe(true);
    const sparse = Array<string>(2); sparse[1] = "2";
    for (const value of [null, [], {}, { schemaVersion: "2", dailyVersions: ["2"] }, { schemaVersion: "1", dailyVersions: ["3", "2"] },
      { schemaVersion: "1", dailyVersions: ["2", "2"] }, { schemaVersion: "1", dailyVersions: ["1"] },
      { schemaVersion: "1", dailyVersions: ["2"], userId: "injected" }, { schemaVersion: "1", dailyVersions: sparse }]) expect(supportsSyncV2(value)).toBe(false);
  });
  it.each([404, 401, 500])("keeps v1 working when capability endpoint returns %i", async status => {
    const h = await harness(); h.capabilities.mockImplementation(async () => new Response(null, { status }));
    await h.service.tick(true); expect(h.bodies()[0]!.schemaVersion).toBe("1");
    expect(h.upload.mock.calls[0]![0]).toContain("/api/v1/sync/"); expect(h.hourlyDays).not.toHaveBeenCalled();
  });
  it("falls back for malformed or oversized capability bodies without uploading richer data", async () => {
    const h = await harness(); h.capabilities.mockImplementation(async () => new Response("x".repeat(4096)));
    await h.service.tick(true); expect(h.bodies()[0]!.schemaVersion).toBe("1");
  });
  it("does not probe or upload for absent consent, or revive a persisted disable", async () => {
    const h = await harness(); h.setState({ status: "connected", account: identity });
    await h.service.tick(true); expect(h.capabilities).not.toHaveBeenCalled(); expect(h.upload).not.toHaveBeenCalled();
    h.setState({ status: "connected", account: identity, syncGrant: "grant-v2" });
    await h.service.disable(); await h.restore().tick(true);
    expect(h.capabilities).not.toHaveBeenCalled(); expect(h.upload).not.toHaveBeenCalled();
  });
  it("does not transfer a capability grant across an account switch during the probe", async () => {
    const h = await harness(); h.capabilities.mockImplementationOnce(async () => {
      h.setState({ status: "connected", account: { ...identity, userId: install }, syncGrant: "different" });
      return Response.json({ schemaVersion: "1", dailyVersions: ["2"] });
    });
    await h.service.tick(true); expect(h.upload).not.toHaveBeenCalled();
  });
});

describe("durable richer daily queue", () => {
  it.each([false, true])("filters foreign session revisions before deduplication (v2=%s)", async rich => {
    const h = await harness();
    if (!rich) h.capabilities.mockImplementation(async () => new Response(null, { status: 404 }));
    const foreign = structuredClone(h.rows[0]!);
    foreign.source.installationId = "33333333-3333-4333-8333-333333333333";
    foreign.revision++;
    h.rows.push(foreign);
    await h.service.tick(true);
    expect(h.bodies()).toHaveLength(1);
    expect(h.bodies()[0]).toMatchObject({ schemaVersion: rich ? "2" : "1", activeMs: 30_000, editCount: 2 });
  });
  it("negotiates v2, persists its version before sending, and does not resend unchanged content", async () => {
    const h = await harness();
    h.upload.mockImplementationOnce(async (_url, options) => {
      const ledger = JSON.parse(await readFile(await h.queueFile(), "utf8"));
      expect(ledger.version).toBe(2); expect(ledger.entries["2026-09-27"].payload.schemaVersion).toBe("2");
      const body = JSON.parse(options!.body as string);
      return Response.json({ schemaVersion: "2", installationId: install, date: body.date, revision: body.revision });
    });
    await h.service.tick(true); await h.service.tick(true);
    expect(h.upload).toHaveBeenCalledTimes(1); expect(h.capabilities).toHaveBeenCalledTimes(1);
    expect(h.upload.mock.calls[0]![0]).toContain("/api/v2/sync/");
    expect(parseSyncDayV2(h.bodies()[0])).toMatchObject({ revision: 1, sessionDays: 1, sessionStarts: 1, hourlyUtc: null,
      sessionDurations: { count: 1, activeMs: 30_000 }, coverage: { historyCompleteness: "unknown", partial: true } });
    expect(h.hourlyDays).not.toHaveBeenCalled();
  });
  it("lazily upgrades acknowledged v1 days using the same floor and next revision", async () => {
    const h = await harness(); h.capabilities.mockImplementationOnce(async () => new Response(null, { status: 404 }));
    await h.service.tick(true); const before = JSON.parse(await readFile(await h.queueFile(), "utf8"));
    expect(before.version).toBe(1);
    h.advance(300_001); await h.service.tick(true);
    const after = JSON.parse(await readFile(await h.queueFile(), "utf8"));
    expect(after.version).toBe(2); expect(after.fromDate).toBe(before.fromDate);
    expect(h.bodies().map(value => [value.schemaVersion, value.revision])).toEqual([["1", 1], ["2", 2]]);
  });
  it("pins v2 before a lost response and never down-projects on later unsupported capabilities", async () => {
    const h = await harness(); h.upload.mockRejectedValueOnce(new Error("response lost after server commit"));
    await h.service.tick(true); expect(h.service.getState().pendingDays).toBe(1);
    h.capabilities.mockImplementation(async () => new Response(null, { status: 404 }));
    const restored = h.restore(); h.advance(60_001); await restored.tick();
    expect(h.upload).toHaveBeenCalledTimes(1); expect(restored.getState().pendingDays).toBe(1);
    h.capabilities.mockImplementation(async () => Response.json({ schemaVersion: "1", dailyVersions: ["1", "2"] }));
    h.advance(300_001); await restored.tick();
    expect(h.bodies().map(value => value.schemaVersion)).toEqual(["2", "2"]);
    expect(h.upload.mock.calls[0]![1]!.body).toBe(h.upload.mock.calls[1]![1]!.body);
    expect(restored.getState().pendingDays).toBe(0);
  });
  it("does not acknowledge a v2 payload with a v1-shaped acknowledgement", async () => {
    const h = await harness(); h.upload.mockImplementationOnce(async (_url, options) => {
      const body = JSON.parse(options!.body as string); return Response.json({ installationId: install, date: body.date, revision: body.revision });
    });
    await h.service.tick(true); expect(h.service.getState()).toMatchObject({ status: "pending", pendingDays: 1 });
  });
  it("bounds offline backfill to 90 initial dates and ten PUTs per pass", async () => {
    const h = await harness(); h.rows.length = 0;
    for (let n = 0; n < 100; n++) { const row = session(`${addDays("2026-09-27", -n)}T12:00:00Z`); row.source.installationId = install; row.endReason = "idle"; h.rows.push(row); }
    const foreign = session("2026-09-27T13:00:00Z"); h.rows.push(foreign);
    await h.service.tick(true); expect(h.upload).toHaveBeenCalledTimes(10); expect(h.service.getState().pendingDays).toBe(80);
    expect(h.bodies().every(value => value.sessionDays === 1)).toBe(true);
    expect(h.bodies()[0]!.coverage.firstObservedDate).toBe(addDays("2026-09-27", -99));
    expect(h.bodies()[0]!.coverage.uploadFromDate).toBe(addDays("2026-09-27", -89));
    const restarted = h.restore(); for (let n = 0; n < 8; n++) { h.advance(30_001); await restarted.tick(); }
    expect(restarted.getState().pendingDays).toBe(0); expect(new Set(h.bodies().map(value => value.date)).size).toBe(90);
  });
  it("updates the start-date finalized cohort when a midnight-spanning session finishes", async () => {
    const h = await harness(); const row = session("2026-09-26T23:59:45Z"); row.source.installationId = install;
    h.rows.splice(0, h.rows.length, row); await h.service.tick(true);
    expect(h.bodies().map(value => value.sessionDays)).toEqual([1, 1]);
    expect(h.bodies().map(value => value.sessionStarts)).toEqual([1, 0]);
    expect(h.bodies()[0]!.incompleteSessionStarts).toBe(1);
    row.endReason = "idle"; row.revision++; await h.service.tick(true);
    expect(h.bodies().at(-1)).toMatchObject({ date: "2026-09-26", revision: 2, incompleteSessionStarts: 0,
      sessionDurations: { count: 1, activeMs: 30_000, editCount: 2 } });
  });
  it("keeps old day revisions stable when a new day arrives", async () => {
    const h = await harness(); await h.service.tick(true);
    const row = session("2026-09-28T12:00:00Z"); row.source.installationId = install; h.rows.push(row);
    h.setToday("2026-09-28"); h.advance(86_400_000); await h.service.tick(true);
    expect(h.bodies().map(value => value.date)).toEqual(["2026-09-27", "2026-09-28"]);
  });
  it("replaces a formerly recorded v2 day with explicit empty counters after a strict empty source read", async () => {
    const h = await harness(); await h.service.tick(true); h.rows.length = 0; await h.service.tick(true);
    expect(h.bodies().at(-1)).toMatchObject({ revision: 2, editCount: 0, activeMs: 0, sessionDays: 0, sessionStarts: 0, languages: [], projects: [],
      coverage: { firstObservedDate: null, lastObservedDate: null, partial: true } });
  });
  it("preserves queued data on corrupt/failed richer history reads", async () => {
    const h = await harness(); h.setHourly(true); await h.service.tick(true);
    const before = await readFile(await h.queueFile(), "utf8");
    h.hourlyDays.mockRejectedValueOnce(new Error("corrupt aggregate")); await h.service.tick(true);
    expect(h.service.getState().status).toBe("error"); expect(await readFile(await h.queueFile(), "utf8")).toBe(before);
    expect(h.upload).toHaveBeenCalledTimes(1);
  });
  it("rejects unknown persisted payload versions without resetting revisions", async () => {
    const h = await harness(); await h.service.tick(true); const file = await h.queueFile();
    const ledger = JSON.parse(await readFile(file, "utf8")); ledger.entries["2026-09-27"].payload.schemaVersion = "999";
    await writeFile(file, JSON.stringify(ledger)); await h.restore().tick(true);
    expect(h.upload).toHaveBeenCalledTimes(1); expect(JSON.parse(await readFile(file, "utf8")).entries["2026-09-27"].payload.schemaVersion).toBe("999");
  });
  it("does not inflate revisions across concurrent windows", async () => {
    const h = await harness(); await Promise.all([h.service.tick(true), h.restore().tick(true)]);
    expect(new Set(h.bodies().map(value => value.revision))).toEqual(new Set([1]));
    expect(new Set(h.upload.mock.calls.map(([, options]) => options!.body)).size).toBe(1);
  });
  it("protects a newer local revision from an old in-flight acknowledgement", async () => {
    const h = await harness(); const other = h.restore();
    h.upload.mockImplementationOnce(async (_url, options) => {
      const body = JSON.parse(options!.body as string);
      h.rows[0]!.revision++; h.rows[0]!.days[0]!.contributions[0]!.editCount++;
      await other.tick(true);
      return Response.json({ schemaVersion: "2", installationId: install, date: body.date, revision: body.revision });
    });
    await h.service.tick(true);
    const ledger = JSON.parse(await readFile(await h.queueFile(), "utf8"));
    expect(ledger.entries["2026-09-27"].payload.revision).toBe(2); expect(ledger.entries["2026-09-27"].acknowledged).toBe(2);
  });
  it("does not send a stale v1 payload after another window pins the day to v2", async () => {
    const h = await harness(); const other = h.restore();
    h.capabilities.mockImplementationOnce(async () => new Response(null, { status: 404 }));
    h.account.getAccessToken.mockImplementationOnce(async () => "first-capability-token");
    h.account.getAccessToken.mockImplementationOnce(async () => { await other.tick(true); return "first-upload-token"; });
    await h.service.tick(true);
    expect(h.bodies().map(value => value.schemaVersion)).toEqual(["2"]);
  });
});

describe("hourly upload privacy", () => {
  it("requires hourly opt-in and removes the whole hourly block with a revisioned replacement", async () => {
    const h = await harness(); await h.service.tick(true); expect(h.bodies()[0]!.hourlyUtc).toBeNull();
    h.setHourly(true); await h.service.tick(true); expect(h.bodies().at(-1)!.hourlyUtc!.activeMsByHour[12]).toBe(30_000);
    h.setHourly(false); await h.service.tick(true); expect(h.bodies().at(-1)).toMatchObject({ revision: 3, hourlyUtc: null });
    expect(h.hourlyDays).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(h.bodies())).not.toMatch(/private-access|private-refresh|local-private-salt|sessionId|fileId|displayName|startedAt|timeZone/);
  });
  it("preserves UTC-only dates even when no local session date matches", async () => {
    const h = await harness(); h.setHourly(true); h.hourly.set("2026-09-26", hours("2026-09-26"));
    await h.service.tick(true); expect(h.bodies()[0]).toMatchObject({ date: "2026-09-26", activeMs: 0, editCount: 0, sessionDays: 0,
      hourlyUtc: { source: "telemetry-v2", dateBasis: "UTC" } });
  });
  it("can upload today's UTC bucket when the collector-local date is yesterday", async () => {
    const h = await harness(); h.setHourly(true); h.rows.length = 0; h.setToday("2026-09-26");
    await h.service.tick(true); expect(h.bodies()[0]!.date).toBe("2026-09-27");
  });
  it("honors hourly withdrawal while waiting for upload credentials", async () => {
    const h = await harness(); h.setHourly(true);
    h.account.getAccessToken.mockImplementationOnce(async () => "capability-token");
    h.account.getAccessToken.mockImplementationOnce(async () => { h.setHourly(false); return "upload-token"; });
    await h.service.tick(true); expect(h.upload).not.toHaveBeenCalled();
    await h.service.tick(true); expect(h.bodies()[0]!.hourlyUtc).toBeNull();
  });
});

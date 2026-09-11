import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncDay, addDays } from "@stack-stats/core";
import { parseSyncDay } from "@stack-stats/protocol";
import { ProfileSyncService, stableInstallation } from "../apps/vscode-extension/src/profile-sync.js";
import type { AccountState } from "../apps/vscode-extension/src/account-service.js";
import { LocalSessionStore } from "../apps/vscode-extension/src/local-store.js";
import { session, context } from "./fixtures.js";
const install = "11111111-1111-4111-8111-111111111111";
const identity = { userId: "22222222-2222-4222-8222-222222222222", username: "fil", displayName: null, profileUrl: "https://stackstats.dev/u/fil" };
const temporary: string[] = [];
const services: ProfileSyncService[] = [];
afterEach(async () => { services.splice(0).forEach(service => service.dispose()); await Promise.all(temporary.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function harness() {
  const directory = await mkdtemp(join(tmpdir(), "stack-stats-sync-")); temporary.push(directory);
  let time = Date.parse("2026-09-10T12:00:00Z");
  let state: AccountState = { status: "connected", account: identity, syncGrant: "33333333-3333-4333-8333-333333333333" };
  const sessions = [session("2026-09-10T12:00:00Z")]; sessions.forEach(row => row.source.installationId = install);
  const fetcher = vi.fn<typeof fetch>(async (url, options) => {
    const body = JSON.parse(options!.body as string);
    return Response.json({ installationId: install, date: body.date, revision: body.revision });
  });
  const account = { getState: () => state, getAccessToken: vi.fn(async () => "access"), refreshAccessToken: vi.fn(async () => "new-access"), getOrigin: () => "https://stackstats.dev" };
  const ports = { directory, installationId: install, projectSalt: "private-test-salt", account, sessions: async () => sessions, today: () => "2026-09-10", now: () => time, fetch: fetcher, random: () => 0 };
  const service = new ProfileSyncService(ports); services.push(service);
  return { ...ports, fetcher, service, setState: (value: AccountState) => { state = value; service.accountChanged(); }, advance: (ms: number) => { time += ms; }, restore: () => { const next = new ProfileSyncService(ports); services.push(next); return next; }, rows: sessions };
}

describe("curated daily contract", () => {
  it("reuses core totals and strips file names, project names, and custom language identifiers", () => {
    const input = session("2026-09-10T12:00:00Z", context("private-project", "secret.ts", "private-language"));
    const value = syncDay([input, input], "2026-09-10", () => "a".repeat(64));
    expect(value).toMatchObject({ activeMs: 30_000, editCount: 2, linesAdded: 4, linesRemoved: 2, sessionCount: 1, fileCount: 1 });
    expect(value.languages[0]?.id).toBe("other");
    expect(JSON.stringify(value)).not.toMatch(/private-project|secret.ts|private-language|sessionId|source|startedAt/);
    expect(() => parseSyncDay({ ...value, userId: identity.userId })).toThrow();
    expect(() => parseSyncDay({ ...value, sourceCode: "never" })).toThrow();
    for (const date of ["2026-02-30", "2026-13-01", "2026-00-01"]) expect(() => parseSyncDay({ ...value, date })).toThrow();
    expect(() => parseSyncDay({ ...value, activeMs: -1 })).toThrow();
    expect(() => parseSyncDay({ ...value, revision: 1.1 })).toThrow();
    expect(() => parseSyncDay({ ...value, editCount: 3 })).toThrow();
    expect(() => parseSyncDay({ ...value, projects: [...value.projects, ...value.projects] })).toThrow();
  });
  it("shares the same date rules and marks a cross-midnight session once on each day", () => {
    const input = session("2026-09-09T23:59:45Z");
    const a = syncDay([input], "2026-09-09", () => "a".repeat(64));
    const b = syncDay([input], "2026-09-10", () => "a".repeat(64));
    expect(a.sessionCount + b.sessionCount).toBe(2); expect(a.activeMs + b.activeMs).toBe(30_000);
  });
  it("persists one random installation ID across windows and restarts", async () => {
    const h = await harness();
    await stableInstallation(h.directory, install);
    const ids = await Promise.all([stableInstallation(h.directory, install), stableInstallation(h.directory)]);
    expect(ids).toEqual([install, install]); expect(await stableInstallation(h.directory)).toBe(install);
  });
});

describe("durable profile synchronization", () => {
  it("never uploads for disconnected, identity-only, or explicitly disabled accounts", async () => {
    const h = await harness();
    h.setState({ status: "disconnected" }); await h.service.tick(true);
    h.setState({ status: "connected", account: identity }); await h.service.tick(true);
    expect(h.fetcher).not.toHaveBeenCalled(); expect(await readdir(h.directory)).toEqual([]);
    h.setState({ status: "connected", account: identity, syncGrant: "grant" });
    h.fetcher.mockRejectedValueOnce(new Error("offline")); await h.service.tick(true); await h.service.disable();
    const restored = h.restore(); await restored.tick(true); expect(restored.getState().status).toBe("disabled"); expect(h.fetcher).toHaveBeenCalledTimes(1);
  });
  it("persists disable even before the first queued upload", async () => {
    const h = await harness(); await h.service.disable(); const restored = h.restore(); await restored.tick(true);
    expect(restored.getState().status).toBe("disabled"); expect(h.fetcher).not.toHaveBeenCalled();
  });
  it("uses new revisions only for changed daily aggregates and resumes after restart", async () => {
    const h = await harness(); await h.service.tick(true); await h.service.tick(true);
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    h.rows[0]!.revision++; h.rows[0]!.days[0]!.contributions[0]!.linesAdded++;
    const restored = h.restore(); await restored.tick(true);
    const payloads = h.fetcher.mock.calls.map(([, options]) => JSON.parse(options!.body as string));
    expect(payloads.map(row => row.revision)).toEqual([1, 2]); expect(restored.getState().pendingDays).toBe(0);
    expect(h.account.getAccessToken).toHaveBeenCalledTimes(2);
  });
  it("does not rewrite an unchanged idle queue on each scheduling tick", async () => {
    const h = await harness(); await h.service.tick(true);
    const directory = (await readdir(h.directory)).find(name => !name.endsWith(".lock"))!;
    const file = join(h.directory, directory, "queue.json"); const before = await stat(file);
    h.advance(30_001); await h.service.tick();
    expect((await stat(file)).ino).toBe(before.ino); expect(h.fetcher).toHaveBeenCalledTimes(1);
  });
  it("retries exactly the same payload after response loss with durable bounded backoff", async () => {
    const h = await harness(); h.fetcher.mockRejectedValueOnce(new Error("offline")); await h.service.tick(true);
    expect(h.service.getState()).toMatchObject({ status: "pending", pendingDays: 1 });
    const restored = h.restore(); h.advance(30_000); await restored.tick(); expect(h.fetcher).toHaveBeenCalledTimes(1);
    h.advance(30_001); await restored.tick(); expect(h.fetcher).toHaveBeenCalledTimes(2);
    expect(h.fetcher.mock.calls[0]![1]!.body).toBe(h.fetcher.mock.calls[1]![1]!.body);
    expect(restored.getState().pendingDays).toBe(0);
    const directory = (await readdir(h.directory)).find(name => !name.endsWith(".lock"))!;
    const ledger = await readFile(join(h.directory, directory, "queue.json"), "utf8");
    expect(ledger).not.toMatch(/accessToken|refreshToken|Bearer|username/);
  });
  it("bounds initial history to 90 dates and sends at most ten days per batch", async () => {
    const h = await harness(); h.rows.length = 0;
    for (let i = 0; i < 100; i++) { const row = session(`${addDays("2026-09-10", -i)}T12:00:00Z`); row.source.installationId = install; h.rows.push(row); }
    const foreign = session("2026-09-10T13:00:00Z"); h.rows.push(foreign);
    await h.service.tick(true); expect(h.fetcher).toHaveBeenCalledTimes(10); expect(h.service.getState().pendingDays).toBe(80);
    const restored = h.restore();
    for (let i = 0; i < 8; i++) { h.advance(30_001); await restored.tick(); }
    expect(restored.getState().pendingDays).toBe(0); expect(h.fetcher).toHaveBeenCalledTimes(90);
    const uploads = h.fetcher.mock.calls.map(([, options]) => JSON.parse(options!.body as string));
    expect(new Set(uploads.map(row => row.date)).size).toBe(90);
    expect(uploads.at(-1).sessionCount).toBe(1);
  });
  it("reuses AccountService refresh after 401 and contains permanent rejection", async () => {
    const h = await harness(); h.fetcher.mockResolvedValueOnce(Response.json({}, { status: 401 })); await h.service.tick(true);
    expect(h.account.refreshAccessToken).toHaveBeenCalledTimes(1); expect(h.service.getState().pendingDays).toBe(0);
    h.rows[0]!.revision++; h.rows[0]!.days[0]!.contributions[0]!.linesAdded++;
    h.fetcher.mockResolvedValueOnce(Response.json({}, { status: 409 })); await h.service.tick(true);
    expect(h.service.getState()).toMatchObject({ status: "error", pendingDays: 1 }); expect(h.service.getState().message).toContain("preserved");
  });
  it("does not send old-account data if account changes during credential acquisition", async () => {
    const h = await harness();
    h.account.getAccessToken.mockImplementationOnce(async () => { h.setState({ status: "connected", account: { ...identity, userId: install }, syncGrant: "different" }); return "other-account-token"; });
    await h.service.tick(true); expect(h.fetcher).not.toHaveBeenCalled();
  });
  it("honors another window disabling sync while token refresh is in progress", async () => {
    const h = await harness(); const other = h.restore();
    h.account.getAccessToken.mockImplementationOnce(async () => { await other.disable(); return "access"; });
    await h.service.tick(true); expect(h.fetcher).not.toHaveBeenCalled(); expect(h.service.getState().status).toBe("disabled");
  });
  it("fails closed on corrupt local sessions and on a corrupt revision ledger", async () => {
    const h = await harness(); const store = new LocalSessionStore(join(h.directory, "sessions"), () => {}); await store.initialize();
    await writeFile(join(store.directory, `${h.rows[0]!.sessionId}.json`), "broken");
    await expect(store.list(true)).rejects.toThrow(); expect(await store.list()).toEqual([]);
    await h.service.tick(true);
    const directory = (await readdir(h.directory)).find(name => name !== "sessions" && !name.endsWith(".lock"))!;
    const file = join(h.directory, directory, "queue.json"); await writeFile(file, "broken");
    await h.restore().tick(true); expect(h.fetcher).toHaveBeenCalledTimes(1); expect(await readFile(file, "utf8")).toBe("broken");
  });
  it("coordinates simultaneous windows without creating divergent revisions", async () => {
    const h = await harness(); const other = h.restore(); await Promise.all([h.service.tick(true), other.tick(true)]);
    const bodies = h.fetcher.mock.calls.map(([, options]) => options!.body);
    expect(new Set(bodies).size).toBe(1);
  });
});

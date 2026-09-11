import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "../apps/daemon/src/server.js";
import { session } from "./fixtures.js";
import { LocalSessionStore } from "../apps/vscode-extension/src/local-store.js";
import { SessionDelivery } from "../apps/vscode-extension/src/delivery.js";

const apps: Array<ReturnType<typeof createServer>> = [];
const directories: string[] = [];
const headers = { authorization: "Bearer secret" };
function setup() {
  const directory = mkdtempSync(join(tmpdir(), "stack-stats-session-api-"));
  directories.push(directory);
  const path = join(directory, "test.db");
  const app = createServer({ databasePath: path, token: "secret" });
  apps.push(app);
  return { app, path, directory };
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("session snapshot pipeline", () => {
  it("authenticates and stores only the latest revision, including after restart", async () => {
    const { app, path } = setup();
    const original = session();
    const newer = structuredClone(original);
    newer.revision++;
    newer.days[0]!.contributions[0]!.linesAdded = 10;
    expect((await app.inject({ method: "POST", url: "/v1/events", payload: original })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/v1/events", headers, payload: newer })).statusCode).toBe(201);
    for (const payload of [original, newer]) {
      expect((await app.inject({ method: "POST", url: "/v1/events", headers, payload })).json()).toMatchObject({ duplicate: true });
    }
    await app.close();
    apps.splice(apps.indexOf(app), 1);
    const restarted = createServer({ databasePath: path, token: "secret" });
    apps.push(restarted);
    const today = await restarted.inject({ url: "/v1/stats?period=today&date=2026-09-01", headers });
    expect(today.json()).toMatchObject({ activeMs: 30_000, sessions: 1, filesTouched: 1, linesAdded: 10, linesRemoved: 2 });
    const week = await restarted.inject({ url: "/v1/stats?period=week&date=2026-09-02", headers });
    expect(week.json()).toMatchObject({ activeDays: 1, averageActiveMs: 30_000, currentStreak: 1, totalLineChanges: 12 });
    expect((await restarted.inject({ url: "/v1/summary", headers })).json()).toMatchObject({ editEvents: 0 });
  });

  it("rejects invalid metadata/durations/dates and respects daemon pause", async () => {
    const { app } = setup();
    const snapshot = session();
    for (const payload of [{ ...snapshot, schemaVersion: "2.0" }, { ...snapshot, token: "should-not-store" }, { ...snapshot, endedAt: "2020-01-01T00:00:00Z" }]) {
      expect((await app.inject({ method: "POST", url: "/v1/events", headers, payload })).statusCode).toBe(400);
    }
    for (const query of ["period=week&date=2026-02-30", "period=bad&date=2026-09-01", "period=today", "period=week&date=invalid"]) {
      expect((await app.inject({ url: `/v1/stats?${query}`, headers })).statusCode).toBe(400);
    }
    await app.inject({ method: "POST", url: "/v1/pause", headers });
    expect((await app.inject({ method: "POST", url: "/v1/events", headers, payload: snapshot })).statusCode).toBe(503);
    await app.inject({ method: "POST", url: "/v1/resume", headers });
    expect((await app.inject({ method: "POST", url: "/v1/events", headers, payload: snapshot })).statusCode).toBe(201);
  });

  it("migrates the original unversioned events table without deleting history", async () => {
    const { app, path } = setup();
    const snapshot = session();
    const row = snapshot.days[0]!.contributions[0]!;
    await app.inject({ method: "POST", url: "/v1/events", headers, payload: {
      schemaVersion: "1.0", eventType: "editor.file_changed", eventId: snapshot.sessionId, occurredAt: snapshot.endedAt,
      source: snapshot.source, session: { sessionId: snapshot.sessionId }, project: row.project, file: row.file,
      change: { operation: "modified", linesAdded: row.linesAdded, linesRemoved: row.linesRemoved, editCount: row.editCount }
    } });
    await app.close();
    apps.splice(apps.indexOf(app), 1);
    const legacy = new DatabaseSync(path);
    legacy.exec("DROP TABLE session_days; DROP TABLE sessions; PRAGMA user_version = 0;");
    legacy.close();
    const migrated = createServer({ databasePath: path, token: "secret" });
    apps.push(migrated);
    expect((await migrated.inject({ method: "POST", url: "/v1/events", headers, payload: session() })).statusCode).toBe(201);
    expect((await migrated.inject({ url: "/v1/summary", headers })).json()).toMatchObject({ editEvents: 1, linesAdded: 4, linesRemoved: 2 });
    const db = new DatabaseSync(path);
    expect(db.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 3 });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'events'").get()).toBeDefined();
    db.close();
  });

  it("delivers a durable snapshot over real loopback HTTP and reads daily/weekly CLI summaries", async () => {
    const { app, path, directory } = setup();
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Expected loopback address");
    const store = new LocalSessionStore(join(directory, "sessions"), () => undefined);
    await store.initialize();
    const snapshot = session(`${new Date().toISOString().slice(0, 10)}T12:00:00Z`);
    await store.save(snapshot);
    const delivery = new SessionDelivery(store, { token: "secret", port: address.port });
    delivery.enqueue(await store.pending());
    await delivery.sync();
    expect(await store.pending()).toEqual([]);
    writeFileSync(join(directory, "config.json"), JSON.stringify({ token: "secret", port: address.port, databasePath: path }));
    for (const period of ["--today", "--week"]) {
      const result = await promisify(execFile)(process.execPath, ["--import", "tsx", resolve("apps/cli/src/main.ts"), "summary", period], {
        env: { ...process.env, STACK_STATS_HOME: directory, TZ: "UTC" }
      });
      expect(JSON.parse(result.stdout)).toMatchObject({ sessions: 1, activeMs: 30_000, linesAdded: 4, linesRemoved: 2 });
    }
  });
});

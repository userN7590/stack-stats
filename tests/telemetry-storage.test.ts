import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readFile, writeFile, utimes, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StackStatsDatabase } from "../packages/storage/src/index.js";
import { createServer } from "../apps/daemon/src/server.js";
import { TelemetryJournal, TelemetryPersistence } from "../apps/vscode-extension/src/telemetry-journal.js";
import { TelemetryBuffer } from "../apps/vscode-extension/src/telemetry-buffer.js";
import { edit, report, range, telemetryContext } from "./telemetry-fixtures.js";
import type { TelemetryBatch, TelemetryEvent } from "@stack-stats/protocol";
import { DatabaseSync } from "node:sqlite";
import { session } from "./fixtures.js";

const directories: string[] = [];
async function temporary() { const dir = await mkdtemp(join(tmpdir(), "stack-telemetry-")); directories.push(dir); return dir; }
const batch = (...events: TelemetryEvent[]): TelemetryBatch => ({ storageVersion: 1, batchId: randomUUID(), events });
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("immutable telemetry storage and API", () => {
  it("migrates v2 session history into v3 without inventing raw historical signals", async () => {
    const path = join(await temporary(), "history.db");
    const original = new StackStatsDatabase(path); original.upsertSession(session()); original.close();
    const legacy = new DatabaseSync(path);
    legacy.exec("DROP TABLE telemetry_claims; DROP TABLE telemetry_events; PRAGMA user_version = 2;"); legacy.close();
    const upgraded = new StackStatsDatabase(path);
    expect(upgraded.daily("2026-09-01")).toMatchObject({ activeMs: 30_000, sessions: 1 });
    expect(upgraded.queryTelemetry({ ...range, limit: 100 })).toMatchObject({ observedEvents: 0, limitations: { legacySessionsIncluded: false } });
    upgraded.close();
  });
  it("deduplicates retries, rejects conflicting IDs atomically, and resolves late reports", async () => {
    const path = join(await temporary(), "test.db");
    const db = new StackStatsDatabase(path);
    const first = edit(), second = edit();
    expect(db.insertTelemetry(batch(first, second))).toBe(2);
    expect(db.insertTelemetry(batch(first))).toBe(0);
    expect(() => db.insertTelemetry(batch(edit(), { ...first, occurredAt: "2026-09-07T12:01:00Z" }))).toThrow("conflict");
    db.insertTelemetry(batch(report(first.eventId)));
    const query = { ...range, limit: 1, projectId: telemetryContext.projectId };
    expect(db.queryTelemetry(query).attribution.reportedAiShare).toBe(0.5);
    const page = db.telemetry(query);
    expect(page.events).toHaveLength(1);
    expect(page.next).toBeTruthy();
    const next = db.telemetry({ ...query, after: page.next! });
    expect(next.events).toHaveLength(1);
    expect(next.events[0]?.eventId).not.toBe(page.events[0]?.eventId);
    expect(next.next).toBeNull();
    db.close();
    const reopened = new StackStatsDatabase(path);
    expect(reopened.queryTelemetry({ ...range, limit: 100 }).edits.editCount).toBe(6);
    reopened.close();
  });

  it("validates/authenticates ingestion and gates attribution reports", async () => {
    const app = createServer({ databasePath: join(await temporary(), "test.db"), token: "secret" });
    try {
      const headers = { authorization: "Bearer secret" }, event = edit();
      expect((await app.inject({ method: "POST", url: "/v2/events", payload: batch(event) })).statusCode).toBe(401);
      expect((await app.inject({ method: "POST", url: "/v2/events", headers, payload: batch(event) })).statusCode).toBe(201);
      expect((await app.inject({ method: "POST", url: "/v2/events", headers, payload: batch(report(event.eventId)) })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url: "/v2/events", headers, payload: { prompts: "do not store" } })).statusCode).toBe(400);
      const query = new URLSearchParams(range).toString();
      expect((await app.inject({ url: `/v2/query?${query}`, headers })).json()).toMatchObject({ edits: { editCount: 3 }, attribution: { unknownShare: 1 } });
      expect((await app.inject({ url: `/v2/compare?${query}`, headers })).json()).toMatchObject({ delta: { edits: { absolute: 3, relative: null } } });
      expect((await app.inject({ url: "/v2/events?from=invalid", headers })).statusCode).toBe(400);
      await app.inject({ method: "POST", url: "/v1/pause", headers });
      expect((await app.inject({ method: "POST", url: "/v2/events", headers, payload: batch(edit()) })).statusCode).toBe(503);
    } finally { await app.close(); }
  });

  it("recovers durable batches after a failed write/restart and preserves corruption", async () => {
    const directory = await temporary(), warn = vi.fn();
    const journal = new TelemetryJournal(directory, warn), buffer = new TelemetryBuffer("test");
    const service = new TelemetryPersistence(journal, buffer);
    await service.initialize();
    buffer.emit("window.focus", { focused: true });
    const save = vi.spyOn(journal, "save").mockRejectedValueOnce(new Error("disk full"));
    await expect(service.checkpoint()).rejects.toThrow("disk full");
    await service.checkpoint();
    expect(save).toHaveBeenCalledTimes(2);
    const ids = await journal.pendingIds();
    expect(ids).toHaveLength(1);
    const broken = `${randomUUID()}.json`;
    await writeFile(join(directory, broken), "{");
    await writeFile(join(directory, "partial.tmp"), "{");
    const restarted = new TelemetryJournal(directory, warn);
    expect(await restarted.list()).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
    expect(await readFile(join(directory, broken), "utf8")).toBe("{");
  });

  it("never prunes offline batches and only ages acknowledged raw telemetry", async () => {
    const directory = await temporary(), journal = new TelemetryJournal(directory, vi.fn());
    const delivered = batch(edit()), offline = batch(edit());
    await journal.save(delivered); await journal.save(offline); await journal.acknowledge(delivered);
    const old = new Date(Date.now() - 40 * 86400_000);
    for (const item of [delivered, offline]) await utimes(join(directory, `${item.batchId}.json`), old, old);
    await journal.prune(30);
    expect((await journal.list()).map((item) => item.batchId)).toEqual([offline.batchId]);
    expect((await readdir(directory)).some((name) => name.includes(delivered.batchId))).toBe(false);
  });

  it("delivers immutable batches over real loopback and recovers missing acknowledgements without inflation", async () => {
    const directory = await temporary(), journal = new TelemetryJournal(join(directory, "journal"), vi.fn());
    const app = createServer({ databasePath: join(directory, "test.db"), token: "secret" });
    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      if (!address || typeof address === "string") throw new Error("Expected port");
      await journal.initialize();
      const payload = batch(edit()); await journal.save(payload);
      const service = new TelemetryPersistence(journal, new TelemetryBuffer("test"), { token: "secret", port: address.port });
      await service.initialize(); await service.sync(true);
      expect(await journal.pendingIds()).toEqual([]);
      await journal.save(batch(payload.events[0]!));
      const restarted = new TelemetryPersistence(journal, new TelemetryBuffer("test"), { token: "secret", port: address.port });
      await restarted.initialize(); await restarted.sync(true);
      const result = await app.inject({ url: `/v2/query?${new URLSearchParams(range)}`, headers: { authorization: "Bearer secret" } });
      expect(result.json().edits.editCount).toBe(3);
    } finally { await app.close(); }
  });
});

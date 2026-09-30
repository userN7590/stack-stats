import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { telemetryEventSchema, type TelemetryBatch, type TelemetryEvent } from "@stack-stats/protocol";
import { HourlyAggregateStore } from "../apps/vscode-extension/src/hourly-aggregates.js";
import { TelemetryJournal } from "../apps/vscode-extension/src/telemetry-journal.js";
import * as localStore from "../apps/vscode-extension/src/local-store.js";
import { edit } from "./telemetry-fixtures.js";

const directories: string[] = [];
const installationId = "test-install";
const base = Date.parse("2026-09-26T12:00:00Z"), DAY = 86_400_000;
const emptySource = { async *strictBatches(): AsyncGenerator<TelemetryBatch> {} };
const batch = (...events: TelemetryEvent[]): TelemetryBatch => ({ storageVersion: 1, batchId: randomUUID(), events });
const changed = (at = "2026-09-26T12:00:00Z") => edit({ occurredAt: at, data: { startedAt: at, firstVersion: 1, lastVersion: 1,
  editCount: 2, linesAdded: 3, linesRemoved: 1, charactersAdded: 9, charactersRemoved: 2, undoCount: 0, redoCount: 0 } });
const interval = (from: string, to: string) => telemetryEventSchema.parse({ ...changed(to), eventType: "activity.interval", evidence: "inferred", data: { startedAt: from } });
async function setup(options: { now?: () => number; maxEventsPerDay?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "stack-hourly-")); directories.push(directory);
  const store = new HourlyAggregateStore(join(directory, "hourly"), installationId, { now: () => base, ...options });
  const warn = vi.fn(), journal = new TelemetryJournal(join(directory, "journal"), warn, store);
  await journal.initialize();
  return { directory, store, journal, warn };
}
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe("durable UTC hourly projection", () => {
  it("splits interval time at UTC midnight while assigning complete edit batches to their final timestamp", async () => {
    const { journal } = await setup();
    const boundary = changed("2026-09-26T00:00:10Z");
    if (boundary.eventType === "editor.edit") boundary.data.startedAt = "2026-09-25T23:59:55Z";
    const otherInstallation = changed(); otherInstallation.source.installationId = "another-installation";
    const focus = telemetryEventSchema.parse({ ...changed(), eventType: "window.focus", data: { focused: true } });
    await journal.save(batch(boundary, interval("2026-09-25T23:59:50Z", "2026-09-26T00:00:10Z"), otherInstallation, focus));
    const days = await journal.hourlyDays();
    expect([...days.keys()]).toEqual(["2026-09-25", "2026-09-26"]);
    expect(days.get("2026-09-25")!.activeMsByHour[23]).toBe(10_000);
    const current = days.get("2026-09-26")!;
    expect(current.activeMsByHour[0]).toBe(10_000);
    expect(current.editCountByHour[0]).toBe(2);
    expect(current.linesAddedByHour[0]).toBe(3);
    expect(current.linesRemovedByHour[0]).toBe(1);
    expect(current.editCountByHour.reduce((a, b) => a + b)).toBe(2);
    expect(current.coverage).toEqual({ firstObservedDate: "2026-09-26", lastObservedDate: "2026-09-26", partial: true, frozen: false, lateInputIgnored: false });
    expect(JSON.stringify([...days])).not.toMatch(/characters|test-install|fileId|projectId|sessionId|instanceId/);
  });

  it("uses UTC hour rather than timestamp offset and leaves focus-only or missing days unavailable", async () => {
    const { journal } = await setup();
    const focus = telemetryEventSchema.parse({ ...changed("2026-09-25T00:00:00Z"), eventType: "window.focus", data: { focused: true } });
    await journal.save(batch(focus, changed("2026-09-26T03:00:00-04:00")));
    const days = await journal.hourlyDays();
    expect(days.has("2026-09-25")).toBe(false);
    expect(days.get("2026-09-26")!.editCountByHour[7]).toBe(2);
    expect(days.get("2026-09-26")!.activeMsByHour.every(value => value === 0)).toBe(true);
  });

  it("deduplicates exact retries, different batch envelopes, and restarts without merging session counters", async () => {
    const { directory, journal } = await setup();
    const first = changed(), timed = interval("2026-09-26T12:59:50Z", "2026-09-26T13:00:10Z");
    await journal.save(batch(first, first, timed));
    await journal.save(batch(timed, first));
    const restarted = new HourlyAggregateStore(join(directory, "hourly"), installationId, { now: () => base });
    const value = (await restarted.readDays(journal)).get("2026-09-26")!;
    expect(value.editCountByHour[12]).toBe(2);
    expect(value.activeMsByHour[12]).toBe(10_000);
    expect(value.activeMsByHour[13]).toBe(10_000);
    expect((await restarted.readDays(journal)).get("2026-09-26")).toEqual(value);
  });

  it("preserves durable daily counters after acknowledged raw telemetry is pruned", async () => {
    const { directory, journal } = await setup();
    const value = batch(changed()); await journal.save(value); await journal.acknowledge(value);
    const old = new Date(Date.now() - 40 * DAY);
    await utimes(join(journal.directory, `${value.batchId}.json`), old, old);
    await journal.prune(30);
    expect(await journal.list()).toEqual([]);
    const restarted = new HourlyAggregateStore(join(directory, "hourly"), installationId, { now: () => base });
    expect((await restarted.readDays(journal)).get("2026-09-26")!.editCountByHour[12]).toBe(2);
  });

  it("serializes simultaneous windows and combines distinct observations from their instances", async () => {
    const { directory, store } = await setup();
    const second = new HourlyAggregateStore(join(directory, "hourly"), installationId, { now: () => base });
    await Promise.all([store.ingest(batch(changed())), second.ingest(batch(changed()))]);
    expect((await store.readDays(emptySource)).get("2026-09-26")!.editCountByHour[12]).toBe(4);
  });

  it("replays a midnight interval after interruption between its two daily writes without inflating the first", async () => {
    const { journal, warn } = await setup();
    const realWrite = localStore.atomicWrite;
    const injected = vi.spyOn(localStore, "atomicWrite").mockImplementation(async (path, text) => {
      if (path.endsWith("2026-09-26.json")) throw new Error("interrupted write");
      return realWrite(path, text);
    });
    await journal.save(batch(interval("2026-09-25T23:59:50Z", "2026-09-26T00:00:10Z")));
    expect(warn).toHaveBeenCalled();
    expect(await journal.list()).toHaveLength(1); // Raw checkpoint still completed.
    injected.mockRestore();
    const recovered = await journal.hourlyDays();
    expect(recovered.get("2026-09-25")!.activeMsByHour[23]).toBe(10_000);
    expect(recovered.get("2026-09-26")!.activeMsByHour[0]).toBe(10_000);
  });

  it("adopts a complete orphan day file after an interrupted manifest update", async () => {
    const { journal } = await setup();
    await journal.hourlyDays();
    const realWrite = localStore.atomicWrite;
    const injected = vi.spyOn(localStore, "atomicWrite").mockImplementation(async (path, text) => {
      if (path.endsWith("manifest.json")) throw new Error("interrupted manifest");
      return realWrite(path, text);
    });
    await journal.save(batch(changed())); injected.mockRestore();
    expect((await journal.hourlyDays()).get("2026-09-26")!.editCountByHour[12]).toBe(2);
  });

  it("recovers a pending sealed batch when interrupted before the raw journal write", async () => {
    const { directory, journal } = await setup();
    const value = batch(changed()), realWrite = localStore.atomicWrite;
    const injected = vi.spyOn(localStore, "atomicWrite").mockImplementation(async (path, text) => {
      if (path === join(journal.directory, `${value.batchId}.json`)) throw new Error("raw write interrupted");
      return realWrite(path, text);
    });
    await expect(journal.save(value)).rejects.toThrow(/interrupted/);
    injected.mockRestore();
    const store = new HourlyAggregateStore(join(directory, "hourly"), installationId, { now: () => base });
    const restarted = new TelemetryJournal(journal.directory, vi.fn(), store); await restarted.initialize();
    expect((await restarted.hourlyDays()).get("2026-09-26")!.editCountByHour[12]).toBe(2);
    expect(await restarted.read(value.batchId)).toEqual(value);
    expect(await readdir(join(journal.directory, "hourly-pending"))).toEqual([]);
  });

  it("allows a concurrent export to finish a sealed pending write without duplicate counters", async () => {
    const { journal } = await setup();
    const value = batch(changed()), realWrite = localStore.atomicWrite;
    let release!: () => void, entered!: () => void, blocked = false;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(localStore, "atomicWrite").mockImplementation(async (path, text) => {
      if (!blocked && path === join(journal.directory, `${value.batchId}.json`)) { blocked = true; entered(); await gate; }
      return realWrite(path, text);
    });
    const saving = journal.save(value); await waiting;
    try { expect((await journal.hourlyDays()).get("2026-09-26")!.editCountByHour[12]).toBe(2); }
    finally { release(); await saving; }
    expect((await journal.hourlyDays()).get("2026-09-26")!.editCountByHour[12]).toBe(2);
  });

  it("does not rescan projected raw history on repeated hourly exports", async () => {
    const { journal } = await setup();
    await journal.save(batch(changed())); await journal.hourlyDays();
    const read = vi.spyOn(journal, "read");
    await journal.hourlyDays(); await journal.hourlyDays();
    expect(read).not.toHaveBeenCalled();
  });

  it("makes a failed pending-marker write discoverable by a different already-running window", async () => {
    const { directory, journal, store } = await setup();
    const otherStore = new HourlyAggregateStore(join(directory, "hourly"), installationId, { now: () => base });
    const other = new TelemetryJournal(journal.directory, vi.fn(), otherStore);
    await other.initialize(); await other.hourlyDays();
    const realWrite = localStore.atomicWrite;
    const injected = vi.spyOn(localStore, "atomicWrite").mockImplementation(async (path, text) => {
      if (path.endsWith(".pending")) throw new Error("pending directory unavailable");
      return realWrite(path, text);
    });
    vi.spyOn(store, "ingest").mockRejectedValueOnce(new Error("projection unavailable"));
    const value = batch(changed()); await journal.save(value);
    expect(await journal.read(value.batchId)).toEqual(value);
    injected.mockRestore();
    expect((await other.hourlyDays()).get("2026-09-26")!.editCountByHour[12]).toBe(2);
    expect((await readdir(journal.directory)).includes("hourly-recovery-required")).toBe(false);
  });

  it("retains the raw batch for retry when both durable recovery signals fail", async () => {
    const { journal } = await setup();
    const realWrite = localStore.atomicWrite;
    const injected = vi.spyOn(localStore, "atomicWrite").mockImplementation(async (path, text) => {
      if (path.endsWith(".pending") || path.endsWith("hourly-recovery-required")) throw new Error("recovery state unavailable");
      return realWrite(path, text);
    });
    const value = batch(changed());
    await expect(journal.save(value)).rejects.toThrow(/raw batch retained/);
    expect(await journal.read(value.batchId)).toEqual(value);
    injected.mockRestore();
    await journal.save(value);
    expect((await journal.hourlyDays()).get("2026-09-26")!.editCountByHour[12]).toBe(2);
  });

  it("recovers fallback payload before a paused producer writes raw even if that producer later cannot project", async () => {
    const { directory, journal, store } = await setup();
    const otherStore = new HourlyAggregateStore(join(directory, "hourly"), installationId, { now: () => base });
    const other = new TelemetryJournal(journal.directory, vi.fn(), otherStore); await other.initialize(); await other.hourlyDays();
    const value = batch(changed()), realWrite = localStore.atomicWrite;
    let release!: () => void, entered!: () => void, blocked = false;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(localStore, "atomicWrite").mockImplementation(async (path, text) => {
      if (path.endsWith(".pending")) throw new Error("pending directory unavailable");
      if (!blocked && path === join(journal.directory, `${value.batchId}.json`)) { blocked = true; entered(); await gate; }
      return realWrite(path, text);
    });
    vi.spyOn(store, "ingest").mockRejectedValueOnce(new Error("producer cannot project"));
    const saving = journal.save(value); await waiting;
    try {
      expect((await other.hourlyDays()).get("2026-09-26")!.editCountByHour[12]).toBe(2);
      expect((await readdir(journal.directory)).includes("hourly-recovery-required")).toBe(false);
    } finally { release(); await saving; }
    expect((await other.hourlyDays()).get("2026-09-26")!.editCountByHour[12]).toBe(2);
    expect((await readdir(journal.directory)).some(name => name.endsWith(".hourly-pending"))).toBe(false);
  });

  it("fails closed on corrupt projection or missing registered days while continuing raw writes", async () => {
    const { directory, journal } = await setup();
    await journal.save(batch(changed()));
    const path = join(directory, "hourly", "2026-09-26.json"), original = await readFile(path, "utf8");
    await writeFile(path, "{");
    await journal.save(batch(changed()));
    expect(await journal.list()).toHaveLength(2);
    await expect(journal.hourlyDays()).rejects.toThrow();
    await writeFile(path, original);
    expect((await journal.hourlyDays()).get("2026-09-26")!.editCountByHour[12]).toBe(4);
    await unlink(path);
    await expect(journal.hourlyDays()).rejects.toThrow();
  });

  it("pauses pruning and richer reads on corrupt raw source rather than silently omitting it", async () => {
    const { journal, warn } = await setup();
    const value = batch(changed()); await journal.save(value); await journal.acknowledge(value);
    const path = join(journal.directory, `${value.batchId}.json`), old = new Date(Date.now() - 40 * DAY);
    await writeFile(path, "{"); await utimes(path, old, old);
    await journal.prune(30);
    expect((await readdir(journal.directory)).includes(`${value.batchId}.json`)).toBe(true);
    expect(warn).toHaveBeenCalled();
    await expect(journal.hourlyDays()).rejects.toThrow();
  });

  it("fails richer sync at the bounded daily ledger cap without dropping raw checkpoint batches", async () => {
    const { journal } = await setup({ maxEventsPerDay: 1 });
    const value = batch(changed(), changed()); await journal.save(value); await journal.acknowledge(value);
    await expect(journal.hourlyDays()).rejects.toThrow(/limit/);
    const old = new Date(Date.now() - 40 * DAY); await utimes(join(journal.directory, `${value.batchId}.json`), old, old);
    await journal.prune(30);
    expect(await journal.list()).toHaveLength(1);
  });

  it("rejects changed contents for the same event identity", async () => {
    const { journal } = await setup();
    const first = changed(); await journal.save(batch(first));
    const conflicting = structuredClone(first); if (conflicting.eventType === "editor.edit") conflicting.data.linesAdded++;
    await journal.save(batch(conflicting));
    await expect(journal.hourlyDays()).rejects.toThrow(/identity conflict/);
  });

  it("freezes old projections, discards dedup ledgers, and conservatively ignores all late input", async () => {
    let now = base;
    const { directory, store } = await setup({ now: () => now });
    const first = batch(changed()); await store.ingest(first);
    now += 120 * DAY;
    let row = (await store.readDays(emptySource)).get("2026-09-26")!;
    expect(row.coverage).toMatchObject({ frozen: true, lateInputIgnored: false, partial: true });
    const local = JSON.parse(await readFile(join(directory, "hourly", "2026-09-26.json"), "utf8"));
    expect(local.events).toEqual({});
    await store.ingest(first); await store.ingest(batch(changed()));
    row = (await store.readDays(emptySource)).get("2026-09-26")!;
    expect(row.editCountByHour[12]).toBe(2);
    expect(row.coverage).toMatchObject({ frozen: true, lateInputIgnored: true });
    now = base; // A clock rollback cannot reopen already frozen history.
    await store.ingest(batch(changed()));
    expect((await store.readDays(emptySource)).get("2026-09-26")!.editCountByHour[12]).toBe(2);
  });

  it("does not invent a zero row for unavailable old history or accept another installation's store", async () => {
    const { directory, journal } = await setup();
    await journal.save(batch(changed("2025-01-01T12:00:00Z")));
    expect((await journal.hourlyDays()).size).toBe(0);
    const other = new HourlyAggregateStore(join(directory, "hourly"), "other", { now: () => base });
    await expect(other.readDays(journal)).rejects.toThrow();
  });
});

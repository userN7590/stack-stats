import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, access, stat, unlink, opendir } from "node:fs/promises";
import { join } from "node:path";
import { telemetryBatchSchema, type SyncHourlyUtc, type TelemetryBatch, type TelemetryEvent } from "@stack-stats/protocol";
import { atomicWrite } from "./local-store.js";
import type { LocalConfig } from "./delivery.js";
import type { TelemetryBuffer } from "./telemetry-buffer.js";
import type { HourlyAggregateStore } from "./hourly-aggregates.js";
import { exclusive } from "./exclusive.js";

export class TelemetryJournal {
  private hourlyRecoveryNeeded = false;
  private get hourlyPending() { return join(this.directory, "hourly-pending"); }
  private get recoverySignal() { return join(this.directory, "hourly-recovery-required"); }
  constructor(readonly directory: string, private readonly warn: (message: string) => void, private readonly hourly?: HourlyAggregateStore) {}
  async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (this.hourly) { await mkdir(this.hourlyPending, { recursive: true, mode: 0o700 }); this.hourlyRecoveryNeeded = true; }
  }
  async save(batch: TelemetryBatch): Promise<void> {
    const parsed = telemetryBatchSchema.parse(batch);
    let signalFailed = false;
    if (this.hourly) {
      // Keep the recoverable batch until projection commits. If the host stops
      // between this marker and its raw write, another window can finish both.
      try { await atomicWrite(join(this.hourlyPending, `${batch.batchId}.pending`), JSON.stringify(parsed)); }
      catch {
        this.hourlyRecoveryNeeded = true;
        try { await this.markRecovery(parsed); } catch { signalFailed = true; }
      }
    }
    await atomicWrite(join(this.directory, `${batch.batchId}.json`), JSON.stringify(parsed));
    // Retain the sealed batch for retry if neither durable outbox representation
    // could be written. Never report this storage failure as a completed save.
    if (signalFailed) throw new Error("Hourly recovery state could not be saved; raw batch retained");
    // The raw durable write must succeed independently of this projection.
    // Strict replay before export/pruning repairs failures or fails closed.
    try {
      await this.hourly?.ingest(parsed);
      if (this.hourly) await unlink(join(this.hourlyPending, `${batch.batchId}.pending`)).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
    }
    catch { this.warn("Hourly aggregation needs attention; raw telemetry is preserved and richer sync will retry."); }
  }
  async read(id: string): Promise<TelemetryBatch> {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid batch ID");
    if ((await stat(join(this.directory, `${id}.json`))).size > 8 * 1024 * 1024) throw new Error("Telemetry batch is too large");
    const batch = telemetryBatchSchema.parse(JSON.parse(await readFile(join(this.directory, `${id}.json`), "utf8")));
    if (batch.batchId !== id) throw new Error("Batch identity mismatch");
    return batch;
  }
  async pendingIds(): Promise<string[]> {
    const names = (await readdir(this.directory)).filter((name) => /^[a-f0-9-]{36}\.json$/.test(name));
    const pending: string[] = [];
    for (let i = 0; i < names.length; i += 16) await Promise.all(names.slice(i, i + 16).map(async (name) => {
      try { await access(join(this.directory, `${name}.synced`)); } catch { pending.push(name.slice(0, -5)); }
    }));
    return pending;
  }
  /** Retention only removes already-delivered new telemetry; legacy sessions and
   * unacknowledged offline data are never pruned. Runs at startup, not on edits. */
  async prune(days: number): Promise<void> {
    if (this.hourly) {
      try {
        const token = await this.recoveryToken();
        await this.hourly.recover(this); this.hourlyRecoveryNeeded = false;
        if (token) await this.clearRecovery(token);
      } catch {
        this.hourlyRecoveryNeeded = true; await this.markRecovery().catch(() => undefined);
        this.warn("Hourly recovery failed; raw telemetry pruning is paused until history is repaired."); return;
      }
    }
    if (!Number.isFinite(days) || days <= 0) return;
    const before = Date.now() - days * 86400_000;
    for (const name of await readdir(this.directory)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
      try {
        const path = join(this.directory, name);
        if ((await stat(path)).mtimeMs >= before) continue;
        await access(`${path}.synced`);
        await unlink(path); await unlink(`${path}.synced`);
      } catch { /* Concurrent windows or a missing ack: preserve remaining data. */ }
    }
  }
  async list(onlyPending = false): Promise<TelemetryBatch[]> {
    const names = (await readdir(this.directory)).filter((name) => /^[a-f0-9-]{36}\.json$/.test(name));
    const batches: TelemetryBatch[] = [];
    for (let i = 0; i < names.length; i += 16) await Promise.all(names.slice(i, i + 16).map(async (name) => {
      if (onlyPending) {
        try { await access(join(this.directory, `${name}.synced`)); return; } catch { /* Retry unacknowledged files. */ }
      }
      try {
        const batch = telemetryBatchSchema.parse(JSON.parse(await readFile(join(this.directory, name), "utf8")));
        if (name !== `${batch.batchId}.json`) throw new Error("Batch identity mismatch");
        batches.push(batch);
      } catch { this.warn(`Unreadable telemetry batch ${name}; preserved. Telemetry reports may be incomplete.`); }
    }));
    return batches;
  }
  /** Strict streaming recovery never silently skips corrupt source batches. */
  async *strictBatches(pendingOnly = false): AsyncGenerator<TelemetryBatch> {
    if (!pendingOnly) {
      for await (const entry of await opendir(this.directory)) {
        if (/^[a-f0-9-]{36}\.json$/.test(entry.name)) yield await this.read(entry.name.slice(0, 36));
      }
    }
    if (!this.hourly) return;
    // Root fallback markers are only needed during signaled/full recovery. They
    // carry the sealed payload too, so clearing a recovery token cannot race a
    // producer that has not written its raw file yet.
    const directories = pendingOnly ? [this.hourlyPending] : [this.hourlyPending, this.directory];
    for (const directory of directories) for await (const entry of await opendir(directory)) {
      const pattern = directory === this.directory ? /^[a-f0-9-]{36}\.hourly-pending$/ : /^[a-f0-9-]{36}\.pending$/;
      if (!pattern.test(entry.name)) continue;
      const id = entry.name.slice(0, 36), marker = join(directory, entry.name);
      let pending: TelemetryBatch;
      try {
        if ((await stat(marker)).size > 8 * 1024 * 1024) throw new Error("Telemetry batch is too large");
        pending = telemetryBatchSchema.parse(JSON.parse(await readFile(marker, "utf8")));
      } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      if (pending.batchId !== id) throw new Error("Batch identity mismatch");
      let raw: TelemetryBatch;
      try { raw = await this.read(id); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        // Recovery writes the same immutable payload a concurrent producer has
        // already sealed; it never needs that producer's in-memory state.
        await atomicWrite(join(this.directory, `${id}.json`), JSON.stringify(pending)); raw = pending;
      }
      if (JSON.stringify(raw) !== JSON.stringify(pending)) throw new Error("Pending telemetry identity conflict");
      yield raw;
      // Resumption means the caller has durably projected this batch. Failed
      // application leaves the recoverable marker available to all windows.
      await unlink(marker).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
    }
  }
  async hourlyDays(): Promise<Map<string, SyncHourlyUtc>> {
    if (!this.hourly) return new Map();
    const token = await this.recoveryToken();
    const days = await this.hourly.readDays(this, this.hourlyRecoveryNeeded || token !== undefined);
    this.hourlyRecoveryNeeded = false;
    if (token) await this.clearRecovery(token);
    return days;
  }
  private async recoveryToken(): Promise<string | undefined> {
    try {
      const token = await readFile(this.recoverySignal, "utf8");
      if (!/^[a-f0-9-]{36}$/.test(token)) throw new Error("Hourly recovery signal is invalid");
      return token;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }
  private async markRecovery(batch?: TelemetryBatch): Promise<void> {
    await exclusive(this.directory, async check => {
      if (batch) { check(); await atomicWrite(join(this.directory, `${batch.batchId}.hourly-pending`), JSON.stringify(batch)); }
      check(); await atomicWrite(this.recoverySignal, randomUUID());
    });
  }
  private async clearRecovery(token: string): Promise<void> {
    await exclusive(this.directory, async check => {
      if (await this.recoveryToken() === token) { check(); await unlink(this.recoverySignal); }
    });
  }
  async acknowledge(batch: TelemetryBatch) { await atomicWrite(join(this.directory, `${batch.batchId}.json.synced`), "1"); }
}

/** No disk or network work in keystroke callbacks. Failed sealed batches retain
 * their IDs, so partial writes/retries/restarts cannot inflate event counts. */
export class TelemetryPersistence {
  private sealed: TelemetryBatch[] = [];
  private writes: Promise<void> = Promise.resolve();
  private sending?: Promise<void>;
  private readonly pending = new Set<string>();
  private retryAt = 0;
  private backoff = 15_000;
  state = "Local telemetry only";
  constructor(readonly journal: TelemetryJournal, readonly buffer: TelemetryBuffer, private readonly config?: LocalConfig) {}

  async initialize(retentionDays = 30): Promise<void> {
    await this.journal.initialize();
    await this.journal.prune(retentionDays);
    for (const id of await this.journal.pendingIds()) this.pending.add(id);
  }
  checkpoint(): Promise<void> {
    const work = this.writes.catch(() => undefined).then(async () => {
      if (!this.sealed.length) {
        const events = this.buffer.drain();
        for (let i = 0; i < events.length; i += 1000) this.sealed.push({ storageVersion: 1, batchId: randomUUID(), events: events.slice(i, i + 1000) });
      }
      while (this.sealed.length) {
        const batch = this.sealed[0]!;
        await this.journal.save(batch);
        this.pending.add(batch.batchId);
        this.sealed.shift();
      }
    });
    this.writes = work;
    return work;
  }
  async events(): Promise<TelemetryEvent[]> {
    await this.checkpoint();
    return (await this.journal.list()).flatMap((batch) => batch.events);
  }
  async hourlyDays(): Promise<Map<string, SyncHourlyUtc>> {
    await this.checkpoint();
    return this.journal.hourlyDays();
  }
  async retry(): Promise<void> {
    for (const id of await this.journal.pendingIds()) this.pending.add(id);
    await this.sync(true);
  }
  sync(force = false): Promise<void> {
    if (this.sending) return this.sending;
    if (!this.config || (!force && Date.now() < this.retryAt)) return Promise.resolve();
    this.sending = this.deliver().finally(() => { this.sending = undefined; });
    return this.sending;
  }
  private async deliver(): Promise<void> {
    for (const id of [...this.pending].slice(0, 10)) {
      let batch: TelemetryBatch;
      try { batch = await this.journal.read(id); }
      catch {
        this.state = "Unreadable telemetry batch preserved; retry after repairing local history";
        this.pending.delete(id); // Manual retry/restart rediscovers it; other batches can proceed.
        continue;
      }
      try {
        const response = await fetch(`http://127.0.0.1:${this.config!.port}/v2/events`, { method: "POST",
          headers: { authorization: `Bearer ${this.config!.token}`, "content-type": "application/json" },
          body: JSON.stringify(batch), signal: AbortSignal.timeout(3000) });
        if ([400, 403, 409, 413].includes(response.status)) {
          this.state = "Some telemetry batches were rejected and retained locally";
          this.retryAt = Date.now() + 300_000;
          continue; // A rejected annotation cannot starve ordinary activity.
        }
        if (!response.ok || (await response.json() as { accepted?: boolean }).accepted !== true) throw new Error("Not acknowledged");
        await this.journal.acknowledge(batch); this.pending.delete(batch.batchId);
        this.backoff = 15_000; this.state = "Telemetry delivered to local daemon";
      } catch {
        this.state = "Telemetry retained locally; delivery unavailable or rejected";
        this.retryAt = Date.now() + this.backoff;
        this.backoff = Math.min(this.backoff * 2, 300_000);
        return;
      }
    }
  }
}

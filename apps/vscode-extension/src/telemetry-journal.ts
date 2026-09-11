import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, access, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { telemetryBatchSchema, type TelemetryBatch, type TelemetryEvent } from "@stack-stats/protocol";
import { atomicWrite } from "./local-store.js";
import type { LocalConfig } from "./delivery.js";
import type { TelemetryBuffer } from "./telemetry-buffer.js";

export class TelemetryJournal {
  constructor(readonly directory: string, private readonly warn: (message: string) => void) {}
  async initialize() { await mkdir(this.directory, { recursive: true, mode: 0o700 }); }
  async save(batch: TelemetryBatch): Promise<void> {
    await atomicWrite(join(this.directory, `${batch.batchId}.json`), JSON.stringify(telemetryBatchSchema.parse(batch)));
  }
  async read(id: string): Promise<TelemetryBatch> {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid batch ID");
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

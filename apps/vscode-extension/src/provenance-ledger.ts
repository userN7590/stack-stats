import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { provenanceBatchSchema, provenanceRecordSchema, type ProvenanceRecord } from "@stack-stats/protocol";
import { atomicWrite } from "./local-store.js";

/** LOCAL-ONLY provenance storage (globalStorage/provenance-v1). Deliberately
 * separate from telemetry-v2: nothing here is delivered to the daemon, projected
 * into hourly aggregates or read by profile sync. Batches are immutable; record
 * IDs are idempotent, so a retried inbox ingestion cannot double count. */
export const PROVENANCE_MAX_QUEUED = 20_000;
export class ProvenanceLedger {
  private queue: ProvenanceRecord[] = [];
  private writes: Promise<void> = Promise.resolve();
  droppedQueued = 0;
  rejected = 0;
  constructor(readonly directory: string, private readonly warn: (message: string) => void) {}

  async initialize(retentionDays = 30): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) return;
    const before = Date.now() - retentionDays * 86_400_000;
    for (const name of await readdir(this.directory)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
      try { if ((await stat(join(this.directory, name))).mtimeMs < before) await unlink(join(this.directory, name)); }
      catch { /* Another window pruned it first. */ }
    }
  }

  /** Durably append; on failure records stay queued (bounded) for the next call. */
  append(records: readonly ProvenanceRecord[]): Promise<void> {
    // Validate per record so one malformed record can never block later writes.
    for (const record of records) {
      const parsed = provenanceRecordSchema.safeParse(record);
      if (parsed.success) this.queue.push(parsed.data);
      else { this.rejected++; this.warn("A provenance record failed validation and was discarded."); }
    }
    if (this.queue.length > PROVENANCE_MAX_QUEUED) { this.droppedQueued += this.queue.length - PROVENANCE_MAX_QUEUED; this.queue.splice(0, this.queue.length - PROVENANCE_MAX_QUEUED); }
    const work = this.writes.catch(() => undefined).then(async () => {
      if (this.queue.length) await mkdir(this.directory, { recursive: true, mode: 0o700 });
      while (this.queue.length) {
        const records = this.queue.slice(0, 1000);
        const batch = provenanceBatchSchema.parse({ storageVersion: 1, batchId: randomUUID(), records });
        await atomicWrite(join(this.directory, `${batch.batchId}.json`), JSON.stringify(batch));
        this.queue.splice(0, records.length);
      }
    });
    this.writes = work;
    return work;
  }
  get queued(): number { return this.queue.length; }

  async list(): Promise<ProvenanceRecord[]> {
    await this.writes.catch(() => undefined);
    let names: string[];
    try { names = (await readdir(this.directory)).filter((name) => /^[a-f0-9-]{36}\.json$/.test(name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return [...this.queue]; throw error; }
    const records: ProvenanceRecord[] = [];
    for (let i = 0; i < names.length; i += 16) await Promise.all(names.slice(i, i + 16).map(async (name) => {
      try {
        const path = join(this.directory, name);
        if ((await stat(path)).size > 8 * 1024 * 1024) throw new Error("Provenance batch is too large");
        const batch = provenanceBatchSchema.parse(JSON.parse(await readFile(path, "utf8")));
        if (name !== `${batch.batchId}.json`) throw new Error("Batch identity mismatch");
        records.push(...batch.records);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.warn(`Unreadable provenance batch ${name}; preserved. Agent activity reports may be incomplete.`);
      }
    }));
    return [...records, ...this.queue];
  }
}

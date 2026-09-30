import { createHash } from "node:crypto";
import { opendir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { telemetryBatchSchema, validSyncDate, type SyncHourlyUtc, type TelemetryBatch } from "@stack-stats/protocol";
import { atomicWrite } from "./local-store.js";
import { exclusive } from "./exclusive.js";

export const HOURLY_MUTABLE_DAYS = 120;
export const HOURLY_MAX_EVENTS_PER_DAY = 20_000;
const DAY_MS = 86_400_000, HOUR_MS = 3_600_000;
const MAX_DAY_BYTES = 4 * 1024 * 1024;
const MAX_COUNTER = 1_000_000_000;
const keys = ["activeMsByHour", "editCountByHour", "linesAddedByHour", "linesRemovedByHour"] as const;
type Counters = Pick<SyncHourlyUtc, typeof keys[number]>;
interface Day extends Counters {
  storageVersion: 1; installationId: string; date: string; frozen: boolean; lateInputIgnored: boolean;
  events: Record<string, string>;
}
interface Manifest { storageVersion: 1; installationId: string; frozenBefore: string; dates: string[] }
export interface HourlyJournalSource { strictBatches(pendingOnly?: boolean): AsyncIterable<TelemetryBatch> }
interface Options { now?: () => number; mutableDays?: number; maxEventsPerDay?: number }
interface Contribution { eventId: string; fingerprint: string; counters: Counters }
const empty = (): Counters => ({ activeMsByHour: Array(24).fill(0), editCountByHour: Array(24).fill(0), linesAddedByHour: Array(24).fill(0), linesRemovedByHour: Array(24).fill(0) });
const dateAt = (at: number) => new Date(at).toISOString().slice(0, 10);
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
function fail(): never { throw new Error("Hourly aggregate history is unavailable or invalid"); }
function exact(value: unknown, fields: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) fail();
}
function counters(value: Record<string, unknown>): Counters {
  const output = empty();
  for (const key of keys) {
    const array = value[key];
    if (!Array.isArray(array) || array.length !== 24) fail();
    for (let hour = 0; hour < 24; hour++) if (!Number.isSafeInteger(array[hour]) || array[hour] < 0 || array[hour] > MAX_COUNTER) fail();
    output[key] = [...array];
    if (output[key].reduce((sum, n) => sum + n, 0) > (key === "activeMsByHour" ? 604_800_000 : MAX_COUNTER)) fail();
  }
  return output;
}

/** A content-free projection of v2 observations, independent of session totals.
 * Each mutable UTC day carries its own dedup ledger. A midnight interval writes
 * two independent idempotent contributions, so replay repairs a partial write.
 * Once frozen, a day never accepts more contributions; exact old retries cannot
 * be distinguished from new late inputs after its ledger has been compacted.
 */
export class HourlyAggregateStore {
  private readonly now: () => number;
  private readonly mutableDays: number;
  private readonly maxEvents: number;
  constructor(readonly directory: string, readonly installationId: string, options: Options = {}) {
    this.now = options.now ?? Date.now;
    this.mutableDays = options.mutableDays ?? HOURLY_MUTABLE_DAYS;
    this.maxEvents = options.maxEventsPerDay ?? HOURLY_MAX_EVENTS_PER_DAY;
    if (!installationId || installationId.length > 256 || !Number.isInteger(this.mutableDays) || this.mutableDays < 1 || this.mutableDays > 3650
      || !Number.isInteger(this.maxEvents) || this.maxEvents < 1 || this.maxEvents > HOURLY_MAX_EVENTS_PER_DAY) throw new Error("Invalid hourly aggregate configuration");
  }

  private cutoff(): string {
    const today = Math.floor(this.now() / DAY_MS) * DAY_MS;
    const date = dateAt(today - (this.mutableDays - 1) * DAY_MS);
    if (!validSyncDate(date)) fail();
    return date;
  }
  private path(date: string) { if (!validSyncDate(date)) fail(); return join(this.directory, `${date}.json`); }
  private async json(path: string, maxBytes: number): Promise<unknown> {
    if ((await stat(path)).size > maxBytes) fail();
    return JSON.parse(await readFile(path, "utf8"));
  }
  private async manifest(check: () => void): Promise<Manifest> {
    const path = join(this.directory, "manifest.json");
    let value: unknown;
    try { value = await this.json(path, 1024 * 1024); }
    catch (error) {
      if (!missing(error)) throw error;
      // A missing manifest alongside prior projections is a damaged history,
      // never an invitation to silently initialize empty sync data.
      for await (const entry of await opendir(this.directory)) if (/^\d{4}-\d{2}-\d{2}\.json$/.test(entry.name)) fail();
      const initial: Manifest = { storageVersion: 1, installationId: this.installationId, frozenBefore: this.cutoff(), dates: [] };
      check(); await atomicWrite(path, JSON.stringify(initial));
      return initial;
    }
    exact(value, ["storageVersion", "installationId", "frozenBefore", "dates"]);
    if (value.storageVersion !== 1 || value.installationId !== this.installationId || !validSyncDate(value.frozenBefore) || !Array.isArray(value.dates)
      || value.dates.length > 36_525 || value.dates.some((date, i, dates) => !validSyncDate(date) || (i > 0 && date <= dates[i - 1]))) fail();
    return value as unknown as Manifest;
  }
  private async day(date: string, known: boolean): Promise<Day | undefined> {
    let value: unknown;
    try { value = await this.json(this.path(date), MAX_DAY_BYTES); }
    catch (error) { if (!known && missing(error)) return undefined; throw error; }
    exact(value, ["storageVersion", "installationId", "date", "frozen", "lateInputIgnored", "events", ...keys]);
    if (value.storageVersion !== 1 || value.installationId !== this.installationId || value.date !== date || typeof value.frozen !== "boolean"
      || typeof value.lateInputIgnored !== "boolean" || !value.events || typeof value.events !== "object" || Array.isArray(value.events)) fail();
    const entries = Object.entries(value.events);
    if (entries.length > this.maxEvents || (value.frozen && entries.length !== 0)
      || entries.some(([id, hash]) => !/^[a-f0-9-]{36}$/.test(id) || typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash))) fail();
    return { storageVersion: 1, installationId: this.installationId, date, frozen: value.frozen, lateInputIgnored: value.lateInputIgnored,
      events: Object.fromEntries(entries) as Record<string, string>, ...counters(value) };
  }
  private async writeDay(day: Day, check: () => void) {
    const text = JSON.stringify(day);
    if (Buffer.byteLength(text) > MAX_DAY_BYTES) fail();
    check(); await atomicWrite(this.path(day.date), text);
  }
  private async writeManifest(value: Manifest, check: () => void) {
    if (value.dates.length > 36_525 || value.dates.some((date, i) => !validSyncDate(date) || (i > 0 && date <= value.dates[i - 1]!))) fail();
    check(); await atomicWrite(join(this.directory, "manifest.json"), JSON.stringify(value));
  }
  private async advance(manifest: Manifest, check: () => void) {
    const cutoff = this.cutoff();
    if (cutoff > manifest.frozenBefore) {
      manifest.frozenBefore = cutoff;
      // Advancing the barrier before discarding IDs makes an interrupted freeze
      // conservative: old inputs remain rejected even before ledger compaction.
      await this.writeManifest(manifest, check);
    }
  }

  private contributions(input: TelemetryBatch): Map<string, Contribution[]> {
    const batch = telemetryBatchSchema.parse(input), days = new Map<string, Contribution[]>(), batchIds = new Map<string, string>();
    for (const event of batch.events) {
      if (event.source.installationId !== this.installationId || !["editor.edit", "activity.interval"].includes(event.eventType)) continue;
      const fingerprint = createHash("sha256").update(JSON.stringify(event)).digest("hex");
      if (batchIds.has(event.eventId) && batchIds.get(event.eventId) !== fingerprint) throw new Error("Hourly event identity conflict");
      if (batchIds.has(event.eventId)) continue;
      batchIds.set(event.eventId, fingerprint);
      const eventDays = new Map<string, Counters>();
      const get = (at: number) => {
        const date = dateAt(at); if (!validSyncDate(date)) fail();
        const row = eventDays.get(date) ?? empty(); eventDays.set(date, row); return row;
      };
      const at = Date.parse(event.occurredAt);
      if (event.eventType === "editor.edit") {
        const row = get(at), hour = new Date(at).getUTCHours();
        row.editCountByHour[hour] = event.data.editCount;
        row.linesAddedByHour[hour] = event.data.linesAdded;
        row.linesRemovedByHour[hour] = event.data.linesRemoved;
      } else if (event.eventType === "activity.interval") {
        let from = Date.parse(event.data.startedAt);
        // A zero interval is still an observed, eligible source contribution.
        if (from === at) get(at);
        while (from < at) {
          const to = Math.min(at, (Math.floor(from / HOUR_MS) + 1) * HOUR_MS);
          get(from).activeMsByHour[new Date(from).getUTCHours()]! += to - from;
          from = to;
        }
      }
      for (const [date, row] of eventDays) {
        const contributions = days.get(date) ?? [];
        contributions.push({ eventId: event.eventId, fingerprint, counters: row }); days.set(date, contributions);
      }
    }
    return days;
  }
  private async apply(input: TelemetryBatch, manifest: Manifest, check: () => void) {
    for (const [date, additions] of [...this.contributions(input)].sort(([a], [b]) => a.localeCompare(b))) {
      const known = manifest.dates.includes(date);
      let day = await this.day(date, known);
      if (date < manifest.frozenBefore) {
        // Do not manufacture a historical zero row when no preserved projection
        // exists. Retained old rows can identify ignored post-freeze input.
        if (day && (!day.lateInputIgnored || !day.frozen)) { day.frozen = true; day.events = {}; day.lateInputIgnored = true; await this.writeDay(day, check); }
        continue;
      }
      day ??= { storageVersion: 1, installationId: this.installationId, date, frozen: false, lateInputIgnored: false, events: {}, ...empty() };
      if (day.frozen) fail();
      let changed = false, eventCount = Object.keys(day.events).length;
      for (const addition of additions) {
        const previous = day.events[addition.eventId];
        if (previous && previous !== addition.fingerprint) throw new Error("Hourly event identity conflict");
        if (previous) continue;
        if (eventCount >= this.maxEvents) throw new Error("Hourly aggregate event limit reached; raw history retained");
        day.events[addition.eventId] = addition.fingerprint;
        eventCount++;
        for (const key of keys) for (let hour = 0; hour < 24; hour++) day[key][hour]! += addition.counters[key][hour]!;
        changed = true;
      }
      counters(day as unknown as Record<string, unknown>);
      if (changed) await this.writeDay(day, check);
      if (!known) { manifest.dates.push(date); manifest.dates.sort(); await this.writeManifest(manifest, check); }
    }
  }

  async ingest(batch: TelemetryBatch): Promise<void> {
    await exclusive(this.directory, async check => {
      const manifest = await this.manifest(check); await this.advance(manifest, check); await this.apply(batch, manifest, check);
    });
  }
  private async replay(source: HourlyJournalSource, manifest: Manifest, check: () => void, pendingOnly = false) {
    // Adopt an atomic day write interrupted before its manifest update. Missing
    // registered days remain an error; an orphan must itself validate strictly.
    for await (const entry of await opendir(this.directory)) {
      if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(entry.name)) continue;
      const date = entry.name.slice(0, 10);
      if (!manifest.dates.includes(date)) { await this.day(date, true); manifest.dates.push(date); manifest.dates.sort(); await this.writeManifest(manifest, check); }
    }
    await this.advance(manifest, check);
    for await (const batch of source.strictBatches(pendingOnly)) { check(); await this.apply(batch, manifest, check); }
    // Validate every known file, including ones with no surviving raw events.
    for (const date of manifest.dates) {
      const day = (await this.day(date, true))!;
      if (date < manifest.frozenBefore && !day.frozen) { day.frozen = true; day.events = {}; await this.writeDay(day, check); }
    }
  }
  async recover(source: HourlyJournalSource): Promise<void> {
    await exclusive(this.directory, async check => { const manifest = await this.manifest(check); await this.replay(source, manifest, check); });
  }
  async readDays(source: HourlyJournalSource, recoverAll = false): Promise<Map<string, SyncHourlyUtc>> {
    return exclusive(this.directory, async check => {
      const manifest = await this.manifest(check); await this.replay(source, manifest, check, !recoverAll);
      const result = new Map<string, SyncHourlyUtc>();
      for (const date of manifest.dates) {
        const day = (await this.day(date, true))!;
        result.set(date, { source: "telemetry-v2", dateBasis: "UTC", ...Object.fromEntries(keys.map(key => [key, [...day[key]]])) as Counters,
          coverage: { firstObservedDate: date, lastObservedDate: date, partial: true, frozen: day.frozen, lateInputIgnored: day.lateInputIgnored } });
      }
      return result;
    });
  }
}

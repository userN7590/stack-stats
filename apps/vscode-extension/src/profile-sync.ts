import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { addDays, latestSessions, syncDay, prepareSyncDaysV2 } from "@stack-stats/core";
import { parseSyncDay, parseSyncDayV2, syncInstallationPattern, validSyncDate, SYNC_MAX_BYTES, type SessionSnapshot, type SyncDay, type SyncDayV2, type SyncHourlyUtc } from "@stack-stats/protocol";
import type { AccountService } from "./account-service.js";
import { atomicWrite } from "./local-store.js";
import { exclusive } from "./exclusive.js";

export interface ProfileSyncState {
  status: "not-connected" | "disabled" | "enabled" | "syncing" | "pending" | "error";
  pendingDays: number;
  lastSyncedAt?: number;
  message?: string;
}
type DailyPayload = SyncDay | SyncDayV2;
interface Entry { payload: DailyPayload; acknowledged: number }
interface Ledger {
  version: 1 | 2; grant: string; enabled: boolean; fromDate: string;
  entries: Record<string, Entry>; lastScan: number; nextAttempt: number; failures: number; lastSyncedAt?: number;
}
export interface SyncAccount {
  getState: AccountService["getState"]; getAccessToken: AccountService["getAccessToken"];
  refreshAccessToken: AccountService["refreshAccessToken"]; getOrigin: AccountService["getOrigin"];
}
interface SyncPorts {
  directory: string; installationId: string; account: SyncAccount;
  projectSalt: string;
  sessions: () => Promise<SessionSnapshot[]>; today: () => string;
  /** Independent UTC population; null is unavailable, never fabricated zeros.
   * The extension only supplies rows when hourly upload is explicitly enabled. */
  hourlyDays?: () => Promise<ReadonlyMap<string, SyncHourlyUtc>>;
  hourlyAllowed?: () => boolean;
  now?: () => number; fetch?: typeof fetch; random?: () => number;
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const pendingCount = (ledger: Ledger) => Object.values(ledger.entries).filter(entry => entry.acknowledged < entry.payload.revision).length;
const content = (payload: DailyPayload) => JSON.stringify({ ...payload, revision: 1 });
class SyncFailure extends Error { constructor(readonly status: number) { super("Sync unavailable"); } }
class SupersededEntry extends Error {}

/** Both acknowledgements and capability responses are deliberately small. */
async function responseJson(response: Response): Promise<unknown> {
  if (!response.body) throw new SyncFailure(502);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 2048) throw new SyncFailure(502);
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

/** A capability is scoped to the authenticated grant, including upload consent.
 * Unknown/malformed versions never authorize a richer upload. */
export function supportsSyncV2(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).length === 2 && row.schemaVersion === "1" && Array.isArray(row.dailyVersions)
    && row.dailyVersions.length > 0 && row.dailyVersions.length <= 2
    && Array.from(row.dailyVersions).every(version => version === "1" || version === "2")
    && new Set(row.dailyVersions).size === row.dailyVersions.length && row.dailyVersions.includes("2");
}

/** Reuses the existing globalState ID, but commits it under a shared filesystem
 * lease to resolve simultaneous first activation. No machine/hardware identity. */
export async function stableInstallation(directory: string, previous?: string): Promise<string> {
  return exclusive(join(directory, "installation"), async check => {
    const file = join(directory, "installation", "id.json");
    try {
      const id: unknown = JSON.parse(await readFile(file, "utf8"));
      if (typeof id !== "string" || !syncInstallationPattern.test(id)) throw new Error("Invalid installation identity");
      return id;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const id = previous && syncInstallationPattern.test(previous) ? previous : randomUUID();
    check(); await atomicWrite(file, JSON.stringify(id)); return id;
  });
}

/** Private pseudonymization salt, never uploaded. This is not an auth token. */
export async function stableSyncSalt(directory: string): Promise<string> {
  return exclusive(join(directory, "installation"), async check => {
    const file = join(directory, "installation", "sync-salt.json");
    try {
      const salt: unknown = JSON.parse(await readFile(file, "utf8"));
      if (typeof salt !== "string" || !/^[a-f0-9]{64}$/.test(salt)) throw new Error("Invalid sync privacy salt");
      return salt;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const salt = randomBytes(32).toString("hex"); check(); await atomicWrite(file, JSON.stringify(salt)); return salt;
  });
}

/** Durable queue is account + origin + installation scoped. Only summaries and
 * retry metadata live here; credentials always come from AccountService. */
export class ProfileSyncService {
  private state: ProfileSyncState = { status: "not-connected", pendingDays: 0 };
  private listeners = new Set<() => void>();
  private running?: Promise<void>;
  private controller?: AbortController;
  private disposed = false;
  private paused = false;
  private nextCheck = 0;
  private capabilities?: { key: string; until: number; v2: boolean };
  private scanEpoch = 0;
  private scannedEpoch = 0;
  private readonly now: () => number;
  constructor(private readonly ports: SyncPorts) { this.now = ports.now ?? Date.now; }
  getState(): ProfileSyncState { return structuredClone(this.state); }
  onDidChange(listener: () => void) { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; }
  private publish(state: ProfileSyncState) { this.state = state; for (const listener of this.listeners) { try { listener(); } catch { /* UI isolation */ } } }
  private path(userId: string) { return join(this.ports.directory, hash(`${this.ports.account.getOrigin()}:${userId}:${this.ports.installationId}`)); }
  private async read(directory: string): Promise<Ledger | undefined> {
    let text: string;
    try { text = await readFile(join(directory, "queue.json"), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    if (text.length > 25_000_000) throw new Error("Sync queue exceeds safety limit");
    const ledger = JSON.parse(text) as Ledger;
    if (![1, 2].includes(ledger.version) || typeof ledger.grant !== "string" || typeof ledger.enabled !== "boolean" || !validSyncDate(ledger.fromDate)
      || !ledger.entries || typeof ledger.entries !== "object" || Array.isArray(ledger.entries)
      || Object.keys(ledger.entries).length > 10_000 || ![ledger.lastScan, ledger.nextAttempt, ledger.failures].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error("Invalid sync queue");
    for (const [date, entry] of Object.entries(ledger.entries)) {
      const payload = entry.payload?.schemaVersion === "2" && ledger.version === 2 ? parseSyncDayV2(entry.payload) : parseSyncDay(entry.payload);
      if (payload.date !== date || !Number.isSafeInteger(entry.acknowledged) || entry.acknowledged < 0 || entry.acknowledged > payload.revision) throw new Error("Invalid sync acknowledgement");
      entry.payload = payload;
    }
    return ledger;
  }
  private async save(directory: string, ledger: Ledger, check: () => void) {
    const text = JSON.stringify(ledger);
    if (text.length > 25_000_000 || Object.keys(ledger.entries).length > 10_000) throw new Error("Sync queue exceeds safety limit");
    check(); await atomicWrite(join(directory, "queue.json"), text);
  }
  /** Disables immediately in this window; persisted consent stops other windows
   * before their next PUT. An already accepted/in-flight upload cannot be recalled. */
  async disable(): Promise<void> {
    this.paused = true; this.controller?.abort();
    const account = this.ports.account.getState();
    const userId = account.account?.userId;
    try {
      if (userId) await exclusive(this.path(userId), async check => {
        const ledger = await this.read(this.path(userId)) ?? { version: 1 as const, grant: account.syncGrant ?? "identity", enabled: false, fromDate: addDays(this.ports.today(), -89), entries: {}, lastScan: 0, nextAttempt: 0, failures: 0 };
        ledger.enabled = false; await this.save(this.path(userId), ledger, check);
      });
      this.publish({ ...this.state, status: userId ? "disabled" : "not-connected", message: "Uploads stopped. Existing server data and publication settings are unchanged." });
    } catch { this.publish({ ...this.state, status: "error", message: "Uploads stopped in this window. Could not save the preference; retry Disable Profile Sync." }); }
  }
  /** Call after starting a new explicit browser consent. The grant ID prevents a
   * cancelled flow, identity-only login or editor restart from enabling uploads. */
  accountChanged(): void { this.controller?.abort(); this.nextCheck = 0; this.capabilities = undefined; this.scanEpoch++; }
  consentRequested(): void { this.paused = false; this.nextCheck = 0; }
  tick(force = false): Promise<void> {
    if (this.running) return this.running;
    if (this.paused && !this.ports.account.getState().account) this.publish({ status: "not-connected", pendingDays: 0 });
    if (this.disposed || this.paused || (!force && this.now() < this.nextCheck)) return Promise.resolve();
    this.nextCheck = this.now() + 30_000;
    this.running = this.run(force).catch(() => this.publish({ ...this.state, status: "error", message: "Local sync history is unreadable, busy, or exceeds limits. Data is preserved; retry Sync Now." })).finally(() => { this.running = undefined; });
    return this.running;
  }
  private async run(force: boolean): Promise<void> {
    const account = this.ports.account.getState();
    if (!account.account) { this.publish({ status: "not-connected", pendingDays: 0 }); return; }
    if (!account.syncGrant) { this.publish({ status: "disabled", pendingDays: 0 }); return; }
    const userId = account.account.userId;
    const grant = account.syncGrant;
    const directory = this.path(userId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // Do not hold a filesystem lease while obtaining credentials or networking:
    // another window must remain able to disable consent immediately.
    const before = await this.read(directory);
    if (before && !before.enabled && before.grant === grant) {
      this.publish({ status: "disabled", pendingDays: pendingCount(before), lastSyncedAt: before.lastSyncedAt }); return;
    }
    const richSupported = account.status === "connected" && await this.negotiate(userId, grant, directory);
    const afterProbe = this.ports.account.getState();
    if (this.paused || this.disposed || afterProbe.account?.userId !== userId || afterProbe.syncGrant !== grant) return;
    let ledger = await exclusive(directory, async check => {
      let current = await this.read(directory);
      let dirty = !current;
      let completedEpoch: number | undefined;
      if (!current) current = { version: 1, grant, enabled: true, fromDate: addDays(this.ports.today(), -89), entries: {}, lastScan: 0, nextAttempt: 0, failures: 0 };
      else if (current.grant !== grant) { dirty = true; current.grant = grant; current.enabled = true; current.nextAttempt = 0; }
      if (current.enabled && (force || this.scanEpoch !== this.scannedEpoch || this.now() - current.lastScan >= 300_000)) {
        const epoch = this.scanEpoch;
        // Read strictly under the revision lease. Never replace a complete day
        // using a partial/corrupt history read or another installation's export.
        const sourceSessions = (await this.ports.sessions()).filter(session => session.source.installationId === this.ports.installationId);
        const sessions = latestSessions(sourceSessions);
        const dates = new Map<string, SessionSnapshot[]>();
        for (const session of sessions) for (const day of session.days) if (day.date >= current.fromDate && day.date <= this.ports.today()) {
          const list = dates.get(day.date) ?? []; list.push(session); dates.set(day.date, list);
        }
        const needsRich = richSupported || Object.values(current.entries).some(entry => entry.payload.schemaVersion === "2");
        const prepared = needsRich ? prepareSyncDaysV2(sourceSessions, this.ports.installationId) : undefined;
        const hourly = needsRich && this.ports.hourlyDays && this.ports.hourlyAllowed?.() !== false ? await this.ports.hourlyDays() : new Map<string, SyncHourlyUtc>();
        const latestDay = [this.ports.today(), new Date(this.now()).toISOString().slice(0, 10)].sort().at(-1)!;
        if (richSupported) for (const date of [...prepared!.dates, ...hourly.keys()]) {
          if (date >= current.fromDate && date <= latestDay && !dates.has(date)) dates.set(date, []);
        }
        // An authoritative strict scan can replace a previously queued v2 day
        // with an empty day. Missing/corrupt reads never reach this point.
        for (const [date, entry] of Object.entries(current.entries)) if (entry.payload.schemaVersion === "2" && !dates.has(date)) dates.set(date, []);
        const alias = (id: string) => createHmac("sha256", this.ports.projectSalt).update(`${this.ports.installationId}:${userId}:${id}`).digest("hex");
        for (const [date, snapshots] of dates) {
          const previous = current.entries[date];
          const useRich = richSupported || previous?.payload.schemaVersion === "2";
          const payload = useRich ? prepared!.build(date, alias, { uploadFromDate: current.fromDate, hourlyUtc: hourly.get(date) ?? null }) : syncDay(snapshots, date, alias);
          if (!previous || content(previous.payload) !== content(payload)) {
            payload.revision = (previous?.payload.revision ?? 0) + 1;
            if (payload.schemaVersion === "2") { parseSyncDayV2(payload); current.version = 2; }
            else parseSyncDay(payload);
            if (Buffer.byteLength(JSON.stringify(payload)) > SYNC_MAX_BYTES) throw new Error("Day exceeds upload limit");
            current.entries[date] = { payload, acknowledged: previous?.acknowledged ?? 0 };
          }
        }
        current.lastScan = this.now(); dirty = true; completedEpoch = epoch;
      }
      if (dirty) await this.save(directory, current, check);
      if (completedEpoch !== undefined) this.scannedEpoch = completedEpoch;
      return current;
    });
    const info = () => ({ pendingDays: pendingCount(ledger), lastSyncedAt: ledger.lastSyncedAt });
    if (!ledger.enabled) { this.publish({ status: "disabled", ...info() }); return; }
    if (account.status !== "connected") { this.publish({ status: "pending", ...info(), message: "Waiting for account connection. Local tracking continues." }); return; }
    this.publish({ status: info().pendingDays ? "pending" : "enabled", ...info() });
    if (!force && ledger.nextAttempt > this.now()) return;
    const awaitingSupport = () => !richSupported && Object.values(ledger.entries).some(entry => entry.payload.schemaVersion === "2" && entry.acknowledged < entry.payload.revision);
    for (const entry of Object.values(ledger.entries).filter(entry => entry.acknowledged < entry.payload.revision && (entry.payload.schemaVersion === "1" || richSupported)).sort((a, b) => a.payload.date.localeCompare(b.payload.date)).slice(0, 10)) {
      if (this.disposed || this.paused) return;
      const latestAccount = this.ports.account.getState();
      if (latestAccount.account?.userId !== userId || latestAccount.syncGrant !== grant || latestAccount.status !== "connected") return;
      const current = await this.read(directory);
      if (!current?.enabled || current.grant !== grant) { this.publish({ status: "disabled", ...info() }); return; }
      this.publish({ status: "syncing", ...info() });
      try {
        let token = await this.ports.account.getAccessToken();
        if (!token) throw new SyncFailure(401);
        const checkAccount = async () => {
          const consent = await this.read(directory);
          if (!consent?.enabled || consent.grant !== grant) throw new SyncFailure(403);
          const saved = consent.entries[entry.payload.date];
          // Credentials can yield to another window that replaces or uploads
          // this day. Recheck immediately before each PUT, including 401 retry.
          if (!saved || saved.acknowledged >= entry.payload.revision || saved.payload.revision !== entry.payload.revision
            || content(saved.payload) !== content(entry.payload)) throw new SupersededEntry();
          if (entry.payload.schemaVersion === "2" && entry.payload.hourlyUtc && this.ports.hourlyAllowed?.() === false) {
            this.scanEpoch++; throw new SyncFailure(0);
          }
          const state = this.ports.account.getState();
          if (this.paused || this.disposed || state.account?.userId !== userId || state.syncGrant !== grant || state.status !== "connected") throw new SyncFailure(401);
        };
        await checkAccount();
        try { await this.put(entry.payload, token); }
        catch (error) {
          if (!(error instanceof SyncFailure) || error.status !== 401) throw error;
          token = await this.ports.account.refreshAccessToken();
          if (!token) throw error;
          await checkAccount(); await this.put(entry.payload, token);
        }
        ledger = await exclusive(directory, async check => {
          const next = await this.read(directory); if (!next) throw new Error("Queue missing");
          const saved = next.entries[entry.payload.date];
          if (saved && saved.payload.revision === entry.payload.revision && content(saved.payload) === content(entry.payload)) saved.acknowledged = entry.payload.revision;
          next.lastSyncedAt = this.now(); next.failures = 0; next.nextAttempt = 0;
          await this.save(directory, next, check); return next;
        });
      } catch (error) {
        if (this.disposed || this.paused) return;
        if (error instanceof SupersededEntry) {
          const latest = await this.read(directory); if (!latest) throw new Error("Queue missing");
          ledger = latest; continue;
        }
        const status = error instanceof SyncFailure ? error.status : 0;
        ledger = await exclusive(directory, async check => {
          const next = await this.read(directory); if (!next) throw new Error("Queue missing");
          next.failures = Math.min(next.failures + 1, 16);
          next.nextAttempt = this.now() + Math.round(Math.min(1_800_000, 60_000 * 2 ** (next.failures - 1)) * (1 + (this.ports.random ?? Math.random)() * 0.2));
          await this.save(directory, next, check); return next;
        });
        if (!ledger.enabled) { this.publish({ status: "disabled", ...info() }); return; }
        const permanent = [400, 403, 409, 413, 422].includes(status);
        this.publish({ status: permanent ? "error" : "pending", ...info(), message: status === 409 ? "Revision conflict. Server data was preserved. Do not reset the queue; see synchronization troubleshooting." : status === 401 || status === 403 ? "Authorization needs attention. Enable Profile Sync to approve a new grant." : permanent ? "The server rejected a daily summary. Update Stack Stats or inspect the sync documentation." : "Offline or service unavailable. Pending days will retry automatically." });
        return;
      }
    }
    if (this.paused || this.disposed) return;
    this.publish({ status: !ledger.enabled ? "disabled" : info().pendingDays ? "pending" : "enabled", ...info(),
      ...(awaitingSupport() ? { message: "Richer summaries are retained locally until the server authorizes aggregate v2 for this connection." } : {}) });
  }
  private async negotiate(userId: string, grant: string, directory: string): Promise<boolean> {
    const key = `${this.ports.account.getOrigin()}:${userId}:${grant}`;
    if (this.capabilities?.key === key && this.capabilities.until > this.now()) return this.capabilities.v2;
    let v2 = false;
    try {
      const token = await this.ports.account.getAccessToken();
      const consent = await this.read(directory);
      const state = this.ports.account.getState();
      if (!token || this.paused || this.disposed || state.status !== "connected" || state.account?.userId !== userId || state.syncGrant !== grant
        || (consent?.grant === grant && !consent.enabled)) return false;
      const controller = new AbortController(); this.controller = controller;
      const timer = setTimeout(() => controller.abort(), 5000); timer.unref?.();
      try {
        const response = await (this.ports.fetch ?? fetch)(`${this.ports.account.getOrigin()}/api/v1/sync/capabilities`, {
          method: "GET", signal: controller.signal, redirect: "error", cache: "no-store", headers: { Authorization: `Bearer ${token}` }
        });
        if (response.ok) v2 = supportsSyncV2(await responseJson(response));
        else await response.body?.cancel();
      } finally { clearTimeout(timer); if (this.controller === controller) this.controller = undefined; }
    } catch { /* Old/offline/unknown servers retain the existing v1 path. */ }
    this.capabilities = { key, until: this.now() + 300_000, v2 };
    return v2;
  }
  private async put(payload: DailyPayload, token: string) {
    const controller = new AbortController(); this.controller = controller;
    const timer = setTimeout(() => controller.abort(), 10_000); timer.unref?.();
    try {
      const response = await (this.ports.fetch ?? fetch)(`${this.ports.account.getOrigin()}/api/v${payload.schemaVersion}/sync/installations/${this.ports.installationId}/days/${payload.date}`, {
        method: "PUT", signal: controller.signal, redirect: "error", cache: "no-store",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(payload)
      });
      if (!response.ok) { await response.body?.cancel(); throw new SyncFailure(response.status); }
      const result = await responseJson(response) as { revision: number; date: string; installationId: string; schemaVersion?: string };
      if (result.revision !== payload.revision || result.date !== payload.date || result.installationId !== this.ports.installationId) throw new SyncFailure(502);
      if (payload.schemaVersion === "2" && result.schemaVersion !== "2") throw new SyncFailure(502);
    } finally { clearTimeout(timer); if (this.controller === controller) this.controller = undefined; }
  }
  dispose(): void { this.disposed = true; this.controller?.abort(); this.listeners.clear(); }
}

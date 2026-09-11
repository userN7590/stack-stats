import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { addDays, latestSessions, syncDay } from "@stack-stats/core";
import { parseSyncDay, syncInstallationPattern, validSyncDate, SYNC_MAX_BYTES, type SessionSnapshot, type SyncDay } from "@stack-stats/protocol";
import type { AccountService } from "./account-service.js";
import { atomicWrite } from "./local-store.js";
import { exclusive } from "./exclusive.js";

export interface ProfileSyncState {
  status: "not-connected" | "disabled" | "enabled" | "syncing" | "pending" | "error";
  pendingDays: number;
  lastSyncedAt?: number;
  message?: string;
}
interface Entry { payload: SyncDay; acknowledged: number }
interface Ledger {
  version: 1; grant: string; enabled: boolean; fromDate: string;
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
  now?: () => number; fetch?: typeof fetch; random?: () => number;
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const pendingCount = (ledger: Ledger) => Object.values(ledger.entries).filter(entry => entry.acknowledged < entry.payload.revision).length;
const content = (payload: SyncDay) => JSON.stringify({ ...payload, revision: 1 });
class SyncFailure extends Error { constructor(readonly status: number) { super("Sync unavailable"); } }

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
    if (ledger.version !== 1 || typeof ledger.grant !== "string" || typeof ledger.enabled !== "boolean" || !validSyncDate(ledger.fromDate)
      || !ledger.entries || typeof ledger.entries !== "object" || Array.isArray(ledger.entries)
      || Object.keys(ledger.entries).length > 10_000 || ![ledger.lastScan, ledger.nextAttempt, ledger.failures].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error("Invalid sync queue");
    for (const [date, entry] of Object.entries(ledger.entries)) {
      const payload = parseSyncDay(entry.payload);
      if (payload.date !== date || !Number.isSafeInteger(entry.acknowledged) || entry.acknowledged < 0 || entry.acknowledged > payload.revision) throw new Error("Invalid sync acknowledgement");
    }
    return ledger;
  }
  private async save(directory: string, ledger: Ledger, check: () => void) {
    const text = JSON.stringify(ledger); if (text.length > 25_000_000) throw new Error("Sync queue exceeds safety limit");
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
  accountChanged(): void { this.controller?.abort(); this.nextCheck = 0; }
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
    let ledger = await exclusive(directory, async check => {
      let current = await this.read(directory);
      let dirty = !current;
      if (!current) current = { version: 1, grant, enabled: true, fromDate: addDays(this.ports.today(), -89), entries: {}, lastScan: 0, nextAttempt: 0, failures: 0 };
      else if (current.grant !== grant) { dirty = true; current.grant = grant; current.enabled = true; current.nextAttempt = 0; }
      if (current.enabled && (force || this.now() - current.lastScan >= 300_000)) {
        // Read strictly under the revision lease. Never replace a complete day
        // using a partial/corrupt history read or another installation's export.
        const sessions = latestSessions(await this.ports.sessions()).filter(session => session.source.installationId === this.ports.installationId);
        const dates = new Map<string, SessionSnapshot[]>();
        for (const session of sessions) for (const day of session.days) if (day.date >= current.fromDate && day.date <= this.ports.today()) {
          const list = dates.get(day.date) ?? []; list.push(session); dates.set(day.date, list);
        }
        for (const [date, snapshots] of dates) {
          const payload = syncDay(snapshots, date, id => createHmac("sha256", this.ports.projectSalt).update(`${this.ports.installationId}:${userId}:${id}`).digest("hex"));
          const previous = current.entries[date];
          if (!previous || content(previous.payload) !== content(payload)) {
            payload.revision = (previous?.payload.revision ?? 0) + 1;
            if (Buffer.byteLength(JSON.stringify(payload)) > SYNC_MAX_BYTES) throw new Error("Day exceeds upload limit");
            current.entries[date] = { payload, acknowledged: previous?.acknowledged ?? 0 };
          }
        }
        current.lastScan = this.now(); dirty = true;
      }
      if (dirty) await this.save(directory, current, check);
      return current;
    });
    const info = () => ({ pendingDays: pendingCount(ledger), lastSyncedAt: ledger.lastSyncedAt });
    if (!ledger.enabled) { this.publish({ status: "disabled", ...info() }); return; }
    if (account.status !== "connected") { this.publish({ status: "pending", ...info(), message: "Waiting for account connection. Local tracking continues." }); return; }
    this.publish({ status: info().pendingDays ? "pending" : "enabled", ...info() });
    if (!force && ledger.nextAttempt > this.now()) return;
    for (const entry of Object.values(ledger.entries).filter(entry => entry.acknowledged < entry.payload.revision).sort((a, b) => a.payload.date.localeCompare(b.payload.date)).slice(0, 10)) {
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
    this.publish({ status: !ledger.enabled ? "disabled" : info().pendingDays ? "pending" : "enabled", ...info() });
  }
  private async put(payload: SyncDay, token: string) {
    const controller = new AbortController(); this.controller = controller;
    const timer = setTimeout(() => controller.abort(), 10_000); timer.unref?.();
    try {
      const response = await (this.ports.fetch ?? fetch)(`${this.ports.account.getOrigin()}/api/v1/sync/installations/${this.ports.installationId}/days/${payload.date}`, {
        method: "PUT", signal: controller.signal, redirect: "error", cache: "no-store",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(payload)
      });
      if (!response.ok) { await response.body?.cancel(); throw new SyncFailure(response.status); }
      const text = await response.text(); if (text.length > 2048) throw new SyncFailure(502);
      const result = JSON.parse(text) as { revision: number; date: string; installationId: string };
      if (result.revision !== payload.revision || result.date !== payload.date || result.installationId !== this.ports.installationId) throw new SyncFailure(502);
    } finally { clearTimeout(timer); if (this.controller === controller) this.controller = undefined; }
  }
  dispose(): void { this.disposed = true; this.controller?.abort(); this.listeners.clear(); }
}

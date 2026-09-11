import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export interface AccountIdentity { userId: string; username: string; displayName: string | null; profileUrl: string }
export interface AccountState {
  status: "disconnected" | "connecting" | "connected" | "expired" | "error";
  account?: AccountIdentity;
  message?: string;
  syncGrant?: string;
}
export interface AccountCredentials {
  accessToken: string; refreshToken: string; expiresAt: string; refreshExpiresAt: string; account: AccountIdentity;
  syncGrant?: string; nextRefreshToken?: string;
}
export interface SecretStore { get(key: string): PromiseLike<string | undefined>; store(key: string, value: string): PromiseLike<void>; delete(key: string): PromiseLike<void> }
interface PendingLink { state: string; verifier: string; redirectUri: string; expiresAt: number; scope?: "stats:write" }
export interface AccountPorts {
  secrets: SecretStore;
  callbackUri: () => Promise<string>;
  openBrowser: (uri: string) => PromiseLike<boolean>;
  origin?: string;
  fetch?: typeof fetch;
  now?: () => number;
  withRefreshLock?: <T>(action: () => Promise<T>) => Promise<T>;
}
const hex = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const random = () => randomBytes(32).toString("hex");
export function parseIdentity(input: unknown): AccountIdentity {
  const value = input as AccountIdentity;
  if (!value || typeof value.userId !== "string" || !uuid.test(value.userId) || typeof value.username !== "string" || !/^[a-z0-9][a-z0-9_-]{2,29}$/.test(value.username)
    || !(value.displayName === null || (typeof value.displayName === "string" && value.displayName.length <= 60))
    || value.profileUrl !== `https://stackstats.dev/u/${value.username}`) throw new Error("Invalid identity response");
  return { userId: value.userId, username: value.username, displayName: value.displayName, profileUrl: value.profileUrl };
}
function parseCredentials(input: unknown): AccountCredentials {
  const value = input as AccountCredentials;
  if (!value || !hex.test(value.accessToken) || !hex.test(value.refreshToken)
    || typeof value.expiresAt !== "string" || typeof value.refreshExpiresAt !== "string"
    || !Number.isFinite(Date.parse(value.expiresAt)) || !Number.isFinite(Date.parse(value.refreshExpiresAt))) throw new Error("Invalid credential response");
  if (value.syncGrant !== undefined && !uuid.test(value.syncGrant)) throw new Error("Invalid sync grant");
  if (value.nextRefreshToken !== undefined && !hex.test(value.nextRefreshToken)) throw new Error("Invalid pending rotation");
  return { ...(value.syncGrant ? { syncGrant: value.syncGrant } : {}), ...(value.nextRefreshToken ? { nextRefreshToken: value.nextRefreshToken } : {}), accessToken: value.accessToken, refreshToken: value.refreshToken, expiresAt: value.expiresAt,
    refreshExpiresAt: value.refreshExpiresAt, account: parseIdentity(value.account) };
}
class AuthRequestError extends Error {
  constructor(readonly status: number) { super("Account request failed"); }
}

/** Account and explicitly consented stats credentials. No dependency on tracking, SQLite, UI, or raw events.
 * All persisted identity/credentials and pending PKCE secrets use SecretStorage.
 * Network failures are contained here; callers may always continue local work. */
export class AccountService {
  readonly secretKey: string;
  readonly pendingKey: string;
  private readonly origin: string;
  private readonly now: () => number;
  private state: AccountState = { status: "disconnected" };
  private credentials?: AccountCredentials;
  private pending?: PendingLink;
  private listeners = new Set<(state: AccountState) => void>();
  private generation = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private validation?: Promise<string | undefined>;
  private initialization?: Promise<void>;
  private lastChecked = 0;
  private lastAttempt = 0;
  private writes: Promise<void> = Promise.resolve();
  private controllers = new Set<AbortController>();
  private disposed = false;

  constructor(private readonly ports: AccountPorts) {
    this.origin = ports.origin ?? "https://stackstats.dev";
    const url = new URL(this.origin);
    if (url.origin !== this.origin || (this.origin !== "https://stackstats.dev" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname)))) throw new Error("Unsupported account origin");
    this.now = ports.now ?? Date.now;
    this.secretKey = `stackStats.account.v1:${this.origin}`;
    this.pendingKey = `${this.secretKey}:pending`;
  }
  getState(): AccountState { return structuredClone({ ...this.state, ...(this.credentials?.syncGrant ? { syncGrant: this.credentials.syncGrant } : {}) }); }
  getOrigin(): string { return this.origin; }
  onDidChange(listener: (state: AccountState) => void) {
    this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) };
  }
  private publish(state: AccountState) {
    if (this.disposed) return;
    this.state = state;
    for (const listener of this.listeners) { try { listener(this.getState()); } catch { /* Consumers cannot interrupt auth. */ } }
  }
  private write(action: () => PromiseLike<void>): Promise<void> {
    const next = this.writes.then(action);
    this.writes = next.catch(() => undefined); return next;
  }
  private invalidate(): number {
    this.generation++;
    for (const controller of this.controllers) controller.abort();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    return this.generation;
  }
  initialize(): Promise<void> {
    return this.initialization ??= this.restore();
  }
  private async restore(): Promise<void> {
    const generation = this.generation;
    try {
      const [saved, pending] = await Promise.all([this.ports.secrets.get(this.secretKey), this.ports.secrets.get(this.pendingKey)]);
      if (generation !== this.generation || this.disposed) return;
      if (saved) this.credentials = parseCredentials(JSON.parse(saved));
      if (pending) {
        const parsed = JSON.parse(pending) as PendingLink;
        if (hex.test(parsed.state) && hex.test(parsed.verifier) && typeof parsed.redirectUri === "string" && parsed.expiresAt > this.now() && parsed.expiresAt <= this.now() + 10 * 60_000) {
          this.pending = parsed; this.armTimeout(); this.publish({ status: "connecting", message: "Complete the connection in your browser." }); return;
        }
        await this.write(() => this.ports.secrets.delete(this.pendingKey));
      }
      if (generation !== this.generation) return;
      if (this.credentials) {
        this.publish({ status: "connected", account: this.credentials.account, message: "Checking account connection…" });
        await this.refreshIdentity();
      }
    } catch { if (generation === this.generation) this.publish({ status: "error", message: "Secure account storage is unavailable or unreadable. Local tracking continues. Disconnect to reset it." }); }
  }
  private armTimeout() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.cancelConnect("Connection timed out. Start again when you are ready."); }, Math.max(0, this.pending!.expiresAt - this.now()));
    this.timer.unref?.();
  }
  async connect(scope?: "stats:write"): Promise<void> {
    await this.initialize();
    if (this.disposed || this.state.status === "connecting") return;
    const generation = this.invalidate();
    this.publish({ status: "connecting", message: "Opening your browser…" });
    try {
      const redirectUri = await this.ports.callbackUri();
      if (generation !== this.generation) return;
      const pending: PendingLink = { state: random(), verifier: random(), redirectUri, expiresAt: this.now() + 10 * 60_000, ...(scope ? { scope } : {}) };
      this.pending = pending;
      await this.write(() => this.ports.secrets.store(this.pendingKey, JSON.stringify(pending)));
      if (generation !== this.generation) return;
      this.armTimeout();
      const url = new URL("/extension/connect", this.origin);
      url.search = new URLSearchParams({ state: pending.state, challenge: createHash("sha256").update(pending.verifier).digest("base64url"), redirectUri, ...(scope ? { scope } : {}) }).toString();
      if (!await this.ports.openBrowser(url.toString())) throw new Error("Browser unavailable");
      if (generation === this.generation) this.publish({ status: "connecting", message: "Approve the connection in your browser. Local tracking continues." });
    } catch { if (generation === this.generation) await this.cancelConnect("Could not open account sign-in. Try again; local tracking continues."); }
  }
  async cancelConnect(message = "Connection cancelled. Local tracking continues."): Promise<void> {
    this.invalidate(); this.pending = undefined;
    try {
      await this.write(() => this.ports.secrets.delete(this.pendingKey));
      this.publish(this.credentials ? { status: "connected", account: this.credentials.account, message } : { status: "disconnected", message });
    } catch { this.publish({ status: "error", message: "Could not clear the pending connection from secure storage. Disconnect to retry." }); }
  }
  async handleCallback(params: URLSearchParams): Promise<void> {
    await this.initialize();
    const pending = this.pending;
    const state = params.get("ss_state");
    // Invalid/unsolicited callbacks must not cancel a legitimate pending flow.
    if (!pending || !state || params.getAll("ss_state").length !== 1 || !hex.test(state)
      || !timingSafeEqual(Buffer.from(state), Buffer.from(pending.state))) return;
    if (pending.expiresAt <= this.now()) { await this.cancelConnect("Connection expired. Please connect again."); return; }
    if (params.get("error") === "access_denied" && params.getAll("error").length === 1 && !params.has("code")) { await this.cancelConnect(); return; }
    const code = params.get("code");
    if (!code || !hex.test(code) || params.getAll("code").length !== 1 || params.has("error")) return;
    const generation = this.invalidate();
    this.pending = undefined; // Consume locally before async exchange/replays.
    let received: AccountCredentials | undefined;
    try {
      await this.write(() => this.ports.secrets.delete(this.pendingKey));
      if (generation !== this.generation) return;
      const credentials = parseCredentials(await this.request("exchange", { code, verifier: pending.verifier, redirectUri: pending.redirectUri }));
      received = credentials;
      if (Boolean(credentials.syncGrant) !== (pending.scope === "stats:write")) throw new Error("Unexpected authorization scope");
      const previous = this.credentials;
      if (generation !== this.generation) { void this.revoke(credentials); return; }
      await this.commit(credentials, generation);
      if (previous) void this.revoke(previous);
    } catch {
      if (received) void this.revoke(received);
      if (generation === this.generation) this.publish({ status: "error", message: "Could not complete account linking. The code may have expired, secure storage failed, or the network is unavailable. Connect again; local tracking continues." });
    }
  }
  private async request(path: string, body?: unknown, accessToken?: string): Promise<unknown> {
    const controller = new AbortController(); this.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 10_000); timeout.unref?.();
    try {
      const response = await (this.ports.fetch ?? fetch)(`${this.origin}/api/extension/${path}`, {
        method: body === undefined ? "GET" : "POST", redirect: "error", cache: "no-store", signal: controller.signal,
        headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      if (!response.ok) throw new AuthRequestError(response.status);
      const text = await response.text();
      if (text.length > 16_384) throw new Error("Invalid account response");
      return JSON.parse(text);
    } finally { clearTimeout(timeout); this.controllers.delete(controller); }
  }
  private async commit(credentials: AccountCredentials, generation: number): Promise<void> {
    await this.write(async () => {
      if (generation !== this.generation || this.disposed) return;
      await this.ports.secrets.store(this.secretKey, JSON.stringify(credentials));
      if (generation !== this.generation || this.disposed) return;
      this.credentials = credentials; this.lastChecked = this.now();
      this.publish({ status: "connected", account: credentials.account });
    });
  }
  /** Internal consumers request credentials here; tokens are never UI state. */
  async getAccessToken(): Promise<string | undefined> {
    await this.initialize();
    if (!this.credentials || this.state.status === "connecting") return undefined;
    if (!this.credentials.nextRefreshToken && Date.parse(this.credentials.expiresAt) > this.now() + 60_000 && this.now() - this.lastChecked < 5 * 60_000) return this.credentials.accessToken;
    return this.refreshIdentity();
  }
  refreshIdentity(): Promise<string | undefined> {
    if (this.validation) return this.validation;
    const generation = this.generation;
    const initialCredentials = this.credentials;
    if (!initialCredentials || this.state.status === "connecting" || this.disposed) return Promise.resolve(undefined);
    let credentials: AccountCredentials = initialCredentials;
    this.lastAttempt = this.now();
    const work = async () => {
      try {
        if (this.ports.withRefreshLock) {
          const saved = await this.ports.secrets.get(this.secretKey);
          if (generation !== this.generation || !saved) return undefined;
          credentials = parseCredentials(JSON.parse(saved));
        }
        if (Date.parse(credentials.refreshExpiresAt) <= this.now()) throw new AuthRequestError(401);
        let next = credentials;
        if (credentials.nextRefreshToken || Date.parse(credentials.expiresAt) <= this.now() + 60_000) next = await this.rotate(credentials, generation);
        else {
          try { const data = await this.request("account", undefined, credentials.accessToken) as { account: unknown }; next = { ...credentials, account: parseIdentity(data.account) }; }
          catch (error) { if (!(error instanceof AuthRequestError) || error.status !== 401) throw error; next = await this.rotate(credentials, generation); }
        }
        if (generation !== this.generation) return undefined;
        if (next.account.userId !== credentials.account.userId) throw new AuthRequestError(401);
        await this.commit(next, generation);
        return generation === this.generation ? next.accessToken : undefined;
      } catch (error) {
        if (generation !== this.generation) return undefined;
        if (error instanceof AuthRequestError && (error.status === 401 || error.status === 403)) {
          this.credentials = undefined;
          try { await this.write(() => this.ports.secrets.delete(this.secretKey)); }
          catch { this.publish({ status: "error", message: "Authentication expired and secure storage could not be cleared. Disconnect to retry." }); return undefined; }
          this.publish({ status: "expired", message: "Authentication expired or was revoked. Reconnect your account; local tracking continues." });
        } else this.publish({ status: "error", account: credentials.account, message: "Account service or secure storage unavailable. Credentials are retained for retry; local tracking continues." });
        return undefined;
      }
    };
    this.validation = (this.ports.withRefreshLock ? this.ports.withRefreshLock(work) : work()).catch(() => {
      this.publish({ status: "error", account: this.credentials?.account, message: "Account refresh is busy or unavailable. Local tracking continues." });
      return undefined;
    }).finally(() => { this.validation = undefined; });
    return this.validation;
  }
  private async rotate(credentials: AccountCredentials, generation: number): Promise<AccountCredentials> {
    if (!credentials.syncGrant) return parseCredentials(await this.request("refresh", { refreshToken: credentials.refreshToken }));
    // Persist a random proposed successor BEFORE sending. Retrying the exact old
    // + successor pair recovers a lost response without reusing a bearer alone.
    const pending = { ...credentials, nextRefreshToken: credentials.nextRefreshToken ?? random() };
    await this.write(async () => {
      if (generation !== this.generation) throw new Error("Connection changed");
      await this.ports.secrets.store(this.secretKey, JSON.stringify(pending));
      this.credentials = pending;
    });
    const next = parseCredentials(await this.request("refresh", { refreshToken: pending.refreshToken, nextRefreshToken: pending.nextRefreshToken }));
    if (next.syncGrant !== credentials.syncGrant || next.refreshToken !== pending.nextRefreshToken) throw new Error("Invalid rotation response");
    return next;
  }
  /** Force refresh after a resource server rejects an otherwise cached token. */
  async refreshAccessToken(): Promise<string | undefined> {
    if (this.credentials) this.credentials = { ...this.credentials, expiresAt: new Date(0).toISOString() };
    // With the cross-window lock we re-read persisted state. Identity validation
    // there will also detect a revoked access token and refresh it.
    return this.refreshIdentity();
  }
  /** Re-read cross-window SecretStorage changes without exposing credentials. */
  async credentialsChanged(): Promise<void> {
    try {
      await this.writes; // Ignore our own SecretStorage notifications after commit.
      const saved = await this.ports.secrets.get(this.secretKey);
      if (saved === (this.credentials ? JSON.stringify(this.credentials) : undefined)) return;
      this.invalidate(); this.pending = undefined; this.credentials = saved ? parseCredentials(JSON.parse(saved)) : undefined;
      this.publish(this.credentials ? { status: "connected", account: this.credentials.account } : { status: "disconnected" });
    } catch { this.publish({ status: "error", message: "Secure account storage is unavailable. Local tracking continues." }); }
  }
  async pendingChanged(): Promise<void> {
    try {
      await this.writes;
      const saved = await this.ports.secrets.get(this.pendingKey);
      if (!this.pending || saved === JSON.stringify(this.pending)) return;
      this.invalidate(); this.pending = undefined;
      this.publish(this.credentials ? { status: "connected", account: this.credentials.account } : { status: "disconnected", message: "The pending connection changed in another window. Start again here if needed." });
    } catch { /* Credential operations surface storage failures independently. */ }
  }
  checkIfDue(): void {
    if (this.credentials && this.now() - this.lastAttempt >= 5 * 60_000) void this.refreshIdentity();
  }
  private async revoke(credentials: AccountCredentials): Promise<boolean> {
    try { await this.request("revoke", { refreshToken: credentials.refreshToken }); return true; }
    catch { return false; }
  }
  async disconnect(): Promise<void> {
    const generation = this.invalidate();
    const credentials = this.credentials;
    this.credentials = undefined; this.pending = undefined;
    try {
      await this.write(async () => { await this.ports.secrets.delete(this.secretKey); await this.ports.secrets.delete(this.pendingKey); });
      if (generation !== this.generation) return;
      this.publish({ status: "disconnected" });
      if (credentials) void this.revoke(credentials).then(revoked => {
        if (!revoked && generation === this.generation) this.publish({ status: "disconnected", message: "Credentials removed locally. Server revocation could not be confirmed; manage editor connections on stackstats.dev." });
      });
    } catch { this.publish({ status: "error", message: "Could not remove credentials from secure storage. Retry Disconnect Account. Local tracking is unaffected." }); }
  }
  dispose(): void { this.disposed = true; this.invalidate(); this.listeners.clear(); }
}

import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { AccountService, parseIdentity, type AccountCredentials } from "../apps/vscode-extension/src/account-service.js";
import { accountRows } from "../apps/vscode-extension/src/sidebar-model.js";

const now = Date.parse("2026-09-10T12:00:00Z");
const identity = { userId: "12345678-1234-4234-8234-123456789012", username: "fil", displayName: "Fil", profileUrl: "https://stackstats.dev/u/fil" };
const credentials = (): AccountCredentials => ({ accessToken: "a".repeat(64), refreshToken: "b".repeat(64), expiresAt: new Date(now + 900_000).toISOString(), refreshExpiresAt: new Date(now + 30 * 86400_000).toISOString(), account: identity });
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const services: AccountService[] = [];
function harness() {
  const values = new Map<string, string>();
  const secrets = { get: vi.fn(async (key: string) => values.get(key)), store: vi.fn(async (key: string, value: string) => { values.set(key, value); }), delete: vi.fn(async (key: string) => { values.delete(key); }) };
  const fetcher = vi.fn<typeof fetch>();
  const openBrowser = vi.fn(async (_uri: string) => true);
  let time = now;
  const service = new AccountService({ secrets, fetch: fetcher, callbackUri: async () => "vscode://undefined_publisher.stack-stats-vscode/auth/callback", openBrowser, now: () => time });
  services.push(service);
  return { service, values, secrets, fetcher, openBrowser, setTime: (value: number) => { time = value; } };
}
async function link(h: ReturnType<typeof harness>) {
  await h.service.initialize();
  await h.service.connect();
  const pending = JSON.parse(h.values.get(h.service.pendingKey)!);
  h.fetcher.mockResolvedValueOnce(json(credentials()));
  await h.service.handleCallback(new URLSearchParams({ ss_state: pending.state, code: "c".repeat(64) }));
  return pending;
}
afterEach(() => { services.splice(0).forEach(service => service.dispose()); vi.useRealTimers(); });

describe("optional account linking", () => {
  it("initializes local-only without any network request or new secrets", async () => {
    const h = harness(); await h.service.initialize();
    expect(h.service.getState()).toEqual({ status: "disconnected" });
    expect(await h.service.getAccessToken()).toBeUndefined();
    expect(h.fetcher).not.toHaveBeenCalled(); expect(h.values.size).toBe(0);
  });
  it("uses state + S256 PKCE, exchanges only once, and persists secrets outside public state", async () => {
    const h = harness(); const pending = await link(h);
    const url = new URL(h.openBrowser.mock.calls[0]![0] as string);
    expect(url.origin + url.pathname).toBe("https://stackstats.dev/extension/connect");
    expect(url.searchParams.get("challenge")).toBe(createHash("sha256").update(pending.verifier).digest("base64url"));
    for (const secret of [pending.verifier, credentials().accessToken, credentials().refreshToken]) expect(url.toString()).not.toContain(secret);
    const [target, options] = h.fetcher.mock.calls[0]!;
    expect(target).toBe("https://stackstats.dev/api/extension/exchange");
    expect(options?.redirect).toBe("error");
    expect(JSON.parse(options?.body as string)).toMatchObject({ verifier: pending.verifier, redirectUri: pending.redirectUri });
    expect(h.service.getState()).toEqual({ status: "connected", account: identity });
    expect(JSON.stringify(h.service.getState())).not.toContain(credentials().refreshToken);
    expect(h.values.has(h.service.pendingKey)).toBe(false);
    await h.service.handleCallback(new URLSearchParams({ ss_state: pending.state, code: "c".repeat(64) }));
    expect(h.fetcher).toHaveBeenCalledOnce();
  });
  it("ignores wrong-state, duplicate, malformed and unsolicited callback parameters", async () => {
    const h = harness(); await h.service.initialize(); await h.service.connect();
    const pending = JSON.parse(h.values.get(h.service.pendingKey)!);
    for (const params of [new URLSearchParams({ ss_state: "e".repeat(64), code: "c".repeat(64) }), new URLSearchParams({ ss_state: pending.state, code: "bad" }), new URLSearchParams(`ss_state=${pending.state}&ss_state=${pending.state}&code=${"c".repeat(64)}`)]) await h.service.handleCallback(params);
    expect(h.fetcher).not.toHaveBeenCalled(); expect(h.service.getState().status).toBe("connecting");
  });
  it("recovers a pending link from SecretStorage after an editor restart", async () => {
    const h = harness(); await h.service.initialize(); await h.service.connect(); h.service.dispose();
    const restored = new AccountService({ secrets: h.secrets, fetch: h.fetcher, callbackUri: async () => "unused", openBrowser: h.openBrowser, now: () => now }); services.push(restored);
    await restored.initialize(); expect(restored.getState().status).toBe("connecting");
    const pending = JSON.parse(h.values.get(restored.pendingKey)!);
    h.fetcher.mockResolvedValueOnce(json(credentials()));
    await restored.handleCallback(new URLSearchParams({ ss_state: pending.state, code: "c".repeat(64) }));
    expect(restored.getState().account).toEqual(identity);
  });
  it("handles browser rejection, explicit cancellation, and expired pending requests", async () => {
    const h = harness(); await h.service.initialize(); h.openBrowser.mockResolvedValueOnce(false);
    await h.service.connect(); expect(h.service.getState().status).toBe("disconnected"); expect(h.values.has(h.service.pendingKey)).toBe(false);
    await h.service.connect(); let pending = JSON.parse(h.values.get(h.service.pendingKey)!);
    await h.service.handleCallback(new URLSearchParams({ ss_state: pending.state, error: "access_denied" }));
    expect(h.service.getState().message).toContain("cancelled");
    await h.service.connect(); pending = JSON.parse(h.values.get(h.service.pendingKey)!); h.setTime(now + 601_000);
    await h.service.handleCallback(new URLSearchParams({ ss_state: pending.state, code: "c".repeat(64) }));
    expect(h.service.getState().message).toContain("expired"); expect(h.fetcher).not.toHaveBeenCalled();
  });
  it("contains SecretStorage errors and never opens a browser without saving the verifier", async () => {
    const h = harness(); await h.service.initialize(); h.secrets.store.mockRejectedValueOnce(new Error("secret details"));
    await h.service.connect(); expect(h.openBrowser).not.toHaveBeenCalled();
    expect(JSON.stringify(h.service.getState())).not.toContain("secret details");
    h.secrets.get.mockRejectedValue(new Error("secure store locked"));
    await h.service.credentialsChanged(); expect(h.service.getState().status).toBe("error");
  });
  it("does not complete a pending browser flow cancelled from another window", async () => {
    const h = harness(); await h.service.initialize(); await h.service.connect();
    const pending = JSON.parse(h.values.get(h.service.pendingKey)!);
    h.values.delete(h.service.pendingKey); await h.service.pendingChanged();
    await h.service.handleCallback(new URLSearchParams({ ss_state: pending.state, code: "c".repeat(64) }));
    expect(h.fetcher).not.toHaveBeenCalled(); expect(h.service.getState().status).toBe("disconnected");
  });
  it("times out an abandoned browser flow without requiring another callback", async () => {
    vi.useFakeTimers();
    const h = harness(); await h.service.initialize(); await h.service.connect();
    await vi.advanceTimersByTimeAsync(600_001);
    expect(h.service.getState().status).toBe("disconnected");
    expect(h.service.getState().message).toContain("timed out");
    expect(h.values.has(h.service.pendingKey)).toBe(false);
  });
});

describe("account lifecycle isolation", () => {
  it("refreshes expired access, coalesces refreshes, and fetches current identity on restart", async () => {
    const h = harness(); h.values.set(h.service.secretKey, JSON.stringify(credentials()));
    h.fetcher.mockResolvedValueOnce(json({ account: { ...identity, displayName: "Updated" } }));
    await h.service.initialize(); expect(h.service.getState().account?.displayName).toBe("Updated");
    h.setTime(now + 901_000);
    const fresh = { ...credentials(), accessToken: "d".repeat(64), expiresAt: new Date(now + 1800_000).toISOString() };
    h.fetcher.mockResolvedValueOnce(json(fresh));
    expect(await Promise.all([h.service.getAccessToken(), h.service.getAccessToken()])).toEqual([fresh.accessToken, fresh.accessToken]);
    expect(h.fetcher).toHaveBeenCalledTimes(2);
    expect(h.fetcher.mock.calls[1]?.[0]).toContain("/refresh");
  });
  it("retains credentials during network/server failures and recovers later", async () => {
    const h = harness(); await link(h);
    h.fetcher.mockRejectedValueOnce(new Error("network unavailable"));
    await h.service.refreshIdentity(); expect(h.service.getState().status).toBe("error"); expect(h.values.has(h.service.secretKey)).toBe(true);
    h.fetcher.mockResolvedValueOnce(json({ error: "server secret" }, 503)); await h.service.refreshIdentity();
    expect(JSON.stringify(h.service.getState())).not.toContain("server secret");
    h.fetcher.mockResolvedValueOnce(json({ account: identity })); await h.service.refreshIdentity();
    expect(h.service.getState().status).toBe("connected");
  });
  it("clears revoked/deleted accounts only after access and refresh are both rejected", async () => {
    const h = harness(); await link(h);
    h.fetcher.mockResolvedValueOnce(json({}, 401)).mockResolvedValueOnce(json({}, 401));
    await h.service.refreshIdentity(); expect(h.service.getState().status).toBe("expired"); expect(h.values.has(h.service.secretKey)).toBe(false);
  });
  it("disconnects locally even offline without deleting unrelated data", async () => {
    const h = harness(); await link(h); h.values.set("unrelated", "keep"); h.fetcher.mockRejectedValueOnce(new Error("offline"));
    await h.service.disconnect(); expect(h.service.getState().status).toBe("disconnected");
    expect(h.values).toEqual(new Map([["unrelated", "keep"]]));
  });
  it("does not resurrect credentials when disconnect races a successful refresh", async () => {
    const h = harness(); await link(h); h.setTime(now + 901_000);
    let finish!: (response: Response) => void;
    h.fetcher.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce(json({ revoked: true }));
    const refresh = h.service.refreshIdentity();
    await h.service.disconnect(); finish(json(credentials())); await refresh;
    expect(h.service.getState().status).toBe("disconnected"); expect(h.values.has(h.service.secretKey)).toBe(false);
  });
  it("notifies sidebar consumers without tokens and observes cross-window disconnect", async () => {
    const h = harness(); const changed = vi.fn(); h.service.onDidChange(changed); await link(h);
    expect(accountRows(h.service.getState())[0]?.description).toBe("Connected as @fil");
    expect(JSON.stringify(changed.mock.calls)).not.toContain(credentials().accessToken);
    h.values.delete(h.service.secretKey); await h.service.credentialsChanged();
    expect(h.service.getState().status).toBe("disconnected");
  });
  it("rejects a forged profile URL and a changed user during refresh", async () => {
    expect(() => parseIdentity({ ...identity, profileUrl: "https://evil.example/u/fil" })).toThrow();
    const h = harness(); await link(h); h.fetcher.mockResolvedValueOnce(json({ account: { ...identity, userId: "99999999-1234-4234-8234-123456789012" } }));
    await h.service.refreshIdentity(); expect(h.service.getState().status).toBe("expired");
  });
});

describe("explicit stats authorization and refresh rotation", () => {
  it("requests additional permission in a new PKCE flow and rejects a scope downgrade", async () => {
    const h = harness(); await link(h); await h.service.connect("stats:write");
    expect(new URL(h.openBrowser.mock.calls.at(-1)![0]).searchParams.get("scope")).toBe("stats:write");
    const pending = JSON.parse(h.values.get(h.service.pendingKey)!);
    h.fetcher.mockResolvedValueOnce(json(credentials())).mockResolvedValueOnce(json({ revoked: true }));
    await h.service.handleCallback(new URLSearchParams({ ss_state: pending.state, code: "c".repeat(64) }));
    expect(h.service.getState().syncGrant).toBeUndefined(); expect(h.service.getState().status).toBe("error");
  });
  it("persists a proposed successor before sending and recovers a lost refresh response", async () => {
    const h = harness(); await h.service.initialize(); await h.service.connect("stats:write");
    const pending = JSON.parse(h.values.get(h.service.pendingKey)!);
    const grant = "44444444-4444-4444-8444-444444444444";
    h.fetcher.mockResolvedValueOnce(json({ ...credentials(), syncGrant: grant }));
    await h.service.handleCallback(new URLSearchParams({ ss_state: pending.state, code: "c".repeat(64) }));
    expect(h.service.getState().syncGrant).toBe(grant);
    h.setTime(now + 901_000);
    let first: { refreshToken: string; nextRefreshToken: string } | undefined;
    h.fetcher.mockImplementationOnce(async (_url, options) => {
      first = JSON.parse(options!.body as string);
      expect(JSON.parse(h.values.get(h.service.secretKey)!).nextRefreshToken).toBe(first!.nextRefreshToken);
      throw new Error("lost response");
    });
    await h.service.getAccessToken(); expect(h.service.getState().status).toBe("error");
    h.fetcher.mockImplementationOnce(async (_url, options) => {
      expect(JSON.parse(options!.body as string)).toEqual(first);
      return json({ ...credentials(), syncGrant: grant, refreshToken: first!.nextRefreshToken, expiresAt: new Date(now + 1800_000).toISOString() });
    });
    await h.service.getAccessToken(); expect(h.service.getState().status).toBe("connected");
    expect(JSON.parse(h.values.get(h.service.secretKey)!).nextRefreshToken).toBeUndefined();
    expect(JSON.stringify(h.service.getState())).not.toContain(first!.nextRefreshToken);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalSessionStore, serializeSession, deserializeSession } from "../apps/vscode-extension/src/local-store.js";
import { SessionDelivery } from "../apps/vscode-extension/src/delivery.js";
import { session } from "./fixtures.js";

const directories: string[] = [];
async function store() {
  const directory = await mkdtemp(join(tmpdir(), "stack-stats-session-"));
  directories.push(directory);
  const warn = vi.fn();
  const value = new LocalSessionStore(directory, warn);
  await value.initialize();
  return { value, directory, warn };
}
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("versioned local snapshots", () => {
  it("roundtrips metadata and rejects invalid/future schemas or source contents", () => {
    const snapshot = session();
    expect(deserializeSession(serializeSession(snapshot))).toEqual(snapshot);
    expect(() => deserializeSession('{"storageVersion":2}')).toThrow();
    expect(() => deserializeSession("{")).toThrow();
    expect(() => serializeSession({ ...snapshot, sourceCode: "secret" } as typeof snapshot)).toThrow();
    expect(() => serializeSession({ ...snapshot, endedAt: "2020-01-01T00:00:00Z" })).toThrow();
    const invalid = structuredClone(snapshot);
    invalid.days[0]!.contributions[0]!.activeMs = 1_000_000;
    expect(() => serializeSession(invalid)).toThrow();
  });

  it("recovers the last complete snapshot across restart, preserves corrupt files, and ignores torn temporary writes", async () => {
    const { value, directory, warn } = await store();
    const snapshot = session();
    await value.save(snapshot);
    const newer = structuredClone(snapshot);
    newer.revision++;
    await value.save(newer);
    await writeFile(join(directory, "partial.tmp"), "{");
    const brokenPath = join(directory, "00000000-0000-4000-8000-000000000000.json");
    await writeFile(brokenPath, "{");
    const restarted = new LocalSessionStore(directory, warn);
    expect(await restarted.list()).toEqual([newer]);
    expect(warn).toHaveBeenCalled();
    expect(await readFile(brokenPath, "utf8")).toBe("{");
    expect(await restarted.pending()).toEqual([newer]);
    await restarted.acknowledge(newer);
    expect(await restarted.pending()).toEqual([]);
    expect((await readdir(directory)).filter((file) => file.endsWith(".tmp"))).toEqual(["partial.tmp"]);
  });

  it("keeps simultaneous window sessions separate and newer revisions pending after an older ack", async () => {
    const { value, directory } = await store();
    const other = new LocalSessionStore(directory, vi.fn());
    const first = session();
    const second = session();
    await Promise.all([value.save(first), other.save(second)]);
    const newer = { ...first, revision: first.revision + 1 };
    await value.save(newer);
    await other.acknowledge(first);
    expect((await other.pending()).map((s) => s.sessionId).sort()).toEqual([first.sessionId, second.sessionId].sort());
  });
});

describe("durable local daemon delivery", () => {
  it("retries offline/paused requests and acknowledges only accepted snapshots", async () => {
    const { value } = await store();
    const snapshot = session();
    await value.save(snapshot);
    const fetch = vi.fn().mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockResolvedValueOnce(new Response('{"accepted":true}', { status: 201 }));
    vi.stubGlobal("fetch", fetch);
    const delivery = new SessionDelivery(value, { token: "test-secret", port: 17321 });
    delivery.enqueue(await value.pending());
    await delivery.sync();
    expect(delivery.state).toContain("offline");
    expect(await value.pending()).toHaveLength(1);
    await delivery.sync();
    expect(fetch).toHaveBeenCalledTimes(1);
    await delivery.sync(true);
    expect(delivery.state).toContain("paused");
    await delivery.sync(true);
    expect(await value.pending()).toHaveLength(0);
    expect(await value.list()).toEqual([snapshot]);
  });

  it("does not drop a newer snapshot arriving during an in-flight request", async () => {
    const { value } = await store();
    const snapshot = session();
    await value.save(snapshot);
    let finish!: (response: Response) => void;
    const fetch = vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }))
      .mockResolvedValue(new Response('{"accepted":true}', { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const delivery = new SessionDelivery(value, { token: "secret", port: 17321 });
    delivery.enqueue([snapshot]);
    const running = delivery.sync();
    const newer = { ...snapshot, revision: snapshot.revision + 1 };
    await value.save(newer);
    delivery.enqueue([newer]);
    finish(new Response('{"accepted":true}', { status: 201 }));
    await running;
    expect(delivery.pendingCount).toBe(1);
    expect(await value.pending()).toEqual([newer]);
    await delivery.sync(true);
    expect(delivery.pendingCount).toBe(0);
  });
});

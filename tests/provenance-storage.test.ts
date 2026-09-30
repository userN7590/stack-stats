import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readdir, readFile, writeFile, utimes, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { provenanceRecordSchema, telemetryBatchSchema, telemetryEventSchema, type AgentInboxRecord, type ProvenanceRecord } from "@stack-stats/protocol";
import { AgentInbox, AGENT_INBOX_MAX_AGE_MS, inboxPaths, readIntegrationState, writeInboxRecord } from "../apps/vscode-extension/src/agent-inbox.js";
import { ProvenanceLedger } from "../apps/vscode-extension/src/provenance-ledger.js";
import { hash } from "./telemetry-fixtures.js";

const temp = () => mkdtemp(join(tmpdir(), "stack-stats-prov-"));
const inboxRecord = (patch: Partial<AgentInboxRecord> = {}): AgentInboxRecord => ({ inboxVersion: 1, recordId: randomUUID(), tool: "claude-code", observedAt: new Date().toISOString(),
  signal: "turn_stopped", sessionHash: hash("s"), cwd: "/work/project", ...patch });
const agentRecord = (patch: Partial<ProvenanceRecord> = {}): ProvenanceRecord => provenanceRecordSchema.parse({ kind: "agent", recordId: randomUUID(), installationId: "i",
  at: new Date().toISOString(), tool: "codex", signal: "turn_stopped", sessionKey: hash("s"), ...patch });

describe("agent inbox", () => {
  it("round-trips integration state and fails closed on corruption", async () => {
    const home = await temp(), inbox = new AgentInbox(home);
    expect(readIntegrationState(home)).toBeUndefined();
    const state = { stateVersion: 1 as const, collecting: true, integrations: { "claude-code": true, codex: false }, excludeFiles: ["**/x/**"], updatedAt: new Date().toISOString() };
    await inbox.writeState(state);
    expect(readIntegrationState(home)).toEqual(state);
    await writeFile(inboxPaths(home).state, JSON.stringify({ ...state, extra: true }));
    expect(readIntegrationState(home)).toBeUndefined();
  });

  it("claims only what the handler persisted and purges invalid, expired and disabled-tool records", async () => {
    const home = await temp(), inbox = new AgentInbox(home);
    const mine = inboxRecord(), theirs = inboxRecord({ cwd: "/other/workspace" }), disabled = inboxRecord({ tool: "codex" });
    const old = inboxRecord({ observedAt: new Date(Date.now() - AGENT_INBOX_MAX_AGE_MS - 1_000).toISOString() });
    for (const record of [mine, theirs, disabled, old]) writeInboxRecord(home, record);
    await writeFile(join(inboxPaths(home).records, `${Date.now()}-${randomUUID()}.json`), "{\"inboxVersion\":1,\"prompt\":\"x\"}");
    await writeFile(inboxPaths(home).dropped, "4");
    const seen: string[] = [];
    const result = await inbox.drain(async (records) => { seen.push(...records.map((record) => record.recordId)); return new Set([mine.recordId]); }, new Set(["claude-code"]));
    expect(result).toEqual({ claimed: 1, unclaimed: 1, invalid: 1, expired: 1, disabled: 1, overflowDropped: 4 });
    expect(seen.sort()).toEqual([mine.recordId, theirs.recordId].sort());
    const left = await readdir(inboxPaths(home).records);
    expect(left).toHaveLength(1);
    expect(left[0]).toContain(theirs.recordId);
  });

  it("delivers each record to exactly one of several concurrent windows, and keeps records when persistence fails", async () => {
    const home = await temp();
    const records = Array.from({ length: 30 }, () => inboxRecord());
    for (const record of records) writeInboxRecord(home, record);
    await expect(new AgentInbox(home).drain(async () => { throw new Error("disk full"); }, new Set(["claude-code"]))).rejects.toThrow("disk full");
    expect(await readdir(inboxPaths(home).records)).toHaveLength(30);
    const claimed: string[] = [];
    const window = () => new AgentInbox(home).drain(async (batch) => { claimed.push(...batch.map((record) => record.recordId)); return new Set(batch.map((record) => record.recordId)); }, new Set(["claude-code"]));
    const results = await Promise.all([window(), window(), window()]);
    expect(results.reduce((n, result) => n + result.claimed, 0)).toBe(30);
    expect(new Set(claimed).size).toBe(30);
    expect(claimed).toHaveLength(30);
  });

  it("installs the hook at a version-stable path only when content changes", async () => {
    const home = await temp(), bundled = join(home, "bundle.cjs");
    await writeFile(bundled, "module.exports = 1;");
    const inbox = new AgentInbox(home);
    const path = await inbox.installHook(bundled);
    expect(await readFile(path, "utf8")).toBe("module.exports = 1;");
    await writeFile(bundled, "module.exports = 2;");
    expect(await readFile(await inbox.installHook(bundled), "utf8")).toBe("module.exports = 2;");
  });
});

describe("local-only provenance ledger", () => {
  it("persists across restarts, deduplicates by record ID and preserves corrupt batches with a warning", async () => {
    const directory = join(await temp(), "provenance-v1"), warnings: string[] = [];
    const ledger = new ProvenanceLedger(directory, (message) => warnings.push(message));
    await ledger.initialize();
    const record = agentRecord();
    await ledger.append([record, agentRecord()]);
    await ledger.append([record]);
    await writeFile(join(directory, `${randomUUID()}.json`), "{broken");
    const restarted = new ProvenanceLedger(directory, (message) => warnings.push(message));
    const listed = await restarted.list();
    expect(new Set(listed.map((item) => item.recordId)).size).toBe(2);
    expect(warnings).toHaveLength(1);
    expect((await readdir(directory)).length).toBe(3);
  });

  it("keeps records queued when a write fails and retries on the next append", async () => {
    const root = await temp(), directory = join(root, "provenance-v1");
    const ledger = new ProvenanceLedger(directory, () => undefined);
    await ledger.initialize();
    await chmod(directory, 0o500);
    await expect(ledger.append([agentRecord()])).rejects.toThrow();
    expect(ledger.queued).toBe(1);
    await chmod(directory, 0o700);
    await ledger.append([agentRecord()]);
    expect(ledger.queued).toBe(0);
    expect(await new ProvenanceLedger(directory, () => undefined).list()).toHaveLength(2);
  });

  it("discards an invalid record without blocking valid ones, and creates its directory lazily", async () => {
    const warnings: string[] = [];
    const ledger = new ProvenanceLedger(join(await temp(), "never-initialized"), (message) => warnings.push(message));
    await ledger.append([{ ...agentRecord(), tool: "unknown-agent" } as unknown as ProvenanceRecord, agentRecord()]);
    expect(ledger.rejected).toBe(1);
    expect(warnings).toHaveLength(1);
    expect(await ledger.list()).toHaveLength(1);
  });

  it("applies retention to local provenance batches", async () => {
    const directory = join(await temp(), "provenance-v1");
    const ledger = new ProvenanceLedger(directory, () => undefined);
    await ledger.initialize();
    await ledger.append([agentRecord()]);
    const [name] = await readdir(directory);
    const old = new Date(Date.now() - 40 * 86_400_000);
    await utimes(join(directory, name!), old, old);
    await new ProvenanceLedger(directory, () => undefined).initialize(30);
    expect(await readdir(directory)).toEqual([]);
    await mkdir(directory, { recursive: true });
  });

  it("rejects provenance claims its evidence cannot support", () => {
    const base = { kind: "change", recordId: randomUUID(), installationId: "i", firstObservedAt: "2026-09-29T12:00:00Z", observedAt: "2026-09-29T12:00:01Z",
      projectId: hash("p"), fileId: hash("f"), languageId: "typescript", operation: "modified", origin: "external", actor: "unknown", confidence: "none", reason: "no_evidence",
      delta: null, observations: { watcher: 1, reload: 0, adapter: 0 } };
    expect(provenanceRecordSchema.safeParse(base).success).toBe(true);
    for (const invalid of [
      { ...base, actor: "human" },                                   // no automatic human claims
      { ...base, tool: "claude-code" },                              // unknown cannot name an agent
      { ...base, confidence: "explicit", actor: "agent", tool: "codex", reason: undefined }, // explicit needs an adapter report
      { ...base, actor: "agent", confidence: "correlated", reason: undefined }, // correlated needs a tool and window
      { ...base, operation: "bulk" },                                // bulk records carry no file identity
      { ...base, delta: { linesAdded: 1, linesRemoved: 0, source: "adapter" } }, // adapter deltas require explicit evidence
      { ...base, path: "/Users/me/secret.ts" },                      // no paths
      { ...base, observedAt: "2026-09-29T11:00:00Z" }                // ordering
    ]) expect(provenanceRecordSchema.safeParse(invalid).success, JSON.stringify(invalid)).toBe(false);
  });

  it("cannot enter the telemetry-v2 stream that feeds the daemon and hourly sync projection", () => {
    const record = agentRecord();
    expect(telemetryEventSchema.safeParse(record).success).toBe(false);
    expect(telemetryBatchSchema.safeParse({ storageVersion: 1, batchId: randomUUID(), events: [record] }).success).toBe(false);
  });
});

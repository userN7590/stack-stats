import { performance } from "node:perf_hooks";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionTracker, queryTelemetry } from "@stack-stats/core";
import { telemetryBatchSchema, type TelemetryEvent } from "@stack-stats/protocol";
import { TelemetryBuffer } from "../apps/vscode-extension/src/telemetry-buffer.js";
import { TelemetryJournal } from "../apps/vscode-extension/src/telemetry-journal.js";
import { StackStatsDatabase } from "../packages/storage/src/index.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const root = await mkdtemp(join(tmpdir(), "stack-telemetry-benchmark-"));
const context = { project: { projectId: hash("benchmark"), displayName: "Benchmark", rootKind: "workspace" as const }, file: { fileId: hash("file"), languageId: "typescript", category: "source" as const } };
const buffer = new TelemetryBuffer("benchmark");
const tracker = new SessionTracker({ createId: randomUUID, timeZone: "UTC",
  source: { adapter: "vscode", adapterVersion: "0.1.0", editorName: "Benchmark", installationId: "benchmark" },
  onInterval: (...args) => buffer.interval(...args) });
const events: TelemetryEvent[] = [], counts = { editCount: 1, linesAdded: 0, linesRemoved: 0 };
const startAt = Date.parse("2026-09-07T00:00:00Z");
const started = performance.now();
for (let i = 0; i < 100_000; i++) {
  const at = startAt + i * 10;
  tracker.edit(context, counts, at);
  buffer.edit({ documentId: "not stored", version: i + 1, at, context, counts, characters: { charactersAdded: 1, charactersRemoved: 0 }, dirty: true, visible: true, focused: true, undoRedo: false }, tracker.sessionId);
  if (i % 1500 === 1499) events.push(...buffer.drain());
}
events.push(...buffer.drain());
const collectMs = performance.now() - started;
const range = { from: "2026-09-07T00:00:00Z", to: "2026-09-08T00:00:00Z", limit: 200 };
let now = performance.now();
const result = queryTelemetry(events, range);
const queryMs = performance.now() - now;
if (result.edits.editCount !== 100_000) throw new Error("Benchmark counter mismatch");
const batch = telemetryBatchSchema.parse({ storageVersion: 1, batchId: randomUUID(), events });
const journal = new TelemetryJournal(join(root, "journal"), () => undefined);
const database = new StackStatsDatabase(join(root, "test.db"));
try {
  await journal.initialize();
  now = performance.now(); await journal.save(batch); const durableWriteMs = performance.now() - now;
  now = performance.now(); database.insertTelemetry(batch); const sqliteInsertMs = performance.now() - now;
  now = performance.now(); database.queryTelemetry(range); const sqliteQueryMs = performance.now() - now;
  // Also exercise a realistically large indexed query independently of the burst.
  const one = events.find((event) => event.eventType === "editor.edit")!;
  now = performance.now();
  for (let i = 0; i < 20; i++) database.insertTelemetry({ storageVersion: 1, batchId: randomUUID(), events: Array.from({ length: 1000 }, () => ({ ...one, eventId: randomUUID() })) });
  const largeInsertMs = performance.now() - now;
  now = performance.now(); database.queryTelemetry(range); const query20kMs = performance.now() - now;
  console.log(JSON.stringify({ syntheticEdits: 100_000, normalizedEvents: events.length, serializedBytes: Buffer.byteLength(JSON.stringify(batch)),
    collectMs, queryMs, durableWriteMs, sqliteInsertMs, sqliteQueryMs, largeInsertMs, query20kMs,
    notes: "Synthetic temporary data; measurements include this machine/runtime and are not product guarantees." }, null, 2));
} finally { database.close(); await rm(root, { recursive: true, force: true }); }

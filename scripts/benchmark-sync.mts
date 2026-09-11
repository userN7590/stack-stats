import { performance } from "node:perf_hooks";
import { mkdtemp, rm, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { addDays } from "@stack-stats/core";
import { ProfileSyncService } from "../apps/vscode-extension/src/profile-sync.js";
import { LocalSessionStore } from "../apps/vscode-extension/src/local-store.js";
import { session, context } from "../tests/fixtures.js";
const directory = await mkdtemp(join(tmpdir(), "stack-stats-sync-bench-"));
const installationId = "11111111-1111-4111-8111-111111111111";
let requests = 0, bytes = 0;
const store = new LocalSessionStore(join(directory, "sessions"), () => {});
const service = new ProfileSyncService({ directory: join(directory, "sync"), installationId, projectSalt: "private-benchmark-salt",
  account: { getState: () => ({ status: "connected", syncGrant: "33333333-3333-4333-8333-333333333333", account: { userId: installationId, username: "bench", displayName: null, profileUrl: "https://stackstats.dev/u/bench" } }), getAccessToken: async () => "test", refreshAccessToken: async () => "test", getOrigin: () => "https://stackstats.dev" },
  today: () => "2026-09-10", sessions: () => store.list(true), fetch: async (_url, options) => {
    requests++; bytes += Buffer.byteLength(options!.body as string); const day = JSON.parse(options!.body as string);
    return Response.json({ date: day.date, revision: day.revision, installationId });
  }
});
try {
  await store.initialize();
  for (let index = 0; index < 3000; index++) {
    const day = addDays("2026-09-10", -Math.floor(index / 10));
    const row = session(`${day}T12:00:00Z`, context(createHash("sha256").update(`project-${index % 20}`).digest("hex"), `file-${index}`, index % 2 ? "typescript" : "python"));
    row.source.installationId = installationId; await store.save(row);
  }
  const start = performance.now(); await service.tick(true); const first = performance.now() - start;
  const secondStart = performance.now(); await service.tick(true); const repeat = performance.now() - secondStart;
  const folders = (await readdir(join(directory, "sync"))).filter(name => !name.endsWith(".lock"));
  const size = (await stat(join(directory, "sync", folders[0]!, "queue.json"))).size;
  console.log(JSON.stringify({ durableSessions: 3000, initialEligibleDays: 90, firstScanAndTenPutsMs: Math.round(first), repeatScanAndTenPutsMs: Math.round(repeat), queueBytes: size, requests, uploadedBytes: bytes, note: "Local temporary disk + in-process mock HTTP; fsync/strict session reads included, network latency excluded." }, null, 2));
} finally { service.dispose(); await rm(directory, { recursive: true, force: true }); }

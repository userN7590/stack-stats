import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../apps/daemon/src/server.js";
import type { EditorFileChangedEvent } from "@stack-stats/protocol";

const apps: Array<ReturnType<typeof createServer>> = [];
const event = (): EditorFileChangedEvent => ({
  schemaVersion: "1.0", eventId: randomUUID(), eventType: "editor.file_changed", occurredAt: new Date().toISOString(),
  source: { adapter: "vscode", adapterVersion: "0.1.0", editorName: "Code", installationId: "install-1" },
  session: { sessionId: "session-1" },
  project: { projectId: "project-1", displayName: "Stack Stats", rootKind: "git" },
  file: { fileId: "file-1", extension: "ts", languageId: "typescript", category: "source" },
  change: { operation: "modified", linesAdded: 4, linesRemoved: 2, editCount: 3 }
});

afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

describe("local edit pipeline", () => {
  it("authenticates, validates, deduplicates, persists, and aggregates events", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "stack-stats-")), "test.db");
    const app = createServer({ databasePath: path, token: "secret" }); apps.push(app);
    const payload = event();
    expect((await app.inject({ method: "POST", url: "/v1/events", payload })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/v1/events", headers: { authorization: "Bearer secret" }, payload: { nope: true } })).statusCode).toBe(400);
    const first = await app.inject({ method: "POST", url: "/v1/events", headers: { authorization: "Bearer secret" }, payload });
    expect(first.statusCode).toBe(201);
    const duplicate = await app.inject({ method: "POST", url: "/v1/events", headers: { authorization: "Bearer secret" }, payload });
    expect(duplicate.json()).toMatchObject({ duplicate: true });
    const summary = await app.inject({ method: "GET", url: "/v1/summary", headers: { authorization: "Bearer secret" } });
    expect(summary.json()).toMatchObject({ editEvents: 1, filesChanged: 1, linesAdded: 4, linesRemoved: 2 });
  });

  it("does not store events while paused", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "stack-stats-")), "test.db");
    const app = createServer({ databasePath: path, token: "secret", paused: true }); apps.push(app);
    const response = await app.inject({ method: "POST", url: "/v1/events", headers: { authorization: "Bearer secret" }, payload: event() });
    expect(response.statusCode).toBe(503);
  });

  it("accepts a real loopback post from the collector and reports it in a --today summary", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "stack-stats-")), "test.db");
    const app = createServer({ databasePath: path, token: "secret" }); apps.push(app);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

    const posted = await fetch(`${base}/v1/events`, {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify(event())
    });
    expect(posted.status).toBe(201);

    const from = new Date(new Date().setHours(0, 0, 0, 0)).toISOString();
    const summary = await fetch(`${base}/v1/summary?from=${encodeURIComponent(from)}`, { headers: { authorization: "Bearer secret" } });
    expect(await summary.json()).toMatchObject({ editEvents: 1, filesChanged: 1, linesAdded: 4, linesRemoved: 2 });
  });

  it("preserves events across daemon restarts", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "stack-stats-")), "test.db");
    const first = createServer({ databasePath: path, token: "secret" });
    await first.inject({ method: "POST", url: "/v1/events", headers: { authorization: "Bearer secret" }, payload: event() });
    await first.close();

    const restarted = createServer({ databasePath: path, token: "secret" }); apps.push(restarted);
    const summary = await restarted.inject({ method: "GET", url: "/v1/summary", headers: { authorization: "Bearer secret" } });
    expect(summary.json()).toMatchObject({ editEvents: 1, filesChanged: 1 });
  });
});

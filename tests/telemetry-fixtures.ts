import { createHash, randomUUID } from "node:crypto";
import { telemetryEventSchema, type TelemetryEvent } from "@stack-stats/protocol";
export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const telemetryContext = { projectId: hash("project"), fileId: hash("file"), languageId: "typescript" };
export const source = { collector: "vscode" as const, instanceId: randomUUID(), installationId: "test-install" };
export const at = "2026-09-07T12:00:00.000Z";
export const range = { from: "2026-09-07T00:00:00Z", to: "2026-09-08T00:00:00Z" };
export function edit(overrides: Partial<TelemetryEvent> = {}): TelemetryEvent {
  return telemetryEventSchema.parse({ schemaVersion: "2.0", eventId: randomUUID(), occurredAt: at, source, evidence: "observed", context: telemetryContext,
    eventType: "editor.edit", data: { startedAt: at, firstVersion: 2, lastVersion: 4, editCount: 3, linesAdded: 2, linesRemoved: 1,
      charactersAdded: 20, charactersRemoved: 10, undoCount: 1, redoCount: 1 }, ...overrides });
}
export function report(target: string, actor: "human" | "ai" = "ai", agent: "codex" | "claude-code" = "codex"): TelemetryEvent {
  return telemetryEventSchema.parse({ schemaVersion: "2.0", eventId: randomUUID(), occurredAt: "2026-09-09T12:00:00Z", source: { ...source, collector: "adapter" },
    evidence: "reported", context: {}, eventType: "attribution.report", data: { targetEventIds: [target], actor, agent: actor === "ai" ? agent : undefined, providerId: hash("provider") } });
}


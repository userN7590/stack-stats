import { randomUUID } from "node:crypto";
import { SessionTracker, type ActivityContext } from "@stack-stats/core";

export const source = { adapter: "vscode" as const, adapterVersion: "0.1.0", editorName: "Code", installationId: "test-install" };
export const context = (project = "project-a", file = "file-a", language = "typescript"): ActivityContext => ({
  project: { projectId: project, displayName: project, rootKind: "workspace" },
  file: { fileId: file, languageId: language, category: "source" }
});
export const counts = { linesAdded: 2, linesRemoved: 1, editCount: 1 };
export const tracker = (timeZone = "UTC") => new SessionTracker({ source, createId: randomUUID, timeZone });
export function session(at = "2026-09-01T12:00:00Z", identity = context()) {
  const value = tracker();
  value.edit(identity, counts, Date.parse(at));
  value.edit(identity, counts, Date.parse(at) + 30_000);
  return value.snapshot()!;
}

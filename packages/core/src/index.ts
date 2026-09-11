import type { EditorFileChangedEvent } from "@stack-stats/protocol";

export * from "./dates.js";
export * from "./lines.js";
export * from "./sessions.js";
export * from "./statistics.js";
export * from "./telemetry.js";
export * from "./privacy.js";

export interface ActivitySummary {
  editEvents: number;
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  projects: Array<{ projectId: string; displayName: string; editEvents: number }>;
  languages: Array<{ languageId: string; editEvents: number; linesAdded: number; linesRemoved: number }>;
}

export function aggregateActivity(events: EditorFileChangedEvent[]): ActivitySummary {
  const files = new Set<string>();
  const projects = new Map<string, ActivitySummary["projects"][number]>();
  const languages = new Map<string, ActivitySummary["languages"][number]>();
  let linesAdded = 0;
  let linesRemoved = 0;

  for (const event of events) {
    files.add(`${event.project.projectId}:${event.file.fileId}`);
    linesAdded += event.change.linesAdded;
    linesRemoved += event.change.linesRemoved;
    const project = projects.get(event.project.projectId) ?? {
      projectId: event.project.projectId,
      displayName: event.project.displayName,
      editEvents: 0
    };
    project.editEvents++;
    projects.set(event.project.projectId, project);
    const language = languages.get(event.file.languageId) ?? {
      languageId: event.file.languageId,
      editEvents: 0,
      linesAdded: 0,
      linesRemoved: 0
    };
    language.editEvents++;
    language.linesAdded += event.change.linesAdded;
    language.linesRemoved += event.change.linesRemoved;
    languages.set(event.file.languageId, language);
  }

  return {
    editEvents: events.length,
    filesChanged: files.size,
    linesAdded,
    linesRemoved,
    projects: [...projects.values()].sort((a, b) => b.editEvents - a.editEvents),
    languages: [...languages.values()].sort((a, b) => b.editEvents - a.editEvents)
  };
}
export * from "./sync.js";

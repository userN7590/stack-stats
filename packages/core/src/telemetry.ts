import type { TelemetryEvent } from "@stack-stats/protocol";

export type Attribution = { actor: "unknown" | "human" | "ai"; agent?: string; evidence: "unknown" | "reported"; conflict: boolean };

/** Claims are annotations, never extra edits. Conflicting claims become unknown.
 * Reports are self-reported provenance, not evidence of human/agent authorship. */
export function resolveAttribution(events: readonly TelemetryEvent[]): Map<string, Attribution> {
  const claims = new Map<string, Attribution>();
  for (const event of events) if (event.eventType === "attribution.report") for (const target of new Set(event.data.targetEventIds)) {
    const claim: Attribution = { actor: event.data.actor, agent: event.data.agent, evidence: "reported", conflict: false };
    const previous = claims.get(target);
    if (previous && (previous.conflict || previous.actor !== claim.actor || previous.agent !== claim.agent)) {
      claims.set(target, { actor: "unknown", evidence: "unknown", conflict: true });
    } else claims.set(target, claim);
  }
  return claims;
}

export interface TelemetryRange { from: string; to: string; projectId?: string; languageId?: string }
export function filterTelemetry(events: readonly TelemetryEvent[], query: TelemetryRange): TelemetryEvent[] {
  const from = Date.parse(query.from), to = Date.parse(query.to);
  return [...new Map(events.map((event) => [event.eventId, event])).values()].filter((event) => {
    const at = Date.parse(event.occurredAt);
    const overlap = event.eventType === "activity.interval" && Date.parse(event.data.startedAt) < to && at > from;
    return ((at >= from && at < to) || overlap) && (!query.projectId || event.context.projectId === query.projectId)
      && (!query.languageId || event.context.languageId === query.languageId);
  }).sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || a.eventId.localeCompare(b.eventId));
}

const edits = () => ({ editCount: 0, linesAdded: 0, linesRemoved: 0, charactersAdded: 0, charactersRemoved: 0, undoCount: 0, redoCount: 0 });
export function queryTelemetry(allEvents: readonly TelemetryEvent[], query: TelemetryRange) {
  const events = filterTelemetry(allEvents, query);
  const attribution = resolveAttribution(allEvents);
  const totals = edits();
  const actors = { unknown: edits(), human: edits(), ai: edits() };
  const agents = new Map<string, ReturnType<typeof edits>>();
  const languages = new Map<string, ReturnType<typeof edits> & { activeMs: number }>();
  const projects = new Map<string, ReturnType<typeof edits> & { activeMs: number }>();
  const hours = Array.from({ length: 24 }, (_, hourUtc) => ({ hourUtc, activeMs: 0, edits: 0 }));
  const types: Record<string, number> = {};
  const taskStarts = new Map<string, TelemetryEvent & { eventType: "task.lifecycle" }>();
  const debugStarts = new Map<string, string>();
  const diagnostics = new Map<string, unknown>();
  const aiTouched = new Set<string>();
  const commits = new Set<string>();
  let activeMs = 0, saves = 0, projectSwitches = 0, languageSwitches = 0, fileSwitches = 0;
  let builds = 0, tests = 0, otherTasks = 0, taskFailures = 0, completedTasks = 0, taskDurationMs = 0;
  let debugRuns = 0, debugDurationMs = 0, laterEditorEditsInAiTouchedFiles = 0, attributionConflicts = 0;
  let gitLinesAdded = 0, gitLinesRemoved = 0, branchChanges = 0, filesystemUnknownNotifications = 0;
  const lifecycle = { created: 0, deleted: 0, renamed: 0 };
  const add = (target: ReturnType<typeof edits>, data: ReturnType<typeof edits>) => {
    for (const key of Object.keys(target) as Array<keyof ReturnType<typeof edits>>) if (key in data) target[key] += data[key];
  };
  for (const event of events) {
    types[event.eventType] = (types[event.eventType] ?? 0) + 1;
    const fileKey = `${event.context.projectId}:${event.context.fileId}`;
    const language = event.context.languageId ? (languages.get(event.context.languageId) ?? { ...edits(), activeMs: 0 }) : undefined;
    const project = event.context.projectId ? (projects.get(event.context.projectId) ?? { ...edits(), activeMs: 0 }) : undefined;
    if (event.eventType === "editor.edit") {
      const claim = attribution.get(event.eventId);
      const actor = claim?.actor ?? "unknown";
      add(totals, event.data); add(actors[actor], event.data);
      if (claim?.conflict) attributionConflicts++;
      if (actor === "ai") {
        const agent = agents.get(claim!.agent!) ?? edits(); add(agent, event.data); agents.set(claim!.agent!, agent);
        aiTouched.add(fileKey);
      } else if (aiTouched.has(fileKey)) laterEditorEditsInAiTouchedFiles += event.data.editCount;
      if (language) add(language, event.data);
      if (project) add(project, event.data);
      hours[new Date(event.occurredAt).getUTCHours()]!.edits += event.data.editCount;
    } else if (event.eventType === "activity.interval") {
      let from = Math.max(Date.parse(event.data.startedAt), Date.parse(query.from));
      const to = Math.min(Date.parse(event.occurredAt), Date.parse(query.to));
      activeMs += to - from;
      if (language) language.activeMs += to - from;
      if (project) project.activeMs += to - from;
      while (from < to) {
        const end = Math.min(to, (Math.floor(from / 3600_000) + 1) * 3600_000);
        hours[new Date(from).getUTCHours()]!.activeMs += end - from;
        from = end;
      }
    } else if (event.eventType === "file.saved") saves++;
    else if (event.eventType === "file.lifecycle") lifecycle[event.data.operation]++;
    else if (event.eventType === "context.switched") {
      const { from, to } = event.data;
      if (from.projectId && to.projectId && from.projectId !== to.projectId) projectSwitches++;
      if (from.languageId && to.languageId && from.languageId !== to.languageId) languageSwitches++;
      if (from.fileId && to.fileId && from.fileId !== to.fileId) fileSwitches++;
    } else if (event.eventType === "task.lifecycle") {
      if (event.data.state === "started" && !taskStarts.has(event.data.executionId)) {
        taskStarts.set(event.data.executionId, event);
        if (event.data.group === "build") builds++; else if (event.data.group === "test") tests++; else otherTasks++;
      }
      if (event.data.state === "process_ended" && event.data.exitCode !== undefined && event.data.exitCode !== 0) taskFailures++;
      if (event.data.state === "ended" && taskStarts.has(event.data.executionId)) {
        completedTasks++;
        taskDurationMs += Math.max(0, Date.parse(event.occurredAt) - Date.parse(taskStarts.get(event.data.executionId)!.occurredAt));
        taskStarts.delete(event.data.executionId);
      }
    } else if (event.eventType === "debug.lifecycle") {
      if (event.data.state === "started") { debugRuns++; debugStarts.set(event.data.executionId, event.occurredAt); }
      else if (debugStarts.has(event.data.executionId)) {
        debugDurationMs += Math.max(0, Date.parse(event.occurredAt) - Date.parse(debugStarts.get(event.data.executionId)!));
        debugStarts.delete(event.data.executionId);
      }
    } else if (event.eventType === "git.commit_observed") {
      const key = `${event.data.repositoryId}:${event.data.commitId}`;
      if (!commits.has(key)) { gitLinesAdded += event.data.linesAdded; gitLinesRemoved += event.data.linesRemoved; commits.add(key); }
    } else if (event.eventType === "git.head_changed" && event.data.previousBranchId !== event.data.branchId) branchChanges++;
    else if (event.eventType === "filesystem.changed" && event.data.origin === "unknown") filesystemUnknownNotifications += event.data.notifications;
    else if (event.eventType === "diagnostics.snapshot") diagnostics.set(fileKey, { context: event.context, ...event.data, observedAt: event.occurredAt });
    if (language) languages.set(event.context.languageId!, language);
    if (project) projects.set(event.context.projectId!, project);
  }
  const changed = totals.charactersAdded + totals.charactersRemoved;
  const actorChanged = (actor: keyof typeof actors) => actors[actor].charactersAdded + actors[actor].charactersRemoved;
  return {
    apiVersion: "2.0", range: query, observedEvents: events.length, byEventType: types, edits: totals, activeMs,
    sessionsObserved: new Set(events.flatMap((event) => event.context.sessionId ? [event.context.sessionId] : [])).size,
    limitations: { legacySessionsIncluded: false, authorshipVerified: false, exactHumanModificationMeasured: false, individualTestCasesMeasured: false, idleMs: null },
    saves, fileOperations: lifecycle, switches: { projects: projectSwitches, languages: languageSwitches, files: fileSwitches },
    attribution: { unit: "UTF-16 code units changed", evidence: "provider-reported, not verified authorship", actors,
      reportedAiShare: changed ? actorChanged("ai") / changed : null, reportedHumanShare: changed ? actorChanged("human") / changed : null,
      unknownShare: changed ? actorChanged("unknown") / changed : null, conflicts: attributionConflicts,
      agents: [...agents].map(([agent, counts]) => ({ agent, ...counts })),
      laterEditorEditsInAiTouchedFiles, exactHumanModifiedAiCharacters: null },
    workflows: { builds, tests, otherTasks, taskFailures, completedTasks, taskDurationMs, incompleteTasks: taskStarts.size, debugRuns, debugDurationMs },
    git: { commitsObserved: commits.size, linesAdded: gitLinesAdded, linesRemoved: gitLinesRemoved, branchChanges },
    filesystem: { unknownNotifications: filesystemUnknownNotifications },
    languages: [...languages].map(([languageId, value]) => ({ languageId, ...value })).sort((a, b) => b.activeMs - a.activeMs || b.editCount - a.editCount),
    projects: [...projects].map(([projectId, value]) => ({ projectId, ...value })).sort((a, b) => b.activeMs - a.activeMs || b.editCount - a.editCount),
    hourlyUtc: hours, latestDiagnostics: [...diagnostics.values()],
    coverage: events.filter((event) => event.eventType === "collector.coverage")
  };
}

export function compareTelemetry(events: readonly TelemetryEvent[], current: TelemetryRange, previous: TelemetryRange) {
  const now = queryTelemetry(events, current), before = queryTelemetry(events, previous);
  const delta = (a: number, b: number) => ({ absolute: a - b, relative: b ? (a - b) / b : null });
  return { current: now, previous: before, delta: { activeMs: delta(now.activeMs, before.activeMs),
    edits: delta(now.edits.editCount, before.edits.editCount), builds: delta(now.workflows.builds, before.workflows.builds), tests: delta(now.workflows.tests, before.workflows.tests) } };
}

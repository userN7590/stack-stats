import { z } from "zod";

const id = z.string().min(1).max(256);
export const privateIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative().safe();
const timestamp = z.string().datetime({ offset: true });
export const telemetryContextSchema = z.object({
  projectId: privateIdSchema.optional(), fileId: privateIdSchema.optional(),
  languageId: id.optional(), sessionId: z.string().uuid().optional()
}).strict();
const base = z.object({
  schemaVersion: z.literal("2.0"), eventId: z.string().uuid(), occurredAt: timestamp,
  source: z.object({ collector: z.enum(["vscode", "filesystem", "git", "adapter"]),
    instanceId: z.string().uuid(), installationId: id }).strict(),
  context: telemetryContextSchema,
  evidence: z.enum(["observed", "inferred", "reported"])
}).strict();
const variant = <T extends string, S extends z.ZodTypeAny>(eventType: T, data: S) => base.extend({ eventType: z.literal(eventType), data }).strict();
const state = z.object({ projectId: privateIdSchema.optional(), fileId: privateIdSchema.optional(), languageId: id.optional() }).strict();
export const telemetryEventSchema = z.discriminatedUnion("eventType", [
  variant("editor.edit", z.object({ startedAt: timestamp, firstVersion: count, lastVersion: count,
    editCount: count.refine((n) => n > 0), linesAdded: count, linesRemoved: count,
    charactersAdded: count, charactersRemoved: count, undoCount: count, redoCount: count }).strict()),
  variant("activity.interval", z.object({ startedAt: timestamp }).strict()),
  variant("session.lifecycle", z.object({ state: z.enum(["started", "ended"]),
    reason: z.enum(["idle", "shutdown", "paused", "clock_changed"]).optional() }).strict()),
  variant("file.saved", z.object({ reason: z.enum(["manual", "after_delay", "focus_out", "unknown"]), version: count }).strict()),
  variant("file.lifecycle", z.object({ operation: z.enum(["created", "deleted", "renamed"]), previousFileId: privateIdSchema.optional() }).strict()),
  variant("context.switched", z.object({ from: state, to: state }).strict()),
  variant("window.focus", z.object({ focused: z.boolean() }).strict()),
  variant("filesystem.changed", z.object({ operation: z.enum(["created", "changed", "deleted"]),
    notifications: count.refine((n) => n > 0), origin: z.enum(["editor_correlated", "unknown"]) }).strict()),
  variant("git.repository", z.object({ repositoryId: privateIdSchema, headId: privateIdSchema.nullable(), branchId: privateIdSchema.nullable() }).strict()),
  variant("git.head_changed", z.object({ repositoryId: privateIdSchema, headId: privateIdSchema.nullable(), branchId: privateIdSchema.nullable(),
    previousHeadId: privateIdSchema.nullable(), previousBranchId: privateIdSchema.nullable() }).strict()),
  variant("git.commit_observed", z.object({ repositoryId: privateIdSchema, commitId: privateIdSchema,
    committedAt: timestamp, parentCount: count, filesChanged: count, linesAdded: count, linesRemoved: count, binaryFiles: count }).strict()),
  variant("task.lifecycle", z.object({ executionId: z.string().uuid(), state: z.enum(["started", "process_ended", "ended"]),
    group: z.enum(["build", "test", "other"]), exitCode: z.number().int().optional() }).strict()),
  variant("debug.lifecycle", z.object({ executionId: z.string().uuid(), state: z.enum(["started", "ended"]), debugTypeId: privateIdSchema }).strict()),
  variant("diagnostics.snapshot", z.object({ errors: count, warnings: count, information: count, hints: count }).strict()),
  variant("attribution.report", z.object({ targetEventIds: z.array(z.string().uuid()).min(1).max(100),
    actor: z.enum(["human", "ai"]), agent: z.enum(["codex", "claude-code", "cursor", "other"]).optional(),
    providerId: privateIdSchema }).strict()),
  variant("collector.coverage", z.object({ capability: z.enum(["editor", "filesystem", "git", "workflows", "diagnostics", "attribution"]),
    state: z.enum(["enabled", "disabled", "gap"]), reason: z.enum(["startup", "settings", "buffer_limit", "io_error", "history_limit", "unavailable"]).optional(),
    droppedObservations: count.optional() }).strict())
]).superRefine((event, ctx) => {
  if (event.eventType === "editor.edit" || event.eventType === "activity.interval") {
    const span = Date.parse(event.occurredAt) - Date.parse(event.data.startedAt);
    if (span < 0 || (event.eventType === "activity.interval" && span > 60_000)) ctx.addIssue({ code: "custom", message: "Invalid observation interval" });
  }
  if (event.eventType === "editor.edit" && (event.data.firstVersion > event.data.lastVersion || event.data.undoCount + event.data.redoCount > event.data.editCount)) {
    ctx.addIssue({ code: "custom", message: "Invalid edit counters or versions" });
  }
  if (event.eventType === "attribution.report" && (event.evidence !== "reported" || (event.data.actor === "ai") !== Boolean(event.data.agent))) {
    ctx.addIssue({ code: "custom", message: "Attribution requires an explicit report and AI agent" });
  }
});

export type TelemetryEvent = z.infer<typeof telemetryEventSchema>;
export type TelemetryContext = z.infer<typeof telemetryContextSchema>;
export type TelemetryType = TelemetryEvent["eventType"];
export type TelemetryData<T extends TelemetryType> = Extract<TelemetryEvent, { eventType: T }>["data"];
export const telemetryTypes = ["editor.edit", "activity.interval", "session.lifecycle", "file.saved", "file.lifecycle", "context.switched", "window.focus",
  "filesystem.changed", "git.repository", "git.head_changed", "git.commit_observed", "task.lifecycle", "debug.lifecycle", "diagnostics.snapshot", "attribution.report", "collector.coverage"] as const satisfies readonly TelemetryType[];
export const telemetryBatchSchema = z.object({ storageVersion: z.literal(1), batchId: z.string().uuid(),
  events: z.array(telemetryEventSchema).min(1).max(1000) }).strict();
export type TelemetryBatch = z.infer<typeof telemetryBatchSchema>;

export const telemetryQuerySchema = z.object({
  from: timestamp, to: timestamp,
  projectId: privateIdSchema.optional(), languageId: id.optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  after: z.string().uuid().optional()
}).strict().refine((query) => Date.parse(query.to) > Date.parse(query.from) && Date.parse(query.to) - Date.parse(query.from) <= 366 * 86400_000,
  "Query range must be positive and at most 366 days");
export type TelemetryQuery = z.infer<typeof telemetryQuerySchema>;

import { z } from "zod";
export * from "./telemetry.js";

const identifier = z.string().min(1).max(256);

export const editorFileChangedEventSchema = z.object({
  schemaVersion: z.literal("1.0"),
  eventId: z.string().uuid(),
  eventType: z.literal("editor.file_changed"),
  occurredAt: z.string().datetime({ offset: true }),
  source: z.object({
    adapter: z.literal("vscode"),
    adapterVersion: identifier,
    editorName: identifier,
    editorVersion: z.string().max(64).optional(),
    installationId: identifier
  }).strict(),
  session: z.object({ sessionId: identifier }).strict(),
  project: z.object({
    projectId: identifier,
    displayName: z.string().min(1).max(256),
    rootKind: z.enum(["git", "workspace"])
  }).strict(),
  file: z.object({
    fileId: identifier,
    extension: z.string().max(32).optional(),
    languageId: identifier,
    category: z.enum(["source", "test", "documentation", "configuration", "other"])
  }).strict(),
  change: z.object({
    operation: z.enum(["created", "modified", "deleted", "renamed"]),
    linesAdded: z.number().int().nonnegative(),
    linesRemoved: z.number().int().nonnegative(),
    editCount: z.number().int().positive()
  }).strict()
}).strict();

export type EditorFileChangedEvent = z.infer<typeof editorFileChangedEventSchema>;

const counter = z.number().int().nonnegative().safe();
export const dateKeySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().startsWith(value);
}, "Invalid calendar date");

export const sessionContributionSchema = z.object({
  project: editorFileChangedEventSchema.shape.project,
  file: editorFileChangedEventSchema.shape.file,
  activeMs: counter,
  linesAdded: counter,
  linesRemoved: counter,
  editCount: counter
}).strict();

// Cumulative, revisioned snapshots replace previous revisions; they are never added
// together. No source text, paths, raw edits, or authentication material belong here.
export const sessionSnapshotSchema = z.object({
  schemaVersion: z.literal("1.0"),
  eventType: z.literal("editor.session_snapshot"),
  sessionId: z.string().uuid(),
  revision: counter.refine((value) => value > 0),
  source: editorFileChangedEventSchema.shape.source,
  startedAt: z.string().datetime({ offset: true }),
  endedAt: z.string().datetime({ offset: true }),
  timeZone: z.string().min(1).max(128).refine((value) => {
    try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
  }, "Invalid time zone"),
  endReason: z.enum(["idle", "shutdown", "paused", "clock_changed"]).optional(),
  days: z.array(z.object({
    date: dateKeySchema,
    contributions: z.array(sessionContributionSchema).min(1)
  }).strict()).min(1)
}).strict();

export const stackStatsEventSchema = z.discriminatedUnion("eventType", [
  editorFileChangedEventSchema, sessionSnapshotSchema
]).superRefine((event, context) => {
  if (event.eventType !== "editor.session_snapshot") return;
  const duration = Date.parse(event.endedAt) - Date.parse(event.startedAt);
  const activeMs = event.days.reduce((sum, day) => sum + day.contributions.reduce((n, row) => n + row.activeMs, 0), 0);
  if (duration < 0 || activeMs > duration) context.addIssue({ code: "custom", message: "Invalid session duration" });
  if (new Set(event.days.map((day) => day.date)).size !== event.days.length) {
    context.addIssue({ code: "custom", message: "Duplicate session day" });
  }
});

export type SessionContribution = z.infer<typeof sessionContributionSchema>;
export type SessionSnapshot = z.infer<typeof sessionSnapshotSchema>;
export type StackStatsEvent = z.infer<typeof stackStatsEventSchema>;

export * from "./sync.js";

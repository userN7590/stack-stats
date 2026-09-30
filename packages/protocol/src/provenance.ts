import { z } from "zod";
import { privateIdSchema } from "./telemetry.js";

/** Phase 9E provenance contracts. Every record here is LOCAL ONLY: it is never
 * part of telemetry-v2 daemon batches, hourly projections or profile sync.
 * Actor "human" is intentionally absent: nothing in these channels proves it. */
export const agentToolSchema = z.enum(["claude-code", "codex", "cursor", "other"]);
export type AgentTool = z.infer<typeof agentToolSchema>;
export const agentSignalSchema = z.enum(["session_started", "tool_started", "tool_finished", "turn_stopped", "session_ended", "interrupted"]);
export type AgentSignal = z.infer<typeof agentSignalSchema>;
const toolKind = z.enum(["shell", "edit", "other"]);
const endReason = z.enum(["completed", "interrupted", "error", "session_ended", "other"]);
const count = z.number().int().nonnegative().safe();
const timestamp = z.string().datetime({ offset: true });
const vendorHash = z.string().regex(/^[a-f0-9]{64}$/);
const MAX_DURATION_MS = 86_400_000;

/** Hook → extension handoff. Paths are transient: the extension resolves them to
 * salted workspace identities and deletes the record. No prompt, response,
 * command text, tool output or source content is representable. */
export const agentInboxRecordSchema = z.object({
  inboxVersion: z.literal(1),
  recordId: z.string().uuid(),
  tool: agentToolSchema,
  observedAt: timestamp,
  signal: agentSignalSchema,
  sessionHash: vendorHash,
  turnHash: vendorHash.optional(),
  callHash: vendorHash.optional(),
  cwd: z.string().min(1).max(4096),
  toolKind: toolKind.optional(),
  durationMs: count.max(MAX_DURATION_MS).optional(),
  vcs: z.boolean().optional(),
  success: z.boolean().optional(),
  endReason: endReason.optional(),
  files: z.array(z.object({
    path: z.string().min(1).max(4096),
    operation: z.enum(["created", "modified", "deleted", "unknown"]),
    linesAdded: count.optional(),
    linesRemoved: count.optional()
  }).strict()).max(200).optional()
}).strict().superRefine((record, ctx) => {
  if (record.files && (record.signal !== "tool_finished" || record.toolKind !== "edit" || record.success !== true)) {
    ctx.addIssue({ code: "custom", message: "Only successful edit tool completions may report files" });
  }
  if (record.files?.some((file) => (file.linesAdded === undefined) !== (file.linesRemoved === undefined))) {
    ctx.addIssue({ code: "custom", message: "Line counts must be reported together" });
  }
  if ((record.callHash || record.toolKind || record.durationMs !== undefined || record.vcs !== undefined) && record.signal !== "tool_started" && record.signal !== "tool_finished") {
    ctx.addIssue({ code: "custom", message: "Tool metadata requires a tool signal" });
  }
});
export type AgentInboxRecord = z.infer<typeof agentInboxRecordSchema>;
export const AGENT_INBOX_MAX_RECORD_BYTES = 256 * 1024;

/** Written by the extension, read by the hook. Missing/invalid state fails closed. */
export const agentIntegrationStateSchema = z.object({
  stateVersion: z.literal(1),
  collecting: z.boolean(),
  integrations: z.object({ "claude-code": z.boolean(), codex: z.boolean() }).strict(),
  excludeFiles: z.array(z.string().max(512)).max(256),
  updatedAt: timestamp
}).strict();
export type AgentIntegrationState = z.infer<typeof agentIntegrationStateSchema>;

const base = { recordId: z.string().uuid(), installationId: z.string().min(1).max(256) };
const agentKeys = z.object({ sessionKey: privateIdSchema, turnKey: privateIdSchema.optional(), callKey: privateIdSchema.optional() }).strict();
const lineDelta = z.object({ linesAdded: count, linesRemoved: count, source: z.enum(["adapter", "document_reload"]) }).strict();

export const provenanceChangeRecordSchema = z.object({
  kind: z.literal("change"), ...base,
  firstObservedAt: timestamp,
  observedAt: timestamp,
  projectId: privateIdSchema,
  fileId: privateIdSchema.optional(),
  languageId: z.string().min(1).max(256),
  operation: z.enum(["created", "modified", "deleted", "bulk"]),
  origin: z.enum(["external", "agent_adapter"]),
  actor: z.enum(["agent", "unknown"]),
  tool: agentToolSchema.optional(),
  confidence: z.enum(["explicit", "correlated", "none"]),
  reason: z.enum(["no_evidence", "vcs_operation", "bulk_change", "ambiguous_agents"]).optional(),
  agent: agentKeys.optional(),
  /** Diff lines (whole-line additions/removals), never editor line boundaries. */
  delta: lineDelta.nullable(),
  observations: z.object({ watcher: count, reload: count, adapter: count }).strict(),
  bulk: z.object({ files: count, created: count, modified: count, deleted: count }).strict().optional(),
  supersedes: z.array(z.string().uuid()).max(50).optional()
}).strict();

export const provenanceAgentRecordSchema = z.object({
  kind: z.literal("agent"), ...base,
  at: timestamp,
  tool: agentToolSchema,
  signal: agentSignalSchema,
  sessionKey: privateIdSchema,
  turnKey: privateIdSchema.optional(),
  callKey: privateIdSchema.optional(),
  projectId: privateIdSchema.optional(),
  toolKind: toolKind.optional(),
  durationMs: count.max(MAX_DURATION_MS).optional(),
  vcs: z.boolean().optional(),
  success: z.boolean().optional(),
  endReason: endReason.optional(),
  filesReported: count.optional()
}).strict();

/** A correlated SUBSET of editor.edit counters observed between will-save and
 * did-save (format/organize/fix on save). Never added to editor totals. */
export const provenanceSaveParticipantRecordSchema = z.object({
  kind: z.literal("save_participant"), ...base,
  at: timestamp,
  projectId: privateIdSchema,
  fileId: privateIdSchema,
  languageId: z.string().min(1).max(256),
  edits: count.refine((n) => n > 0),
  linesAdded: count,
  linesRemoved: count
}).strict();

export const provenanceCoverageRecordSchema = z.object({
  kind: z.literal("coverage"), ...base,
  at: timestamp,
  capability: z.enum(["external_changes", "agent_inbox"]),
  reason: z.enum(["buffer_limit", "inbox_expired", "inbox_invalid", "inbox_overflow", "io_error"]),
  dropped: count.refine((n) => n > 0)
}).strict();

export const provenanceRecordSchema = z.discriminatedUnion("kind", [
  provenanceChangeRecordSchema, provenanceAgentRecordSchema, provenanceSaveParticipantRecordSchema, provenanceCoverageRecordSchema
]).superRefine((record, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: "custom", message });
  if (record.kind !== "change") return;
  if (Date.parse(record.observedAt) < Date.parse(record.firstObservedAt)) issue("Change observation order is invalid");
  if (record.operation === "bulk") {
    if (record.fileId || !record.bulk || record.delta || record.actor !== "unknown") issue("Bulk changes are aggregate, unattributed and delta-free");
  } else if (!record.fileId || record.bulk) issue("File changes require one file identity");
  if (record.confidence === "explicit" && (record.origin !== "agent_adapter" || record.actor !== "agent" || !record.tool || !record.agent || record.reason)) issue("Explicit provenance requires an adapter report");
  if (record.confidence === "correlated" && (record.origin !== "external" || record.actor !== "agent" || !record.tool || !record.agent || record.reason)) issue("Correlated provenance requires an agent tool window");
  if (record.confidence === "none" && (record.actor !== "unknown" || record.tool || record.agent || !record.reason || record.origin !== "external")) issue("Unknown provenance cannot name an agent");
  if (record.delta?.source === "adapter" && record.confidence !== "explicit") issue("Adapter deltas require explicit provenance");
});
export type ProvenanceRecord = z.infer<typeof provenanceRecordSchema>;
export type ProvenanceChangeRecord = z.infer<typeof provenanceChangeRecordSchema>;
export type ProvenanceAgentRecord = z.infer<typeof provenanceAgentRecordSchema>;
export type ProvenanceSaveParticipantRecord = z.infer<typeof provenanceSaveParticipantRecordSchema>;

export const provenanceBatchSchema = z.object({
  storageVersion: z.literal(1),
  batchId: z.string().uuid(),
  records: z.array(provenanceRecordSchema).min(1).max(1000)
}).strict();
export type ProvenanceBatch = z.infer<typeof provenanceBatchSchema>;

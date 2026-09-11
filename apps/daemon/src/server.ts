import Fastify from "fastify";
import { stackStatsEventSchema, dateKeySchema } from "@stack-stats/protocol";
import { StackStatsDatabase } from "@stack-stats/storage";
import { telemetryBatchSchema, telemetryQuerySchema, telemetryTypes } from "@stack-stats/protocol";

export interface ServerOptions { databasePath: string; token: string; paused?: boolean; logger?: boolean; allowAttributionReports?: boolean }

export function createServer(options: ServerOptions) {
  const app = Fastify({ bodyLimit: 8 * 1024 * 1024, logger: options.logger ?? false });
  const database = new StackStatsDatabase(options.databasePath);
  let paused = options.paused ?? false;

  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/health") return;
    if (request.headers.authorization !== `Bearer ${options.token}`) {
      request.log.warn({ url: request.url }, "rejected unauthorized request");
      return reply.code(401).send({ error: "unauthorized" });
    }
  });

  app.get("/health", async () => ({ status: "ok", paused }));
  app.get("/v2/capabilities", async () => ({ apiVersion: "2.0", telemetrySchemaVersion: "2.0", eventTypes: telemetryTypes,
    limits: { batchEvents: 1000, queryDays: 366, pageEvents: 1000, aggregateEvents: 100000 },
    attributionReportsAllowed: options.allowAttributionReports ?? false,
    units: { characters: "UTF-16 code units", editorLines: "line boundaries", hourly: "UTC", durations: "milliseconds" },
    unavailable: ["verified_authorship", "exact_human_modified_ai_code", "individual_test_results", "true_idle_time", "activity_before_collection"] }));
  app.post("/v2/events", async (request, reply) => {
    if (paused) return reply.code(503).send({ error: "collection_paused" });
    const parsed = telemetryBatchSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_telemetry_batch" });
    if (!options.allowAttributionReports && parsed.data.events.some((event) => event.eventType === "attribution.report")) {
      return reply.code(403).send({ error: "attribution_reports_disabled" });
    }
    try {
      const inserted = database.insertTelemetry(parsed.data);
      return reply.code(201).send({ accepted: true, inserted, duplicates: parsed.data.events.length - inserted });
    } catch (error) {
      if (error instanceof Error && error.message === "Telemetry event ID conflict") return reply.code(409).send({ error: "event_id_conflict" });
      throw error;
    }
  });
  for (const route of ["events", "query", "compare"] as const) app.get(`/v2/${route}`, async (request, reply) => {
    const parsed = telemetryQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_query", expected: "from/to ISO timestamps, optional projectId, languageId, limit and after" });
    try {
      return route === "events" ? database.telemetry(parsed.data) : route === "query" ? database.queryTelemetry(parsed.data) : database.compareTelemetry(parsed.data);
    } catch (error) {
      // Do not echo arbitrary input or database paths in error responses/logs.
      return reply.code(422).send({ error: "query_unavailable", reason: error instanceof Error && error.message.startsWith("Query exceeds") ? "narrow_range" : "invalid_cursor_or_history" });
    }
  });
  app.post("/v1/events", async (request, reply) => {
    if (paused) {
      request.log.info("rejected event because collection is paused");
      return reply.code(503).send({ error: "collection_paused" });
    }
    const parsed = stackStatsEventSchema.safeParse(request.body);
    if (!parsed.success) {
      request.log.warn({ issues: parsed.error.issues }, "rejected invalid event");
      return reply.code(400).send({ error: "invalid_event", issues: parsed.error.issues });
    }
    const inserted = parsed.data.eventType === "editor.session_snapshot"
      ? database.upsertSession(parsed.data) : database.insert(parsed.data);
    request.log.info({
      eventType: parsed.data.eventType,
      duplicate: !inserted
    }, "stored activity metadata");
    return reply.code(inserted ? 201 : 200).send({ accepted: true, duplicate: !inserted });
  });
  app.post("/v1/pause", async () => { paused = true; return { paused }; });
  app.post("/v1/resume", async () => { paused = false; return { paused }; });
  app.get("/v1/summary", async (request) => {
    const query = request.query as { from?: string; to?: string };
    return database.summary(query.from, query.to);
  });
  app.get("/v1/stats", async (request, reply) => {
    const query = request.query as { period?: string; date?: string };
    const date = dateKeySchema.safeParse(query.date);
    if (!date.success || (query.period !== "today" && query.period !== "week")) {
      return reply.code(400).send({ error: "Expected period=today|week and date=YYYY-MM-DD" });
    }
    return query.period === "today" ? database.daily(date.data) : database.weekly(date.data);
  });
  app.addHook("onClose", async () => database.close());
  return app;
}

import { DatabaseSync } from "node:sqlite";
import { aggregateActivity, dailyStatistics, weeklyStatistics, weekStart, addDays, type ActivitySummary } from "@stack-stats/core";
import { editorFileChangedEventSchema, stackStatsEventSchema, type EditorFileChangedEvent, type SessionSnapshot } from "@stack-stats/protocol";
import { telemetryBatchSchema, telemetryEventSchema, type TelemetryBatch, type TelemetryEvent, type TelemetryQuery } from "@stack-stats/protocol";
import { queryTelemetry, compareTelemetry } from "@stack-stats/core";

export class StackStatsDatabase {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    try { this.migrate(); } catch (error) { this.db.close(); throw error; }
  }

  private migrate(): void {
    const version = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    if (version.user_version > 3) throw new Error("This database requires a newer Stack Stats version");
    this.db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        received_at TEXT NOT NULL,
        project_id TEXT NOT NULL,
        language_id TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_occurred_at ON events(occurred_at);
      CREATE INDEX IF NOT EXISTS idx_events_project_id ON events(project_id);
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_days (
        session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        date TEXT NOT NULL,
        PRIMARY KEY (session_id, date)
      );
      CREATE INDEX IF NOT EXISTS idx_session_days_date ON session_days(date);
      CREATE TABLE IF NOT EXISTS telemetry_events (
        event_id TEXT PRIMARY KEY, event_type TEXT NOT NULL, occurred_at TEXT NOT NULL,
        started_at TEXT, project_id TEXT, file_id TEXT, language_id TEXT, payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_telemetry_time ON telemetry_events(occurred_at, event_id);
      CREATE INDEX IF NOT EXISTS idx_telemetry_project_time ON telemetry_events(project_id, occurred_at);
      CREATE INDEX IF NOT EXISTS idx_telemetry_language_time ON telemetry_events(language_id, occurred_at);
      CREATE TABLE IF NOT EXISTS telemetry_claims (
        report_id TEXT NOT NULL REFERENCES telemetry_events(event_id) ON DELETE CASCADE,
        target_id TEXT NOT NULL, PRIMARY KEY(report_id, target_id)
      );
      CREATE INDEX IF NOT EXISTS idx_telemetry_claim_target ON telemetry_claims(target_id);
      PRAGMA user_version = 3;
      COMMIT;
    `);
  }

  insert(event: EditorFileChangedEvent): boolean {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO events
      (event_id, event_type, occurred_at, received_at, project_id, language_id, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.eventId,
      event.eventType,
      event.occurredAt,
      new Date().toISOString(),
      event.project.projectId,
      event.file.languageId,
      JSON.stringify(event)
    );
    return result.changes === 1;
  }

  list(from?: string, to?: string): EditorFileChangedEvent[] {
    let sql = "SELECT payload_json FROM events WHERE 1 = 1";
    const params: string[] = [];
    if (from) { sql += " AND occurred_at >= ?"; params.push(from); }
    if (to) { sql += " AND occurred_at < ?"; params.push(to); }
    sql += " ORDER BY occurred_at ASC";
    const rows = this.db.prepare(sql).all(...params) as Array<{ payload_json: string }>;
    return rows.map((row) => editorFileChangedEventSchema.parse(JSON.parse(row.payload_json)));
  }

  summary(from?: string, to?: string): ActivitySummary {
    return aggregateActivity(this.list(from, to));
  }

  upsertSession(input: SessionSnapshot): boolean {
    const session = stackStatsEventSchema.parse(input);
    if (session.eventType !== "editor.session_snapshot") throw new Error("Expected session snapshot");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db.prepare(`
        INSERT INTO sessions (session_id, revision, started_at, ended_at, payload_json) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET revision = excluded.revision,
          started_at = excluded.started_at, ended_at = excluded.ended_at, payload_json = excluded.payload_json
        WHERE excluded.revision > sessions.revision
      `).run(session.sessionId, session.revision, session.startedAt, session.endedAt, JSON.stringify(session));
      if (result.changes === 1) {
        this.db.prepare("DELETE FROM session_days WHERE session_id = ?").run(session.sessionId);
        const insert = this.db.prepare("INSERT INTO session_days (session_id, date) VALUES (?, ?)");
        for (const day of session.days) insert.run(session.sessionId, day.date);
      }
      this.db.exec("COMMIT");
      return result.changes === 1;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  sessions(from?: string, to?: string): SessionSnapshot[] {
    const rows = from && to
      ? this.db.prepare(`SELECT payload_json FROM sessions WHERE session_id IN
          (SELECT session_id FROM session_days WHERE date >= ? AND date < ?) ORDER BY started_at`).all(from, to)
      : this.db.prepare("SELECT payload_json FROM sessions ORDER BY started_at").all();
    return (rows as Array<{ payload_json: string }>).map((row) => {
      const value = stackStatsEventSchema.parse(JSON.parse(row.payload_json));
      if (value.eventType !== "editor.session_snapshot") throw new Error("Invalid stored session");
      return value;
    });
  }

  daily(date: string) { return dailyStatistics(this.sessions(date, addDays(date, 1)), date); }

  weekly(date: string) {
    const from = weekStart(date);
    const dates = this.db.prepare("SELECT DISTINCT date FROM session_days WHERE date <= ?").all(date) as Array<{ date: string }>;
    return weeklyStatistics(this.sessions(from, addDays(from, 7)), date, dates.map((row) => row.date));
  }

  close(): void { this.db.close(); }

  insertTelemetry(input: TelemetryBatch): number {
    const batch = telemetryBatchSchema.parse(input);
    const insert = this.db.prepare(`INSERT OR IGNORE INTO telemetry_events
      (event_id, event_type, occurred_at, started_at, project_id, file_id, language_id, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const claim = this.db.prepare("INSERT OR IGNORE INTO telemetry_claims (report_id, target_id) VALUES (?, ?)");
    this.db.exec("BEGIN IMMEDIATE");
    let count = 0;
    try {
      for (const event of batch.events) {
        // Normalize offsets for stable indexed comparisons. Keep original payload
        // timestamp for transport fidelity; queries use epoch comparisons in core.
        const result = insert.run(event.eventId, event.eventType, new Date(event.occurredAt).toISOString(),
          "startedAt" in event.data ? new Date(event.data.startedAt).toISOString() : null,
          event.context.projectId ?? null, event.context.fileId ?? null, event.context.languageId ?? null, JSON.stringify(event));
        count += Number(result.changes);
        if (!result.changes) {
          const existing = this.db.prepare("SELECT payload_json FROM telemetry_events WHERE event_id = ?").get(event.eventId) as { payload_json: string };
          if (existing.payload_json !== JSON.stringify(event)) throw new Error("Telemetry event ID conflict");
        }
        if (result.changes && event.eventType === "attribution.report") for (const target of event.data.targetEventIds) claim.run(event.eventId, target);
      }
      this.db.exec("COMMIT");
      return count;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  telemetry(query: TelemetryQuery, paginate = true): { events: TelemetryEvent[]; next: string | null } {
    const from = new Date(query.from).toISOString(), to = new Date(query.to).toISOString();
    let where = "occurred_at >= ? AND occurred_at < ? AND ((occurred_at >= ? AND occurred_at < ?) OR (event_type = 'activity.interval' AND started_at < ? AND occurred_at > ?))";
    const args: Array<string | number> = [from, new Date(Date.parse(to) + 60_001).toISOString(), from, to, to, from];
    if (query.projectId) { where += " AND project_id = ?"; args.push(query.projectId); }
    if (query.languageId) { where += " AND language_id = ?"; args.push(query.languageId); }
    if (query.after) {
      const cursor = this.db.prepare("SELECT occurred_at FROM telemetry_events WHERE event_id = ?").get(query.after) as { occurred_at: string } | undefined;
      if (!cursor) throw new Error("Unknown event cursor");
      where += " AND (occurred_at > ? OR (occurred_at = ? AND event_id > ?))";
      args.push(cursor.occurred_at, cursor.occurred_at, query.after);
    }
    // Queries are bounded; API callers must narrow the range if they exceed the
    // aggregation ceiling. Never return a silently truncated aggregate.
    const limit = paginate ? query.limit : 100_000;
    const rows = this.db.prepare(`SELECT payload_json FROM telemetry_events WHERE ${where} ORDER BY occurred_at, event_id LIMIT ?`).all(...args, limit + 1) as Array<{ payload_json: string }>;
    if (!paginate && rows.length > limit) throw new Error("Query exceeds 100000 events; narrow the range");
    const events = rows.slice(0, limit).map((row) => telemetryEventSchema.parse(JSON.parse(row.payload_json)));
    if (!paginate && events.length) {
      // Reports can arrive later than their edits, including outside the queried
      // date range. Resolve annotations through the indexed target relation.
      const reports = new Map<string, TelemetryEvent>();
      const select = this.db.prepare(`SELECT e.payload_json FROM telemetry_claims c JOIN telemetry_events e ON e.event_id = c.report_id WHERE c.target_id = ?`);
      for (const event of events) if (event.eventType === "editor.edit") {
        for (const row of select.all(event.eventId) as Array<{ payload_json: string }>) {
          const report = telemetryEventSchema.parse(JSON.parse(row.payload_json)); reports.set(report.eventId, report);
        }
      }
      events.push(...reports.values());
    }
    return { events, next: rows.length > limit ? events.at(-1)!.eventId : null };
  }

  queryTelemetry(query: TelemetryQuery) { return queryTelemetry(this.telemetry({ ...query, after: undefined }, false).events, query); }
  compareTelemetry(query: TelemetryQuery) {
    const duration = Date.parse(query.to) - Date.parse(query.from);
    const previous = { ...query, from: new Date(Date.parse(query.from) - duration).toISOString(), to: query.from, after: undefined };
    const events = [...this.telemetry({ ...query, after: undefined }, false).events, ...this.telemetry(previous, false).events];
    return compareTelemetry(events, query, previous);
  }
}

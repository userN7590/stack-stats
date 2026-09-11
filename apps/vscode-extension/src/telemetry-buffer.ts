import { randomUUID } from "node:crypto";
import type { ActivityContext } from "@stack-stats/core";
import type { TelemetryContext, TelemetryData, TelemetryEvent, TelemetryType } from "@stack-stats/protocol";
import type { DocumentChange } from "./collector.js";

export function eventContext(context?: ActivityContext, sessionId?: string): TelemetryContext {
  return { projectId: context?.project.projectId, fileId: context?.file.fileId, languageId: context?.file.languageId, sessionId };
}

export class TelemetryBuffer {
  private readonly events = new Map<string, TelemetryEvent>();
  private readonly editBuckets = new Map<string, Extract<TelemetryEvent, { eventType: "editor.edit" }>>();
  private readonly samples = new Map<string, string>();
  private dropped = 0;
  private readonly intervals = new Map<string, Extract<TelemetryEvent, { eventType: "activity.interval" }>>();
  readonly instanceId = randomUUID();
  constructor(private readonly installationId: string, private readonly limit = 2000) {}

  emit<T extends TelemetryType>(eventType: T, data: TelemetryData<T>, context: TelemetryContext = {}, at = Date.now(),
    collector: TelemetryEvent["source"]["collector"] = "vscode", evidence: TelemetryEvent["evidence"] = "observed"): string | undefined {
    if (this.events.size >= this.limit) { this.dropped++; return; }
    const event = { schemaVersion: "2.0", eventId: randomUUID(), occurredAt: new Date(at).toISOString(),
      source: { collector, instanceId: this.instanceId, installationId: this.installationId }, eventType, data, context, evidence } as TelemetryEvent;
    this.events.set(event.eventId, event);
    return event.eventId;
  }

  edit(change: DocumentChange, sessionId?: string): void {
    const context = eventContext(change.context, sessionId);
    const key = JSON.stringify([Math.floor(change.at / 15_000), context]);
    let bucket = this.editBuckets.get(key);
    if (bucket && change.version < bucket.data.lastVersion) bucket = undefined;
    const counts = { ...change.counts, ...(change.characters ?? { charactersAdded: 0, charactersRemoved: 0 }),
      undoCount: change.reason === "undo" ? change.counts.editCount : 0, redoCount: change.reason === "redo" ? change.counts.editCount : 0 };
    if (bucket) {
      for (const name of Object.keys(counts) as Array<keyof typeof counts>) bucket.data[name] += counts[name];
      bucket.data.lastVersion = change.version;
      bucket.occurredAt = new Date(change.at).toISOString();
    } else {
      const id = this.emit("editor.edit", { ...counts, startedAt: new Date(change.at).toISOString(), firstVersion: change.version, lastVersion: change.version }, context, change.at);
      if (id) this.editBuckets.set(key, this.events.get(id) as Extract<TelemetryEvent, { eventType: "editor.edit" }>);
    }
  }

  interval(context: ActivityContext, from: number, to: number, sessionId: string): void {
    const identity = eventContext(context, sessionId);
    const key = JSON.stringify([Math.floor(to / 15_000), identity]);
    const previous = this.intervals.get(key);
    if (previous && Date.parse(previous.occurredAt) === from && to - Date.parse(previous.data.startedAt) <= 60_000) {
      previous.occurredAt = new Date(to).toISOString();
      return;
    }
    const id = this.emit("activity.interval", { startedAt: new Date(from).toISOString() }, identity, to, "vscode", "inferred");
    if (id) this.intervals.set(key, this.events.get(id) as Extract<TelemetryEvent, { eventType: "activity.interval" }>);
  }

  sample<T extends "diagnostics.snapshot" | "filesystem.changed">(type: T, data: TelemetryData<T>, context: TelemetryContext,
    collector: TelemetryEvent["source"]["collector"] = "vscode", evidence: TelemetryEvent["evidence"] = "observed", at = Date.now()): void {
    const key = JSON.stringify([type, context, type === "filesystem.changed" ? (data as TelemetryData<"filesystem.changed">).operation : ""]);
    const previousId = this.samples.get(key);
    const previous = previousId ? this.events.get(previousId) : undefined;
    if (previous) {
      if (previous.eventType === "filesystem.changed") (data as TelemetryData<"filesystem.changed">).notifications += previous.data.notifications;
      this.events.delete(previous.eventId);
    }
    const id = this.emit(type, data, context, at, collector, evidence);
    if (id) this.samples.set(key, id);
  }

  /** Seal a bounded immutable batch. Caller retains it until durable write succeeds. */
  drain(): TelemetryEvent[] {
    const values = [...this.events.values()];
    this.events.clear(); this.editBuckets.clear(); this.samples.clear(); this.intervals.clear();
    if (this.dropped) {
      this.emit("collector.coverage", { capability: "editor", state: "gap", reason: "buffer_limit", droppedObservations: this.dropped });
      this.dropped = 0;
    }
    return values;
  }
  get size(): number { return this.events.size; }
}

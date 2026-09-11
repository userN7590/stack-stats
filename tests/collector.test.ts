import { describe, expect, it } from "vitest";
import { DocumentCollector, type DocumentChange } from "../apps/vscode-extension/src/collector.js";
import { aggregateSessions } from "@stack-stats/core";
import { context, counts, tracker } from "./fixtures.js";

const at = Date.parse("2026-09-01T12:00:00Z");
const event = (patch: Partial<DocumentChange> = {}): DocumentChange => ({
  documentId: "file:1", version: 2, at, dirty: false, focused: true, visible: true,
  undoRedo: false, context: context(), counts, ...patch
});
const noEdit = { linesAdded: 0, linesRemoved: 0, editCount: 0 };

describe("VS Code document event sequencing", () => {
  it("records a visible untitled edit even without a subsequent dirty-state notification", () => {
    const value = tracker();
    new DocumentCollector(value).change(event({ untitled: true }));
    expect(value.snapshot()?.days[0]?.contributions[0]?.editCount).toBe(1);
  });
  it("records the first edit when the dirty-state notification follows its content event", () => {
    const value = tracker();
    const collector = new DocumentCollector(value);
    collector.change(event());
    expect(value.snapshot()).toBeUndefined();
    collector.change(event({ dirty: true, counts: noEdit, at: at + 1 }));
    collector.change(event({ dirty: true, version: 3, at: at + 10_000 }));
    collector.change(event({ dirty: false, counts: noEdit, at: at + 11_000 }));
    expect(aggregateSessions(value.pending(), "2026-09-01", "2026-09-02")).toMatchObject({ activeMs: 10_000, editCount: 2, linesAdded: 4 });
  });

  it("does not replay a clean disk reload into a later edit, different version or late dirty event", () => {
    for (const confirmation of [event({ version: 3, dirty: true, counts: noEdit }), event({ at: at + 1001, dirty: true, counts: noEdit })]) {
      const value = tracker();
      const collector = new DocumentCollector(value);
      collector.change(event());
      collector.change(confirmation);
      expect(value.snapshot()).toBeUndefined();
    }
    const value = tracker();
    const collector = new DocumentCollector(value);
    collector.change(event());
    collector.change(event({ version: 3, at: at + 10_000 }));
    collector.change(event({ version: 3, at: at + 10_001, dirty: true, counts: noEdit }));
    expect(value.snapshot()?.days[0]?.contributions[0]?.editCount).toBe(1);
  });

  it("ignores invisible/unfocused edits, retains clean-state undo, and clears closed/paused pending changes", () => {
    const value = tracker();
    const collector = new DocumentCollector(value);
    collector.change(event({ visible: false, dirty: true }));
    collector.change(event({ focused: false, dirty: true }));
    expect(value.snapshot()).toBeUndefined();
    collector.change(event());
    collector.close("file:1");
    collector.change(event({ dirty: true, counts: noEdit }));
    expect(value.snapshot()).toBeUndefined();
    collector.change(event());
    collector.clear();
    collector.change(event({ dirty: true, counts: noEdit }));
    expect(value.snapshot()).toBeUndefined();
    collector.change(event({ undoRedo: true }));
    expect(value.snapshot()?.days[0]?.contributions[0]?.editCount).toBe(1);
  });
});

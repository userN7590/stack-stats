import type { ActivityContext, EditCounts, SessionTracker } from "@stack-stats/core";

export interface DocumentChange {
  documentId: string;
  version: number;
  at: number;
  dirty: boolean;
  focused: boolean;
  visible: boolean;
  undoRedo: boolean;
  untitled?: boolean;
  context: ActivityContext;
  counts: EditCounts;
  characters?: { charactersAdded: number; charactersRemoved: number };
  reason?: "undo" | "redo";
}

/** VS Code can deliver content changes BEFORE its dirty-state notification. Hold
 * only metadata/counters for a clean change, then confirm the same document version
 * became dirty. Disk reloads stay clean; opening a file is not evidence of editing.
 */
export class DocumentCollector {
  private readonly unconfirmed = new Map<string, DocumentChange>();
  constructor(private readonly tracker: SessionTracker, private readonly observed?: (event: DocumentChange) => void) {}

  private record(event: DocumentChange): void {
    this.tracker.edit(event.context, event.counts, event.at);
    this.observed?.(event);
  }

  change(event: DocumentChange): void {
    const previous = this.unconfirmed.get(event.documentId);
    this.unconfirmed.delete(event.documentId);
    if (event.counts.editCount === 0) {
      if (event.dirty && previous?.version === event.version && event.at - previous.at <= 1000) {
        this.record(previous);
      }
      return;
    }
    if (!event.focused || !event.visible) return;
    // Untitled documents have no disk reloads and do not consistently emit a
    // matching dirty-state notification after their first content change.
    if (!event.dirty && !event.undoRedo && !event.untitled) { this.unconfirmed.set(event.documentId, event); return; }
    this.record(event);
  }

  close(documentId: string): void { this.unconfirmed.delete(documentId); }
  clear(): void { this.unconfirmed.clear(); }
}

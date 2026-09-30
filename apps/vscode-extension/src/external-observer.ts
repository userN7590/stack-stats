import * as vscode from "vscode";
import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { sep } from "node:path";
import { ChangeReconciler, countReloadDiffLines, isBinaryPath, isTransientArtifact, languageFromPath, summarizeAgentActivity, toChangeRecord,
  type AgentActivitySummary, type FileRef, type PrivacyPolicy, type ReconcileStats } from "@stack-stats/core";
import type { AgentInboxRecord, AgentTool, ProvenanceAgentRecord, ProvenanceRecord, TelemetryEvent } from "@stack-stats/protocol";
import type { DocumentMetadata } from "./metadata.js";
import type { DocumentChange } from "./collector.js";
import type { AgentInbox, DrainResult } from "./agent-inbox.js";
import type { ProvenanceLedger } from "./provenance-ledger.js";

/** Working-tree-replacing Git operations update these refs. Their notifications are
 * used only as a transient "VCS operation happened" signal and are never recorded. */
const VCS_PATH = /[\\/]\.git[\\/](?:HEAD|ORIG_HEAD|MERGE_HEAD|REBASE_HEAD|CHERRY_PICK_HEAD|logs[\\/]HEAD|rebase-merge[\\/].*|rebase-apply[\\/].*)$/;
const RELOAD_CONFIRM_MS = 1_000;
const RELOAD_PROMOTE_MS = 1_200;
const SAVE_PARTICIPANT_MAX_MS = 30_000;

/** Deterministic UUID-shaped ID so re-ingesting an inbox record after a crash
 * yields identical ledger record IDs (deduplicated by readers). */
export function derivedId(seed: string): string {
  const h = createHash("sha256").update(seed).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${(8 + (parseInt(h[16]!, 16) & 3)).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export interface ObserverStatus {
  pendingObservations: number; reloadCandidates: number; ledgerQueued: number;
  ignored: { excluded: number; binary: number; transient: number };
  lastInbox?: DrainResult & { at: number };
  reconciled: Omit<ReconcileStats, "pending"> & { changes: number; agentSignals: number };
}
export interface ObserverOptions {
  installationId: string;
  metadata: DocumentMetadata;
  /** Salted hash shared with session/telemetry identities. */
  hash: (value: string) => string;
  policy: () => PrivacyPolicy;
  ledger: ProvenanceLedger;
  inbox?: AgentInbox;
  /** Tracking enabled and not shutting down. */
  collecting: () => boolean;
  /** stackStats.collectFilesystem. */
  filesystem: () => boolean;
  integrations: () => ReadonlySet<AgentTool>;
  telemetry: () => Promise<TelemetryEvent[]>;
  log: (message: string) => void;
  now?: () => number;
}

/** Normalization boundary between VS Code/hook inputs and the pure reconciler.
 * External observations never reach SessionTracker: they cannot start, extend or
 * credit a human coding session. */
export class ExternalChangeObserver implements vscode.Disposable {
  private readonly reconciler = new ChangeReconciler({ createId: randomUUID });
  private readonly reloads = new Map<string, { version: number; at: number; file: FileRef; linesAdded: number; linesRemoved: number }>();
  private readonly saving = new Map<string, number>();
  private readonly participants = new Map<string, { at: number; projectId: string; fileId: string; languageId: string; edits: number; linesAdded: number; linesRemoved: number }>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly realFolders = new Map<string, string>();
  private readonly ignored = { excluded: 0, binary: 0, transient: 0 };
  private readonly reconciled: ObserverStatus["reconciled"] = { duplicateNotificationsMerged: 0, watcherAbsorbed: 0, reloadAbsorbed: 0, editorWritesSuppressed: 0,
    ephemeralDropped: 0, uncorroboratedReloads: 0, droppedObservations: 0, changes: 0, agentSignals: 0 };
  private lastInbox?: DrainResult & { at: number };
  private flushing: Promise<void> = Promise.resolve();
  private readonly now: () => number;

  constructor(private readonly o: ObserverOptions) {
    this.now = o.now ?? Date.now;
    const on = (disposable: vscode.Disposable) => this.disposables.push(disposable);
    on(vscode.workspace.onWillSaveTextDocument((event) => { this.saving.set(event.document.uri.toString(), this.now()); }));
    on(vscode.workspace.onDidSaveTextDocument((document) => { this.saving.delete(document.uri.toString()); this.editorWrite(document.uri, document.languageId); }));
    on(vscode.workspace.onDidCreateFiles((event) => { for (const uri of event.files) this.editorWrite(uri); }));
    on(vscode.workspace.onDidDeleteFiles((event) => { for (const uri of event.files) this.editorWrite(uri); }));
    on(vscode.workspace.onDidRenameFiles((event) => { for (const file of event.files) { this.editorWrite(file.oldUri); this.editorWrite(file.newUri); } }));
    on(vscode.workspace.onDidChangeWorkspaceFolders(() => this.realFolders.clear()));
  }

  private active(): boolean { return this.o.collecting() && this.o.filesystem(); }

  private fileRef(uri: vscode.Uri, folder: vscode.WorkspaceFolder, languageId = languageFromPath(uri.fsPath)): FileRef | undefined {
    const context = this.o.metadata.fromUri(uri, languageId);
    if (!context) return undefined;
    return { key: uri.toString(), workspaceKey: folder.uri.toString(), projectId: context.project.projectId, fileId: context.file.fileId, languageId: context.file.languageId };
  }

  private editorWrite(uri: vscode.Uri, languageId?: string): void {
    if (!this.active() || uri.scheme !== "file") return;
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    const file = folder && this.fileRef(uri, folder, languageId);
    if (file) this.reconciler.observe({ kind: "editor_write", file, at: this.now() });
  }

  /** Fed by the existing single workspace watcher (no second recursive watcher). */
  watcher(uri: vscode.Uri, operation: "created" | "changed" | "deleted"): void {
    if (!this.active() || uri.scheme !== "file") return;
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) return;
    const at = this.now();
    if (VCS_PATH.test(uri.fsPath)) { this.reconciler.observe({ kind: "vcs", workspaceKey: folder.uri.toString(), at }); return; }
    if (isTransientArtifact(uri.fsPath)) { this.ignored.transient++; return; }
    if (isBinaryPath(uri.fsPath)) { this.ignored.binary++; return; }
    const file = this.fileRef(uri, folder);
    if (!file) { this.ignored.excluded++; return; }
    this.reconciler.observe({ kind: "watcher", file, operation, at });
  }

  /** A clean content change on an open file document is a disk reload unless the
   * matching dirty-state notification follows within a second (the collector's
   * first-edit rule). VS Code computes whole-line reload edits, which give exact
   * diff lines without retaining text. Revert has the same shape but no disk
   * notification; the reconciler drops reloads without watcher corroboration. */
  documentChanged(event: vscode.TextDocumentChangeEvent): void {
    const { document } = event;
    if (!this.active() || document.uri.scheme !== "file" || event.reason !== undefined) return;
    const key = document.uri.toString(), at = this.now(), candidate = this.reloads.get(key);
    if (!event.contentChanges.length) {
      if (candidate && document.isDirty && candidate.version === document.version && at - candidate.at <= RELOAD_CONFIRM_MS) this.reloads.delete(key);
      return;
    }
    if (document.isDirty) return;
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    const file = folder && this.fileRef(document.uri, folder, document.languageId);
    if (!file) return;
    if (candidate) this.promote(key);
    this.reloads.set(key, { version: document.version, at, file, ...countReloadDiffLines(event.contentChanges) });
  }

  private promote(key: string): void {
    const candidate = this.reloads.get(key);
    if (!candidate) return;
    this.reloads.delete(key);
    this.reconciler.observe({ kind: "reload", file: candidate.file, at: candidate.at, linesAdded: candidate.linesAdded, linesRemoved: candidate.linesRemoved });
  }

  /** Recorded editor edits (already counted by sessions) that happened between
   * will-save and did-save: a correlated subset for format/organize/fix on save. */
  editorEdit(change: DocumentChange): void {
    const started = this.saving.get(change.documentId);
    if (started === undefined || change.at - started > SAVE_PARTICIPANT_MAX_MS || change.at < started) return;
    const key = `${change.context.project.projectId}:${change.context.file.fileId}`;
    const entry = this.participants.get(key) ?? { at: change.at, projectId: change.context.project.projectId, fileId: change.context.file.fileId,
      languageId: change.context.file.languageId, edits: 0, linesAdded: 0, linesRemoved: 0 };
    entry.at = change.at; entry.edits += change.counts.editCount; entry.linesAdded += change.counts.linesAdded; entry.linesRemoved += change.counts.linesRemoved;
    this.participants.set(key, entry);
  }

  private async realFolder(folder: vscode.WorkspaceFolder): Promise<string> {
    let value = this.realFolders.get(folder.uri.fsPath);
    if (!value) { value = await realpath(folder.uri.fsPath).catch(() => folder.uri.fsPath); this.realFolders.set(folder.uri.fsPath, value); }
    return value;
  }

  /** Map a hook-reported absolute path into this window's workspaces, tolerating
   * symlinked roots (macOS /tmp → /private/tmp). Paths stay in memory only. */
  private async locate(path: string): Promise<{ uri: vscode.Uri; folder: vscode.WorkspaceFolder } | undefined> {
    const candidates = [path];
    const real = await realpath(path).catch(() => undefined);
    if (real && real !== path) candidates.push(real);
    for (const candidate of candidates) {
      const uri = vscode.Uri.file(candidate);
      const folder = vscode.workspace.getWorkspaceFolder(uri);
      if (folder) return { uri, folder };
      for (const workspace of vscode.workspace.workspaceFolders ?? []) {
        const root = await this.realFolder(workspace);
        if (candidate === root || candidate.startsWith(root + sep)) return { uri: vscode.Uri.file(workspace.uri.fsPath + candidate.slice(root.length)), folder: workspace };
      }
    }
    return undefined;
  }

  private async ingest(records: AgentInboxRecord[]): Promise<Set<string>> {
    const claimed = new Set<string>(), output: ProvenanceRecord[] = [];
    for (const record of [...records].sort((a, b) => a.observedAt.localeCompare(b.observedAt) || a.recordId.localeCompare(b.recordId))) {
      const cwd = await this.locate(record.cwd);
      const files: Array<{ file: FileRef; report: NonNullable<AgentInboxRecord["files"]>[number]; index: number }> = [];
      let fileFolder: vscode.WorkspaceFolder | undefined;
      for (const [index, report] of (record.files ?? []).entries()) {
        const target = await this.locate(report.path);
        if (!target) continue;
        fileFolder ??= target.folder;
        if (isBinaryPath(target.uri.fsPath) || isTransientArtifact(target.uri.fsPath)) continue;
        const file = this.fileRef(target.uri, target.folder);
        if (file) files.push({ file, report, index });
      }
      const folder = cwd?.folder ?? fileFolder;
      if (!folder) continue; // Another window (or a later session) may own it.
      claimed.add(record.recordId);
      if (!this.o.policy().allowsProject(folder.uri.fsPath)) continue; // Excluded project: consumed, never recorded.
      const at = Date.parse(record.observedAt), key = (kind: string, value?: string) => value ? this.o.hash(`agent-${kind}:${value}`) : undefined;
      const keys = { sessionKey: key("session", record.sessionHash)!, turnKey: key("turn", record.turnHash), callKey: key("call", record.callHash) };
      const signal: ProvenanceAgentRecord = { kind: "agent", recordId: record.recordId, installationId: this.o.installationId, at: record.observedAt, tool: record.tool,
        signal: record.signal, sessionKey: keys.sessionKey, projectId: this.o.hash(folder.uri.fsPath) };
      for (const [name, value] of Object.entries({ turnKey: keys.turnKey, callKey: keys.callKey, toolKind: record.toolKind, durationMs: record.durationMs, vcs: record.vcs,
        success: record.success, endReason: record.endReason, filesReported: record.files?.length })) if (value !== undefined) Object.assign(signal, { [name]: value });
      output.push(signal);
      const workspaceKey = folder.uri.toString();
      if (keys.callKey && record.toolKind === "shell") {
        const window = { ...keys, callKey: keys.callKey, tool: record.tool, workspaceKey, at, durationMs: record.durationMs, vcs: record.vcs };
        if (record.signal === "tool_started") this.reconciler.toolStarted(window);
        if (record.signal === "tool_finished") this.reconciler.toolFinished(window);
      }
      if (record.signal === "turn_stopped" || record.signal === "interrupted" || record.signal === "session_ended") this.reconciler.turnStopped(record.tool, keys.sessionKey, at);
      for (const { file, report, index } of files) {
        const change = this.reconciler.agentChange({ id: derivedId(`${record.recordId}:${index}`), tool: record.tool, ...keys, at, file, operation: report.operation,
          delta: report.linesAdded !== undefined && report.linesRemoved !== undefined ? { linesAdded: report.linesAdded, linesRemoved: report.linesRemoved } : null });
        output.push(toChangeRecord(change, this.o.installationId));
      }
    }
    // Durable before the inbox files are deleted; a failure leaves them for retry.
    if (output.length) await this.o.ledger.append(output);
    this.reconciled.agentSignals += output.filter((record) => record.kind === "agent").length;
    this.reconciled.changes += output.filter((record) => record.kind === "change").length;
    return claimed;
  }

  /** Called on the shared 15-second timer; `force` on shutdown and inspection. */
  flush(force = false): Promise<void> {
    const work = this.flushing.catch(() => undefined).then(() => this.run(force));
    this.flushing = work;
    return work;
  }

  private async run(force: boolean): Promise<void> {
    const now = this.now(), records: ProvenanceRecord[] = [];
    const coverage = (capability: "external_changes" | "agent_inbox", reason: "buffer_limit" | "inbox_expired" | "inbox_invalid" | "inbox_overflow" | "io_error", dropped: number) => {
      if (dropped > 0) records.push({ kind: "coverage", recordId: randomUUID(), installationId: this.o.installationId, at: new Date(now).toISOString(), capability, reason, dropped });
    };
    for (const [key, candidate] of [...this.reloads]) if (now - candidate.at >= RELOAD_PROMOTE_MS) this.promote(key);
    if (this.o.collecting() && this.o.inbox) {
      const integrations = this.o.integrations();
      if (integrations.size || await this.o.inbox.exists()) {
        try {
          const result = await this.o.inbox.drain((items) => this.ingest(items), integrations);
          this.lastInbox = { ...result, at: now };
          coverage("agent_inbox", "inbox_invalid", result.invalid);
          coverage("agent_inbox", "inbox_expired", result.expired);
          coverage("agent_inbox", "inbox_overflow", result.overflowDropped);
          if (result.claimed) this.o.log(`Agent inbox: ingested ${result.claimed} hook signal(s); ${result.unclaimed} belong to workspaces not open in this window.`);
        } catch { this.o.log("Agent inbox could not be read; hook signals remain queued for retry."); }
      }
    }
    const { changes, stats } = this.reconciler.reconcile(now, force);
    for (const [name, value] of Object.entries(stats)) if (name !== "pending") (this.reconciled as unknown as Record<string, number>)[name]! += value;
    this.reconciled.changes += changes.length;
    records.push(...changes.map((change) => toChangeRecord(change, this.o.installationId)));
    for (const entry of this.participants.values()) {
      records.push({ kind: "save_participant", recordId: randomUUID(), installationId: this.o.installationId, at: new Date(entry.at).toISOString(),
        projectId: entry.projectId, fileId: entry.fileId, languageId: entry.languageId, edits: entry.edits, linesAdded: entry.linesAdded, linesRemoved: entry.linesRemoved });
    }
    this.participants.clear();
    for (const [key, at] of this.saving) if (now - at > SAVE_PARTICIPANT_MAX_MS) this.saving.delete(key);
    coverage("external_changes", "buffer_limit", stats.droppedObservations);
    if (records.length) {
      try { await this.o.ledger.append(records); }
      catch { this.o.log("Could not save provenance records; they remain queued in memory for the next checkpoint."); }
    }
    if (changes.length) {
      const by = (predicate: (change: typeof changes[number]) => boolean) => changes.filter(predicate).length;
      // Pseudonymous prefixes only: no names, paths or content.
      const sample = changes.slice(0, 5).map((change) => `${change.fileId ? `file ${change.fileId.slice(0, 8)}` : `${change.bulk?.files ?? 0} files`}: ${change.confidence === "none" ? `unknown (${change.reason})` : `${change.tool} ${change.confidence}`}`);
      this.o.log(`Provenance: ${by((c) => c.confidence === "explicit")} agent-reported, ${by((c) => c.confidence === "correlated")} agent-correlated, ${by((c) => c.confidence === "none")} unattributed change record(s); `
        + `${stats.duplicateNotificationsMerged + stats.watcherAbsorbed + stats.reloadAbsorbed} duplicate observation(s) merged. ${sample.join("; ")}${changes.length > 5 ? `; …${changes.length - 5} more` : ""}`);
    }
  }

  async records(): Promise<ProvenanceRecord[]> { return this.o.ledger.list(); }

  async summary(range: { from: string; to: string }): Promise<AgentActivitySummary> {
    const [records, telemetry] = await Promise.all([this.o.ledger.list(), this.o.telemetry()]);
    return summarizeAgentActivity({ records, telemetry, range, now: this.now() });
  }

  status(): ObserverStatus {
    return { pendingObservations: this.reconciler.pendingCount, reloadCandidates: this.reloads.size, ledgerQueued: this.o.ledger.queued,
      ignored: { ...this.ignored }, ...(this.lastInbox ? { lastInbox: { ...this.lastInbox } } : {}), reconciled: { ...this.reconciled } };
  }

  reset(): void { this.reloads.clear(); this.saving.clear(); this.participants.clear(); this.realFolders.clear(); }
  dispose(): void { this.reset(); for (const disposable of this.disposables) disposable.dispose(); }
}

import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import type { PrivacyPolicy } from "@stack-stats/core";
import type { TelemetryContext, TelemetryData } from "@stack-stats/protocol";
import type { DocumentMetadata } from "./metadata.js";
import { eventContext, type TelemetryBuffer } from "./telemetry-buffer.js";

export class WorkflowCollectors {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly taskRuns = new Map<vscode.TaskExecution, { id: string; group: "test" | "build" | "other"; context: TelemetryContext }>();
  private readonly debugRuns = new Map<string, { id: string; type: string; context: TelemetryContext }>();
  private readonly saves = new Map<string, TelemetryData<"file.saved">["reason"]>();
  private readonly writes = new Map<string, number>();
  private readonly fsPending = new Map<string, { uri: vscode.Uri; operation: "created" | "changed" | "deleted"; count: number; at: number }>();
  private readonly diagnostics = new Map<string, vscode.Uri>();
  private previous?: TelemetryContext;
  private overflow = 0;

  constructor(private readonly buffer: TelemetryBuffer, private readonly metadata: DocumentMetadata,
    private readonly hash: (value: string) => string, private readonly policy: () => PrivacyPolicy,
    private readonly enabled: () => boolean) {
    const on = (disposable: vscode.Disposable) => this.disposables.push(disposable);
    on(vscode.workspace.onWillSaveTextDocument((event) => this.saves.set(event.document.uri.toString(),
      event.reason === vscode.TextDocumentSaveReason.Manual ? "manual" : event.reason === vscode.TextDocumentSaveReason.AfterDelay ? "after_delay" : "focus_out")));
    on(vscode.workspace.onDidSaveTextDocument((document) => {
      const key = document.uri.toString(), context = this.context(document.uri, document.languageId);
      if (context) { this.buffer.emit("file.saved", { reason: this.saves.get(key) ?? "unknown", version: document.version }, context); this.writes.set(key, Date.now()); }
      this.saves.delete(key);
    }));
    on(vscode.workspace.onDidCloseTextDocument((document) => this.saves.delete(document.uri.toString())));
    on(vscode.workspace.onDidCreateFiles((event) => { for (const uri of event.files) this.lifecycle(uri, "created"); }));
    on(vscode.workspace.onDidDeleteFiles((event) => { for (const uri of event.files) this.lifecycle(uri, "deleted"); }));
    on(vscode.workspace.onDidRenameFiles((event) => {
      for (const file of event.files) {
        const before = this.context(file.oldUri), after = this.context(file.newUri);
        // A rename crossing an exclusion boundary must not expose the excluded ID.
        if (before && after) this.buffer.emit("file.lifecycle", { operation: "renamed", previousFileId: before.fileId }, after);
        if (before) this.writes.set(file.oldUri.toString(), Date.now());
        if (after) this.writes.set(file.newUri.toString(), Date.now());
      }
      this.metadata.clear();
    }));
    on(vscode.window.onDidChangeActiveTextEditor((editor) => this.switch(editor?.document)));
    on(vscode.workspace.onDidOpenTextDocument((document) => {
      if (vscode.window.activeTextEditor?.document === document) this.switch(document);
    }));
    on(vscode.window.onDidChangeWindowState((state) => {
      const context = vscode.window.activeTextEditor ? this.context(vscode.window.activeTextEditor.document.uri, vscode.window.activeTextEditor.document.languageId) : undefined;
      if (context) this.buffer.emit("window.focus", { focused: state.focused }, context);
    }));
    const watcher = vscode.workspace.createFileSystemWatcher("**/*");
    on(watcher);
    on(watcher.onDidCreate((uri) => this.filesystem(uri, "created")));
    on(watcher.onDidChange((uri) => this.filesystem(uri, "changed")));
    on(watcher.onDidDelete((uri) => this.filesystem(uri, "deleted")));
    on(vscode.languages.onDidChangeDiagnostics((event) => {
      if (!this.enabled() || !this.setting("collectDiagnostics", false)) return;
      for (const uri of event.uris) {
        if (this.diagnostics.size < 500) this.diagnostics.set(uri.toString(), uri); else this.overflow++;
      }
    }));
    on(vscode.tasks.onDidStartTask((event) => {
      if (!this.enabled() || !this.setting("collectWorkflows", true)) return;
      const scope = event.execution.task.scope;
      const context = this.workspaceContext(typeof scope === "object" ? scope.uri : undefined);
      if (!context) return;
      const groupId = event.execution.task.group?.id;
      const group = groupId === "build" || groupId === "rebuild" ? "build" : groupId === "test" ? "test" : "other";
      const run = { id: randomUUID(), group, context } as const;
      this.taskRuns.set(event.execution, run);
      this.buffer.emit("task.lifecycle", { executionId: run.id, group, state: "started" }, context);
    }));
    on(vscode.tasks.onDidEndTaskProcess((event) => {
      const run = this.taskRuns.get(event.execution);
      if (run && this.enabled() && this.allowedContext(run.context)) this.buffer.emit("task.lifecycle", { executionId: run.id, group: run.group,
        state: "process_ended", exitCode: event.exitCode }, run.context);
    }));
    on(vscode.tasks.onDidEndTask((event) => {
      const run = this.taskRuns.get(event.execution); this.taskRuns.delete(event.execution);
      if (run && this.enabled() && this.allowedContext(run.context)) this.buffer.emit("task.lifecycle", { executionId: run.id, group: run.group, state: "ended" }, run.context);
    }));
    on(vscode.debug.onDidStartDebugSession((session) => {
      if (!this.enabled() || !this.setting("collectWorkflows", true)) return;
      const context = this.workspaceContext(session.workspaceFolder?.uri);
      if (!context) return;
      const run = { id: randomUUID(), type: this.hash(session.type), context };
      this.debugRuns.set(session.id, run);
      this.buffer.emit("debug.lifecycle", { executionId: run.id, state: "started", debugTypeId: run.type }, context);
    }));
    on(vscode.debug.onDidTerminateDebugSession((session) => {
      const run = this.debugRuns.get(session.id); this.debugRuns.delete(session.id);
      if (run && this.enabled() && this.allowedContext(run.context)) this.buffer.emit("debug.lifecycle", { executionId: run.id, state: "ended", debugTypeId: run.type }, run.context);
    }));
    this.switch(vscode.window.activeTextEditor?.document);
  }

  private setting(key: string, fallback: boolean) { return vscode.workspace.getConfiguration("stackStats").get(key, fallback); }
  private context(uri: vscode.Uri, language?: string): TelemetryContext | undefined {
    if (!this.enabled()) return;
    const context = this.metadata.fromUri(uri, language);
    return context ? eventContext(context) : undefined;
  }
  private workspaceContext(uri?: vscode.Uri): TelemetryContext | undefined {
    if (uri) return this.policy().allowsProject(uri.fsPath) ? { projectId: this.hash(uri.fsPath) } : undefined;
    // Unscoped workflows cannot safely be assigned to the active project. With
    // any excluded root, omit them instead of leaking work from that root.
    return (vscode.workspace.workspaceFolders ?? []).every((folder) => this.policy().allowsProject(folder.uri.fsPath)) ? {} : undefined;
  }
  private allowedContext(context: TelemetryContext) {
    return !context.projectId || vscode.workspace.workspaceFolders?.some((folder) => this.hash(folder.uri.fsPath) === context.projectId && this.policy().allowsProject(folder.uri.fsPath));
  }
  private lifecycle(uri: vscode.Uri, operation: "created" | "deleted") {
    const context = this.context(uri);
    if (context) { this.buffer.emit("file.lifecycle", { operation }, context); this.writes.set(uri.toString(), Date.now()); }
  }
  private switch(document?: vscode.TextDocument) {
    const context = document ? this.context(document.uri, document.languageId) : undefined;
    if (context && this.previous && JSON.stringify(context) !== JSON.stringify(this.previous)) this.buffer.emit("context.switched", { from: this.previous, to: context }, context);
    this.previous = context;
  }
  private filesystem(uri: vscode.Uri, operation: "created" | "changed" | "deleted") {
    if (!this.enabled() || !this.setting("collectFilesystem", true) || !this.metadata.fromUri(uri)) return;
    const key = `${uri.toString()}:${operation}`, previous = this.fsPending.get(key);
    if (!previous && this.fsPending.size >= 1000) { this.overflow++; return; }
    this.fsPending.set(key, { uri, operation, count: (previous?.count ?? 0) + 1, at: Date.now() });
  }
  flush(): void {
    if (!this.enabled()) { this.reset(); return; }
    for (const observation of this.fsPending.values()) {
      const context = this.context(observation.uri);
      if (context && this.setting("collectFilesystem", true)) this.buffer.sample("filesystem.changed", { operation: observation.operation,
        notifications: observation.count, origin: Math.abs(observation.at - (this.writes.get(observation.uri.toString()) ?? 0)) < 2000 ? "editor_correlated" : "unknown" }, context, "filesystem", "inferred", observation.at);
    }
    this.fsPending.clear();
    for (const uri of this.diagnostics.values()) {
      const context = this.context(uri);
      if (!context || !this.setting("collectDiagnostics", false)) continue;
      const counts = { errors: 0, warnings: 0, information: 0, hints: 0 };
      for (const diagnostic of vscode.languages.getDiagnostics(uri)) {
        if (diagnostic.severity === vscode.DiagnosticSeverity.Error) counts.errors++;
        else if (diagnostic.severity === vscode.DiagnosticSeverity.Warning) counts.warnings++;
        else if (diagnostic.severity === vscode.DiagnosticSeverity.Information) counts.information++; else counts.hints++;
      }
      this.buffer.sample("diagnostics.snapshot", counts, context);
    }
    this.diagnostics.clear();
    if (this.overflow) { this.buffer.emit("collector.coverage", { capability: "filesystem", state: "gap", reason: "buffer_limit", droppedObservations: this.overflow }); this.overflow = 0; }
    for (const [key, at] of this.writes) if (Date.now() - at > 30_000) this.writes.delete(key);
  }
  reset(): void { this.previous = undefined; this.fsPending.clear(); this.diagnostics.clear(); this.saves.clear(); this.writes.clear(); this.taskRuns.clear(); this.debugRuns.clear(); }
  dispose(): void { this.reset(); for (const disposable of this.disposables) disposable.dispose(); }
}

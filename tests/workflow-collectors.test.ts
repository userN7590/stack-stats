import { beforeEach, describe, expect, it, vi } from "vitest";
import { PrivacyPolicy } from "@stack-stats/core";

const host = vi.hoisted(() => ({ listeners: new Map<string, (event: any) => void>(), reads: [] as string[], activeTextEditor: undefined as any,
  folders: [] as Array<{ uri: { scheme: string; fsPath: string; toString(): string }; name: string; index: number }> }));
vi.mock("vscode", () => {
  const listen = (name: string) => (listener: (event: any) => void) => { host.listeners.set(name, listener); return { dispose: () => host.listeners.delete(name) }; };
  return {
    TextDocumentSaveReason: { Manual: 1, AfterDelay: 2, FocusOut: 3 },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    workspace: {
      get workspaceFolders() { return host.folders; },
      getWorkspaceFolder: (uri: { fsPath: string }) => host.folders.find((folder) => uri.fsPath.startsWith(`${folder.uri.fsPath}/`)),
      getConfiguration: () => ({ get: (key: string, fallback: unknown) => { host.reads.push(key); return fallback; } }),
      onWillSaveTextDocument: listen("willSave"), onDidSaveTextDocument: listen("didSave"), onDidCloseTextDocument: listen("close"), onDidOpenTextDocument: listen("open"),
      onDidCreateFiles: listen("create"), onDidDeleteFiles: listen("delete"), onDidRenameFiles: listen("rename"),
      createFileSystemWatcher: () => ({ onDidCreate: listen("fsCreate"), onDidChange: listen("fsChange"), onDidDelete: listen("fsDelete"), dispose: () => undefined })
    },
    window: { onDidChangeActiveTextEditor: listen("active"), onDidChangeWindowState: listen("focus"), get activeTextEditor() { return host.activeTextEditor; } },
    languages: { onDidChangeDiagnostics: listen("diagnostics"), getDiagnostics: () => [{ severity: 0 }, { severity: 1 }] },
    tasks: { onDidStartTask: listen("taskStart"), onDidEndTaskProcess: listen("taskProcess"), onDidEndTask: listen("taskEnd") },
    debug: { onDidStartDebugSession: listen("debugStart"), onDidTerminateDebugSession: listen("debugEnd") }
  };
});
import { WorkflowCollectors } from "../apps/vscode-extension/src/workflow-collectors.js";
import { TelemetryBuffer } from "../apps/vscode-extension/src/telemetry-buffer.js";
import { DocumentMetadata, hash } from "../apps/vscode-extension/src/metadata.js";
import { CAPABILITY_SETTINGS, TRACKING_PRESETS, resolveTracking, planLevel, type TrackingCapabilities, type TrackingLevel } from "../apps/vscode-extension/src/tracking-levels.js";

const uri = (fsPath: string) => ({ scheme: "file", fsPath, toString: () => `file://${fsPath}` });
const workspace = { uri: uri("/ws"), name: "ws", index: 0 };
const documentA = { uri: uri("/ws/a.ts"), languageId: "typescript", version: 2 };
const documentB = { uri: uri("/ws/b.py"), languageId: "python", version: 1 };
const fire = (name: string, event: unknown) => host.listeners.get(name)!(event);
const level = (value: TrackingLevel): TrackingCapabilities => {
  const settings = new Map<string, unknown>();
  for (const change of planLevel(value, () => undefined)) settings.set(change.key, change.value);
  return resolveTracking((key) => settings.get(key)).capabilities;
};

/** Every VS Code signal the workflow collectors listen to, once. */
function exercise(capabilities: TrackingCapabilities) {
  const buffer = new TelemetryBuffer("install");
  const policy = new PrivacyPolicy([], []);
  const forwarded: string[] = [];
  const collectors = new WorkflowCollectors(buffer, new DocumentMetadata("salt", () => policy), (value) => hash(value, "salt"), () => policy, () => true,
    () => capabilities, (target, operation) => forwarded.push(`${operation}:${target.fsPath}`));
  host.reads = [];
  fire("active", { document: documentA }); fire("active", { document: documentB });
  host.activeTextEditor = { document: documentB }; fire("focus", { focused: false });
  fire("willSave", { document: documentA, reason: 1 }); fire("didSave", documentA);
  fire("fsChange", documentA.uri); fire("fsCreate", uri("/ws/generated.ts"));
  fire("create", { files: [uri("/ws/new.ts")] }); fire("rename", { files: [{ oldUri: uri("/ws/new.ts"), newUri: uri("/ws/renamed.ts") }] });
  fire("delete", { files: [uri("/ws/renamed.ts")] });
  fire("diagnostics", { uris: [documentA.uri] });
  const execution = { task: { scope: workspace, group: { id: "test" } } };
  fire("taskStart", { execution }); fire("taskProcess", { execution, exitCode: 1 }); fire("taskEnd", { execution });
  fire("debugStart", { id: "d1", type: "node", workspaceFolder: workspace }); fire("debugEnd", { id: "d1" });
  collectors.flush();
  const events = buffer.drain();
  collectors.dispose();
  return { types: new Set(events.map((event) => event.eventType)), events, forwarded, reads: [...host.reads] };
}

beforeEach(() => { host.listeners.clear(); host.folders = [workspace]; host.activeTextEditor = { document: documentA }; });

describe("workflow collectors follow the capability snapshot", () => {
  it("Moderate and Extensive observe exactly their capabilities; Minimal observes none of them", () => {
    const expected = { editor_events: ["file.saved", "file.lifecycle", "context.switched", "window.focus"], external_changes: ["filesystem.changed"],
      tasks_debugging: ["task.lifecycle", "debug.lifecycle"], problem_counts: ["diagnostics.snapshot"] } as const;
    for (const value of ["minimal", "moderate", "extensive"] as const) {
      const { types, forwarded } = exercise(level(value));
      for (const [id, eventTypes] of Object.entries(expected)) for (const type of eventTypes) {
        expect(types.has(type), `${value}: ${type}`).toBe(TRACKING_PRESETS[value].includes(id as keyof typeof expected));
      }
      // The shared watcher still fans out; the external-change observer applies its own gate.
      expect(forwarded).toEqual(["changed:/ws/a.ts", "created:/ws/generated.ts"]);
    }
  });

  it("keeps save correlation for external changes when editor workflow is off", () => {
    const { types, events } = exercise({ ...level("moderate"), editor_events: false });
    expect(types.has("file.saved")).toBe(false);
    const saved = events.find((event) => event.eventType === "filesystem.changed" && event.data.operation === "changed");
    expect(saved?.eventType === "filesystem.changed" && saved.data.origin).toBe("editor_correlated");
  });

  it("reads no tracking setting while handling events", () => {
    const { reads } = exercise(level("extensive"));
    expect(reads.filter((key) => CAPABILITY_SETTINGS.includes(key))).toEqual([]);
  });
});

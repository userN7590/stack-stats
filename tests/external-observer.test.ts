import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrivacyPolicy } from "@stack-stats/core";
import type { AgentInboxRecord, ProvenanceChangeRecord, ProvenanceRecord } from "@stack-stats/protocol";

const host = vi.hoisted(() => ({ folders: [] as Array<{ uri: { fsPath: string; scheme: string; toString(): string }; name: string; index: number }>, listeners: new Map<string, (event: any) => void>() }));
vi.mock("vscode", () => {
  const uri = (fsPath: string) => ({ scheme: "file", fsPath, toString: () => `file://${fsPath}` });
  const listen = (name: string) => (listener: (event: any) => void) => { host.listeners.set(name, listener); return { dispose: () => host.listeners.delete(name) }; };
  return {
    Uri: { file: uri },
    workspace: {
      get workspaceFolders() { return host.folders; },
      getWorkspaceFolder: (target: { fsPath: string }) => host.folders.find((folder) => target.fsPath === folder.uri.fsPath || target.fsPath.startsWith(`${folder.uri.fsPath}/`)),
      getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
      onWillSaveTextDocument: listen("willSave"), onDidSaveTextDocument: listen("didSave"), onDidCreateFiles: listen("create"),
      onDidDeleteFiles: listen("delete"), onDidRenameFiles: listen("rename"), onDidChangeWorkspaceFolders: listen("folders")
    }
  };
});
import * as vscode from "vscode";
import { DocumentMetadata, hash } from "../apps/vscode-extension/src/metadata.js";
import { ExternalChangeObserver } from "../apps/vscode-extension/src/external-observer.js";
import { ProvenanceLedger } from "../apps/vscode-extension/src/provenance-ledger.js";
import { AgentInbox, writeInboxRecord } from "../apps/vscode-extension/src/agent-inbox.js";
import { vendorHash } from "../apps/vscode-extension/src/agent-adapters.js";

let clock = Date.parse("2026-09-29T12:00:00Z");
const root = mkdtempSync(join(tmpdir(), "stack-stats-observer-"));
const ws = join(root, "ws"), other = join(root, "other"), excluded = join(root, "secret-project");
for (const directory of [ws, other, excluded]) mkdirSync(directory);
let collecting = true;
async function setup(options: { excludeProjects?: string[] } = {}) {
  host.folders = [ws, excluded].map((fsPath, index) => ({ uri: vscode.Uri.file(fsPath) as any, name: `f${index}`, index }));
  const salt = "salt";
  const policy = new PrivacyPolicy([], options.excludeProjects ?? []);
  const ledger = new ProvenanceLedger(join(mkdtempSync(join(tmpdir(), "stack-stats-ledger-")), "provenance-v1"), () => undefined);
  const home = mkdtempSync(join(tmpdir(), "stack-stats-home-"));
  const inbox = new AgentInbox(home, () => clock);
  await ledger.initialize();
  const observer = new ExternalChangeObserver({ installationId: "install", metadata: new DocumentMetadata(salt, () => policy), hash: (value) => hash(value, salt), policy: () => policy,
    ledger, inbox, collecting: () => collecting, filesystem: () => true, integrations: () => new Set(["claude-code", "codex"]), telemetry: async () => [], log: () => undefined, now: () => clock });
  return { observer, ledger, home };
}
const uri = (path: string) => vscode.Uri.file(path);
const changes = async (ledger: ProvenanceLedger) => (await ledger.list()).filter((record): record is ProvenanceChangeRecord => record.kind === "change");
const document = (path: string, version: number, isDirty: boolean) => ({ uri: uri(path), version, isDirty, languageId: "typescript" });
const reload = (path: string, version = 2) => ({ document: document(path, version, false), reason: undefined,
  contentChanges: [{ range: { start: { line: 1, character: 0 }, end: { line: 2, character: 0 } }, rangeLength: 10, rangeOffset: 0, text: "a\nb\n" }] }) as any;
const record = (patch: Partial<AgentInboxRecord>): AgentInboxRecord => ({ inboxVersion: 1, recordId: randomUUID(), tool: "claude-code", observedAt: new Date(clock).toISOString(),
  signal: "tool_finished", sessionHash: vendorHash("claude-code", "session", "s1"), turnHash: vendorHash("claude-code", "turn", "p1"), cwd: ws, ...patch });

beforeEach(() => { collecting = true; clock += 3_600_000; host.listeners.clear(); });

describe("external change observer (VS Code normalization boundary)", () => {
  it("records an external write once, with reload-derived diff lines, and ignores scratch, binary and excluded paths", async () => {
    const { observer, ledger } = await setup();
    observer.watcher(uri(join(ws, "a.ts")), "changed");
    observer.watcher(uri(join(ws, "a.ts")), "changed");
    observer.documentChanged(reload(join(ws, "a.ts")));
    for (const path of ["a.ts.tmp.99.abcdef12", "logo.png", ".env", "node_modules/x/index.js"]) observer.watcher(uri(join(ws, path)), "created");
    clock += 2_000; await observer.flush(true);
    const [change] = await changes(ledger);
    expect(await changes(ledger)).toHaveLength(1);
    expect(change).toMatchObject({ actor: "unknown", confidence: "none", operation: "modified", fileId: hash("a.ts", "salt"), projectId: hash(ws, "salt"),
      delta: { linesAdded: 2, linesRemoved: 1, source: "document_reload" }, observations: { watcher: 2, reload: 1 } });
    expect(observer.status().ignored).toEqual({ excluded: 2, binary: 1, transient: 1 });
    expect(JSON.stringify(await ledger.list())).not.toContain(root);
  });

  it("does not treat a user's first keystroke, a save or File: Revert as an external change", async () => {
    const { observer, ledger } = await setup();
    const path = join(ws, "typed.ts");
    observer.documentChanged(reload(path, 5));
    observer.documentChanged({ document: document(path, 5, true), reason: undefined, contentChanges: [] } as any); // dirty confirmation → editor edit
    host.listeners.get("didSave")!(document(join(ws, "saved.ts"), 3, false));
    observer.watcher(uri(join(ws, "saved.ts")), "changed");
    observer.documentChanged(reload(join(ws, "reverted.ts"), 7)); // clean reload with no disk notification
    clock += 2_000; await observer.flush(true);
    expect(await changes(ledger)).toEqual([]);
    expect(observer.status().reconciled).toMatchObject({ editorWritesSuppressed: 1, uncorroboratedReloads: 1 });
  });

  it("ingests hook signals: explicit agent changes absorb watcher duplicates; shell windows correlate; git operations stay unknown", async () => {
    const { observer, ledger, home } = await setup();
    const edited = join(ws, "src", "edited.ts");
    observer.watcher(uri(edited), "created");
    observer.watcher(uri(edited), "changed");
    writeInboxRecord(home, record({ toolKind: "edit", success: true, callHash: vendorHash("claude-code", "call", "e1"), files: [{ path: edited, operation: "modified", linesAdded: 4, linesRemoved: 1 }] }));
    clock += 500;
    observer.watcher(uri(join(ws, "generated.ts")), "changed");
    writeInboxRecord(home, record({ toolKind: "shell", success: true, durationMs: 2_000, vcs: false, callHash: vendorHash("claude-code", "call", "b1") }));
    clock += 60_000;
    observer.watcher(uri(join(ws, ".git", "HEAD")), "changed");
    observer.watcher(uri(join(ws, "checked-out.ts")), "changed");
    writeInboxRecord(home, record({ observedAt: new Date(clock + 200).toISOString(), toolKind: "shell", success: true, durationMs: 1_000, vcs: true, callHash: vendorHash("claude-code", "call", "b2") }));
    writeInboxRecord(home, record({ observedAt: new Date(clock + 300).toISOString(), signal: "turn_stopped", endReason: "completed" }));
    writeInboxRecord(home, record({ cwd: other, signal: "turn_stopped" }));
    clock += 2_000; await observer.flush(true);
    const all = await ledger.list();
    const byFile = new Map((await changes(ledger)).map((change) => [change.fileId, change]));
    expect(byFile.get(hash("src/edited.ts", "salt"))).toMatchObject({ origin: "agent_adapter", actor: "agent", confidence: "explicit", tool: "claude-code", delta: { linesAdded: 4, linesRemoved: 1, source: "adapter" } });
    expect(byFile.get(hash("generated.ts", "salt"))).toMatchObject({ origin: "external", actor: "agent", confidence: "correlated", tool: "claude-code" });
    expect(byFile.get(hash("checked-out.ts", "salt"))).toMatchObject({ actor: "unknown", reason: "vcs_operation" });
    expect(byFile.size).toBe(3);
    expect(all.filter((item) => item.kind === "agent")).toHaveLength(4);
    expect(observer.status().lastInbox).toMatchObject({ claimed: 4, unclaimed: 1 });
    expect(readdirSync(join(home, "agent-inbox-v1", "records"))).toHaveLength(1);
    const serialized = JSON.stringify(all);
    for (const secret of [root, "s1", "p1", vendorHash("claude-code", "session", "s1")]) expect(serialized).not.toContain(secret);
  });

  it("consumes but never records signals from an excluded project, and observes nothing while paused", async () => {
    const { observer, ledger, home } = await setup({ excludeProjects: ["**/secret-project"] });
    writeInboxRecord(home, record({ cwd: excluded, toolKind: "edit", success: true, files: [{ path: join(excluded, "x.ts"), operation: "modified" }] }));
    await observer.flush(true);
    expect(await ledger.list()).toEqual([]);
    expect(readdirSync(join(home, "agent-inbox-v1", "records"))).toEqual([]);
    collecting = false;
    observer.watcher(uri(join(ws, "paused.ts")), "changed");
    writeInboxRecord(home, record({ signal: "turn_stopped" }));
    await observer.flush(true);
    expect(await ledger.list()).toEqual([]);
    expect(readdirSync(join(home, "agent-inbox-v1", "records"))).toHaveLength(1);
  });

  it("stores editor edits made during save participants as a correlated subset record", async () => {
    const { observer, ledger } = await setup();
    const path = join(ws, "format.ts");
    host.listeners.get("willSave")!({ document: document(path, 3, true) });
    const context = new DocumentMetadata("salt").fromUri(uri(path) as any, "typescript")!;
    observer.editorEdit({ documentId: uri(path).toString(), version: 4, at: clock + 5, dirty: true, focused: true, visible: true, undoRedo: false, context, counts: { editCount: 2, linesAdded: 3, linesRemoved: 1 } });
    host.listeners.get("didSave")!(document(path, 4, false));
    observer.editorEdit({ documentId: uri(path).toString(), version: 5, at: clock + 50, dirty: true, focused: true, visible: true, undoRedo: false, context, counts: { editCount: 1, linesAdded: 0, linesRemoved: 0 } });
    await observer.flush(true);
    const records = (await ledger.list()).filter((item): item is Extract<ProvenanceRecord, { kind: "save_participant" }> => item.kind === "save_participant");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ edits: 2, linesAdded: 3, linesRemoved: 1, fileId: hash("format.ts", "salt") });
  });
});

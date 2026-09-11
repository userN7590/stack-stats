import * as vscode from "vscode";
import { createHash, randomUUID } from "node:crypto";
import { extname, relative } from "node:path";
import type { ActivityContext, PrivacyPolicy } from "@stack-stats/core";

export const hash = (value: string, salt: string) => createHash("sha256").update(`${salt}:${value}`).digest("hex");

// Preserve the original collector's classifications without scanning the filesystem.
function category(path: string): ActivityContext["file"]["category"] {
  const lower = path.toLowerCase();
  if (/(^|\/)(__tests__|test|tests|spec)(\/|\.)/.test(lower) || /\.(test|spec)\./.test(lower)) return "test";
  if (/(^|\/)(readme|docs?|changelog|license)/.test(lower) || /\.mdx?$/.test(lower)) return "documentation";
  if (/(package\.json|tsconfig|\.ya?ml|\.toml|dockerfile|\.env)/.test(lower)) return "configuration";
  return "source";
}

export class DocumentMetadata {
  private readonly cache = new Map<string, { language: string; context: ActivityContext }>();
  private readonly untitledIds = new Map<string, string>();
  constructor(private readonly salt: string, private readonly policy?: () => PrivacyPolicy) {}

  get(document: vscode.TextDocument): ActivityContext | undefined {
    return this.fromUri(document.uri, document.languageId);
  }

  fromUri(uri: vscode.Uri, languageId = "unknown"): ActivityContext | undefined {
    const document = { uri, languageId };
    if (document.uri.scheme !== "file" && document.uri.scheme !== "untitled") return undefined;
    const project = vscode.workspace.getWorkspaceFolder(document.uri)
      ?? (document.uri.scheme === "untitled" && vscode.workspace.workspaceFolders?.length === 1 ? vscode.workspace.workspaceFolders[0] : undefined);
    if (this.policy && !this.policy().allows(project?.uri.fsPath, document.uri.fsPath)) return undefined;
    const key = document.uri.toString();
    const cached = this.cache.get(key);
    if (cached?.language === document.languageId) return cached.context;
    const folder = vscode.workspace.getWorkspaceFolder(document.uri)
      ?? (document.uri.scheme === "untitled" && vscode.workspace.workspaceFolders?.length === 1 ? vscode.workspace.workspaceFolders[0] : undefined);
    const projectId = hash(folder?.uri.fsPath ?? "stack-stats:loose-files", this.salt);
    let path = folder ? relative(folder.uri.fsPath, document.uri.fsPath).replaceAll("\\", "/") : document.uri.fsPath;
    if (document.uri.scheme === "untitled") {
      const id = this.untitledIds.get(key) ?? randomUUID();
      this.untitledIds.set(key, id);
      path = `untitled:${id}`;
    }
    const context: ActivityContext = {
      project: {
        projectId,
        displayName: folder ? (vscode.workspace.getConfiguration("stackStats").get("includeProjectNames", false) ? folder.name : `Project ${projectId.slice(0, 8)}`) : "Loose files",
        rootKind: "workspace"
      },
      file: {
        fileId: hash(path, this.salt), languageId: document.languageId,
        extension: extname(path).slice(1, 33) || undefined, category: category(path)
      }
    };
    this.cache.set(key, { language: document.languageId, context });
    return context;
  }

  close(document: vscode.TextDocument): void {
    this.cache.delete(document.uri.toString());
    this.untitledIds.delete(document.uri.toString());
  }
  clear(): void { this.cache.clear(); }
}

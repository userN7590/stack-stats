import { afterEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";

const host = vi.hoisted(() => ({ scheme: "vscode", handler: undefined as vscode.UriHandler | undefined }));
vi.mock("vscode", () => ({
  ExtensionMode: { Production: 1, Development: 2 },
  Uri: {
    // Actual VS Code keeps the original authority on the object and lowercases
    // it only on serialization. WHATWG URL preserves case for custom schemes.
    from: (uri: { scheme: string; authority: string; path: string }) => ({ ...uri,
      toString: () => `${uri.scheme}://${uri.authority.toLowerCase()}${uri.path}`
    }),
    parse: (value: string) => ({ authority: new URL(value).host })
  },
  env: { get uriScheme() { return host.scheme; } },
  window: { registerUriHandler: (handler: vscode.UriHandler) => { host.handler = handler; return { dispose() {} }; } }
}));
import { createAccountService } from "../apps/vscode-extension/src/vscode-account.js";

const disposables: vscode.Disposable[] = [];
function harness(extensionId: string) {
  const subscriptions: vscode.Disposable[] = [];
  const context = { extensionMode: 1, extension: { id: extensionId }, globalStorageUri: { fsPath: "/unused" }, subscriptions,
    secrets: { get: async () => undefined, store: async () => {}, delete: async () => {}, onDidChange: () => ({ dispose() {} }) }
  } as unknown as vscode.ExtensionContext;
  const service = createAccountService(context);
  disposables.push(...subscriptions);
  return vi.spyOn(service, "handleCallback").mockResolvedValue();
}
afterEach(() => { disposables.splice(0).forEach(item => item.dispose()); host.handler = undefined; vi.restoreAllMocks(); });

describe("account callback identity", () => {
  for (const extensionId of ["StackStats.stack-stats-vscode", "undefined_publisher.stack-stats-vscode"]) {
    for (const scheme of ["vscode", "vscode-insiders", "cursor", "windsurf"]) {
      it(`accepts exact manifest and serialized authorities for ${scheme} ${extensionId}`, async () => {
        host.scheme = scheme;
        const callback = harness(extensionId);
        const query = "windowId=1&ss_state=synthetic-state&code=synthetic-code";
        for (const authority of new Set([extensionId, extensionId.toLowerCase()])) {
          await host.handler!.handleUri({ scheme, authority, path: "/auth/callback", query, fragment: "" } as vscode.Uri);
        }
        expect(callback).toHaveBeenCalledTimes(new Set([extensionId, extensionId.toLowerCase()]).size);
        expect(callback.mock.calls[0]![0].toString()).toBe(query);
      });
    }
  }

  it.each([
    { scheme: "https" }, { scheme: "VSCODE" },
    { authority: "sTaCkStats.stack-stats-vscode" }, { authority: "STACKSTATS.stack-stats-vscode" },
    { authority: "StackStats.stack-stats-vscode.evil" }, { authority: "evil.StackStats.stack-stats-vscode" },
    { authority: "wrong.stack-stats-vscode" }, { authority: "StackStats.other-extension" },
    { authority: "undefined_publisher.stack-stats-vscode" }, { authority: "StackStats.stack-stats-vscode:443" },
    { path: "/auth/callback/" }, { path: "/auth/callback?windowId=1" }, { path: "/auth/callback%3FwindowId=1" },
    { path: "/auth/other" }, { fragment: "unexpected" }
  ])("ignores a callback with a mismatched native destination: %j", async mismatch => {
    host.scheme = "vscode";
    const callback = harness("StackStats.stack-stats-vscode");
    await host.handler!.handleUri({ scheme: "vscode", authority: "stackstats.stack-stats-vscode", path: "/auth/callback",
      query: "windowId=1&ss_state=synthetic-state&code=synthetic-code", fragment: "", ...mismatch } as vscode.Uri);
    expect(callback).not.toHaveBeenCalled();
  });
});

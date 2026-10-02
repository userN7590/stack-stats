import { afterEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import { createHash } from "node:crypto";

const host = vi.hoisted(() => ({
  scheme: "vscode", windowId: "1" as string | undefined, opened: "", result: true,
  failure: false
}));
vi.mock("vscode", () => ({
  ExtensionMode: { Production: 1, Development: 2 },
  Uri: {
    from: (uri: { scheme: string; authority: string; path: string }) => uri,
    // Model the URI-object path in VS Code's external opener: parse decodes the
    // query, toString(true) escapes its nested '?', then encodeURI escapes '%'.
    // https://github.com/microsoft/vscode/issues/135949
    parse: (value: string) => {
      const url = new URL(value);
      return { toString: () => `${url.origin}${url.pathname}?${decodeURIComponent(url.search.slice(1)).replaceAll("?", "%3F")}` };
    }
  },
  env: {
    get uriScheme() { return host.scheme; },
    asExternalUri: async (uri: { scheme: string; authority: string; path: string }) => ({
      toString: () => `${uri.scheme}://${uri.authority}${uri.path}${host.windowId === undefined ? "" : `?windowId=${host.windowId}`}`
    }),
    openExternal: async (target: string | { toString(skipEncoding: boolean): string }) => {
      host.opened = typeof target === "string" ? target : encodeURI(target.toString(true));
      if (host.failure) throw new Error("Browser unavailable");
      return host.result;
    }
  },
  window: { registerUriHandler: () => ({ dispose() {} }) }
}));
import { createAccountService } from "../apps/vscode-extension/src/vscode-account.js";

function harness() {
  const values = new Map<string, string>();
  const subscriptions: vscode.Disposable[] = [];
  const context = {
    extensionMode: 1, extension: { id: "undefined_publisher.stack-stats-vscode" },
    globalStorageUri: { fsPath: "/unused" }, subscriptions,
    secrets: {
      get: async (key: string) => values.get(key),
      store: async (key: string, value: string) => { values.set(key, value); },
      delete: async (key: string) => { values.delete(key); },
      onDidChange: () => ({ dispose() {} })
    }
  } as unknown as vscode.ExtensionContext;
  const service = createAccountService(context);
  disposables.push(...subscriptions);
  return { service, values };
}
const disposables: vscode.Disposable[] = [];
afterEach(() => {
  disposables.splice(0).forEach(item => item.dispose());
  host.opened = ""; host.result = true; host.failure = false;
});

describe("account browser URI serialization", () => {
  for (const scheme of ["vscode", "vscode-insiders", "cursor", "windsurf"]) {
    for (const windowId of [undefined, "1", "9876543210"]) {
      for (const scope of [undefined, "stats:write"] as const) {
        it(`preserves ${scheme} callback, window ${windowId ?? "none"}, scope ${scope ?? "identity"}`, async () => {
          host.scheme = scheme; host.windowId = windowId;
          const { service, values } = harness();
          await service.connect(scope);
          const pending = JSON.parse(values.get(service.pendingKey)!);
          const expected = `${scheme}://undefined_publisher.stack-stats-vscode/auth/callback${windowId === undefined ? "" : `?windowId=${windowId}`}`;
          const url = new URL(host.opened);
          expect(pending.redirectUri).toBe(expected);
          expect(url.searchParams.get("redirectUri")).toBe(expected);
          expect(url.searchParams.get("redirectUri")).not.toContain("%3F");
          expect(url.origin + url.pathname).toBe("https://stackstats.dev/extension/connect");
          expect(url.searchParams.get("state")).toBe(pending.state);
          expect(url.searchParams.get("challenge")).toBe(createHash("sha256").update(pending.verifier).digest("base64url"));
          expect(url.searchParams.get("scope")).toBe(scope ?? null);
          expect(service.getState().status).toBe("connecting");
        });
      }
    }
  }
  it.each(["rejection", "exception"])("preserves browser %s handling", async failure => {
    host.result = false; host.failure = failure === "exception";
    const { service, values } = harness();
    await service.connect();
    expect(service.getState().status).toBe("disconnected");
    expect(values.has(service.pendingKey)).toBe(false);
  });
});

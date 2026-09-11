import * as vscode from "vscode";
import { join } from "node:path";
import { exclusive } from "./exclusive.js";
import { AccountService } from "./account-service.js";

export function createAccountService(context: vscode.ExtensionContext): AccountService {
  // Local test origins cannot be set by workspace settings or installed builds.
  let origin = "https://stackstats.dev";
  if (context.extensionMode === vscode.ExtensionMode.Development && process.env.STACK_STATS_AUTH_ORIGIN) {
    try {
      const candidate = new URL(process.env.STACK_STATS_AUTH_ORIGIN);
      if (candidate.protocol === "http:" && ["localhost", "127.0.0.1"].includes(candidate.hostname) && candidate.origin === process.env.STACK_STATS_AUTH_ORIGIN) origin = candidate.origin;
    } catch { /* Invalid development overrides never prevent local tracking. */ }
  }
  const callback = vscode.Uri.from({ scheme: vscode.env.uriScheme, authority: context.extension.id, path: "/auth/callback" });
  const service = new AccountService({
    secrets: context.secrets, origin,
    withRefreshLock: action => exclusive(join(context.globalStorageUri.fsPath, "account-refresh"), async check => { const result = await action(); check(); return result; }),
    callbackUri: async () => (await vscode.env.asExternalUri(callback)).toString(true),
    openBrowser: uri => vscode.env.openExternal(vscode.Uri.parse(uri))
  });
  context.subscriptions.push(service, vscode.window.registerUriHandler({
    handleUri: async uri => {
      if (uri.scheme !== callback.scheme || uri.authority !== callback.authority || uri.path !== callback.path || uri.fragment) return;
      await service.handleCallback(new URLSearchParams(uri.query));
    }
  }), context.secrets.onDidChange(event => {
    if (event.key === service.secretKey) void service.credentialsChanged();
    if (event.key === service.pendingKey) void service.pendingChanged();
  }));
  return service;
}

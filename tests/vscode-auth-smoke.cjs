const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { writeFile } = require("node:fs/promises");
const { join } = require("node:path");
const vscode = require("vscode");

// Opens localhost pages in the system browser. A real HTTP server records
// the requests after VS Code's opener and the browser have serialized them.
// The development-only auth origin receives Connect and returns a cancellation
// through the real native URI handler. No credentials or auth grant are issued.
exports.run = async () => {
  const root = process.env.STACK_STATS_SMOKE_DIR;
  const origin = new URL(process.env.STACK_STATS_AUTH_ORIGIN);
  assert.equal(origin.hostname, "127.0.0.1");
  const requests = new Map();
  let exchangeRequests = 0;
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/extension/connect") requests.set(url.searchParams.get("case") ?? "account", url);
    if (url.pathname.startsWith("/api/extension/")) exchangeRequests++;
    response.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
    response.end("Stack Stats local callback serialization test. This tab can be closed.");
  });
  try {
    await new Promise((resolve, reject) => server.once("error", reject).listen(Number(origin.port), "127.0.0.1", resolve));
    const extension = vscode.extensions.all.find(item => item.packageJSON.name === "stack-stats-vscode");
    assert(extension);
    const callback = vscode.Uri.from({ scheme: vscode.env.uriScheme, authority: extension.id, path: "/auth/callback" });
    const external = await vscode.env.asExternalUri(callback);
    const routing = new URLSearchParams(external.query);
    assert.equal(external.scheme, vscode.env.uriScheme);
    assert.equal(external.authority, extension.id);
    assert.equal(external.path, "/auth/callback");
    assert.deepEqual([...routing.keys()], ["windowId"], "Desktop VS Code appends only windowId");
    assert.match(routing.get("windowId"), /^[0-9]{1,10}$/);
    const expected = external.toString(true);
    const examples = {};
    for (const kind of ["uri-object", "string"]) {
      const url = new URL(`http://127.0.0.1:${server.address().port}/extension/connect`);
      url.search = new URLSearchParams({ case: kind, state: "synthetic-state", challenge: "synthetic-challenge", redirectUri: expected }).toString();
      assert(await vscode.env.openExternal(kind === "string" ? url.toString() : vscode.Uri.parse(url.toString())));
      for (let attempt = 0; attempt < 200 && !requests.has(kind); attempt++) await new Promise(resolve => setTimeout(resolve, 100));
      assert(requests.has(kind), `System browser requested the ${kind} localhost URL`);
      const received = requests.get(kind);
      examples[kind] = { rawQuery: received.search, redirectUri: received.searchParams.get("redirectUri") };
    }
    assert.equal(examples["uri-object"].redirectUri, expected.replace("?", "%3F"), "URI-object opener reproduces nested query double encoding");
    assert(examples["uri-object"].rawQuery.includes("%253FwindowId"));
    assert.equal(examples.string.redirectUri, expected, "Runtime string opener preserves the callback exactly");
    assert(!examples.string.rawQuery.includes("%253F"));
    const api = await extension.activate();
    assert.equal(api.account.getState().status, "disconnected");
    await vscode.commands.executeCommand("stackStats.connectAccount");
    for (let attempt = 0; attempt < 200 && !requests.has("account"); attempt++) await new Promise(resolve => setTimeout(resolve, 100));
    assert(requests.has("account"), "Production adapter sends Connect to the isolated development origin");
    assert.equal(api.account.getState().status, "connecting");
    const connect = requests.get("account");
    assert.equal(connect.searchParams.get("redirectUri"), expected);
    const incoming = new URL(expected);
    incoming.searchParams.set("ss_state", connect.searchParams.get("state"));
    incoming.searchParams.set("error", "access_denied");
    await vscode.commands.executeCommand("vscode.open", vscode.Uri.parse(incoming.toString()));
    for (let attempt = 0; attempt < 100 && api.account.getState().status !== "disconnected"; attempt++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(api.account.getState().status, "disconnected", "Actual native return reaches the account service");
    assert.match(api.account.getState().message, /cancelled/);
    assert.equal(exchangeRequests, 0, "Cancellation exchanges no code and issues no credentials");
    await writeFile(join(root, "auth-results.json"), JSON.stringify({ vscodeVersion: vscode.version, uriScheme: vscode.env.uriScheme, extensionId: extension.id,
      callbackUri: callback.toString(true), externalCallbackUri: expected, examples,
      nativeReturn: { manifestAuthority: callback.authority, serializedAuthority: vscode.Uri.parse(expected).authority, result: "cancelled", exchangeRequests } }, null, 2));
    await writeFile(join(root, "passed"), "passed");
  } catch (error) {
    await writeFile(join(root, "failed"), error.stack ?? String(error)); throw error;
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
};

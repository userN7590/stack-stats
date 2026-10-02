# Phase 10B: Marketplace release candidate and auth migration

Dates: 1–2 October 2026. Target editor: desktop VS Code (tested on 1.138.0, macOS).

**Status: stopped at Checkpoint C.** The 0.6.0 release candidate is built, audited and installs cleanly. The production web callback change is ready, but you must deploy it before a real browser sign-in can be tested. Publication is also blocked until a privacy policy exists (§20). Nothing has been staged, committed, pushed, deployed, uploaded or published.

This report supersedes three Phase 10A positions: the publisher recommendation, the assumption that callback case is preserved, and the classification of a privacy policy as optional. The unrelated `docs/audits/` directory is untouched.

| Checkpoint | State |
| --- | --- |
| A: account callback fix audited | Done (§4) |
| B: web callback allowlist ready | Done (§6) |
| C: user deploys the web callback change | **Waiting on you** (§26) |
| D: real browser sign-in tested | Blocked on C (§17) |
| E: release VSIX final | Candidate ready; rebuild if packaged text changes (§18) |
| F: Marketplace upload approved | Blocked on C, D, E and the privacy policy |

## 1. Confirmed publisher identity

`StackStats`, exactly as confirmed by the owner. `https://marketplace.visualstudio.com/publishers/StackStats` returned HTTP 200. `@vscode/vsce` 3.9.2 packages it without changing case.

## 2. Final extension identity

| Surface | Value |
| --- | --- |
| `package.json` `publisher` / `name` | `StackStats` / `stack-stats-vscode` |
| Canonical extension ID | `StackStats.stack-stats-vscode` |
| `extension.vsixmanifest` | `Id="stack-stats-vscode" Version="0.6.0" Publisher="StackStats"` |
| Runtime `context.extension.id` | `StackStats.stack-stats-vscode` |
| VS Code CLI `--list-extensions` | `stackstats.stack-stats-vscode@0.6.0` (VS Code's own lowercase display) |
| `globalStorageUri` folder | `…/User/globalStorage/stackstats.stack-stats-vscode` |
| Serialized callback authority | `stackstats.stack-stats-vscode` (VS Code's URI serializer lowercases authorities) |

The tooling did not reject or rewrite the publisher. VS Code shows lowercase IDs in some places, but the package identity stays `StackStats`. `pnpm check:vsix --release` now requires the identity to be exactly `StackStats.stack-stats-vscode`. `pnpm test:vsix` matches CLI output case-insensitively and separately asserts the exact runtime ID.

## 3. Version 0.6.0

The only version change is `apps/vscode-extension/package.json`: `0.5.0` → `0.6.0`. The root workspace (`0.1.0`) and internal packages are unchanged. `pnpm-lock.yaml` records dependencies, not the extension version, so it needs no change. The new `apps/vscode-extension/CHANGELOG.md` has a concise 0.6.0 entry and is packaged as `extension/changelog.md`.

## 4. Account callback bug and fix (Checkpoint A)

There are two separate callback fixes. They belong in separate commits.

### Fix 1: pre-existing browser URL encoding fix (Commit A)

**Audit.** At the start of Phase 10B, the working tree had exactly one change in `apps/vscode-extension/src/vscode-account.ts`. It replaced `openExternal(vscode.Uri.parse(uri))` with `openExternal(uri as unknown as vscode.Uri)` and added a 3-line comment. The resulting blob is `34d2739`. `tests/vscode-account.test.ts` was untracked (26 tests, blob `926bcb4`). That is why `git diff` showed nothing for it, so its contents were read in full. No unrelated account work was mixed in.

**Bug.** The account service builds `https://stackstats.dev/extension/connect?…&redirectUri=<callback>` with `URLSearchParams`. Desktop VS Code's `asExternalUri` returns `vscode://…/auth/callback?windowId=N`. The encoding fails in three steps:

1. `vscode.Uri.parse()` decodes the outer query.
2. `toString()` re-escapes the nested `?` as `%3F`.
3. The opener's `encodeURI` escapes the `%` again.

The browser therefore receives `%253FwindowId`. stackstats.dev decodes that once to `…/auth/callback%3FwindowId=1`. That is no longer a query boundary, so the site rejects the callback (microsoft/vscode#135949).

**Fix.** The completed string is passed to `openExternal`. The runtime accepts strings; `vscode.d.ts` declares only `Uri`, hence the narrow cast.

**Scope.** This affects outbound browser serialization only. Incoming callback parsing, authority checks, state, PKCE, tokens, sync and consent are unchanged. Security behavior is unchanged.

**Test coverage of the original tests:**

| Covered | Not covered here |
| --- | --- |
| `vscode`, `vscode-insiders`, `cursor`, `windsurf` | Malformed incoming callbacks. These are covered by `tests/account.test.ts`: malformed, duplicate, unsolicited, wrong-state, expired and cancelled callbacks. |
| No `windowId`, `windowId=1`, `windowId=9876543210` | |
| Assertions that `%3F` never appears after decoding, which catches double encoding | |
| Identity scope vs `stats:write` | |
| State and S256 challenge binding | |
| Cleanup after a browser rejection or exception | |

**Commit A alone** is HEAD plus only these two blobs. In a scratch tree it passes typecheck and build, and 336/336 tests in 27 files.

### Fix 2: release-identity return fix (Commit B, new in 10B)

Real VS Code keeps `Uri.from({authority: "StackStats.stack-stats-vscode"}).authority` in mixed case. However, `toString(true)` serializes it lowercase, and a real URI handler receives `uri.authority === "stackstats.stack-stats-vscode"`. The old strict comparison against `callback.authority` silently ignored the browser return, so sign-in never completed.

This only appears once the publisher contains capitals. The beta `undefined_publisher` is already lowercase. The handler now accepts exactly two authorities: the original one, and the one VS Code itself produces when parsing the serialized callback. Other casings, other publishers, prefixes/suffixes, ports, wrong scheme/path and fragments stay rejected; see `tests/vscode-account-identity.test.ts` (23 tests).

## 5. Old vs new callback examples (real VS Code 1.138.0)

`pnpm test:vscode:auth` runs the extension in a real Development host. The system browser fetches a localhost page, and an HTTP server records the request. Only synthetic state/challenge values are used, and no credentials are issued.

```text
env.uriScheme:                    vscode
context.extension.id:             StackStats.stack-stats-vscode
asExternalUri(callback):          vscode://stackstats.stack-stats-vscode/auth/callback?windowId=1

Before (Uri object), raw query:   …&redirectUri=vscode://stackstats.stack-stats-vscode/auth/callback%253FwindowId=1
Before, decoded redirectUri:      vscode://stackstats.stack-stats-vscode/auth/callback%3FwindowId=1     ← rejected

After (string), raw query:        …&redirectUri=vscode%3A%2F%2Fstackstats.stack-stats-vscode%2Fauth%2Fcallback%3FwindowId%3D1
After, decoded redirectUri:       vscode://stackstats.stack-stats-vscode/auth/callback?windowId=1       ← exact

Native return (vscode.open of the lowercase callback with ss_state + error=access_denied):
  reached AccountService → state "disconnected / cancelled", token exchange requests: 0
```

## 6. Web allowlist change (Checkpoint B)

Repository: `/Users/fstopyra/Desktop/stack-stats/stack-stats-web`. The stale `/Users/fstopyra/Desktop/stack-stats-web` clone was not used.

Before this change, `validRedirect` hard-coded `undefined_publisher.stack-stats-vscode` for four schemes. It allowed `?windowId=N` only on those built-in entries. `STACK_STATS_EXTENSION_REDIRECT_URIS` entries match only as whole strings. Desktop window IDs vary, so an environment-only change could not support the release identity. A code deploy is required.

`src/lib/extension-auth.ts` now has a finite native list covering four schemes and three exact authorities, with the exact path `/auth/callback`:

| Authority | Purpose |
| --- | --- |
| `stackstats.stack-stats-vscode` | What VS Code actually sends (observed) |
| `StackStats.stack-stats-vscode` | Canonical spelling, exact only |
| `undefined_publisher.stack-stats-vscode` | Temporary beta compatibility (§8) |

Native matching now compares the raw string, never a normalized URL. The value must equal the base, or the base plus `?windowId=` and 1–10 ASCII digits. Values over 2048 characters, or containing control characters, whitespace or backslashes, are rejected first. Configured extra URIs keep exact-match semantics and never gain `windowId`. `src/lib/distribution.ts` and `VSCODE_EXTENSION_URL` are unchanged. The production smoke script (`scripts/check-production.mjs`) now probes the real lowercase release callback.

## 7. Callback security model

- **Scheme, authority and path:** exact strings from a finite list. There is no wildcard, prefix/suffix, case-folding, port, userinfo or fragment.
- **Query:** none, or a single literal `windowId` of 1–10 digits. The following are all rejected:
  - pre-existing `code`, `ss_state` or `error` values;
  - duplicates and extra keys;
  - encoded keys or values (`window%49d`, `%31`);
  - `;` or `?` injection;
  - encoded separators (`%3F`, `%253F`, `%2f`, `%252f`);
  - dot segments and backslashes.
- **No double decoding:** the validator receives the once-decoded `redirectUri` and does no further decoding or normalization.
- **No open redirect:** web callbacks only go to an allowlisted native URI, or to an exactly configured relay.
- **Bound flow:** state is random, compared in constant time and bound to a locally initiated pending request. The S256 verifier stays in SecretStorage and goes only to the HTTPS exchange. The database consumes the 90-second code once, with the exact full `redirect_uri` and a matching verifier.
- **Separate consent:** account linking never grants `stats:write` or publishes anything.

Web test coverage includes:

- the exact accepted forms for every scheme/authority pair, with and without `windowId`;
- one level of outer-URL encoding;
- 28 malformed query suffixes per callback;
- 14 look-alike or wrong authorities (wrong publisher, `.evil` suffix, `evil.` prefix, another extension, mixed case, port, userinfo, encoded dot);
- 9 path-normalization attempts;
- uppercase scheme, whitespace and control characters, and encoded whole URIs;
- configured-extra strictness;
- approval and exchange rejection before any RPC;
- an exact-callback PKCE exchange;
- login/signup continuation rejecting `%3F`, `%253F` and look-alikes.

## 8. Legacy identity handling

`undefined_publisher.stack-stats-vscode` stays as an exact, commented entry so that beta VSIX users can still sign in during the transition. It does not migrate their editor storage or secrets.

Removal plan, recorded in the web repo's `docs/MARKETPLACE_AUTH_060.md`:

1. Review beta upgrades in Phase 10C.
2. Before the next Marketplace minor release, remove the entry and its positive tests in a separate web change, adding rejection tests. Announce the cutoff to beta users.
3. If the deadline moves, record the owner, reason and new date.

Never replace any entry with a wildcard or a case-insensitive match.

**Supabase change required: no.** Supabase returns to the website's own `/auth/callback`. Native editor URIs are validated by web code and are never sent to Supabase. The SQL functions only length-check `p_redirect_uri` and compare it for exact equality at exchange (`supabase/migrations/20260909…`, `20260910…`, `20260927…`). No database migration, Supabase redirect URL or auth setting changes.

## 9. SecretStorage implications

Experiments ran in isolated profiles under ordinary (non-test) editor windows, because `--extensionTestsPath` forces in-memory storage. The account keys are `stackStats.account.v1:<origin>` and `…:pending`.

- **Across identities:** the new identity cannot read the old identity's SecretStorage. Release users start disconnected and must **sign in once again**. That is acceptable for beta and is documented in the README and CHANGELOG. No secrets are copied between identities.
- **Same-identity uninstall/reinstall:** SecretStorage survived. **Uninstall is not a logout.** Run **Disconnect Account** before uninstalling to clear credentials and revoke the connection.

## 10. globalState / globalStorage implications

| Data | New publisher identity | Same-identity uninstall → reinstall |
| --- | --- | --- |
| `globalStorageUri` (history, queues, installation file) | New, empty `stackstats.stack-stats-vscode` folder | **Deleted** by VS Code's deferred cleanup (on the second start after uninstall) |
| `globalState` (`installationId`, `privacySalt`, `agentIntegrationsConnectedAt`) | Separate, empty namespace | Survived |
| `workspaceState` / `storageUri` | Separate (Stack Stats does not use them) | Survived |
| SecretStorage | Separate; old values unreadable | Survived |
| `stackStats.*` settings | **Shared** (configuration namespace, not publisher) | Survived |
| `~/.stackstats` (hook launcher, runtime, inbox, state, backups, optional daemon) | **Shared**, outside extension storage | Survived; the uninstall hook pauses collection |
| Claude `settings.json` / Codex `hooks.json` entries | **Shared**, outside extension storage | Survived unless disconnected |

**Duplicate installs.** VS Code lets both identities be installed. With both enabled, the second fails to activate with `command 'stackStats.currentSession.focus' already exists`, because they contribute identical command, view and setting IDs. **Disabling the old extension globally is enough.** Uninstalling is not required to use 0.6.0, and keeping the old one disabled preserves its storage as a rollback. Never run both enabled.

## 11. Local history migration

**Chosen approach: A + C, manually.** Make an explicit verified backup, then optionally do an allowlisted file import into a never-activated release folder. No migration code was added. The beta population is small, and an automatic cross-identity copier would need path discovery across profiles and remotes. Phase 10A already showed that history physically lives in `globalStorageUri` as plain directories with a stable format.

Copy these directories:

- `sessions-v1`
- `telemetry-v2`
- `provenance-v1`

Do **not** copy:

- `installation`: it would reuse the old device ID and sync salt;
- `profile-sync-v1`: the old account's upload queue and consent metadata;
- `hourly-v1`: bound to the old installation ID, so it fails validation;
- `account-refresh`: transient locks;
- VS Code `state.vscdb` or credential stores.

Validation used synthetic, schema-valid history in a fresh release profile. VS Code activated, its API returned the imported edits and agent records, and session files kept their original `installationId`. A new installation ID was generated, the new hourly manifest had no imported dates, and the account and sync stayed disconnected.

### Your machine (run by you; VS Code must be fully quit)

Checked read-only on 2 October:

- `~/Library/Application Support/Code/User/globalStorage/undefined_publisher.stack-stats-vscode` exists (6.8 MB) and holds `sessions-v1`, `telemetry-v2`, `provenance-v1`, `hourly-v1`, `installation`, `profile-sync-v1` and `account-refresh`.
- `…/stackstats.stack-stats-vscode` does not exist.
- The installed extension is `undefined_publisher.stack-stats-vscode-0.5.0`.

For a named profile or a remote host, use the history root shown by **Stack Stats: Show Status**.

1. In VS Code, open Extensions, find `@id:undefined_publisher.stack-stats-vscode` and choose **Disable** (not *Disable (Workspace)*). Then **quit every VS Code window** so pending writes finish. Do not uninstall yet. Leave real Claude/Codex hooks alone.
2. Back up and verify:

   ```sh
   python3 - <<'PY'
   from pathlib import Path
   import hashlib, shutil
   base = Path.home() / 'Library/Application Support/Code/User/globalStorage'
   source = base / 'undefined_publisher.stack-stats-vscode'
   backup = Path.home() / 'Desktop/StackStats-beta-backup-0.6.0'
   assert source.is_dir(), f'Missing source: {source}'
   assert not backup.exists(), f'Backup already exists; keep it: {backup}'
   assert not any(p.is_symlink() for p in source.rglob('*')), 'Stop: inspect unexpected symlinks first'
   backup.mkdir(mode=0o700)
   shutil.copytree(source, backup / 'storage', copy_function=shutil.copy2)
   def hashes(d):
       return {str(p.relative_to(d)): hashlib.sha256(p.read_bytes()).hexdigest() for p in d.rglob('*') if p.is_file()}
   assert hashes(source) == hashes(backup / 'storage'), 'Backup verification failed; do not uninstall'
   print(f'Verified local-history backup: {backup}')
   PY
   ```

3. Install the release candidate while VS Code is still closed. A CLI install does not activate it.

   ```sh
   '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code' \
     --install-extension /private/tmp/stack-stats-10b-rc/stack-stats-vscode-0.6.0.vsix
   ```

4. Import only the allowlisted history. The script refuses to run if the destination already exists. Never merge into it, or delete it to make the script run.

   ```sh
   python3 - <<'PY'
   from pathlib import Path
   import shutil
   backup = Path.home() / 'Desktop/StackStats-beta-backup-0.6.0/storage'
   target = Path.home() / 'Library/Application Support/Code/User/globalStorage/stackstats.stack-stats-vscode'
   assert backup.is_dir(), f'Missing verified backup: {backup}'
   assert not target.exists(), f'Destination already exists; review before importing: {target}'
   target.mkdir(mode=0o700)
   for name in ('sessions-v1', 'telemetry-v2', 'provenance-v1'):
       source = backup / name
       if source.is_dir():
           assert not any(p.is_symlink() for p in source.rglob('*')), 'Stop: inspect unexpected symlinks first'
           shutil.copytree(source, target / name, copy_function=shutil.copy2)
   print(f'Imported local history into the release identity: {target}')
   PY
   ```

5. Open VS Code. Check that Extensions shows **Stack Stats 0.6.0 by StackStats** and that the old extension is disabled. Then:
   - Run **Refresh Stats** and confirm historical totals.
   - Confirm your settings.
   - Run Agents → **Verify Agent Integrations**.

   Do not rewrite vendor config because of the publisher change.
6. After the web deploy, sign in again (§17). Approve private sync separately only if you want it.
7. Keep the backup. You can uninstall the disabled old extension later. If you do, reload afterwards: its uninstall hook pauses the shared `~/.stackstats` hook state until the release extension activates again. Then verify agents.

**Effects to expect:**

- Imported beta sessions stay **local only**. Profile Sync uploads only sessions whose `source.installationId` matches the current installation (`profile-sync.ts`), and the hourly store ignores foreign installations. Old history is therefore never re-uploaded as a new device. Summaries already synced stay on the server under the old device.
- New privacy salts can split historical and new project/file labels in local reports.

## 12. Settings behavior

`stackStats.*` keys belong to the configuration namespace, not the publisher. In the isolated profile, persisted `collectGit=false`, `collectFilesystem=false` and `agentIntegrations.claudeCode=true` carried over unchanged to the new identity. Pause state and capability or agent choices carry over too. A clean profile with no settings resolves to Moderate.

## 13. Installation ID behavior

`stableInstallation` reads `globalState`, then `globalStorage/installation/id.json`, and otherwise creates a UUID.

- **New identity:** both are empty, so the extension gets a **new installation ID**. Sync after consent registers a new device, and nothing uploads as the old installation, even with imported history.
- **Same-identity reinstall:** the extension can reuse the old UUID, because `globalState` survives the deletion of the storage folder.

Continuing the old cloud installation on purpose would need a coordinated migration of state, queue and salt. That is out of scope.

## 14. Agent integration behavior

The launcher, runtime, hook state and inbox live under `STACK_STATS_HOME` (`~/.stackstats` by default). Vendor entries call the stable launcher with `/bin/sh`, and no path contains the publisher. Results under isolated `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `STACK_STATS_HOME`:

- **Identity switch:**
  - Vendor files stayed byte-identical.
  - Both agents still showed as connected.
  - Claude's last-signal verification survived, because the missing per-identity `connectedAt` is treated as 0.
  - Codex still required approval.
  - A deliberately stale runtime hint was refreshed to the new host's `process.execPath`.
  - No vendor config was rewritten, and no repair is needed.
- **Claude Code:**
  - The real manager merged 6 entries and preserved an unrelated `model` key.
  - A synthetic Stop payload, run through the exact configured command and the packaged hook, reached the extension (`verified: true`).
  - Disconnect removed only Stack Stats entries.
  - No real model turn was run: the Claude CLI was not on the test PATH, and an isolated config directory has no credentials.
- **Codex:**
  - The real manager merged 6 entries and showed `approvalPending: true`.
  - The installed Codex app-server `hooks/list` parsed all six commands exactly (`source: user`, `trustStatus: untrusted`, no warnings or errors).
  - Trust was not bypassed, and no `trusted_hash` or `config.toml` was written.
  - After disconnect, `hooks/list` returned zero hooks.
- **Clean VSIX:** declining Connect leaves both vendor files byte- and mtime-identical, writes no settings and installs no hook runtime (§16).

## 15. Sync behavior

Sync semantics are unchanged.

- **Contract parity:** v1 contract and SQL language parity with the production web repo passed, and v2 module parity (`--require-v2`) passed.
- **Unit tests:** cover v1 fallback, v2 capability negotiation and promotion, hourly opt-in (default off), retry and durability, the 90-day/10-day bounds, foreign-installation filtering, grant isolation and refresh. Agent telemetry has no sync path.
- **Consent:** account sign-in does not grant `stats:write`. Private sync needs a separate browser approval.
- **Publication:** the extension has no publication API, and publication stays a website choice. The identity change resets no website publication settings and broadens nothing.

Live authenticated sync is part of Checkpoint D (§17).

## 16. Clean-profile results

`pnpm test:vsix` ran on the release candidate. It uses isolated user data, extensions, `STACK_STATS_HOME`, `CLAUDE_CONFIG_DIR` and `CODEX_HOME`, inspects the real workbench through DevTools, and saves screenshots. All checks passed:

- **Identity:** the runtime ID is exactly `StackStats.stack-stats-vscode`, loaded from the isolated install.
- **Icon and publisher:** the Marketplace S² icon appears in Extensions with publisher **StackStats**, and the Activity Bar S² icon renders.
- **UI checkpoints:** all seven passed: sidebar, extensions, levels, advanced, agents, attention, paused.
- **Panels and defaults:**
  - The Activity, Agents and Account panels all render.
  - Tracking resolves to Moderate, and the install writes no settings.
  - The status bar shows "Stack Stats • Idle", with 0 errors and 0 warnings.
- **Pickers and reports:**
  - Pause and Resume are reflected.
  - Dismissing the tracking-level pickers keeps Moderate and writes nothing.
  - Advanced tracking works.
  - **Show Telemetry Privacy** prints all three layers and shows Moderate.
- **Agent confirmations:** the Claude and Codex confirmations decline without writing vendor files, settings or hooks.
- **Account:** declining the browser prompt returns to local-only, with no sync.
- **Logs:** no Stack Stats activation errors, duplicate registrations or rejected promises.
- **Uninstall and reinstall:**
  - The extension folder is removed.
  - VS Code **deletes the local history folder** after restart.
  - The uninstall hook paused the shared agent hook state.
  - Reinstall succeeded.
- **Interactive smoke:** a local edit in the packaged build is recorded. Passed.

Tracking levels: `tests/tracking-levels.test.ts` and `tests/tracking-controls.test.ts` cover Minimal, Moderate, Extensive, Custom and Restore Recommended. They verify that no sync, publication or vendor-config mutation happens and no history is deleted. The VSIX UI checkpoints cover the pickers.

## 17. Real sign-in: manual checkpoint (Checkpoint D)

**Not yet run.** It needs the web change in production. After you deploy it (§26), install the release candidate by following §11 and, with the old extension disabled, check each of these:

1. **Connect Account** → approve VS Code's open-browser prompt → sign in at `https://stackstats.dev` → approve. The browser returns to **the same VS Code window**.
2. The Account panel shows your username. **Open Profile** opens your profile. Private sync stays off.
3. Restart VS Code: the account is restored. After about 15 minutes (access token expiry), an account action refreshes silently.
4. **Disconnect Account** clears the connection (and revokes it, if online). **Connect Account** again completes a fresh callback.
5. Optionally, **Enable Profile Sync** → approve the separate consent → **Sync Now**:
   - Private daily summaries arrive, and hourly stays off unless you enable it.
   - An offline attempt retries later.
   - Your website publication settings are unchanged, and nothing new is public.

Record pass/fail, the VS Code version and the VSIX SHA-256 here, never tokens. Insiders, Cursor and Windsurf have generated-URI and web-validation coverage only. They are not claimed as supported.

## 18. Release VSIX details

| | |
| --- | --- |
| Path | `/private/tmp/stack-stats-10b-rc/stack-stats-vscode-0.6.0.vsix` |
| SHA-256 | `a09325b9650787a8e810751c3cda83962896b225b530940799857584c0175618` |
| Identity | `StackStats.stack-stats-vscode@0.6.0` |
| Files / size | 11 entries, 216,897 bytes (211.81 KB) |
| Built with | `pnpm --filter stack-stats-vscode exec vsce package --no-dependencies --out <path>` (runs `vscode:prepublish` → build) |

The contents were rebuilt from the final tree on 2 October and are byte-identical; only the zip timestamps differ. `/private/tmp` is cleared on reboot. Rebuild with the command above at Checkpoint E, or sooner if packaged text changes (for example, a privacy link). Then re-run §19 and §16 and record the new hash. The tracked `apps/vscode-extension/stack-stats-vscode-0.*.vsix` files were not touched.

## 19. Package audit

`pnpm check:vsix --release` passed. Archive contents:

| Bytes | Entry |
| ---: | --- |
| 520 | `[Content_Types].xml` |
| 3,214 | `extension.vsixmanifest` |
| 914 | `extension/changelog.md` |
| 213,495 | `extension/dist/agent-hook.cjs` |
| 522,134 | `extension/dist/extension.cjs` |
| 195,720 | `extension/dist/uninstall.cjs` |
| 1,070 | `extension/LICENSE.txt` |
| 22,650 | `extension/package.json` |
| 11,201 | `extension/readme.md` |
| 2,083 | `extension/resources/stack-stats-activity-bar.svg` |
| 10,936 | `extension/resources/stack-stats-icon.png` (256×256) |

The exact-file allowlist in `check:vsix` means nothing outside the 11 entries above can be packaged. That rules out source maps, `.env` files, databases, nested VSIX files, tests, audit files and Claude/Codex config.

A manual scan of the extracted files found none of:

- `sourceMappingURL`;
- `/Users/fstopyra` or `/var/folders`;
- service-role strings;
- JWT, Anthropic-key or refresh-token shapes;
- private keys.

Two hits were checked and are not secrets:

- `/private/tmp`: one generic code comment about the macOS `/tmp` symlink.
- `.env`: privacy exclusion patterns and the `vscode.env` API.

Loopback references are the optional daemon and the development-only auth origin.

## 20. Privacy page status

`https://stackstats.dev/privacy` returns 404. The [Marketplace Publisher Agreement](https://aka.ms/vsmarketplace-agreement), §8(b)(ii), says: "You must maintain a privacy policy if (i) your Offering accesses, collects or transmits any Personal Data to you or a third party." It also says you must inform Customers of the policy.

Optional account linking and private sync transmit account identity and activity summaries to stackstats.dev. **A privacy policy is therefore required: publication is blocked.** No policy was drafted or published. The path does not have to be `/privacy`. Screenshots are not required to package or upload, so the Phase 10A screenshot plan stays. Favicon work is deferred.

## 21. Remaining blockers

1. **Checkpoint C:** you deploy the web commit (§26).
2. **Checkpoint D:** real browser sign-in and the optional live sync check pass (§17).
3. **Privacy policy:** you approve a policy, host it, and link it from the README (and in the Marketplace listing, if the portal offers a field). Then rebuild and re-audit, because packaged text changes.
4. **Push extension commits first:** the packaged README and CHANGELOG link to this document on GitHub (`userN7590/stack-stats`, public). The links 404 until Commit B is on `main`.
5. **Checkpoint F:** your explicit approval of the upload.

## 22. Manual Marketplace upload steps (after §21)

1. Rebuild (§18) and run `pnpm check:vsix --release <vsix>` and `pnpm test:vsix --vsix <vsix>`. Record the SHA-256 (Checkpoint E).
2. Sign in to `https://marketplace.visualstudio.com/manage` with the account that owns **StackStats**.
3. Choose **StackStats → New extension → Visual Studio Code**, then upload the audited `stack-stats-vscode-0.6.0.vsix`. Check the identity, version, README, icon, license and privacy link before submitting. **Submitting publishes** after validation, so it is not a dry run.
4. Wait for validation, then install from the Marketplace into a clean profile and repeat §17 steps 1–4.

Manual upload needs no Azure DevOps PAT, and none was created or requested. `vsce publish` was not used.

## 23. Post-publish web steps (Phase 10C)

1. Set the release link in the web repo's existing distribution configuration (`src/lib/distribution.ts` / `VSCODE_EXTENSION_URL`) to `https://marketplace.visualstudio.com/items?itemName=StackStats.stack-stats-vscode`. Run the homepage CTA tests and web checks, then deploy with approval.
2. Re-run `npm run check:production -- https://stackstats.dev` and a Marketplace-install sign-in.
3. Track the legacy-callback removal (§8). Add screenshots in a later package update if wanted.

## 24. Extension staging blocks

Run each block from `/Users/fstopyra/Desktop/projects/stack-stats`. Never use `git add .`, and keep `docs/audits/` unstaged.

**Commit A** stages the exact pre-existing blobs. They are stored in the object database (`git hash-object -w`), so the commit is byte-exact without hand-editing hunks:

```sh
git update-index --add --cacheinfo 100644,34d27399b66a43e457e94be2e98137751653412e,apps/vscode-extension/src/vscode-account.ts
git update-index --add --cacheinfo 100644,926bcb44f20b943b59c4fe844475edd71c268bf7,tests/vscode-account.test.ts
git diff --cached --stat   # expect exactly: vscode-account.ts 5 +-, tests/vscode-account.test.ts 89 +
```

If git reports a missing object (for example, after aggressive `git gc --prune=now`), stop and regenerate the blobs. Do not stage the working-tree files for Commit A.

**Commit B** goes after Commit A is committed:

```sh
git add -- apps/vscode-extension/package.json apps/vscode-extension/CHANGELOG.md apps/vscode-extension/README.md \
  apps/vscode-extension/src/vscode-account.ts tests/vscode-account.test.ts tests/vscode-account-identity.test.ts \
  tests/vscode-auth-smoke.cjs scripts/test-vscode.mjs scripts/test-vsix.mjs scripts/check-vsix.mjs package.json \
  README.md docs/ACCOUNTS.md docs/PHASE-10B-RELEASE-CANDIDATE.md
git status --short   # expect only: ?? docs/audits/
```

Both sequences were simulated in a temporary index. Commit A was 2 files (+93/−1). After Commit B, the staged tree equals the working tree except `docs/audits/`.

## 25. Extension commit commands

```sh
git commit -F - <<'EOF'
Fix desktop extension auth callback encoding

Pass the completed sign-in URL to vscode.env.openExternal as a string. The Uri overload re-serializes the nested redirectUri query, so desktop VS Code's ?windowId reached stackstats.dev as %253F and the callback was rejected. Callback parsing, state, PKCE and token handling are unchanged. Adds a regression matrix for vscode, vscode-insiders, cursor and windsurf with and without windowId.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

```sh
git commit -F - <<'EOF'
Prepare StackStats 0.6.0 Marketplace release candidate (Phase 10B)

Set publisher StackStats and version 0.6.0 (StackStats.stack-stats-vscode). VS Code keeps the publisher's case in extension.id but lowercases the callback authority when serializing, so the URI handler also accepts that exact serialized authority; other casings, publishers and paths stay rejected. Add a packaged CHANGELOG, beta migration notes, a real VS Code auth-return smoke (pnpm test:vscode:auth), exact release identity checks in check:vsix and case-insensitive CLI matching in test:vsix. Document storage, SecretStorage, installation ID, settings and agent behavior across the identity change.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

## 26. Web staging block

Run from `/Users/fstopyra/Desktop/stack-stats/stack-stats-web` (branch `main`, level with `origin/main`):

```sh
git add -- src/lib/extension-auth.ts tests/extension-auth.test.ts tests/extension-api.test.ts tests/auth-callback.test.ts \
  tests/auth-continuation.test.tsx scripts/check-production.mjs docs/EXTENSION_AUTH.md docs/PRODUCTION_AUTH_SYNC.md \
  docs/MARKETPLACE_AUTH_060.md
git status --short   # expect nothing unstaged
```

**Deployment (Checkpoint C, needs your approval):**

1. In Vercel, confirm the project serving stackstats.dev deploys `userN7590/stack-stats-web` from `main`.
2. Run `git push origin main`.
3. Wait until the commit shows **Ready / Production** on stackstats.dev.
4. Run `npm run check:production -- https://stackstats.dev`.
5. Continue with §17.

Rolling the commit back removes release-identity sign-in; beta sign-in keeps working. Never fix a failed rollout by broadening the allowlist.

## 27. Web commit command

```sh
git commit -F - <<'EOF'
Allow Marketplace extension callbacks with strict window routing

Accept the 0.6.0 StackStats.stack-stats-vscode callback in VS Code's serialized lowercase form and its exact canonical spelling, keep the beta undefined_publisher callback temporarily, and compare native callbacks byte-for-byte with only a 1-10 digit windowId. Rejects look-alike publishers, mixed case, encoded or double-encoded separators and path normalization. No Supabase or database change.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

## Validation summary (2 October 2026)

| Check | Result |
| --- | --- |
| `pnpm test` | 383 passed (28 files) |
| Commit A alone (scratch tree): typecheck, build, test | Passed; 336 tests (27 files) |
| `pnpm typecheck`, `pnpm build`, `git diff --check` | Passed |
| `pnpm test:vscode:api`, `pnpm test:vscode`, `pnpm test:vscode:auth` (real VS Code 1.138.0) | Passed |
| `pnpm test:vsix` on the release candidate | Passed (7 UI checkpoints, uninstall/reinstall, interactive) |
| `pnpm check:vsix --release` + manual scan | Passed |
| `pnpm benchmark:provenance` | Completed (8 scenarios; no sync or provenance code changed in 10B) |
| Sync contract parity (v1 and `--require-v2`) against the production web repo | Passed |
| Web targeted auth tests / full `npm test` | 56 / 755 passed |
| Web `npm run lint`, `npx tsc --noEmit`, `npm run build`, `git diff --check` | Passed |
| Web `npm run test:db` | Not run: no local Docker daemon. No hosted database was used instead |

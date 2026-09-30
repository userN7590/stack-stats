# Phase 9E.1: One-click agent integrations

Phase 9E made Stack Stats agent-aware, but connecting Claude Code or Codex meant editing JSON by hand. This phase adds a configuration layer on top of the Phase 9E architecture. The hook, inbox, reconciler and ledger are unchanged in behavior. A user now clicks **Connect**, reads what Stack Stats will add, approves, and is done. **Disconnect** removes only what Stack Stats added.

Status: implemented and verified locally (§14). Not committed, pushed or published.

---

## 1. The problem with the Phase 9E setup

To attribute agent activity, a Phase 9E user had to:

1. find and enable `stackStats.agentIntegrations.claudeCode` or `.codex`;
2. run *Set Up Agent Integrations* and copy a JSON snippet;
3. merge it into `~/.claude/settings.json` or `~/.codex/hooks.json` by hand;
4. restart the tool and check manually that signals arrived.

The snippet also embedded the Node.js path found on the developer's `PATH` (here `/usr/local/bin/node`). On machines with nvm, Homebrew on Apple silicon, Windows or no system Node.js, that command was wrong or broke on the next upgrade. That was a release blocker for the Marketplace.

## 2. Final user flow

```text
Install Stack Stats
  → external changes are tracked automatically (writer unknown), no setup
Stack Stats sidebar → Agents
  External changes   Tracked automatically
  Claude Code        Not connected   [Connect Claude Code]
  Codex              Not connected   [Connect Codex]
Click Connect → native modal: what is added, what is reported, what is never reported → Connect
  Claude Code        Connected       Last activity: No activity received yet
  … use Claude Code normally …
  Claude Code        Connected · just now
Click Disconnect → modal → only Stack Stats entries removed
```

Codex adds one step that Stack Stats cannot and must not skip. Codex runs new hooks only after the user approves them in Codex. After connecting, the row reads **Approve in Codex** until the first Codex signal arrives.

Without an integration: external change → tracked → writer unknown.
With an integration: external change → tracked → labeled Claude Code or Codex where the agent's own hook reports it.

The sidebar, the confirmations and *Show Agent Activity* all use the same sentence: *"External changes are tracked automatically. Connect an agent to label them."*

## 3. Audit of the real configuration formats (read-only)

The audit was done before any mutation code was written. Nothing in the user's configuration was modified. All experiments used throwaway directories.

| | Claude Code 2.1.284 | Codex 0.155.0-alpha.16.3 |
| --- | --- | --- |
| Installed as | VS Code extension `anthropic.claude-code` (native binary inside it); **not on PATH** | VS Code extension `openai.chatgpt` (binary inside it); **not on PATH** |
| User config found | `~/.claude/settings.json`: 108 bytes, `model` and `modelSettings`, no hooks | `~/.codex/config.toml`: model, personality, per-project `trust_level`; **no `hooks.json`** |
| Leftover Phase 9E state | `~/.stackstats/agent-inbox-v1/state.json` had `claude-code: true`, but no hook was ever merged. The new UI reports this as *Needs attention: hooks are missing* with a one-click repair. | — |
| Config locations | User `settings.json` (`CLAUDE_CONFIG_DIR` overrides the directory); project `.claude/settings.json` and `.claude/settings.local.json`; managed settings | `$CODEX_HOME/hooks.json` (default `~/.codex`), `[[hooks.*]]` tables in `config.toml`, project `.codex/` (trusted projects only), plugins |
| Hook handler shape | From the bundled settings JSON Schema: `command` + optional **`args` (exec form, no shell)**, `timeout`, `async`, `statusMessage`, `if` | From the app-server protocol (`codex app-server generate-ts`): `command` (a **shell string**), `commandWindows`, `timeout`, `async`, `statusMessage`. **`args` is silently ignored**: verified with `hooks/list` |
| Trust | None for user settings; `disableAllHooks` and managed `allowManagedHooksOnly` can switch hooks off | `hooks.state."<key>".trusted_hash` in `config.toml`, written only by Codex's own review UI. The key is **positional**: `<file>:<event>:<group>:<handler>` |

**Codex trust experiment.** This used an isolated `CODEX_HOME` and Codex's own `hooks/list`, with no model call:

- A newly added hook reports `trustStatus: "untrusted"`.
- The trust hash does not depend on position.
- Removing a hook that sits before another user hook moves that later hook to a new key, and Codex then reports it **untrusted** again.

So Stack Stats must append its entries at the end of each list, and it must warn when disconnecting would move hooks that come after it.

**Chosen mutation targets:**

- **Claude Code: user `settings.json`** (honoring `CLAUDE_CONFIG_DIR`). It is the documented user scope, applies to every project, and needs no trust step. Project and local scopes belong to repositories. Managed settings belong to administrators.
- **Codex: user `hooks.json`** (honoring `CODEX_HOME`). It is an officially supported, isolated JSON file, so no TOML is ever written. `config.toml` is only *read*, and only to notice Stack Stats entries a Phase 9E user may have put there. Maintaining two parallel configurations is avoided (§6).

**Backup and failure strategy:** §8.

## 4. Integration manager architecture

`apps/vscode-extension/src/agent-integrations.ts` has no VS Code dependency, so every path runs in tests against temporary homes. Vendor JSON handling lives only there. `extension.ts` and the sidebar see only a normalized `IntegrationStatus`.

| Piece | Role |
| --- | --- |
| `integrationPaths(environment)` | All locations from `os.homedir()` or the vendor overrides (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `STACK_STATS_HOME`), using platform-specific path syntax |
| `managedHooks(tool, env)` | The exact entries Stack Stats owns on this machine, derived from each adapter's `hooks` list (the Phase 9E event and matcher choices are unchanged) |
| `ownershipTest(tool, env)` | Exact-signature ownership (§7) |
| `planConnect` / `planDisconnect` / `inspectHooks` / `preservesUnrelated` / `serializeLike` | Pure planning over parsed JSON |
| `installHookRuntime` | Hook, launcher and runtime hint (§6) |
| `AgentIntegrationManager` | `detect`, `status`, `statuses`, `previewConnect`, `connect`, `previewDisconnect`, `disconnect`, `installRuntime`, `manualSetup` |
| `connectPrompt` / `disconnectPrompt` / `statusSummary` | User-facing copy, kept pure so the privacy wording is tested |

**Status model** (the smallest honest set):

| State | Meaning |
| --- | --- |
| `not_detected` | No installation evidence: no vendor VS Code extension, no config directory, no CLI on `PATH`. No Connect button is shown. |
| `available` | Detected; no Stack Stats entries; setting off |
| `connected` | Setting on **and** every managed entry present exactly **and** the launcher and hook exist. Two separate flags: `verified` means a signal arrived since connecting; `approvalPending` means a Codex connection with no signal yet. |
| `needs_attention` | Partial or conflicting: paused (entries present, setting off), entries missing, outdated or legacy entries, runtime missing, `disableAllHooks`, Stack Stats entries found in Codex `config.toml` |
| `error` | The tool's config cannot be read or parsed. The message includes a line number only. |

Status comes from the tool's real configuration, never from the boolean setting alone. Detection executes nothing. It checks the vendor's VS Code extension ID, a directory `stat`, and a `PATH` scan that uses `PATHEXT` on Windows.

## 5. Claude Code strategy

- **Entries:** one matcher group per Phase 9E event (`SessionStart`, `PostToolUse` and `PostToolUseFailure` for `Bash|Edit|Write|MultiEdit|NotebookEdit`, `Stop`, `StopFailure`, `SessionEnd`). There is still no `UserPromptSubmit`.
- **Handler (POSIX):** `{ "type": "command", "command": "/bin/sh", "args": ["<home>/.stackstats/hooks/stack-stats-hook-v1.sh", "claude-code"], "timeout": 5 }`. The exec form involves no shell parsing, so spaces, quotes and `$` in the home path are harmless.
- **Handler (Windows):** `command` is `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`, with `args` `-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <launcher.ps1> claude-code`.
- **Connect also turns on** `stackStats.agentIntegrations.claudeCode` and writes the hook state. Disconnect turns it off.
- **Session reload:** the success message says new Claude Code sessions are labeled, and an already-open session may need a restart. Hooks are read at session start.

## 6. Codex strategy and the hook runtime

### Codex

- **Entries:** `SessionStart`, `PreToolUse` (`^Bash$`), `PostToolUse` (`^(Bash|apply_patch)$`), `Stop`, `Interrupt`, `SessionEnd`, as in Phase 9E. Codex itself parses all six (verified with `hooks/list`).
- **Command** (a shell string, because Codex has no argv):
  - POSIX: `/bin/sh '<launcher>' codex`, POSIX single-quoted;
  - Windows: `powershell.exe … -File "<launcher.ps1>" codex`, valid under cmd, PowerShell and Git Bash.
- **Trust:** Stack Stats never writes `hooks.state` or `trusted_hash`, never passes a bypass flag, and never runs Codex. The remaining user step is to approve the Stack Stats hooks in Codex: its startup review, `/hooks` in the CLI, or the Hooks settings page in the Codex extension.
  - **Detection:** the first Codex signal after connecting is proof that approval happened. The UI moves from *Approve in Codex* to *Connected*.
- **Position safety:**
  - Connect appends at the end of each list, so no user hook moves.
  - Upgrades replace Stack Stats entries in place.
  - Disconnect counts the user hooks whose position would change. The confirmation then says, for example, *"Codex … will ask you to approve 1 other hook listed after Stack Stats again."*
- **`config.toml`:** never modified. If it contains Stack Stats entries (a manual Phase 9E setup), the status is *Needs attention* with a message to remove them there. Stack Stats does not create a duplicate silently.

### Hook runtime and Node.js portability

Vendor entries now point at a **version-stable launcher**, never at a Node.js binary:

| File (in `~/.stackstats/hooks/`, or under `STACK_STATS_HOME`) | Content | Rewritten |
| --- | --- | --- |
| `stack-stats-agent-hook-v1.cjs` | The bundled hook (unchanged protocol) | When the bundled content changes |
| `stack-stats-hook-v1.sh` / `.ps1` | Launcher, generated by the extension | On upgrade, when its content changes |
| `hook-runtime-v1` | One line: the extension host's own runtime (`process.execPath`) | On every activation with an integration on, and on Connect |

What the launcher does:

1. Validates the tool argument.
2. Exits immediately if the hook or the state file is missing, tracking is paused, or this tool is off. This cheap pre-check is not the security boundary; the hook re-validates.
3. Runs `<runtime> <hook> <tool>` with `ELECTRON_RUN_AS_NODE=1`. Standard input passes through untouched, and `STACK_STATS_HOME` is pinned to its own home so the agent's environment cannot redirect records.
4. Discards stdout and stderr and always exits 0.

The runtime choice, in order:

1. **The editor's own runtime.** It is always present where the extension host runs: VS Code's Electron helper, `Code.exe`, or the Remote server's `node`. VS Code's own `code` CLI launcher uses the same `ELECTRON_RUN_AS_NODE` mechanism.
2. **`node` on `PATH`** (nvm, Homebrew on Apple silicon, system Node). This fallback covers a stale hint, for example after an editor update and before the next activation.
3. **Neither found:** exit 0 silently.

No global Node.js is assumed. The dogfood run proves it: a real Claude Code turn ran with `PATH=/usr/bin:/bin:/usr/sbin:/sbin`.

**Measured cost per hook invocation** (10 runs):

- VS Code's Electron helper: about 65 ms;
- `/usr/local/bin/node`: about 40 ms;
- plus about 2 ms for `sh`;
- when disconnected or paused, only the shell start.

The hook bundle now targets `node18` so an older `PATH` Node also parses it.

**Lifecycle:**

- Extension, editor and Node upgrades never change the vendor entries, so they need no reconnect and no Codex re-approval.
- If a future launcher needs a new argument contract, it will ship as `-v2`. The manager will recognize `-v1` and Phase 9E entries as its own and upgrade them in place on the next Connect or Repair. Codex will then ask once for approval, because the command changed.

## 7. Ownership detection

Neither vendor format has an ID or comment field. Ownership is therefore an **exact command signature** built from this home's paths:

- **Current:**
  - Claude: `command` equal to `/bin/sh` (or the PowerShell path), with `args` exactly `[<this launcher>, <tool>]`;
  - Codex: `command` exactly equal to the generated string.
- **Legacy (Phase 9E manual snippet):**
  - the argv form `args` exactly `[<home>/hooks/stack-stats-agent-hook-v1.cjs, <tool>]`;
  - or the string `"<runtime>" "<that script>" <tool>`, optionally prefixed with `ELECTRON_RUN_AS_NODE=1 `.

A user's look-alike hook is never recognized: another path, an unquoted `node "<script>"`, or a wrapper. Tests assert that such hooks survive Connect, upgrade and Disconnect.

## 8. Safe merge, disconnect and file handling

**Connect** (`planConnect`), idempotent:

- Existing Stack Stats entries, current or legacy, are updated **in place**.
- A group's matcher is changed only when the group holds nothing but the Stack Stats entry.
- Duplicates are removed.
- Missing entries are appended at the end of their event list.
- A second Connect produces identical bytes, and the file is not rewritten.

**Disconnect** (`planDisconnect`) removes every owned entry, and only the groups, event lists or `hooks` object that became empty *because of that removal*. For a normal configuration, connect followed by disconnect restores the original file byte for byte (tested, and seen in the dogfood run). The one exception is an event list that was already empty (`"Stop": []`) before Stack Stats filled it. It disappears with the entry, which is semantically identical.

**Every write:**

1. Parse with `JSON.parse` (an empty file counts as `{}`). Malformed JSON, a non-object root or a non-object `hooks` value stops everything, and nothing is written.
2. Plan in memory, re-serialize in the file's own style (indent, CRLF, BOM, final newline, minified form, key order), then **re-parse and verify**:
   - everything except Stack Stats entries is canonically identical (`preservesUnrelated`);
   - every managed entry is present, or none is after a disconnect.
3. Take a cross-window lock (`~/.stackstats/integrations`, the existing `proper-lockfile` helper).
4. **Compare-and-swap:** re-read the file. If another program changed it since it was read, abort with "changed while Stack Stats was updating it".
5. Respect a read-only file (checked with `access(W_OK)`) instead of replacing it through the directory.
6. Keep **one backup** per file: `~/.stackstats/integrations/backups/<tool>-settings.json.bak` or `codex-hooks.json.bak`. It holds the pre-change content, is overwritten on each change, and is stored with mode 0700/0600 because vendor settings can contain secrets. Nothing accumulates.
7. Write a temporary file in the same directory (`wx`, the original file's mode), `fsync`, then atomically `rename` it (retried briefly on Windows sharing violations). The temporary file is always cleaned up.
8. Symlinked configs (dotfile managers) are written at their real target so the link survives. A dangling link is an error, not a new file.

**Settings rollback and fail-closed disconnect:**

- A failed Connect restores the previous setting.
- A failed Disconnect still turns the setting off and rewrites the state file, so the hook records nothing further. The error explains that the entries remain.

**Order on Connect:** the Stack Stats side first (hook, launcher, runtime hint, setting, state), then the vendor file. An agent session that starts mid-connect therefore never finds a missing launcher.

## 9. Privacy

- The manager reads vendor configuration only to find and manage Stack Stats entries. It has no input for prompts, responses, transcripts, source, terminal output or payloads. Hook payload handling is unchanged: the Phase 9E adapters run in the hook process.
- Errors show a line number, never V8's parse message, which can quote file text. Logs record only error codes. Status objects carry no vendor values; a test serializes `statuses()` and asserts no settings values appear.
- Integration status, backups and last-signal marks are local only. Nothing new is synced, uploaded or published. A test asserts that the manager imports no sync, account, delivery or network module. The v1 sync contract parity check passes.
- New local data:
  - `agent-inbox-v1/last-signal-<tool>`: **one timestamp** per tool, no history;
  - one config backup per tool;
  - the launcher and runtime hint.
- Installation detection is local and read-only: an extension ID lookup, a directory `stat`, a `PATH` scan. It is shown only in this user's sidebar.

## 10. Error handling

| Situation | Behavior |
| --- | --- |
| Malformed JSON | *Can't read its settings · … isn't valid JSON (line N). Nothing was changed.* An **Open File** action is offered; Connect refuses |
| Non-object root or `hooks` | Structure error; nothing written |
| Read-only file, permission denied, read-only FS | Specific message; nothing written; setting rolled back |
| File changed during the update | Aborted (compare-and-swap); try again |
| Symlink target missing | Error; the link is left in place |
| Hooks missing, setting on | *Needs attention* → **Repair connection** |
| Entries present, setting off | *Paused* → Connect resumes; Disconnect removes |
| Legacy or outdated entries | *Needs attention* → Connect shows an **Update** confirmation |
| `disableAllHooks: true` | *Needs attention*, with an explanation |
| Stack Stats entries in Codex `config.toml` | *Needs attention*: remove them there (TOML is never edited) |
| Launcher or hook missing | *Needs attention* → repair reinstalls |

## 11. Platforms

| Platform | Status |
| --- | --- |
| macOS | Verified: unit, launcher and real-hook tests; both real VS Code smoke tests; dogfood with real Claude Code and Codex binaries and VS Code's runtime |
| Linux | Same POSIX code path (`/bin/sh`, POSIX quoting, `PATH` lookup); covered by the platform-neutral tests; not run on a Linux machine here |
| Windows | Architecture implemented: PowerShell launcher with raw-byte stdin forwarding, `%SystemRoot%` PowerShell path, `PATHEXT` lookup, backslash paths, replace retries, and Windows timeouts raised to at least 3 s for PowerShell cold start. Unit tests cover entry and path shapes. **Not run on Windows or with real Windows agents.** Group Policy that forbids `-ExecutionPolicy Bypass` would block the launcher. |
| Remote SSH / WSL / containers | The extension host, its homedir and the agents' config live on the same (remote) machine. The runtime hint is the remote server's `node` and is refreshed on each activation, with the `PATH` fallback in between. An agent on a different machine from the extension host is still not linked (Phase 9E limitation). |

## 12. UI

- **New native panel: Agents** (between Activity and Account). It shows:
  - *External changes: Tracked automatically*, with the zero-config message as tooltip;
  - one row per agent: *Not detected* (no action), *Not connected* → **Connect**, *Connected · last activity* → **Disconnect**, *Approve in Codex* with an explanation, *Needs attention* → **Repair** / **Disconnect**, or *Can't read its settings* → **Check again**;
  - *Show agent activity*.

  The panel title reads *Optional*, *N connected*, *Approval needed* or *Needs attention*. Its title bar holds Verify (refresh); Manage, Show Agent Activity, Disconnect All and Advanced sit in the "…" menu.
- **Confirmations:** native modal `showInformationMessage`, with **Connect/Update** or **Disconnect**, plus Cancel. No webview.
- **Commands:**
  - *Manage Agent Integrations* (QuickPick of applicable actions);
  - *Connect Agent…*, *Disconnect Agent…*;
  - *Disconnect All Agent Integrations*;
  - *Verify Agent Integrations*;
  - *Advanced: Show Manual Agent Integration Setup*.

  The old `stackStats.setupAgentIntegrations` ID remains for keybindings. It is hidden from the palette, installs the runtime as before, prints the advanced setup (launcher entries, no Node path) and offers *Manage Agent Integrations*. It never opens a focus-stealing picker.
- ***Show Agent Activity*** now opens with the zero-config message and the rule that human coding time is separate. It lists external observation first, then each agent's real connection status.
- **Settings:** `stackStats.agentIntegrations.claudeCode` / `.codex` remain; the hook needs them as the Stack Stats-side switch. They are described as *managed by Connect / Disconnect*, with a link to the command. Turning one off pauses labeling without removing hooks. Connect and Disconnect set them, so there is one control system.
- **First-run discovery:** deferred. The Agents panel and its tooltip are the only prompt. No notification nags about unknown writers.

## 13. Verification

- Status is re-derived on activation, on window focus, after every command, after setting changes, and once a minute. That means two small file reads and three `stat`s; no agent is run.
- *Connected · No activity received yet* until the first signal. The hook stamps `last-signal-<tool>` for every accepted signal, even one from a workspace this window does not claim. After that: *Connected · 2m ago*.
- **Verify** re-checks configuration, the hook runtime and the last signal. It never starts Claude Code or Codex and never creates a billable run.
- **Uninstall:**
  - VS Code cannot reliably ask for consent at uninstall time, so vendor files are not cleaned automatically.
  - Stack Stats offers *Disconnect All Agent Integrations*, and the README tells users to run it before uninstalling.
  - As a best-effort safety net, a `vscode:uninstall` hook (`dist/uninstall.cjs`) pauses Stack Stats' **own** state file, so leftover entries exit in the launcher pre-check.
  - Independently, the hook now **fails closed on a state file older than 30 days**. The extension refreshes it on activation and every 6 hours.

## 14. Tests and validation

**New: `tests/agent-integrations.test.ts` (25 tests).** Isolated temporary homes (paths with a space and an apostrophe), injected settings, clock and detection. It covers:

- detection (none, config directory, CLI on `PATH`, editor extension) and that detection creates nothing;
- status derived from config (missing, paused, runtime gone, partial repair, `disableAllHooks`);
- verified vs unverified;
- Claude Code:
  - connect with preserved unrelated settings, hooks, indentation and mode, the runtime installed, the setting enabled and a 0600 backup;
  - idempotent reconnect (bytes and mtime unchanged);
  - file creation;
  - disconnect restoring exact bytes;
  - malformed JSON (line number only, no secret echoed, nothing written, setting rolled back);
  - structure errors;
  - read-only file, unwritable directory, disconnect-when-stuck still disabling;
  - Phase 9E legacy upgrade in place with duplicate removal and look-alike user hooks preserved;
  - symlinked settings, dangling link;
- Codex:
  - string commands appended after user hooks, with approval pending until a signal;
  - idempotent reconnect;
  - the shifted-hook warning and user-only removal;
  - malformed `hooks.json`;
  - `config.toml` flagged but byte-identical;
- the pure planner round trip, drift detection, formatting preservation, and Windows entry/path shapes;
- privacy of status and confirmations, and that the manager has no sync or network imports;
- the Agents panel rows;
- the POSIX launcher: runtime and stdin, `STACK_STATS_HOME` pinning, silence, fail-closed cases, `PATH` fallback, no runtime at all;
- the **real hook bundled on the fly** through the launcher (record, last-signal mark, 30-day stale state failing closed);
- the uninstall hook pausing only Stack Stats state.

**Updated:**

- `agent-adapters.test.ts`: the managed entries replace the removed `setup()` snippet;
- `agent-hook.test.ts`: the fixture's `updatedAt` is now relative, because of the 30-day fail-closed rule;
- `sidebar-native.test.ts` and `vscode-api-smoke.cjs`: the Agents panel.

| Check | Result |
| --- | --- |
| `pnpm test` | **302 passed, 24 files** (277 before this phase + 25 new) |
| `pnpm typecheck` | Passed |
| `pnpm build` | Passed: `extension.cjs` 482 KB, `agent-hook.cjs` 209 KB, `uninstall.cjs` 191 KB |
| `pnpm test:vscode:api` (real VS Code) | Passed |
| `pnpm test:vscode` (real VS Code) | Passed |
| VSIX packaging (to a scratch path; tracked VSIXs untouched) | Passed: 9 files, 190.5 KB, including `dist/agent-hook.cjs` and `dist/uninstall.cjs` |
| `pnpm benchmark:provenance` | Passed all built-in count checks (e.g. 10,000 duplicates → 20 changes in 19 ms; summary over 55,000 records in 112 ms) |
| `check-sync-contract.mts` (read-only, both web checkouts) | v1 parity passed |
| `git diff --check` | Clean |

**Real-world dogfood.** This ran in an isolated home whose path contains spaces, parentheses and an apostrophe. Real manager code, the built hook, and VS Code's Electron helper as the runtime. The user's configs were only copied, never written.

- **Claude Code 2.1.284:**
  - begins *available*;
  - Connect merges 6 entries and keeps `model` and `modelSettings`;
  - one real `claude -p` turn (haiku, $0.023) with **no Node.js on PATH** and `--settings` pointing at the isolated file;
  - signals `session_started`, `tool_finished:edit`, `tool_finished:shell`, `turn_stopped` and `session_ended` arrived, all `claude-code`, with explicit `hello.txt` evidence and no prompt text;
  - status became *verified*;
  - Disconnect restored the copied settings **byte for byte**, and the hook then wrote nothing;
  - the tracking state stayed on.
- **Codex 0.155:**
  - Connect wrote `hooks.json`;
  - **Codex's own `hooks/list`** parsed all 6 entries (events, matchers, `source: user`), and each reported `trustStatus: "untrusted"`. That matches the UI's *Approve in Codex*;
  - the exact configured command strings, run through `/bin/sh -c` with Codex-shaped payloads, produced 4 `codex` records, including the `apply_patch` file, and did not record Stop's assistant message;
  - Disconnect left `{}`, and Codex listed no hooks.
  - **No real Codex model turn was run.** It requires approving the hooks in Codex, and Stack Stats (and this test) will not bypass or forge that approval.

## 15. Known limitations

- **Codex approval** is a manual step inside Codex. Stack Stats detects approval only through the first signal after connecting. Before that, the row says *Approve in Codex* even if the user already approved and has not used Codex since.
- **Open sessions:** hooks are read at session start, so an already-running Claude Code or Codex session is not labeled until it restarts.
- **Scopes not managed:** Claude project and local settings, managed settings (`allowManagedHooksOnly` hides user hooks), Codex project or plugin hooks. Codex `config.toml` is read only to warn. `[features] hooks = false` in Codex is not detected.
- **Look-alike user hooks** that call the Stack Stats hook script themselves are, by design, not recognized, and could double-report.
- **Formatting:** JSON is re-serialized in the file's own style. A pre-existing empty event list is not restored after disconnect (§8). JSON cannot carry comments, so none are lost.
- **Windows** is implemented but unverified with real agents (§11).
- **Uninstall:** vendor entries remain unless the user runs *Disconnect All* first. They are inert (paused state, and the 30-day fail-closed rule).
- **Detection signals:** a leftover `~/.claude` or `~/.codex` directory counts as installed. Connecting then only adds inert entries.
- **Multiple editors** share `~/.stackstats`. The last editor to activate writes the runtime hint, and any of them works.

## 16. Marketplace implications

Would this work for a student who installs Stack Stats from the Marketplace, uses Claude Code, has never opened a JSON settings file and does not know what a hook is? **Yes:**

- External changes are tracked from install.
- The Agents panel shows Claude Code as *Not connected* with a **Connect** button.
- One modal explains the change in plain language.
- No JSON, TOML, Node path, hook syntax or inbox is ever shown, except behind *Advanced*.
- The hook runs on the editor's own runtime, so no Node.js install is needed.
- Upgrades need no reconnect.
- Disconnect is one click and restores their settings.

For Codex the extra step is Codex's own approval prompt, which the UI names explicitly. Before publishing, consider a Windows smoke run with a real agent (§11).

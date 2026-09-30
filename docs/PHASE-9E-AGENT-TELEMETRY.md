# Phase 9E: AI / agent-aware development telemetry

Stack Stats now sees work that agents and other tools do outside the VS Code editor, reconciles each physical change into one record, and names an agent only when that agent's own hooks say so. Agent runtime is reported beside human coding time, never inside it. Everything in this phase is **local only**: nothing new is synced, published or sent to the daemon.

Status: implemented and verified locally (see §18). Not committed, pushed or published.

> **Setup superseded by [Phase 9E.1](PHASE-9E1-AGENT-INTEGRATIONS.md).** Users no longer copy hook JSON or enable settings by hand. **Connect** in the Agents panel adds the entries after confirmation, and **Disconnect** removes only them. Hook entries now run a version-stable launcher on the editor's own runtime instead of a machine-specific Node.js path. The manual snippet described below survives only as *Advanced: Show Manual Agent Integration Setup*. The telemetry model in this document is unchanged.

---

## 1. Audit: what Stack Stats captured before this phase

This audit was done against the working tree at the start of the phase: v0.5.0 plus the uncommitted Phase 9A changes. The code was read first; the behavior was then proven in a real, isolated VS Code instance (§2).

### 1.1 Every activity source in the extension

| Source | Where | Feeds |
| --- | --- | --- |
| `workspace.onDidChangeTextDocument` | `extension.ts` → `DocumentCollector` | **The only input to sessions**: session start/extension, active time, edits, line boundaries, files, languages, projects; also `editor.edit` / `activity.interval` telemetry |
| `onWillSaveTextDocument` / `onDidSaveTextDocument` | `workflow-collectors.ts`; `extension.ts` | `file.saved` telemetry; save time only *expires* idle sessions, never extends them |
| `onDidCreate/Delete/RenameFiles` | `workflow-collectors.ts` | `file.lifecycle` (VS Code–initiated operations only) |
| `createFileSystemWatcher("**/*")` (one recursive watcher) | `workflow-collectors.ts` | `filesystem.changed`: coalesced notification **counts**, origin `editor_correlated` if within 2 s of a save/file operation, otherwise `unknown` |
| `onDidChangeActiveTextEditor`, `onDidChangeWindowState` | both | Break the active-time evidence interval; `context.switched`, `window.focus` |
| Tasks, debug sessions, diagnostics (opt-in) | `workflow-collectors.ts` | Lifecycle/count telemetry |
| Git polling (≤ 1/min, trusted workspaces) | `git-observer.ts` | HEAD/branch/commit metadata and numstat |
| `api.reportAttribution` (opt-in) | `extension.ts` | `attribution.report`: annotates **existing `editor.edit` batches only** |

No terminal output, clipboard, process list or Git working-tree diff is read.

### 1.2 What causes each metric

| Metric | Exact cause |
| --- | --- |
| Active time | Gap of ≤ 60 s between two **recorded** editor edits. No heartbeat and no tail credit. |
| Additions/removals | `countLineChanges` over recorded edits' `contentChanges`: inserted newline boundaries / removed range line spans. These are *editor line boundaries*, not a diff. |
| File touched | A recorded edit's salted `(projectId, fileId)`. |
| Language / project activity | The recorded edit's document language and workspace folder. |
| Session continuation | A recorded edit less than 5 minutes (configurable 1–60) after the previous one. |
| "Recorded edit" | A nonempty change to a `file`/`untitled` document that is **visible**, in a **focused** window, not excluded, and **dirty**. A change that arrives with the document still clean must be confirmed by a dirty-state event for the same version within 1 s; undo/redo and untitled documents are exceptions. |

Consequence: a write that reaches disk without going through a focused, visible, dirty editor document is never an edit, never time and never a line.

## 2. Experiments performed

Harness: a dedicated extension-test script ran 20 scenarios inside a real, isolated VS Code 1.95+ window (temporary profile, workspace and Git repository) with the current Stack Stats build. It recorded only event **shapes**: range lines/columns, lengths, newline counts, dirty/visible/focused flags and watcher operations. It also recorded Stack Stats session and telemetry deltas per scenario. No file text was logged. Separately:

- **Claude Code 2.1.284 file writes:** I (running as Claude Code) edited a scratch file with the real Edit and Write tools while an fs watcher and inode checks observed the result.
- **Codex 0.155 `apply_patch`:** the real implementation was run offline through the binary's `--codex-run-as-apply-patch` dispatch. No model was involved.
- **Real headless agent runs** with isolated hook configuration and a payload-dumping hook, in throwaway directories:
  - `claude -p` using `--settings <temp file>`;
  - `codex exec` with `--ephemeral --ignore-user-config --dangerously-bypass-hook-trust`.

  Each run was one trivial prompt: create a file, edit it, run `ls`. Only redacted field names and types were inspected, and the raw dumps were deleted. User configuration was not modified. Cost: Claude about $0.12; Codex about 8k tokens.

### 2.1 Results (pre-9E behavior)

"Watcher" counts are notifications seen by an extension `FileSystemWatcher`; "fs unknown" is the resulting `filesystem.changed` telemetry counter.

| # | Action | VS Code document events | Watcher events | Counted? (edits / time / lines) | Duplicates | Provenance knowable? |
| --- | --- | --- | --- | --- | --- | --- |
| A | Human types (`type` command) | Clean first change + dirty confirmation, then dirty changes | none until save | **Yes**: 35 edits, +2 lines, 1.3 s | — | No: VS Code has no author field; actor unknown |
| B | Paste 60 lines | 1 change, 60 newlines | — | **Yes**: 1 edit, +60 lines, 3.3 s (gap from previous edit) | — | No (size is not evidence) |
| C | Refactor-style `WorkspaceEdit` (visible + closed file), Save All | Visible: dirty change; closed: change with `visible=false` | save → created + changed | Visible part **yes**; invisible part dropped; save = `editor_correlated` | 2 watcher per save | No |
| D1/D2 | Formatter via Format Document / format on save | Formatter not invoked: the test host cannot answer VS Code's formatter selection | — | Not exercised (limitation) | — | — |
| D3 | Save participant (`onWillSave` `waitUntil` edits: the format/organize-on-save mechanism) | Dirty change **between will-save and did-save** | 2 | **Yes**: counted as editor edits and lines, **and extended active time by 344 ms** | — | Correlated only (lifecycle window, not a cause field) |
| E | Shell `>>` append to closed file | — | 2 × changed (same ms) | **No**; fs unknown +2 | 2 per write | No |
| F | Script truncate+write closed file | — | 2 × changed | No; +2 | 2 | No |
| G1 | Claude-style temp+rename, closed file | — | created(target), deleted(tmp), changed(target), deleted(tmp) — temp **never reported created** | No; +4 (temp file included) | 4 | No |
| G2 | Claude-style, open visible clean file | **Reload**: clean change, whole-line range (lines 1–2 → 2 newlines), `reason` undefined | as G1 | No (collector drops unconfirmed clean change); +4 | 4 + reload | No |
| H1 | **Real Codex `apply_patch`**, open visible file | Reload, whole-line range | 2 × changed | No; +2 | 3 | No |
| H2 | Real Codex, closed file + Add File | — | changed×2, created×2 | No; +4 | 2 per file | No |
| I / J | External create / delete | — | created×2 / deleted×2 | No; +2 each | 2 | No |
| K2 | External write, open **hidden** tab | Reload with `visible=false` | 2 | No | 3 | No |
| K3 | External write, open **dirty** file | none (conflict; no reload) | 2 | Pre-existing user edit counted normally; external write not | 2 | No |
| M | 120 files written in a burst | — | 139 (120 created, 19 changed) | No; +139 | partially coalesced | No |
| N | Human edit, then 7 agent-style writes over 70 s idle | 1 human change | 28 | Human edit only: +1 edit, **+0 time**; session end = human edit | 4 per write | No |
| O | Human edits the agent-changed open file | Normal change | — | **Yes**, normally | — | No |
| R | File: Revert on a dirty document | Clean change shaped exactly like a reload | **none** | No | — | n/a |
| V | `git checkout` switching 40 tracked files | Reload for the open file | `.git/HEAD` created, `.git/index` created, `.git/logs/HEAD` changed, 40 × changed | No; +40 (`.git` excluded by policy) | — | No; VCS refs visible transiently |
| T | Temp file created and deleted | — | created, deleted | No; +2 | — | No |

Physical write mechanics observed:

| Writer | Mechanism | Evidence |
| --- | --- | --- |
| Claude Code Edit/Write | Writes `<file>.tmp.<pid>.<hex>` then renames over the target (inode changes) | fs.watch + inode before/after my own tool calls |
| Codex `apply_patch` | Writes in place (same inode, no temp file) | Real binary, offline |
| VS Code save | created/changed pair from the watcher | Scenario C/D |

### 2.2 Real hook payloads (field names verified, values discarded)

| | Claude Code 2.1.284 | Codex 0.155 |
| --- | --- | --- |
| Integration surface | Documented hooks (`~/.claude/settings.json`, project settings, or `--settings`) | Documented hooks (`~/.codex/hooks.json` or `[[hooks.*]]` in `config.toml`); JSON Schemas for every hook input are embedded in the binary; feature `hooks` is *stable* and on by default. **New hooks must be trusted by the user.** |
| Turn identity | `prompt_id` on tool, Stop and SessionEnd events | `turn_id` on tool and Stop events |
| File-edit tools | `Edit`, `Write`, `MultiEdit`, `NotebookEdit`: `tool_input.file_path`; `tool_response.structuredPatch` (Claude's own hunks), `type: create/update`, `originalFile` | `apply_patch`: `tool_input.command` is the patch (`*** Add/Update/Delete File:` headers, `+`/`-` lines); `tool_response` is a string starting `Exit code: N` |
| Shell | `Bash`, `tool_input.command`; **`PostToolUse.duration_ms`** | `Bash`, `tool_input.command`; no duration, so PreToolUse is needed |
| Sensitive fields present | `transcript_path`, `last_assistant_message` (Stop), prompt (UserPromptSubmit), `originalFile`, `content`, stdout | `last_assistant_message`, prompt (UserPromptSubmit), full patch text, command output |
| First signal of a turn | First tool call (5.3 s after prompt in the test) | First tool call (8.1 s after start) |

## 3. Coverage gaps found

1. **Agent and external work was invisible.** Shell writes, scripts, Claude Code, Codex, creates, deletes, bursts and checkouts never appeared in the sidebar, sessions or sync. They surfaced only as a raw `filesystem.changed` notification counter in developer JSON. That counter was inflated about 2× by duplicate watcher layers, and Claude's temp files added more.
2. **The existing provenance API could not represent agent writes.** `attribution.report` annotates `editor.edit` batches, and agent disk writes never create one.
3. **No agent run or runtime model.**
4. **Free line data was discarded.** VS Code computes whole-line reload edits for open documents, and the collector threw them away.
5. **No reconciliation.** One write produced 2–4 notifications plus an optional reload; saves were correlated only by a 2 s window.
6. **Tool edits inside the editor are indistinguishable.** Save participants (format/organize/fix on save) count as editor edits and extend active time; `WorkspaceEdit`s to visible documents (refactors, in-editor AI) look like typing. VS Code exposes no cause (`TextDocumentChangeReason` is only Undo/Redo).
7. **Bulk VCS churn** appeared as N unrelated notifications.

## 4. Chosen event model

A normalization boundary (`apps/vscode-extension/src/external-observer.ts`, plus the vendor adapters) converts VS Code events, watcher notifications and hook payloads into editor-independent observations. The pure core (`packages/core/src/provenance.ts`) never sees VS Code or vendor shapes.

```text
VS Code watcher ─┐   document reloads ─┐   saves/file ops ─┐   .git ref notifications ─┐
                 └────────────── ExternalObservation (transient keys, salted IDs) ─────┘
Claude/Codex hook → adapter (hook process) → inbox record (metadata) → AgentChangeReport / tool window / turn signal
                                   ↓
                       ChangeReconciler (bounded, pure)
                                   ↓
     CanonicalChange ─────→ provenance-v1 ledger (local only) ←──── agent signal records
                                   ↓
           summarizeAgentActivity (+ local editor.edit/activity.interval telemetry)
```

`CanonicalChange` (persisted as `ProvenanceChangeRecord`, strict schema in `packages/protocol/src/provenance.ts`):

| Field | Meaning |
| --- | --- |
| `recordId` | UUID; deterministic for inbox-derived records so a replay deduplicates |
| `firstObservedAt`, `observedAt` | Observation span of the reconciled burst (observation time, not write time) |
| `projectId`, `fileId` | Existing salted identities, identical to session/telemetry IDs (joinable locally) |
| `languageId` | Open document's language, else inferred from the file name (`languageFromPath`), else `unknown` |
| `operation` | `created` · `modified` · `deleted` · `bulk` |
| `origin` | `agent_adapter` (explicit hook report) · `external` (observed on disk) |
| `actor` / `tool` / `confidence` / `reason` | See §5–6 |
| `agent` | Salted `sessionKey`, `turnKey`, `callKey` |
| `delta` | `{linesAdded, linesRemoved, source: adapter · document_reload}` in **diff lines**, or `null` |
| `observations` | How many watcher / reload / adapter observations the record reconciles |
| `bulk` | Aggregate file/operation counts for bulk records |
| `supersedes` | Earlier records replaced by a late explicit report |

Editor edits are **not** duplicated into the new ledger. Existing `editor.edit` telemetry already is the canonical editor stream; analytics reads it as origin `editor`, actor `unknown` (or a provider-reported claim).

Agent signals are persisted as metadata records (`ProvenanceAgentRecord`): `session_started`, `tool_started`, `tool_finished`, `turn_stopped`, `interrupted`, `session_ended`, carrying tool kind, duration, a VCS boolean, success and end reason. Runs are **derived** from these records on read (§13), so there is no mutable open-run state to lose in a crash.

## 5. Provenance taxonomy

Separate dimensions instead of one overloaded enum:

| Dimension | Values | Backed by |
| --- | --- | --- |
| Origin | `editor` (existing telemetry), `external`, `agent_adapter` | Which channel established the change |
| Actor | `agent`, `unknown` (plus `human`/`ai` only via the pre-existing explicit attribution report API) | Evidence only; **no automatic "human"**, because nothing observed proves it |
| Tool | `claude-code`, `codex`, `cursor`, `other` (existing agent vocabulary) | Present only when actor is `agent` |
| Unknown reason | `no_evidence`, `vcs_operation`, `bulk_change`, `ambiguous_agents` | Why no actor was assigned |

Deliberately **not** in the taxonomy:
- **`tool` actor for formatters.** Save participants are reported as a correlated *subset* counter of editor edits instead (§21 of the brief; see §12).
- **An "AI-assisted editor" class.** Nothing VS Code exposes supports it.

## 6. Confidence and evidence model

| Level | Rule |
| --- | --- |
| `explicit` | The agent's own hook reported this file in a successful edit-tool completion: Claude `PostToolUse` for Edit/Write/MultiEdit/NotebookEdit; Codex `apply_patch` with `Exit code: 0`. |
| `correlated` | The whole external burst lies inside **one** agent's shell-command window in the same workspace, with a 1 s lead and 1.5 s grace. The window is Codex PreToolUse→PostToolUse, or Claude's `PostToolUse` time minus `duration_ms`. There must be no VCS signal and no second agent. |
| `none` | Everything else. |

No timing-only, size-only, speed-only or "an agent was open" rule can assign an agent. Timing is used only to narrow provenance: to merge duplicates, to suppress VS Code's own saves, and to refuse attribution during VCS operations.

## 7. External-file strategy

**Mechanism: reuse the one existing VS Code `FileSystemWatcher("**/*")`** via a fan-out callback in `WorkflowCollectors`. No second recursive watcher is created, and no Node `fs.watch`/chokidar is used.

| Option | Verdict |
| --- | --- |
| VS Code workspace watcher | **Chosen.** Already running; honours `files.watcherExclude`; runs where the extension host runs (Remote SSH/containers/Codespaces); no extra CPU. Reports about 2 notifications per write, which are reconciled. |
| Document reload events | **Chosen for deltas.** Free, exact whole-line diffs for open documents; no text retained. Needs watcher corroboration, because Revert has the same shape. |
| Node `fs.watch` / chokidar | Rejected: duplicates VS Code's watcher, poor on remote/network filesystems, and a large-monorepo CPU and handle cost. |
| Git diff snapshots | Rejected for per-change use: a repository-wide diff after every write is expensive, excludes untracked files, and conflates branch state with activity. Git numstat remains in existing commit telemetry. |
| Persisted content fingerprints/snapshots | Rejected: would build a source cache or fingerprint database (§12). |

Eligibility reuses `DocumentMetadata.fromUri` → `PrivacyPolicy` (built-in secret/generated exclusions, `excludeFiles`, `excludeProjects`), plus:
- Transient artifacts (`*.tmp.<pid>.<hex>`, `.tmp`, `~`, vim swap/`4913`, emacs locks, `.crswap`) are dropped and counted.
- Common binary extensions are dropped and counted.
- `.git` ref paths are a transient VCS signal only.

Remote, containers, Codespaces and SSH: observation happens on the extension-host machine. Workspace trust: nothing here executes workspace code. Symlinked roots: hook paths are matched raw and via `realpath` against folder realpaths (macOS `/tmp` → `/private/tmp`). Case-mismatched paths on case-insensitive filesystems are not reconciled.

## 8. Deduplication strategy

`ChangeReconciler` (pure, bounded):

1. **Per-file bursts.** Observations of one file less than 2 s apart form one burst, capped at a 30 s span. Duplicate watcher layers and a reload merge into one candidate.
2. **Absorbed by explicit report.** An adapter report for the file within ±3 s absorbs the burst (counted as `watcherAbsorbed`/`reloadAbsorbed`, not emitted).
3. **Reload without disk corroboration** is dropped (`uncorroboratedReloads`). This is Revert, or a watcher miss.
4. **Editor write suppression.** A save or VS Code file operation on the file within ±2 s explains the watcher events, unless a reload shows the disk differed from the editor.
5. **Ephemeral files.** Created-then-deleted within the burst are dropped.
6. **Settle window.** Bursts finalize 20 s after their last observation, because the agent inbox is read every 15 s. They stay held while an agent command in the same workspace is still open (up to 10 min, released under queue pressure).
7. **Late explicit reports.** An unattributed change finalized before its explicit report arrived is replaced through `supersedes`, never double counted. Explicit records are persisted immediately at ingestion.
8. **Bulk.** More than 25 distinct files in a near-simultaneous cluster (gaps ≤ 500 ms, span ≤ 30 s) become one unattributed `bulk` record; explicit reports are unaffected.
9. **Replay safety.** Readers deduplicate by `recordId`; inbox-derived IDs are deterministic.

Content fingerprints turned out to be unnecessary. Same-file identity, bounded time windows, the reload/dirty-state protocol and explicit call identities are sufficient, so **no hashes of content are computed or stored**.

## 9. Agent adapter architecture

Two layers, neither of them in core:

- **`AgentHookAdapter`** (`apps/vscode-extension/src/agent-adapters.ts`, no VS Code dependency) has `id`, `displayName`, `hooks` (events/matchers it needs), `normalize(payload) → AgentInboxRecord | undefined`, and `setup(command)` (config snippet and notes). Claude Code and Codex are implemented. Normalization happens **inside the hook process**. Vendor IDs are hashed there, only headers, prefixes and line counts of patches and snippets are read, and everything else is discarded before anything touches disk.
- **Hook executable** (`agent-hook.ts` → `dist/agent-hook.cjs`). It is copied to a version-stable path, `~/.stackstats/hooks/stack-stats-agent-hook-v1.cjs` (or under `STACK_STATS_HOME`). It:
  - reads `agent-inbox-v1/state.json` and **fails closed** when that file is missing or invalid, tracking is paused, or the integration is off;
  - bounds stdin (32 MiB) and runtime (4 s), prints nothing, and always exits 0;
  - applies exclusions, binary and transient filters early;
  - writes one atomic record, with the inbox capped at 5,000 records (drops beyond that are counted).
- **Inbox → extension**. `AgentInbox.drain` holds a cross-window lease (the existing `proper-lockfile` helper).
  - A window claims a record only if its `cwd` or its files are inside that window's workspace folders.
  - Claimed records are written durably to the ledger **before** they are deleted.
  - Unclaimed records wait up to 14 days. Invalid, expired and disabled-tool records are deleted and counted.
- **Core** receives only normalized `AgentChangeReport`, tool windows and turn signals.

New adapters (Copilot, Cursor, Windsurf, JetBrains AI, custom agents) implement `AgentHookAdapter` for hook-style tools. In-process sources can feed the same normalized reconciler methods. Nothing in core names a vendor except the shared tool enum.

## 10. Claude Code findings

**Supported (explicit), opt-in.** Hooks used:
- `SessionStart`;
- `PostToolUse` and `PostToolUseFailure` for `Bash|Edit|Write|MultiEdit|NotebookEdit`;
- `Stop`, `StopFailure`, `SessionEnd`.

**Not used:**
- `UserPromptSubmit`, because it carries the prompt;
- `PreToolUse`, because `duration_ms` already bounds shell windows.

What the adapter extracts:
- Diff lines from `structuredPatch` (exact, including `replace_all` and Write-over-existing).
- A created file's lines from Write `type: "create"`.
- Otherwise a bounded Myers diff of `old_string`/`new_string`, or `null` when `replace_all` gives no patch.

The file write is atomic temp+rename; the temp file is ignored.

## 11. Codex findings

**Supported (explicit), opt-in.** Hooks used:
- `SessionStart`;
- `PreToolUse` for `^Bash$`;
- `PostToolUse` for `^(Bash|apply_patch)$`;
- `Stop`, `Interrupt`, `SessionEnd`.

`apply_patch` files are reported only with `Exit code: 0`. Paths may be relative (resolved against `cwd`); moves become deleted + modified. Codex requires the user to **trust** new hooks (`/hooks`). Writes are in place.

Validated against real `codex exec` payloads and the input JSON Schemas embedded in the binary. The CI tests use fixtures of the same shape and do not depend on the binary.

## 12. Human-time semantics (unchanged)

- Sessions, active time, edits, line boundaries, files, languages, projects and streaks are computed exactly as before, by the unchanged `DocumentCollector`/`SessionTracker`.
- External and agent observations are never passed to `SessionTracker`.
- Verified: pure tests show editor totals are identical with and without provenance; both real VS Code smokes show that idle agent-style writes leave the current session's end time, edit count and active time unchanged, and that a human follow-up edit counts normally.
- **Existing behavior kept and now disclosed:**
  - save-participant edits still count as editor edits and can add active time (D3);
  - in-editor `WorkspaceEdit`s to visible documents still count.

  Phase 9E adds a correlated **subset** counter for the first (`save_participant` records: edits and lines observed between will-save and did-save), reported as "of which during save participants", never subtracted.

## 13. Agent-time semantics

- A **run** is one agent turn delimited by the vendor's lifecycle hooks: grouped by tool + salted session + turn key (sequence-based when a turn ID is absent).
- **Start** is the first observed signal of the turn, usually its first tool call. Claude's shell start is `PostToolUse` minus `duration_ms`. This is a **lower bound**: thinking before the first tool call is not observed without the prompt-bearing hook.
- **End states:**
  - `completed` (Stop);
  - `interrupted` (StopFailure/Interrupt);
  - `ended` (SessionEnd without Stop);
  - `running` (a signal within the last 30 min);
  - `incomplete` (stale, ending at its last signal).
- Metrics:
  - **observed run time** (sum of clipped spans);
  - **agent wall time** (union of spans across agents);
  - **overlap with editor activity** (intersection with existing `activity.interval` evidence);
  - runs with and without file changes, tool and shell call counts.
- Agent time is never added to, and never extends, human coding time.

## 14. Local storage changes

| Location | Contents | Lifecycle |
| --- | --- | --- |
| `globalStorage/provenance-v1/<batchId>.json` | `{storageVersion:1, batchId, records[1..1000]}`: change, agent, save_participant, coverage records | Append-only atomic batches; strict per-record validation (invalid records are discarded without blocking); in-memory queue bounded at 20,000 on write failure; corrupt batches preserved with a warning; pruned at activation by `stackStats.rawRetentionDays` (default 30; 0 = keep) |
| `$STACK_STATS_HOME` or `~/.stackstats/agent-inbox-v1/records/<ms>-<uuid>.json` | Transient hook records, including absolute paths | Created only after an integration is enabled; deleted on ingestion; 14-day expiry; 5,000-record cap; 0700 directory, 0600 files |
| `…/agent-inbox-v1/state.json` | `{stateVersion:1, collecting, integrations, excludeFiles, updatedAt}` | Rewritten on activation and setting changes |
| `…/hooks/stack-stats-agent-hook-v1.cjs` | Bundled hook copy | Rewritten only when the bundled content changes |

Nothing existing was migrated or reinterpreted. `sessions-v1`, `telemetry-v2`, `hourly-v1`, `profile-sync-v1` and SQLite are untouched. Historical activity keeps no provenance: it is read as editor origin, actor unknown, and no history is re-labeled.

## 15. Sync and privacy boundaries

| Data | Classification (Phase 9E) |
| --- | --- |
| Canonical change records, agent signals, runs, save-participant subset, coverage | **Local only** |
| Hook inbox records with transient paths | **Local only**, deleted on ingestion |
| Aggregate agent statistics | Potential future *private* sync (not implemented) |
| Public agent statistics | Not published; needs a later explicit metric design |

These guarantees are structural, not policy:
- Provenance is not in `telemetry-v2`, so it never reaches the daemon or the hourly projection that feeds v2 sync. Tests prove the telemetry schemas reject provenance records.
- `ProfileSyncService` still reads only session snapshots and hourly aggregates.
- v1/v2 sync code and contracts are unchanged; the parity check passes.

Enabling an integration does not enable sync or publication.

## 16. Threat model (AI telemetry specific)

| Risk | Mitigation |
| --- | --- |
| Revealing which AI vendor or employer tooling a developer uses | Local only; opt-in per tool. Since 9E.1, installation *detection* (extension ID, config directory, CLI on PATH) runs locally and read-only, is shown only in the user's own sidebar and is never uploaded |
| Work-schedule exposure | Run timestamps stay local; no upload |
| Prompts / responses / transcripts | Prompt-bearing hooks not installed; `last_assistant_message`, `transcript_path`, `originalFile`, `content`, command text and output are ignored in the hook process; the schema has no field that could hold them |
| Command history and secrets | Only a derived `vcs` boolean survives from shell commands |
| Filenames and paths | Paths exist only transiently in the 0700 inbox; ledger records hold salted IDs; exclusions applied twice (hook and extension) |
| Private repository / project names | Salted project IDs; excluded projects' records are consumed and never recorded |
| Source-code fingerprinting | No content hashes computed or stored; diff-line counts only |
| Vendor ID linkage | Session/turn/call IDs hashed in the hook and salted again before persistence |
| Forged hook records | A local process could write inbox records. Records are claims (like attribution reports), labeled `explicit` = "reported by the agent's hook", not cryptographically attested. |
| Hook breaking the agent | Always exits 0, prints nothing, 4 s self-timeout, 32 MiB input cap |

## 17. Performance limits

| Bound | Value |
| --- | --- |
| Pending observations | 5,000 (overflow counted as a coverage record) |
| Settle / burst / bulk chain / max span | 20 s / 2 s / 500 ms / 30 s |
| Tool window hold | 10 min (released when the queue is over half full) |
| Retained correlation state | 10 min, ≤ 5,000 entries per list |
| Inbox | ≤ 500 records per drain, 5,000 on disk, 256 KiB per record |
| Hook | 32 MiB stdin, 4 s; diff budget of 4M steps, then `null` |
| Ledger queue | 20,000 records |

Per keystroke the only added work is a map lookup and flag checks; there is no disk I/O. Per watcher event: an eligibility check and an array push. Reconciliation runs on the existing 15 s timer. The bundled hook measured a **median 55 ms / p95 68 ms** wall time per invocation (Node startup dominated).

## 18. Tests and validation

**New tests (55):**
- `provenance-reconciler.test.ts` (18);
- `provenance-summary.test.ts` (7);
- `agent-adapters.test.ts` (10);
- `agent-hook.test.ts` (5; spawns the real hook);
- `provenance-storage.test.ts` (10);
- `external-observer.test.ts` (5; mocked VS Code, full ingestion path).

They cover: duplicate merging, save suppression, reload deltas and Revert, explicit absorption and late supersede, correlation windows, ambiguity, VCS and bulk churn, steady-stream settling, queue pressure and caps, run states, analytics separation, Claude/Codex payload normalization with privacy assertions, hook fail-closed behavior, exclusions, the overflow cap, exactly-once multi-window inbox draining, persistence failure, ledger restart/corruption/retention/validation, schema rejection of unsupported claims, and telemetry-stream isolation.

**Real VS Code smoke tests:**
- **API smoke:**
  - closed-file, open-file (reload diff lines) and 30-file external writes;
  - zero edits, time and sessions afterwards;
  - Claude Code and Codex lifecycles through the **bundled hook run by the editor's own runtime**;
  - no double counting;
  - nothing private in the ledger;
  - disabled integrations write nothing.
- **Interactive smoke:** idle agent-style writes do not start or extend a session and add no time; a human follow-up edit counts normally.

| Check | Result |
| --- | --- |
| `pnpm test` | **277 passed, 23 files** (222 pre-existing + 55 new) |
| `pnpm typecheck` | Passed |
| `pnpm build` | Passed (`extension.cjs` 438 KB, `agent-hook.cjs` 210 KB) |
| `pnpm test:vscode:api` | Passed |
| `pnpm test:vscode` | Passed |
| VSIX packaging (to a scratch path; the tracked 0.5.0 VSIX is untouched) | Passed: 8 files, 145 KB, includes `dist/agent-hook.cjs` |
| `check-sync-contract.mts` against the web repo (read-only) | v1 parity passed |
| `git diff --check` | Clean |
| `pnpm benchmark:provenance` | Passed all built-in count checks (below) |

Benchmark (synthetic, in-memory; every scenario asserts its expected canonical counts). "Quiet" is a run at normal load; "loaded" is the slowest run seen while the machine sat at load average about 27:

| Scenario | Canonical output | Quiet | Loaded |
| --- | --- | --- | --- |
| 100 files × 2 notifications, 50 explicitly reported | 50 changes, 100 absorbed | 2 ms | 20 ms |
| 1,000 file events, one burst | 1 bulk record, 0 attributed | 6 ms | 66 ms |
| 10,000 duplicate notifications, 20 files | 20 changes, 9,980 merged | 19 ms | 211 ms |
| 200 agent commands × 5 files | 1,000 correlated | 10 ms | 57 ms |
| 20,000 observations vs 5,000 cap | 5,000 accepted, 15,000 counted drops | 39 ms | 269 ms |
| Simulated hour, 1 write/s | 3,600 changes, max 20 pending, 0 left | 49 ms | 619 ms |
| Summary over 55,000 records | 50,000 explicit | 107 ms | 2.3 s |
| Normalize 1,000 hook payloads (1,000-line patches) | 2,000 records | 116 ms | 924 ms |

Heap growth stayed at 10–480 KiB per scenario apart from the 1,000-file burst (about 1.6 MiB transient). The benchmark caught and drove the fix for a real defect: an endless burst/cluster under steady streams, which peaked at 3,586 pending before the fix and 20 after.

## 19. Known limitations

- **Integration coverage.**
  - Codex and Claude integrations must be connected (one click since 9E.1; Codex additionally asks the user to approve the hooks). Without that, agent writes are counted as unknown external changes.
  - Hook-based agents running on a different machine from the extension host (e.g. agent on the host, workspace in a container) are not linked.
- **Run and change semantics.**
  - Run start is a lower bound. Pure-chat turns are zero-length runs.
  - Correlated changes can include another process's write that lands inside an agent's command window in the same workspace.
  - Near-simultaneous independent writes of more than 25 files become one bulk record. VCS detection needs `.git` inside the workspace or a VCS shell command from a hooked agent.
- **Deltas.** External-change line counts exist only for documents open in VS Code. Explicit Write-over-existing without `structuredPatch`, `NotebookEdit` and deletions have `null` deltas.
- **VS Code limits.**
  - Watcher misses (excluded folders, OS event loss) lose external changes; a reload without a watcher event is dropped by design.
  - Directory events may appear as file changes.
- **Timing and crashes.**
  - About 35 s of pending observations can be lost on a crash.
  - Recording is delayed 20–35 s.
  - Disabling an integration purges its unread inbox records.
- **Out of scope for this phase.**
  - Save participants and in-editor tool/AI edits still count as editor activity (unchanged, disclosed).
  - No code-survival, authorship or "AI-written %" measurement exists or is implied.

## 20. Deferred work

- **Opt-in and setup.**
  - ~~Opt-in UI flow that writes vendor hook configuration with consent~~: done in Phase 9E.1.
  - Optional prompt-free turn-start signal if a vendor adds one; `UserPromptSubmit` stays excluded.
- **More tools.** Copilot, Cursor (hooks), Windsurf, JetBrains AI, generic agents via the adapter interface. Cursor's in-editor edits need a provider API before they can be separated from typing.
- **Separating tool edits from typing.** Whether save-participant edits should stop extending active time: a deliberate, versioned semantics change for later.
- **Data products.** Private aggregate sync of agent statistics (a new consented contract version); public metrics only via a separate publication registry. A richer sidebar view once semantics settle (today: *Show Agent Activity* command and API).
- **Robustness.** Signed/attested adapter records. Cross-device run deduplication.

## Files in this phase

**New:**
- Protocol and core: `packages/protocol/src/provenance.ts`, `packages/core/src/provenance.ts`, `packages/core/src/languages.ts`.
- Extension: `apps/vscode-extension/src/{external-observer,agent-adapters,agent-hook,agent-inbox,provenance-ledger,agent-report}.ts`.
- Benchmark: `scripts/benchmark-provenance.mts`.
- Tests: the six test files in §18.

**Changed:**
- Core and protocol: `packages/core/src/{index,lines}.ts`, `packages/protocol/src/index.ts`.
- Extension: `apps/vscode-extension/src/{extension,workflow-collectors}.ts`, `apps/vscode-extension/package.json`.
- Root: `package.json` (benchmark script).
- Tests: both smoke tests.
- Docs: `docs/TELEMETRY.md`, `README.md`, `apps/vscode-extension/README.md`.

New commands:
- **Stack Stats: Show Agent Activity** (also in the Activity view's "…" menu);
- **Stack Stats: Set Up Agent Integrations** (9E.1: replaced by *Manage Agent Integrations*; kept as a hidden alias).

New settings (default off):
- `stackStats.agentIntegrations.claudeCode`;
- `stackStats.agentIntegrations.codex`.

New API:
- `api.agentActivity(range)`;
- `api.provenance(range)`.

# Stack Stats telemetry engine

Stack Stats now has three layers: normalized observations, reusable reducers, and API/presentation consumers. Existing session tracking, local session snapshots, v1 APIs and legacy events remain intact. New telemetry starts when the new collector runs; it does not invent character, hourly, workflow or attribution history for older sessions.

## Collection matrix

“Observed” means an API or Git returned a fact. It does not mean the developer personally performed or authored it. “Inferred” indicates a documented approximation. “Reported” means a cooperating provider supplied a claim.

| Event type | Collected data | Reliability and limitations |
| --- | --- | --- |
| `editor.edit` | File/project/language/session IDs; first/last document versions and timestamps; edit, line-boundary, UTF-16 character, undo and redo counters | Observed content changes after the existing focused/visible/dirty confirmation rules. Batched in 15-second buckets; no keystroke stream. Inline changes, paste, completion, formatters and extensions are not distinguishable by authorship. |
| `activity.interval` | Start/end of evidenced editing intervals and context | Inferred by the existing <=60-second edit-gap rule. Consecutive intervals coalesce up to 60 seconds. No idle tail credit. Queries split intervals at hour/range boundaries. |
| `session.lifecycle` | Session ID, start/end transition, optional ending reason | Observed tracker transitions using five-minute grouping by default, configurable to 1–60 minutes. The 60-second active-time evidence gap stays fixed. An abrupt crash may omit the ending event; durable session snapshots still recover as before. |
| `file.saved` | File context, document version, manual/after-delay/focus-out save reason when supplied | Observed saves, including saves without changes. A save is not coding time. Save reason may be unknown if no preceding will-save event was observed. |
| `file.lifecycle` | Create/delete/rename operation; old/new salted file IDs for renames | VS Code file-operation events, including operations initiated by extensions. Directory operations may also appear: these are operation counts, not exact recursive file counts. A rename crossing an exclusion boundary is omitted. |
| `context.switched` | Previous/new file, project and language IDs | Observed active-editor changes; derived counters compare IDs. Opening the first editor is not a switch. Unsupported/excluded tabs break context. Language reopen events are considered when the document is active. |
| `window.focus` | Focus boolean and eligible active context | Observed focus transitions. Not a heartbeat, foreground duration, proof of work or exact idle measurement. |
| `filesystem.changed` | Coalesced create/change/delete notification counts, salted identity, latest notification timestamp | Notifications, not exact operations or line/character changes. Writer is unknown. A notification within two seconds of a matching editor save/operation is labeled `editor_correlated` as an inference; other notifications remain unknown. OS watchers can coalesce/miss notifications. |
| `git.repository` | Salted repository, current commit and branch IDs (nullable for unborn/detached cases) | A baseline observation, not a new commit. No scan/import of existing history on initial discovery. |
| `git.head_changed` | Previous/new salted HEAD and branch IDs | Observed changes between polls. A checkout/reset is not counted as a newly authored commit. Intermediate switches between polls may be missed. |
| `git.commit_observed` | Salted repository/commit IDs, commit time, parent count, eligible changed-file/line and binary-file counts | Newly reachable commits observed after same-branch advancement, including first commits after an observed unborn repository. Counts use first-parent Git numstat and exclusions. Commits may come from pulls or other authors. Not a count of “my commits.” |
| `task.lifecycle` | Random execution ID; started/process-ended/ended state; declared build/test/other group; optional exit code | Observed VS Code task runs. Names and command lines are never used to guess task type. A test task may run many test cases, none, or fail to launch. Nonzero process exits are reported, not labeled failed test cases. Missing ends remain incomplete. |
| `debug.lifecycle` | Random execution ID, start/end, salted debug adapter type | Observed VS Code debugging sessions. Elapsed lifecycle time includes pauses and waiting; it is not added to coding time. No variables, stack traces, launch configuration, arguments or output. |
| `diagnostics.snapshot` | Latest error/warning/information/hint counts per changed file | Optional, off by default. Severity counts only; no message, code, related information or source snippet. Snapshots replace one another in queries rather than summing errors. |
| `attribution.report` | Target edit-event UUIDs, reported human/AI actor, known agent category and salted provider ID | Optional, off by default. Explicit claims, never verified authorship. Supported agent labels: Codex, Claude Code, Cursor and Other. No automatic integrations or agent-installation detection are implied. |
| `collector.coverage` | Collector enabled/disabled/gap state and bounded-buffer/history-limit reasons | Makes known omissions visible. A lack of a gap event is not proof of complete capture, especially after crashes or OS watcher loss. |

VS Code's [document, file-operation, task, debug and watcher APIs](https://code.visualstudio.com/api/references/vscode-api) provide these observations but do not expose a universal edit-author field. Git statistics use [machine-readable numstat with external diff/text conversion disabled](https://git-scm.com/docs/git-diff). No timestamps or operation shapes are used to guess that Codex, Claude Code or Cursor produced a change.

## Event and storage contract

The authoritative runtime schemas are in `packages/protocol/src/telemetry.ts`. Every payload is a strict discriminated variant; unknown fields/types/versions are rejected. There is no arbitrary metadata bag into which source, prompts or commands can accidentally flow.

```ts
type TelemetryEvent = {
  schemaVersion: "2.0";
  eventId: UUID;                     // immutable, idempotent observation identity
  occurredAt: ISO8601;
  source: {
    collector: "vscode" | "filesystem" | "git" | "adapter";
    instanceId: UUID;                // one collector activation/window
    installationId: string;
  };
  context: {
    projectId?: SHA256;
    fileId?: SHA256;
    languageId?: string;
    sessionId?: UUID;
  };
  evidence: "observed" | "inferred" | "reported";
  eventType: /* one of the 16 variants above */;
  data: /* the corresponding strict payload */;
};

// Example edit payload. Characters are UTF-16 code units, not graphemes.
type EditorEditData = {
  startedAt: ISO8601;
  firstVersion: number;
  lastVersion: number;
  editCount: number;
  linesAdded: number;
  linesRemoved: number;
  charactersAdded: number;
  charactersRemoved: number;
  undoCount: number;
  redoCount: number;
};

type TelemetryBatch = {
  storageVersion: 1;
  batchId: UUID;
  events: TelemetryEvent[];          // 1–1,000 events
};
```

Counters are nonnegative safe integers. Private identifiers must be SHA-256-shaped hashes. Versions and counter relationships are validated. Active intervals cannot exceed 60 seconds. AI claims require an agent label and `evidence: "reported"`.

Raw editor observations are coalesced before persistence. Line/character counters are the minimum measurements necessary once text is discarded; per-hour/project/language/agent totals, ratios and comparisons are derived later. Existing cumulative session snapshots continue as a compatibility projection and are not added to raw telemetry totals.

The extension appends immutable, atomic JSON batch files under `globalStorageUri/telemetry-v2`, separate from existing `sessions-v1`. Stable batch/event IDs survive write/retry failures. Partial temporary files are ignored; corrupt files are preserved with warnings. Delivery acknowledgements are separate. Data is flushed on the existing 15-second timer and normal shutdown; abrupt crashes retain the existing approximate 15-second loss window. Unconfirmed first file edits only retain counters while waiting for the matching dirty-state signal; untitled documents use their separately tested event behavior.

SQLite schema **v3** adds indexed `telemetry_events` and `telemetry_claims` tables, preserving the v1 events and v2 session/day tables. Batch insertion is transactional. Identical event retries are ignored; reusing an event ID with different contents rejects and rolls back the batch. Reports may arrive before/after their targets. The target index resolves late reports even if their own timestamp lies outside a queried period. Unknown targets have no effect until an actual edit with that ID exists.

## Attribution and AI modification

Native editor changes start **unknown**, even inside Cursor or while an agent is installed. Filesystem notifications start **unknown**. There is no process-name heuristic, prompt/history inspection, or assumption that large/fast edits are AI.

An optional provider reports the identities of complete `editor.edit` batches it can actually account for. Reports annotate those batches; they never create additional edits. If reports disagree on human/AI or agent identity, the affected event becomes unknown/conflicted. Repeated identical claims do not inflate counters. A report spanning a mixed-author batch would be inaccurate: providers must abstain unless they can account for the entire batch. This version does not pretend to split mixed authorship within a batch or to verify the caller's truthfulness.

Queries expose **reported AI share**, **reported human share**, **unknown share**, and per-agent reported counters. The denominator is all observed changed UTF-16 units (added plus removed), including unknown activity. Empty denominators return `null`. These are not percentages of a repository's source code, accepted AI output, net committed code, or verified human work.

`laterEditorEditsInAiTouchedFiles` is a deliberately limited proxy: subsequent non-AI-labeled edits to a file touched by a reported AI edit **within the selected range**. It does not prove a human made the later edit or that the same lines were changed. `exactHumanModifiedAiCharacters` is always `null`: exact code lineage/retention cannot be reconstructed from these content-free observations. Do not label this proxy “human correction of AI code.”

Not currently measurable reliably: universal human/AI attribution; automatic identification of Codex/Claude/Cursor writes; exact human reworking/retention of AI-generated code; real idle or total working time; individual test-case outcomes across all providers; terminal commands/builds/tests outside VS Code tasks; external writer identity; exact filesystem change counts or external character diffs; Git activity missed between polls or while offline. No values are fabricated for these signals.

## Query architecture

```text
VS Code / filesystem / Git / explicit adapter claims
          ↓ eligibility policy, content-free normalization, batching
strict immutable events → local journal → authenticated SQLite ingestion
          ↓
core.filterTelemetry + resolveAttribution + queryTelemetry/compareTelemetry
          ↓
extension exports / output commands / HTTP API / CLI / future stackstats.dev
```

`packages/core/src/telemetry.ts` contains editor-independent pure reducers. It deduplicates event IDs, resolves provenance annotations, clips/splits active intervals, calculates counters/rankings, pairs workflow lifecycles, keeps latest diagnostic samples, and compares ranges. No VS Code dependency is required. The existing `statistics.ts` remains the authoritative daily/weekly session aggregation for old and new session history.

Returned query groups: edits; estimated active milliseconds; sessions observed; saves; VS Code file operations; project/language/file switches; attribution and coverage; task/debug invocations, ends, known exit failures and paired duration; Git observations; unknown filesystem notifications; language/project rankings; UTC hourly histogram; latest diagnostics; known coverage events and explicit limitations.

Edit counters are assigned to the 15-second batch's last timestamp. Buckets align with UTC hour boundaries. Active time is clipped exactly to the requested range. Hourly values are explicitly UTC; historical session daily totals retain their original local dates. A lifecycle duration is available only when both endpoints occur in the queried range; incomplete or cross-boundary runs must not be interpreted as zero-duration finished work. Weekly comparison in the extension uses local calendar Mondays; HTTP comparison uses the previous equal-length elapsed interval (be explicit around DST).

### HTTP and CLI

The daemon remains loopback-only and bearer-authenticated. All v2 endpoints, including capabilities, require the token. `/health` retains its original unauthenticated local health behavior.

| Route | Behavior |
| --- | --- |
| `GET /v2/capabilities` | Version, event types, units, limits, report permission, unavailable measurements |
| `POST /v2/events` | Strict normalized batch ingestion; atomic and idempotent |
| `GET /v2/events` | Cursor-paginated raw events |
| `GET /v2/query` | Reusable derived analytics |
| `GET /v2/compare` | Current range versus previous equal-duration range |

Query parameters: required `from`/`to` ISO timestamps, optional `projectId` (hash), `languageId`, `limit` (1–1,000) and `after` (last event UUID). Ranges are half-open and at most 366 days. Unknown cursors are rejected. Aggregate queries exceeding 100,000 events fail explicitly with `narrow_range`; they are never silently truncated. Raw pages use timestamp/event-ID keyset ordering. Ingestion rejects unsupported schemas; producers should inspect capabilities before using new event types. Envelope, local batch, database and API versions are separate migration boundaries.

```sh
pnpm stackstats init
pnpm dev:daemon

# In another terminal:
pnpm stackstats telemetry --today
pnpm stackstats telemetry --week --language typescript
pnpm stackstats compare --week
pnpm stackstats events --today --limit 100
pnpm stackstats events --today --limit 100 --after EVENT_UUID
pnpm stackstats telemetry --from 2026-09-01T00:00:00Z --to 2026-09-08T00:00:00Z
pnpm stackstats ingest --file normalized-batch.json

# Existing session and legacy queries still work:
pnpm stackstats summary --today
pnpm stackstats summary --week
pnpm stackstats summary --legacy
```

Daemon report ingestion is off by default. Start with `STACK_STATS_ALLOW_ATTRIBUTION=1 pnpm dev:daemon` to accept explicit reports. A batch containing reports is rejected while that flag is off; it remains in local storage. Ordinary rejected batches do not block delivery of other batches. No CLI command scrapes agent history or sends telemetry to the internet.

### Extension API and commands

```ts
const extension = vscode.extensions.all.find(e => e.packageJSON.name === "stack-stats-vscode");
const api = await extension!.activate();
// api.apiVersion === "2.0"
const stats = await api.query({ from, to, projectId });
const page = await api.events({ from, to, limit: 100 });

// Explicit opt-in required; report only batches you can account for completely.
await api.reportAttribution({
  targetEventIds: [knownEditorEditEventId],
  actor: "ai", agent: "codex", providerId: saltedProviderHash
});
```

The extension API additionally rejects unknown/non-edit targets. This is not an authenticated agent attestation protocol: VS Code extensions already share substantial local privileges, and provenance reports remain claims. A future signed/provider-specific integration can enrich evidence without rewriting observed counters.

New commands: **Stack Stats: Show Telemetry Today**, **Compare Telemetry Weeks**, and **Show Telemetry Privacy**. Existing Today/Week/Current Session, status, pause/resume and retry commands remain. Local query results cover retained local batches; use the indexed daemon API for long history. Legacy sessions are explicitly excluded from v2 raw telemetry queries because their missing underlying signals cannot be reconstructed.

## Privacy controls and collection costs

- No source text, prompts, clipboard, terminal/task commands, task names, process output, debug configuration/variables, diagnostic messages, Git commit messages, author names/emails or remote URLs are stored. Filesystem observation does not read file contents. Git only returns metadata and numstat.
- Project/file/branch/commit/debug-type/provider identifiers are salted or required to be hashed. Raw telemetry omits project display names. The existing session setting for project-name opt-in remains separate. Hashes are pseudonyms, not anonymization against every possible correlation.
- `stackStats.excludeFiles` and `excludeProjects` accept the documented `*`, `**`, `?` glob subset. Project matching includes root paths/names and excluded ancestors for nested observations. Checks apply before session collection and all new eligible sources. Invalid policies fail closed. Renames do not expose excluded endpoints. Settings affect future collection; they do not erase existing records.
- Built-in file exclusions cover `.git`, `node_modules`, `dist`, `build`, `coverage`, `.next`, `.venv`, `.env`/`.env.*`, `.pem`, `.key`, `.ssh`, `.aws`, and `secrets` paths. Add organization-specific exclusions. These patterns are always applied; they are not a claim to identify every sensitive filename.
- Filesystem, Git and workflow collectors default on; `collectFilesystem`, `collectGit` and `collectWorkflows` disable them. Diagnostics and attribution reports default off. Git subprocesses run only in trusted workspaces. Pause stops new observations; it can still deliver already-recorded data. CLI pause only pauses daemon ingestion.
- `stackStats.rawRetentionDays` defaults to 30. At activation, acknowledged raw batch files older than that storage age are pruned. `0` retains indefinitely. Undelivered batches, legacy/session history and daemon SQLite are preserved. A source shutdown/restart does not backfill the missed period. Long-term retention/deletion of the SQLite mirror remains an explicit operator responsibility.
- One existing 15-second timer handles checkpoints, collector flushes and retry scheduling. Edits do no filesystem writes, source scans or HTTP requests. The edit map coalesces bursts; raw memory is capped at 2,000 pending observations plus sealed retry batches. Overflow emits a coverage gap. Pending delivery retains IDs rather than whole historical payloads in memory.
- Filesystem watching is potentially expensive on large/network workspaces. It uses VS Code's workspace watcher and respects its exclusions, then applies Stack Stats eligibility filters. Notifications are coalesced; pending watcher keys cap at 1,000. Turning collection off prevents recording, although the lightweight watcher subscription remains registered until extension shutdown.
- Git is potentially expensive in large repositories: polling at most once a minute, round-robin up to four roots; bounded new-history inspection (20 commits); 2.5-second command timeouts and 2-MB output limits; a five-second soft history-inspection budget per observation. Git does not backfill initial history. Limits generate coverage gaps. No external diff/textconv helpers or filesystem monitor hooks are run. Overlapping workspace roots can expose overlapping Git diff scopes; do not interpret Git line totals as unique authored output across such scopes.
- Diagnostics only sample changed eligible documents at checkpoint, capped at 500 pending URIs. Tasks/debugging use event subscriptions, not process polling. Local reports and startup recovery enumerate retained metadata files and can be expensive for a long offline backlog. The daemon uses indexed time/project/language queries, a 100,000-event aggregation ceiling and synchronous SQLite outside the extension host. Large queries should be narrowed/paged; a production backend can stream the same reducers behind another storage adapter.

## Verification and benchmark

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm benchmark
pnpm test:vscode:api  # real host APIs, tasks/files/watchers; no keyboard focus required
pnpm test:vscode      # additionally requires the isolated window to stay focused
```

The expanded tests cover strict schemas/privacy, mixed/conflicting/late claims, exact range/hour clipping, comparison zero denominators, batching/overflow, UTF-16 units, exclusions, first-edit/untitled sequencing, immutable collision rejection, transaction rollback, cursor pages, migration from session schema v2, persistence/retry/retention/corruption, real HTTP delivery, and real Git commits/branches. Existing session/line/time/DST/recovery tests remain. There is no configured lint task.

The telemetry implementation passed **49 tests across eight test files**. With the v0.2.0 native sidebar, the suite passes **58 tests across ten files**, alongside typechecking, all workspace builds, VSIX packaging, and both real VS Code smoke tests. The API host smoke exercises all seven native views, command execution, UI preferences, file operations and exclusions, filesystem notifications, a declared test task, and attribution guards. The interactive host smoke also passed edits/save, session timing, pause/resume, untitled documents and persistence. The bundled extension is approximately **214 KB**. Future interactive runs still require native window focus.

The synthetic benchmark creates only temporary data and checks its own counter totals. On Node 24.16.0 in this workspace, the final run of 100,000 synthetic edits yielded **134 events / 87,232 serialized bytes**, approximately **957 ms** collection total, **1.7 ms** pure aggregation, **6.6 ms** durable batch write, **2.4 ms** SQLite insertion, and **277 ms** for a roughly 20,000-event SQLite query. This is about 9.6 microseconds per synthetic edit, not an end-to-end editor latency guarantee. The benchmark excludes real Git/watcher/VS Code callback cost and does not prove constant performance at arbitrary history sizes. Re-run on target systems before selecting deployment limits.

Manual checks beyond the API harness: keep the F5 development host focused; type/paste/delete/undo/redo; edit an excluded file/project and verify both session and telemetry totals stay unchanged; save with auto-save/manual save; create/rename/delete files; modify a file using another application; run declared build/test tasks; start/stop debugging; opt into diagnostics; make a commit, wait for a Git poll, then switch branches; pause/resume; stop/restart the daemon and replay; verify reported provenance stays optional and unknown activity remains visible. Raw events can be inspected with the CLI or `api.events`.

## Public profile versus private/API analytics

Recommended **13 opt-in public profile metrics**, aggregated over sufficiently broad periods and labeled as activity rather than skill/productivity:

1. Estimated active coding time this week.
2. Active coding days in the last 30 days.
3. Current coding streak (without treating breaks as failure).
4. Weekly active-time history.
5. Active-time language mix.
6. Distinct languages used in the last 30 days (not proficiency).
7. Coding sessions per week.
8. Median active session duration.
9. Number of explicitly public projects worked on.
10. Active-time share across those opted-in public projects.
11. Weekly test-task invocations, labeled as task runs rather than tests passed.
12. Week-over-week active-time change.
13. Optional gross editor line-boundary changes, without ranking developers by volume.

These are presentation choices derived from sessions/events, not new redundant stored counters. Some profile reducers, such as median session duration, remain simple future presentation work.

Keep richer data **private/API-only by default**: exact timestamps/hour-of-day and focus patterns; raw file/project/branch/commit identifiers; context-switch frequency; per-file edits, characters and undo/redo; task exit failures/durations and debugging timelines; diagnostics; external-change notifications and correlations; provider identities and conflicting reports; reported AI/manual ratios and their unknown coverage; the AI-touched-file revisit proxy; retention/retry/gap diagnostics. Do not publish “AI code rewritten by humans” or “commits authored” from evidence this engine does not possess.

Next infrastructure priorities are provider-specific opt-in provenance integrations with finer attributable batches, stable file/rename identity, journal compaction and broader storage retention controls, cross-collector overlap reconciliation, and negotiated/signed backend delivery. No account, public profile, cloud sync or team surveillance functionality is enabled by this change.

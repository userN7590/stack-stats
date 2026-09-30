# Phase 9A: richer versioned sync aggregates

This is the extension/engine implementation and the handoff for the **next** web task. `stack-stats-web`, Supabase, public publication behavior, and profile UI are unchanged by this task. Nothing was pushed or deployed. A server that only supports v1 continues receiving v1. New aggregates remain local until the server explicitly advertises support for the authenticated grant.

## 1. Reverified starting point

Before implementation, the sync path was re-read rather than assumed from the audit:

```text
SessionTracker
  → 15-second durable sessions-v1 snapshots
  → strict LocalSessionStore.list(true)
  → latestSessions, current-installation filter
  → dailyStatistics → syncDay v1 curator
  → account/origin/installation queue.json
  → optional daily PUT
```

`ProfileSyncService` did not read the v2 telemetry journal or SQLite. The existing v2 reducer's hourly UTC activity, characters, undo/redo, switching, saves, workflow, Git, diagnostics, and reported attribution could not cross this boundary. Local daemon delivery and profile-cloud sync were independent paths.

The v1 contract has twelve required keys: `schemaVersion`, `aggregationVersion`, `date`, `revision`, `activeMs`, `editCount`, `linesAdded`, `linesRemoved`, `sessionCount`, `fileCount`, `languages`, `projects`. Each breakdown contains an ID and the four counters. No session IDs, file IDs, exact activity times, names, or raw events are sent. Its strict source file remains unchanged for existing consumers.

The retained invariants are:

- Identity linking alone does not enable uploads; the browser must grant `stats:write`.
- Namespace: authenticated account, random installation UUID, recorded date. Authentication determines the account; the payload has no owner field.
- A day is a complete replacement at an increasing revision. Equal revision/equal content is a retry; equal revision/different content and stale revisions are conflicts.
- Pending means queued revision exceeds acknowledged revision. A successful reply advances acknowledgement only when the queued content/revision still matches what was sent.
- First consent fixes `uploadFromDate` to today minus 89 days. This floor survives restarts and renewed grants; it is not a rolling cloud-retention policy.
- Automatic history scans are bounded to five-minute intervals; the coordinator checks at thirty-second intervals and sends up to ten pending dates per run.
- Offline failures preserve durable payloads, with exponential backoff. A 401 refreshes credentials once. Permanent validation/revision errors remain visible.
- Strict session reads stop reconciliation on corruption. Partial reads must not replace a complete historical cloud day.
- Project display names and local IDs are excluded; HMAC aliases are private-salt, account, and installation scoped. Unknown language IDs map to `other`.
- Different devices may record overlapping work. Idempotent transport does not deduplicate physical activity across devices.

The separate prior local audit under `docs/audits/2026-09-26-telemetry-metric-audit/` contains further pre-change evidence; it is not included in the proposed Phase 9A commit. This report is self-contained. Relevant implementation source is [ProfileSyncService](../apps/vscode-extension/src/profile-sync.ts), [v1 contract](../packages/protocol/src/sync.ts), [session reducer](../packages/core/src/statistics.ts), and [journal](../apps/vscode-extension/src/telemetry-journal.ts).

## 2. Selected first expansion

The main daily counters continue using session snapshots as their authoritative input. Existing v2 event observations supply a **separate optional hourly projection**. The two projections must never be added together as if they were separate work.

| Metric family | Existing source | Exact meaning and unit | Merge / derived law |
| --- | --- | --- | --- |
| Active time | Session contributions | Evidence-backed inter-edit milliseconds; not all working time | Sum daily installation counters, overlap caveat |
| Edit count | Session contributions | Nonempty content-change records, not callback events or keystrokes | Sum |
| Added/removed lines | Session contributions | Gross editor line boundaries, including undo/redo | Sum; derive net as added−removed and churn as added+removed |
| Daily numeric series | Versioned daily rows | Each row's recorded collector-local date | Group by date; preserve date basis |
| Active days/streaks/weekday activity | Day totals and dates | A date is active when edits or active time are positive | Union date keys, then compute counts, runs, weekday sums |
| Session-days | Latest snapshots with contributions on a day | Daily participation, including sessions spanning midnight | Sum into session-days, never call the sum unique sessions |
| Session starts | Latest snapshots, original local start date | Each known session belongs to exactly one start date | Sum starts across dates/installations; no cross-device physical-session dedup |
| Incomplete session starts | Same cohort, missing final end reason | Known starts whose snapshot has not finalized | Sum within selected start cohorts; not a live-user-presence metric |
| Completed-session durations | Finalized snapshots assigned to original local start date | Whole-session active time; count, sum, min, max, histogram | Sum count/sum/bins; min/min and max/max; mean=sum/count |
| Session edit/line density | Completed-session cohort counters | Whole-session changes for the same completed cohort | Ratio of total counters to completed count, not average daily ratios |
| Daily file identities | Contribution `(projectId,fileId)` pairs | Distinct recorded identities for one installation/day | Sum only as file-days; no lifetime unique-file inference |
| Daily language activity/count | Session language contributions | Allowlisted language IDs and four counters | Group counters by language ID; union IDs for distinct languages |
| Daily project activity/count | Session project contributions | Account/installation HMAC aliases and four counters | Group known aliases within installation; bounded overflow caveat |
| UTC hour-of-day activity | Existing v2 edit/interval events | Twenty-four bins per UTC date for active ms, edits, added/removed lines | Sum compatible UTC bins; interval time split at UTC hour/day boundaries |
| Coverage metadata | Retained source dates and sync floor | Known observations and source version; incomplete history explicitly acknowledged | Never turn absence into measured zero or imply all-time coverage |

### Deferred metrics and reasons

- **Exact median session duration:** the payload provides a bounded histogram. The web may identify a median bucket or clearly labeled estimate; it cannot claim an exact median from buckets.
- **Unique lifetime/cross-device files:** no stable shared file identity is uploaded. Daily counts are file-days when summed.
- **Globally unique repositories:** aliases remain intentionally installation scoped. Workspace identity is not proof of one repository.
- **Project/language/file switching:** existing local observations are useful, but this first contract avoids widening the source mix and inherited switching caveats. File switching also has the audit's same-relative-path cross-project caveat.
- **Characters, undo/redo, saves, workflow/Git/diagnostics:** existing local observations remain available locally; these categories are not required for the selected first time/session/day expansion.
- **AI integration, models/tokens/cost, granular provenance, AST, technologies, skills, research:** outside Phase 9A. No new provider integration, source-content archive, symbol telemetry, or inference was introduced.
- **True idle time, productivity, skill, unique human work time:** not established by these observations. No new claim is made.

## 3. Exact version and deployment behavior

V1 stays in `packages/protocol/src/sync.ts`. V2 is a separate `packages/protocol/src/sync-v2.ts` module; its exports are exposed through the protocol package. Both remain strict contracts. Unknown wire versions or extra payload fields fail validation.

Before using v2, the extension requests:

```http
GET /api/v1/sync/capabilities
Authorization: Bearer <existing scoped access token>
```

The capability response is a small strict object:

```json
{"schemaVersion":"1","dailyVersions":["1","2"]}
```

**Required next-server rule:** advertise `"2"` only when the authenticated connection's consent covers the richer aggregate categories and the server supports the v2 validator, atomic replacement, and downgrade protection. General server support is not evidence of a user's consent. Existing grant flows must explain the additional session/coverage fields before enabling v2 for those grants.

An absent/unknown endpoint or invalid capability response leaves never-promoted days on v1. A v1 server is never sent an experimental v2 body to discover support. The client caches capability results for five minutes, scoped to the current account, origin, and grant; account changes clear that cache. GET requests time out after five seconds, and response bodies are bounded to 2,048 bytes. Capability/version negotiation is not a workspace-controlled authentication origin; existing origin restrictions stay in force.

Routes:

| Payload | Route | Consumer behavior |
| --- | --- | --- |
| V1 | `PUT /api/v1/sync/installations/{uuid}/days/{date}` | Existing v1 path, unchanged body semantics |
| V2 | `PUT /api/v2/sync/installations/{uuid}/days/{date}` | Strict v2 validation and same account/installation/date replacement namespace |

The new endpoint is a routing/version distinction, not a second additive record of the same day. The server must replace/promote one canonical day. It must not count v1 and v2 rows twice.

### Queue migration and the lost-response rule

- Existing ledger, date floor, consent, entry revisions, and acknowledgements are preserved.
- Promotion changes canonical content and increments that day's existing revision. Acknowledgement does not advance merely because the body was rebuilt.
- Persist the promoted body and ledger format before a v2 request. A timeout can happen after the server commits; a client must not infer rejection from response loss.
- Once queued as v2, a day never silently becomes v1 again. Capability disappearance, network error, and server rollback preserve the pending v2 record and expose an actionable state. Sending a queued v2 body still requires v2 capability for the current authenticated grant; a renewed grant supporting only v1 cannot receive that richer body.
- The next server must reject a v1 body replacing an already-promoted v2 day, even if the v1 revision is larger. This protects against an older editor window with an in-flight v1 body and against client downgrades.
- Ledger format v2 is deliberately unreadable to older extensions. An old extension fails closed instead of erasing richer data; users should upgrade all windows sharing storage. Do not reset the queue to resolve this.
- Retry the exact body/revision after an uncertain outcome. A real content change may use the next revision; never manufacture revision growth just to overpower a cloud conflict.

The existing queue safety bounds remain 10,000 date entries and 25,000,000 serialized text characters (about 25 MB for these predominantly ASCII records). A richer, high-cardinality installation can reach the size limit sooner than a v1 installation. Bounds fail closed and preserve the saved queue; no automatic compaction drops revisions or retained cloud ownership. Long-term queue compaction is a future migration, not a reason to reset installation identity.

## 4. V2 payload field dictionary

The protocol source is authoritative. No free-form metric bag, arbitrary user key, source text, file ID, session ID, repository name, prompt, command, or precise activity timestamp is allowed.

| Field | Meaning |
| --- | --- |
| `schemaVersion` | String literal `"2"`, the wire-version discriminator |
| `aggregationVersion` | Integer literal `1`, the initial v2 reduction semantics |
| `date`, `revision` | Existing valid calendar date and positive per-day revision |
| `activeMs`, `editCount`, `linesAdded`, `linesRemoved` | Collector-local day counters from session snapshots |
| `sessionDays` | Sessions contributing to this local day |
| `sessionStarts` | All known session starts owned by this local date |
| `incompleteSessionStarts` | Start-cohort sessions without a final end reason |
| `fileCount` | Distinct contribution `(projectId,fileId)` pairs on this installation/local day |
| `projectCount` | Exact distinct local project identities observed this day before overflow |
| `languageCount` | Number of normalized contribution-language rows, exactly `languages.length` |
| `languages[]` | Sorted standard language ID and the four daily counters |
| `projects[]` | Bounded sorted HMAC project ID and the four daily counters |
| `projectOverflow` | Omitted-project count and four counters; preserves totals without exposing an unbounded identity list |
| `sessionDurations` | Completed start-cohort summary: `count`, four counters, `minActiveMs`, `maxActiveMs`, `histogram` |
| `hourlyUtc` | `null` when hourly upload is not available/selected, otherwise the bounded UTC projection below |
| `coverage` | Source, date basis, known observation dates, upload floor, and explicit incompleteness |

All twenty top-level keys are required. Numeric counters are nonnegative safe integers. Daily active time and hourly active-time sums are capped at 604,800,000 ms; other counters at 1,000,000,000; revision and completed-cohort active milliseconds at 1,000,000,000,000. This allows overlapping observations without claiming a week can fit in one physical day. UTF-8 JSON payload size is capped at 65,536 bytes.

Language rows are capped at 128 and must use the existing allowlist. Project rows are capped at 128. Select projects by descending active time, edits, lines added, lines removed, then lexical alias; wire-sort the selected rows lexically. Omitted project counters and count go into `projectOverflow`. The language counters must sum to day counters; project rows plus overflow must independently do the same. `projectCount = projects.length + projectOverflow.projectCount`.

Arrays must be dense, sorted IDs must be unique, and overflow requires a full retained page of 128 project aliases. With zero `sessionDays`, daily counters and file/project/language dimensions must all be zero; positive `sessionDays` require contribution identities. Composite file identity also implies `fileCount >= projectCount`. The independent start cohort and optional UTC-hour arrays can still contain observations on a row without local-day contributions.

Example v2 body with one finalized session and hourly upload off:

```json
{
  "schemaVersion": "2",
  "aggregationVersion": 1,
  "date": "2026-09-27",
  "revision": 2,
  "activeMs": 30000,
  "editCount": 2,
  "linesAdded": 4,
  "linesRemoved": 2,
  "sessionDays": 1,
  "sessionStarts": 1,
  "incompleteSessionStarts": 0,
  "fileCount": 1,
  "languageCount": 1,
  "projectCount": 1,
  "languages": [{"id":"typescript","activeMs":30000,"editCount":2,"linesAdded":4,"linesRemoved":2}],
  "projects": [{"id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","activeMs":30000,"editCount":2,"linesAdded":4,"linesRemoved":2}],
  "projectOverflow": {"projectCount":0,"activeMs":0,"editCount":0,"linesAdded":0,"linesRemoved":0},
  "sessionDurations": {
    "count":1,"activeMs":30000,"editCount":2,"linesAdded":4,"linesRemoved":2,
    "minActiveMs":30000,"maxActiveMs":30000,"histogram":[0,1,0,0,0,0,0,0,0]
  },
  "hourlyUtc": null,
  "coverage": {
    "source":"sessions-v1","dateBasis":"collector-local",
    "firstObservedDate":"2026-09-27","lastObservedDate":"2026-09-27",
    "uploadFromDate":"2026-06-30","historyCompleteness":"unknown","partial":true
  }
}
```

### Completed-session cohort and histogram

Every session is owned by its **original recorded local start date** for whole-session statistics. Its active time still contributes to the actual local days on which it occurred. A session spanning two days therefore has two session-day contributions, one start, and one completed duration sample once finalized.

Whole-session duration is the sum of active contribution milliseconds. It is **not** `endedAt−startedAt`, which may include uncredited gaps. Session edit/line cohort sums use the same finalized members as duration count, so edits/session and lines/session use a consistent denominator. A crash can leave a snapshot incomplete; this is reported separately and not silently counted as a completed duration.

The histogram has nine fixed buckets. The first eight exclusive upper bounds are `1, 60000, 300000, 900000, 1800000, 3600000, 7200000, 14400000` milliseconds; the final bucket is at least four hours. The first bucket represents zero active milliseconds, a valid outcome for a one-edit session. Histograms merge by element-wise sum; their counts must match completed sample count.

`sessionStarts = completed cohort count + incompleteSessionStarts`. This cohort is different from the day's `sessionDays`; neither is a substitute for the other.

For an empty completed cohort, all four cohort counters and histogram bins are zero, and min/max are `null`. The validator checks histogram count, first/last occupied bucket against min/max, and feasible duration sums. It rejects contradictory cohort summaries instead of allowing the server to normalize them silently.

### Hourly object

```text
hourlyUtc = null OR {
  source: "telemetry-v2",
  dateBasis: "UTC",
  activeMsByHour: [24 nonnegative integer values],
  editCountByHour: [24 nonnegative integer values],
  linesAddedByHour: [24 nonnegative integer values],
  linesRemovedByHour: [24 nonnegative integer values],
  coverage: {
    firstObservedDate, lastObservedDate, partial: true,
    frozen: boolean, lateInputIgnored: boolean
  }
}
```

Index 0 means 00:00–01:00 UTC on the row's date. Active intervals are split at UTC hour/day boundaries. Existing edit batches do not retain each constituent edit time; their edit/line counters use the batch observation timestamp. This is aggregate timing precision, not a keystroke timeline.

**The two date bases must stay separate:** the main row totals are collector-local; the hourly object is a UTC date. Around midnight, UTC bins can belong to a date whose local session counters are zero. Their sum is not required to equal the local-day totals. Do not “repair” this legitimate difference by scaling or dropping bins. A period comparison needs matching UTC versus collector-local bounds.

Both hourly observation dates equal the UTC row date. `partial:true` is always explicit. `frozen` means the local replay ledger has been compacted and counters no longer accept additional input. `lateInputIgnored` is only valid for a frozen day; it can mean a retry was offered after compaction, not necessarily lost new activity.

Hourly upload is an explicit application-scoped option, **off by default**, `stackStats.syncHourlyActivity`. This setting governs optional transfer of a coarse existing-observation projection; no raw event firehose or new invasive observation is added. Disabling it queues revised day replacements with `hourlyUtc:null`; the server's canonical hourly field changes only after those replacements successfully sync. It is not immediate remote erasure, account deletion, or a public-publication change. The local hourly projection remains retained for private use/re-enabling.

### Coverage object

```text
coverage = {
  source: "sessions-v1",
  dateBasis: "collector-local",
  firstObservedDate: known retained first session date OR null,
  lastObservedDate: known retained last session date at/before this row OR null,
  uploadFromDate: persisted consent/backfill floor,
  historyCompleteness: "unknown",
  partial: true
}
```

Coverage describes observations, not an instrumentation guarantee. Earliest retained history may predate the upload floor and does not mean its counters were uploaded. Latest observed date is not proof of uninterrupted capture. The client does not claim that pauses, excluded work, unobserved editors, crashes, or removed local files were measured.

The server already knows accepted dates from its rows; it should derive `firstUploadedDate`, `lastUploadedDate`, distinct uploaded dates, and record count there. It must not trust a client-supplied lifetime total or streak. “Lifetime” should be replaced with a phrase such as “tracked activity available since …”, and dates should distinguish observed source coverage from uploaded coverage.

## 5. Cross-device/cloud merge rules

| Field/product | Correct merge | Invalid interpretation |
| --- | --- | --- |
| Four daily counters | Sum canonical installation-day records | Unique human time, repository growth, authorship |
| Active dates/days | Union dates with positive active time or edit count; then count | Sum installation active-day counts |
| Current/longest streak | Derive from unioned active dates with a documented end-date/grace rule | Sum client/device streaks |
| Weekday activity | Group local recorded dates by weekday, sum their counters | Relabel UTC hourly totals as recorded-local totals |
| `sessionDays` | Sum daily participation counts | Distinct sessions across dates |
| `sessionStarts` | Sum start cohorts | Guaranteed distinct physical work sessions across independent collectors |
| Completed duration count/sum/bins | Sum compatible cohorts | Average daily/device averages, or exact median from histograms |
| Completed duration max/min | Max/min over nonempty cohorts | Use zero as missing minimum |
| Average session duration | Sum completed active time / sum completed count | Divide all-day time by start count or by session-days |
| Edits/lines per completed session | Same completed-cohort total / completed count | Mix all-day numerator with completed-cohort denominator |
| `fileCount` | Sum only with label file-days | Unique lifetime files |
| Standard languages | Sum counters by normalized language ID; union IDs for count | Sum daily language counts |
| Known project aliases | Group by installation+alias | Merge same alias from unrelated namespaces as one repository |
| Overflow projects | Sum overflow counters; count as project-day participation | Treat sum of overflow/day projectCount as lifetime distinct projects |
| Language/project shares | Recompute from summed numerators/denominator | Average percentages |
| Hour arrays | Element-wise sum over matching UTC date/hour interpretation | Deduplicate simultaneous devices or imply local timezone |
| Coverage | Report source/version/date bounds and incompleteness; preserve metric-specific missingness | Treat missing hourly/session precision as zero |

Project overflow needs special treatment. Daily `projectCount` remains exact for that source/day, but omitted project identities cannot be deduplicated across days. A period-wide known-alias count is a **lower bound** whenever overflow exists. Expose a completeness flag and optional `overflowProjectDays`; do not show a false exact lifetime project total. A selection limit is not permission to silently discard counters.

Language rankings and shares must name their measure: active milliseconds, edits, added lines, or removed lines. A most-used language is the maximum of that selected summed measure, with a documented deterministic tie rule. Ranking retained project aliases across a period is incomplete when overflow exists; an omitted alias may accumulate enough activity to change the true winner.

Collector-local dates can originate in different recorded time zones. Their daily totals cannot be rebinned to one viewer-selected time zone after upload. Keep recorded-local calendar products labeled accordingly; use compatible UTC-hour data for UTC products when available.

## 6. Legacy history, durability, and missing data

Old session snapshots can supply daily counters and completed-session cohorts without creating new observation facts. They cannot recover old hourly intervals that were never captured or already pruned. V2 therefore supports a meaningful session-only day with `hourlyUtc:null`; null is distinct from twenty-four measured zero values.

Within the original upload floor, the extension lazily promotes eligible days after capability negotiation. Outside that floor, historical counters remain local. A session-start cohort can lie outside the floor even if some of its later activity is within it; the cloud must not fabricate the missing start/duration record. UTC-only dates are included even if their collector-local day has no session row, including today's UTC date when the collector-local date is still yesterday. Empty days are valid aggregates; an empty payload alone does not prove the collector ran all day.

A successful strict scan is authoritative for existing v2 records: if a previously queued day now has no source contributions, its next revision contains explicit empty counters. Read failures preserve the earlier queue. A user manually deleting all valid local snapshots is different from a parse failure; the extension cannot infer the user's cloud-retention intent from that deletion.

### Durable hourly projection

The extension creates `globalStorage/hourly-v1` regardless of cloud connection or the hourly-upload setting. `HourlyAggregateStore` writes one atomic file per UTC date plus a manifest. It reads only existing `editor.edit` and `activity.interval` events belonging to this installation. Other event families, foreign installations, project/file/session IDs, and character/provenance counters do not enter this projection.

- Mutable window: **120 calendar UTC dates including today**. Each mutable day keeps a bounded event-ID-to-fingerprint ledger for exact retry deduplication within that day.
- Limits: **20,000 contributions per day**, **4 MiB per day file**, and manifest safety limits. Overflow is an error that preserves raw history, not silent truncation.
- Writes: the existing shared filesystem lease and atomic write/fsync/rename path coordinate windows. An interval spanning UTC midnight contributes idempotently to both daily files; replay repairs a partial cross-day write. An orphan valid day file can be recovered into its manifest; a missing registered file is treated as damaged history.
- Before the raw write, the journal creates `hourly-pending/<batchId>.pending` containing the same normalized sealed batch. After the raw batch and projection commit, it removes that marker. A marker can reconstruct a raw file if the process stopped between those writes; another window can safely finish the same immutable batch.
- If the normal pending-directory write fails, a root-level `<batchId>.hourly-pending` file preserves the sealed payload before an `hourly-recovery-required` UUID signal is written. Other windows check the signal and fully recover that payload before clearing the unchanged token under the journal lease. A producer resuming later cannot make the failed projection disappear from recovery. If both durable outbox mechanisms fail, the raw batch is preserved and save throws, keeping the sealed batch eligible for retry.
- A rollup failure warns but does not undo a successful raw write. Startup and pre-prune recovery strictly stream retained raw batches and pending markers. Normal hourly exports recover only pending markers and validate durable projection files, avoiding a full raw-history scan on every upload. Already-projected raw corruption is detected on startup or pre-prune replay rather than every normal export. A detected corruption/cap failure blocks the affected rich read and pauses pruning until repaired.
- Frozen days retain their four arrays indefinitely while discarding old dedup IDs. Late input to a frozen existing day is ignored and explicitly flagged. Old retained raw input without a prior preserved projection is not backfilled outside the mutable horizon and does not create a fabricated zero day.
- The freeze barrier only moves forward. Moving the system clock backward cannot reopen already-compacted days and double count old replays.

The projection does not read daemon SQLite. Data present only in SQLite is still outside extension profile-sync backfill. Default raw-journal retention remains a separate setting; raw deletion never implies deletion of compact hourly aggregates. Precise event IDs/hashes stay local.

## 7. Privacy boundary

- Main public publication behavior is unchanged. The server's current `publishProfile`/`publishLanguages` controls must not automatically expose every new v2 key.
- New private upload consent must name session aggregates, coverage dates, and the optional UTC-hour pattern. The hourly setting is a separate explicit choice.
- Project aliases remain linkable private account data. Default public results should expose no project aliases, installation IDs, session IDs, file IDs, exact activity timestamps, or source settings.
- Standard language IDs remain allowlisted; custom identifiers collapse to `other`.
- No source/clipboard/prompt/terminal/environment/secret value is sent. No raw character histogram, AST node data, agent model/token data, or source provenance is added.
- Calendar/hour patterns can reveal schedules. Public time-pattern visualizations require separate metric/category selection, not just a chart visibility toggle.
- Upload disabling, publication disabling, and deletion are three separate operations. The next web task must explain existing-data retention and implement erasure deliberately.

## 8. Exact web implementation handoff — not implemented here

### 8.1 Contract vendoring and checks

Keep `src/lib/sync-contract.ts` for existing v1 consumers. Vendor the new dependency-free source bundle without edits:

```text
packages/protocol/src/sync.ts    → src/lib/stack-stats-protocol/sync.ts
packages/protocol/src/sync-v2.ts → src/lib/stack-stats-protocol/sync-v2.ts
```

The bundle preserves relative module imports. Use the same parsing/canonicalization rules as the sender, plus independent SQL validation. An equivalent manually rewritten validator is not an exact contract-parity check.

```sh
node --import tsx scripts/check-sync-contract.mts /path/to/stack-stats-web
node --import tsx scripts/check-sync-contract.mts --require-v2 /path/to/stack-stats-web
```

Default mode still verifies the existing v1 source and SQL language set without requiring a web change. `--require-v2` additionally requires both exact new module files. Source parity does **not** prove SQL v2 validation, consent, routes, or deployment readiness; those need web/database tests.

### 8.2 Supabase migration requirements

1. Keep one account/installation/date canonical record and its revision. Retain v1 rows; interpret version-specific fields without inventing v2 history.
2. Add strict v2 SQL validation for exact fields/types, bounds, sorted IDs, language allowlist, counter consistency, overflow accounting, histogram consistency, fixed 24-bin arrays, and coverage dates/literals. Validate serialized size independently of the HTTP body.
3. Update the transactional day writer to accept the appropriate validated version, preserve ownership/`stats:write`/quotas, and reject wire-version downgrade of an existing v2 row regardless of higher revision. Equal-revision no-op/conflict and stale-revision behavior stays intact.
4. Update private summary reducers to map legacy `sessionCount` to **session-days only** and legacy full project rows to known aliases. V1 supplies no complete session-start/duration/hour dataset; missing fields remain unavailable.
5. Add private series/dataset endpoints or RPCs with bounded periods/dimensions. Main day, UTC-hour, start-cohort duration, and language/project datasets need independent coverage/denominator metadata.
6. Protect direct tables and helper reducers as before. No arbitrary owner ID, private project list, or raw payload should be accepted by a public endpoint.
7. Add consent/version capability storage for connections, and publication selections with defaults excluding new categories. Existing grants/publication settings do not imply every future metric is allowed.
8. Honor full replacements: an accepted `hourlyUtc:null` replaces the canonical optional hourly value with null. Separately add an explicit cloud deletion/export path and define erasure of old revisions, backups, and exports. Upload withdrawal does not itself erase those copies, and a nullable field is not an account-deletion command.

#### Verified current targets and concrete migration plan

The following names were rechecked read-only in `/Users/fstopyra/Desktop/stack-stats/stack-stats-web`; they describe local source, not a verification of a live deployment.

| Current source | Exact target for the next web task |
| --- | --- |
| `supabase/migrations/20260910000000_profile_sync.sql:122` | `public.sync_installations`, `public.sync_days`, `public.sync_privacy`, `public.sync_rate_limits` |
| Same migration, lines 152, 185 | `sync_validate_day(jsonb)` and `sync_put_day(text,uuid,date,jsonb)` |
| Same migration, lines 221, 238, 245 | Private helper `sync_aggregate(uuid,date,date)`, authenticated `sync_private_summary(text,date)`, public `sync_public_profile(text)` |
| Same migration, lines 258, 264 | `sync_get_privacy()` and `sync_set_privacy(boolean,boolean)` |
| `supabase/migrations/20260909000000_extension_identity.sql:4` and `20260910000000_profile_sync.sql:1` | `extension_auth_codes`, `extension_connections`, `extension_access_tokens`; code-to-connection scope propagation in `extension_exchange` |
| `src/lib/sync-api.ts:7` | `putSyncDay`, `syncPrivacy`, and `privateSyncSummary` HTTP/RPC boundary |
| `src/lib/extension-api.ts:26`, `src/lib/extension-auth.ts:4` | Authorize-request validation, RPC selection, bearer handling, and no-store responses |
| `src/components/auth/extension-consent.tsx:25` | Current browser upload disclosure; a new explicit richer-consent choice belongs here |
| `src/app/u/[username]/page.tsx:61`, `src/lib/synced-profile.ts:8` | Current public RPC call and six-field profile adapter |
| `src/app/settings/sync/page.tsx:13` | Current private summary/privacy consumers |

Create a **new** migration, proposed name `supabase/migrations/20260927000000_sync_daily_v2.sql`; do not rewrite an applied migration. A concrete compatible storage plan is:

- Keep `sync_days`' existing `(user_id,installation_id,date)` primary key, `revision bigint`, and `payload jsonb`. V2 fits the existing JSONB column; no separate per-metric table or second day row is needed. Read the version from `payload->>'schemaVersion'`; no speculative counter backfill is required.
- Add `stats_schema_version smallint not null default 1 check (stats_schema_version in (1,2))` and nullable `stats_consent_at timestamptz` to both `extension_auth_codes` and `extension_connections`. Existing rows stay version 1. Add a constraint requiring `stats:write` and a nonnull consent timestamp for version 2. A new authenticated `extension_authorize_stats_v2(text,text)` records version 2 only after the richer disclosure is accepted. Copy those fields in `extension_exchange`; token refresh retains its existing connection and consent version. Client-supplied version fields never upgrade an existing grant by themselves.
- Add `sync_validate_day_v2(jsonb)` with the section 4 checks, while keeping `sync_validate_day(jsonb)` as the v1 validator. Replace `sync_put_day` with a version-aware dispatcher: validate the chosen version, require the connection's v2 consent for a v2 body, lock the owner as before, reject a downgrade **before** revision replacement, then reuse the same row/upsert. Keep direct validator/helper execution revoked.
- Add `sync_capabilities(p_access_token text)` using the same hashed-token, access expiry, connection expiry, and scope checks as the writer. Return only the strict capability object. A scope/expiry failure must not disclose account data. Advertise `['1','2']` only for a version-2-consented connection when the v2 writer is ready.
- Add private `sync_aggregate_v2(uuid,date,date)` and authenticated `sync_private_summary_v2(text,date)` rather than changing the existing summary response discriminator silently. In both legacy and v2 reductions, calculate session-days with `case when payload->>'schemaVersion'='1' then (payload->>'sessionCount')::bigint else (payload->>'sessionDays')::bigint end`. Read completed cohorts only from version-2 rows; absent v1 cohorts are unavailable history, not observed zeros. Group project aliases by installation and expose overflow/completeness metadata. Sum histogram indices 0–8 and hourly indices 0–23 independently.
- Add authenticated `sync_private_datasets_v2(p_period text,p_to date,p_dataset text)` with an enumerated dataset ID (`daily`, `languagesByDay`, `projectsByDay`, `sessionStartCohorts`, or `hourlyUtc`) and bounded periods/result sizes. Resolve the owner with `auth.uid()`; never accept a browser-supplied owner UUID. Select the corresponding independent date basis and coverage.
- Add `publication_version smallint not null default 1 check (publication_version in (1,2))`, `published_metrics jsonb not null default '[]'::jsonb`, and `publish_schedule boolean not null default false` to `sync_privacy`. Validate the metric array against a fixed registry, require unique IDs, and cap it (proposed 128). Existing publications gain no new metrics. The legacy booleans keep their existing meaning for the legacy RPC.
- Add authenticated `sync_set_privacy_v2(p_publish_profile boolean,p_metric_ids jsonb,p_publish_schedule boolean)` and `sync_get_privacy_v2()`. The setter moves that account's publication version to 2, stores only known selected IDs, and rejects schedule IDs unless schedule publication is explicitly enabled. Once an account uses version-2 publication, the old `sync_set_privacy(boolean,boolean)` must not reset it to broad legacy publication; reject that incompatible operation or preserve the stricter selections. RLS/direct-table restrictions remain in place.

Test SQL independently: invalid/extra keys, numeric limits, empty cohorts, bin sums/extrema, inconsistent breakdowns, project overflow, malformed hourly arrays, mixed v1/v2 periods, grant consent, revision race/retry, downgrade rejection, direct-RPC bypass attempts, and public field exclusions. The TypeScript source parity script does not validate any of those database behaviors.

Keep `security definer` functions on an empty `search_path` with qualified table/helper names. Explicitly grant authenticated private/consent/privacy wrappers only to `authenticated`; grant bearer-checked capability/day entry points and the intentionally public profile wrapper to their required `anon,authenticated` callers. Revoke direct table access and all aggregate/validator helper execution from `public,anon,authenticated` as the existing migration does.

### 8.3 API routes and acknowledgements

- Implement the authenticated capabilities GET with bounded strict response and no caching/redirects. Advertise v2 only when both the server and grant permit it.
- Keep the v1 PUT working for old clients.
- Implement the v2 PUT at the route documented above. Require URL date to equal body date; derive account from bearer; return exact installation/date/revision acknowledgement.
- Retain sanitized status codes for unauthorized/scope, malformed body, conflict, size, quota, and installation limits. A failure must not silently coerce v2 into v1.
- A successful v2 response must include `schemaVersion:"2"` alongside the matching `installationId`, `date`, and `revision`; otherwise the extension preserves the pending upload. Response bodies are bounded to 2,048 bytes. A lost response must be recoverable by replaying the identical body/revision. Ensure any server version/feature rollout preserves this property.

Exact Next route work:

| Path | Required next change |
| --- | --- |
| `src/app/api/v1/sync/installations/[installationId]/days/[date]/route.ts` | Keep the existing v1 entry point and v1 parser; writer must still reject a v1 downgrade of a stored v2 row |
| `src/app/api/v1/sync/capabilities/route.ts` — new | GET bearer → `sync_capabilities`; strict bounded response, no-store, no user ID argument |
| `src/app/api/v2/sync/installations/[installationId]/days/[date]/route.ts` — new | PUT → new `putSyncDayV2` in `src/lib/sync-api.ts`, vendored `parseSyncDayV2`, URL/body agreement, same `sync_put_day` transaction |
| `src/app/api/v2/sync/summary/route.ts` — new | GET authenticated browser → `sync_private_summary_v2`; reuse strict period/date/query validation |
| `src/app/api/v2/sync/datasets/route.ts` — new | GET authenticated browser → `sync_private_datasets_v2`; validate a bounded dataset enum and period |
| `src/app/api/v2/sync/privacy/route.ts` — new | Same-origin authenticated update → versioned publication setter; exact metric allowlist, schedule gate |
| `src/app/api/extension/authorize/route.ts`, `src/lib/extension-api.ts`, `src/components/auth/extension-consent.tsx` | Add the explicit richer-consent browser action and select `extension_authorize_stats_v2` only for that approved action |

Successful new and identical-retry v2 writes must return, for example, `{"schemaVersion":"2","installationId":"<matching UUID>","date":"2026-09-27","revision":2,"unchanged":false}`. Keep `unchanged` informational. Map a proposed `version_downgrade` writer error to 409; retain existing stale/conflict/invalid/quota/installation mappings. Do not echo submitted payloads or credential details in errors.

### 8.4 Private and public profile products

Private dashboards can expose valid daily counters, session-day/start counts, completed-session histograms, mean/max active duration, per-language counters, and selected project aggregates with the caveats above. UTC-hour datasets remain optional and separately labeled.

Public RPCs should construct an explicit selected-field allowlist. Suggested individually selectable safe candidates are active time, edit count, line additions/removals/net/churn, active days, session starts or session-days under their correct names, completed-session mean/max/histogram, language counts/totals/shares, and coarse date/weekday/hour patterns only with separate schedule publication. Project identity count needs overflow completeness; project aliases remain private by default.

Do not return every v2 field and rely on the React UI to hide it. Layout selection controls presentation; the RPC controls publication. Existing manually entered values must remain labeled and separate from tracked aggregates. Unknown, unsupported, pruned, incomplete, and measured-zero are distinct states.

The current `sync_public_profile(text)` explicitly returns `activeMs`, `editCount`, `linesAdded`, `linesRemoved`, `fileDays`, `projectCount`, `recordCount`, `updatedAt`, and conditionally `languages`. Preserve its fixed legacy allowlist for publication-version-1 accounts while making its reducer understand mixed daily versions. For publication-version-2 accounts, make this legacy RPC return null, so it cannot bypass narrower metric selections. Do not add session starts, dates, or hourly bins to the existing broad publication choice.

Add `sync_public_profile_v2(p_username text,p_period text default '30',p_to date default current_date)` for the new profile product. It resolves the published account by username, requires `publish_profile` and `publication_version=2`, validates period/end date, and builds only selected known metric results. It must never grant direct execution of `sync_aggregate_v2`. A proposed response shape is:

```ts
type PublishedMetricsV2 = {
  schemaVersion: "2";
  metrics: Array<{
    id: string;                    // selected registry ID only
    definitionVersion: 1;
    unit: "milliseconds" | "count" | "lines" | "percent";
    value?: number | null;
    dataset?: unknown;             // concrete per-ID allowlisted schema, never raw payload
    quality: "available" | "partial" | "unavailable";
    dateBasis: "collector-local" | "UTC";
  }>;
};
```

Use concrete dataset types in implementation. Omit unselected IDs entirely; do not return them with hidden flags. The new privacy HTTP body can be the strict object `{schemaVersion:"2",publishProfile:true,metricIds:["activity.active_ms"],publishSchedule:false}`. An hour/streak/date-pattern registry entry requires both its own selection and schedule permission. Project aliases/installation IDs are excluded from the initial publishable registry. Publication metadata must also be limited: exact observation dates or histograms cannot escape through an unselected metric's coverage block.

Update `src/app/u/[username]/page.tsx` to call the versioned public RPC and consume approved metric results through the registry. If no version-2 publication exists, use the legacy RPC; its version gate prevents an empty/limited new selection from exposing legacy fields. `src/lib/synced-profile.ts` remains the legacy six-field adapter; it cannot safely stand in for arbitrary new datasets. When project counts are incomplete because of overflow, render a known-identity lower bound with its quality label, or omit an exact-count presentation. No public component should query private summary/dataset RPCs and filter after retrieval.

### 8.5 Recommended metric registry shape

The next web phase should separate metric meaning from presentation:

```ts
type MetricDefinition = {
  id: string;                       // stable semantic identifier
  definitionVersion: number;
  label: string;
  description: string;
  unit: "milliseconds" | "count" | "lines" | "percent";
  shape: "scalar" | "series" | "distribution" | "categories";
  source: "daily" | "sessionStartCohort" | "hourlyUtc";
  requiresWireVersion: "1" | "2";
  dateBasis: "collector-local" | "UTC";
  numerator?: string;
  denominator?: string;
  merge: "sum" | "max" | "min" | "dateUnion" | "identityUnion" | "derived";
  privacyCategory: "totals" | "languages" | "sessions" | "schedule" | "projects";
  requiresCompleteIdentitySet?: boolean;
  compatiblePresentations: string[];
};
```

Registry entries should also declare supported periods/dimensions, evidence/source labels, empty-state text, and coverage requirements. Dataset results carry value/rows plus quality and coverage. A metric ID must never mean different denominators depending on renderer. “Single stat”, “stat grid”, and “dataset visualization” consume the same approved metric result. Images/documents/links are different section types and should not gain access to private metric payloads.

## 9. Validation and implementation record

The contract-check command has regression tests covering the unchanged v1 consumer, source drift, SQL language drift, missing/mismatched v2 bundle, and invalid command flags. The existing web checkout is only read by the v1 parity command; no files there are changed.

### Changed implementation files

| File | Change |
| --- | --- |
| `packages/protocol/src/sync-v2.ts` | New strict v2 types, bounds, canonical parser, coverage, cohort histogram, and UTC-hour contract |
| `packages/protocol/src/index.ts` | Export the separate v2 contract |
| `packages/core/src/sync-v2.ts` | Deterministic installation-filtered daily/session-cohort preparation and bounded project reduction |
| `packages/core/src/index.ts` | Export the new reducer API |
| `apps/vscode-extension/src/hourly-aggregates.ts` | Durable bounded UTC-day rollup, replay deduplication, freezing, corruption checks, and cross-window coordination |
| `apps/vscode-extension/src/telemetry-journal.ts` | Integrate the optional hourly store with recoverable pending batches, raw saves, startup/prune recovery, bounded rich reads, and pruning guards |
| `apps/vscode-extension/src/profile-sync.ts` | Capability negotiation, preserved v1 fallback, durable v2 promotion, hourly option, strict acknowledgements, and no downgrade |
| `apps/vscode-extension/src/extension.ts` | Wire the hourly store, rich sync source, and setting changes |
| `apps/vscode-extension/package.json` | Application-scoped `stackStats.syncHourlyActivity`, default false |
| `scripts/check-sync-contract.mts` | Preserve the v1 check and add explicit future `--require-v2` bundle parity |
| `docs/PHASE-9A-SYNC.md` | This implementation report and next-web handoff |

`packages/protocol/src/sync.ts` is unchanged. The pre-existing account callback changes and audit documents are outside this implementation's proposed commit.

### Added and changed tests

| File | Coverage |
| --- | --- |
| `tests/sync-v2.test.ts` — new | V1 compatibility; strict v2 parsing; deterministic/revisioned inputs; local, DST, and midnight ownership; completed/open cohorts; histogram bounds; empty/partial history; file identity; language normalization/caps; project overflow; byte limits; privacy exclusions |
| `tests/profile-sync-v2.test.ts` — new | Capability validation/fallback; consent and account races; ledger promotion; offline queue/backfill; lost response and no downgrade; strict v2 acknowledgement; stable revisions; start-cohort updates; concurrent windows; corrupt history; hourly opt-in/withdrawal; UTC-only dates |
| `tests/hourly-aggregates.test.ts` — new | UTC splitting; edit-batch timing; retry/restart idempotency; multiple windows; partial-write recovery; raw pruning; corruption/caps; frozen history; absent history; installation isolation |
| `tests/sync-contract-check.test.ts` — new | V1-only consumer; source/SQL language drift; required v2 bundle/mismatch; invalid flags |
| `tests/profile-sync.test.ts` — changed | Existing v1 service expectations alongside capability probing |
| `tests/vscode-api-smoke.cjs` — changed | Extension configuration exposes the hourly setting with its safe default |
| `tests/vscode-smoke.cjs` — changed | Real collected edits match the durable hourly projection and excluded source remains absent |

### Check results

| Check | Result |
| --- | --- |
| `pnpm test` | Passed: 17 files, 222 tests, including the 26 pre-existing account tests |
| `pnpm typecheck` | Passed |
| `pnpm build` | Passed |
| `pnpm test:vscode:api` | Passed |
| `pnpm test:vscode` | Passed, including real edit counts matching durable hourly arrays |
| `pnpm exec vitest run tests/sync-contract-check.test.ts` | Passed: 1 file, 4 tests |
| Default parity command against `/Users/fstopyra/Desktop/stack-stats/stack-stats-web` | Passed v1 exact source and SQL language parity; read-only |
| Documented v2 JSON example parsed with `parseSyncDayV2` | Passed; 20 exact top-level fields |
| `git diff --check` | Passed |
| Preserved-file checks | V1 protocol and pre-existing account source/tests retained their original SHA hashes |

The initial sandbox runs could not open loopback test sockets (`EPERM`) or launch VS Code through macOS LaunchServices. Permitted reruns outside that sandbox passed. The 222-test suite includes 53 v2 contract/reducer tests, 19 hourly durability tests, and the 4 parity-command tests. The real web v2 parity mode is intentionally not expected to pass before its separate migration; passing temporary-fixture tests proves the check's behavior, not deployed v2 support.

## 10. Remaining boundaries

- V2 upload is gated off against the current v1-only server. The web/database work in section 8 is necessary before richer cloud/private/public products exist.
- Multi-device and multi-window overlapping observations may inflate activity time. Transport deduplication cannot identify the same physical work observed by independent collectors.
- Retained sessions provide useful older cohorts, but incomplete/crashed sessions remain incomplete and discarded historical hourly observations cannot be reconstructed. No lifetime completeness is claimed.
- Hourly durability uses a bounded 120-day replay window. A frozen day keeps its known counters and rejects further input; `lateInputIgnored` discloses this conservative boundary. Detected corruption or capacity limits fail the affected operation closed. Daily retry deduplication does not provide a global event-ID conflict index for mutated timestamps moved to unrelated days.
- The profile queue retains its 10,000-date / roughly 25 MB bound. High-cardinality rich payloads can exhaust it before 10,000 days; a future migration will need revision-preserving compaction for that case.
- Hourly edit/line timing has the existing batch timestamp's precision. UTC hours and collector-local daily totals intentionally have different date bases.
- Project overflow prevents exact distinct-project counts across periods. Installation-scoped identities prevent repository reconciliation across devices; files remain daily counts.
- Older extension versions cannot safely operate on a promoted ledger. Keep all windows using that storage current; the future server must also enforce no downgrade.
- Default-off hourly upload and grant-scoped capability protect future transfer. Per-metric public publication and explicit cloud erasure remain web tasks.

## 11. Recommended commit command

Review the working tree first. The following stages only Phase 9A files, excluding the account callback changes and prior untracked audit documents that were already present:

```sh
git add \
  apps/vscode-extension/package.json \
  apps/vscode-extension/src/extension.ts \
  apps/vscode-extension/src/profile-sync.ts \
  apps/vscode-extension/src/telemetry-journal.ts \
  apps/vscode-extension/src/hourly-aggregates.ts \
  packages/core/src/index.ts \
  packages/core/src/sync-v2.ts \
  packages/protocol/src/index.ts \
  packages/protocol/src/sync-v2.ts \
  scripts/check-sync-contract.mts \
  tests/profile-sync.test.ts \
  tests/profile-sync-v2.test.ts \
  tests/vscode-api-smoke.cjs \
  tests/vscode-smoke.cjs \
  tests/hourly-aggregates.test.ts \
  tests/sync-v2.test.ts \
  tests/sync-contract-check.test.ts \
  docs/PHASE-9A-SYNC.md
git diff --cached --check
git diff --cached --stat
git commit -m "Add capability-gated v2 sync aggregates"
```

These are recommended commands, not commands executed by this task. No push or deployment is included.

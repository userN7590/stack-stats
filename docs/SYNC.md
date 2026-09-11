# Optional aggregate synchronization (v1)

Stack Stats tracks locally by default. Connecting an account enables optional profile synchronization. **Account linking alone never uploads history.** Run **Stack Stats: Enable Profile Sync** and approve **private summary uploads** in the existing browser login/PKCE flow. Publishing those uploads is a separate, default-off choice at `/settings/sync`.

Only durable session snapshots from this installation are eligible; legacy SQLite-only file events and raw history are not converted.

This release implements sync; it does not change the collector, session semantics, CLI APIs, daemon delivery, raw-event journal, or SQLite schema v3. No account, network, or cloud database is needed for local tracking. A failed upload never acknowledges/deletes local sessions or raw events.

## Exactly what is uploaded

One canonical daily summary per authenticated account, random installation UUID, and recorded local calendar date:

- Estimated active coding milliseconds from existing evidenced intervals.
- Editor edit operations and gross line boundaries added/removed, including undo/redo as already counted locally. These are not Git diffs or proof of authorship.
- Count of sessions contributing to that date and distinct recorded files on that installation/date.
- Language totals for time, edits, and line changes. Only a fixed standard-language allowlist is accepted; custom/unknown language identifiers are grouped as `other`.
- Project totals for time, edits, and line changes. Project IDs are HMAC-SHA256 pseudonyms using a private random salt and account/installation domain separation. Names are never sent, even when local `includeProjectNames` is enabled.
- Schema/aggregation version, monotonic daily revision, installation UUID, and calendar date. Server receipt timestamps support last-sync display.

No source, file contents, filenames, paths, file IDs, local session IDs, prompts, credentials in payloads, raw events, keystrokes, commit/branch/remote identifiers, terminal commands/output, diagnostics, precise activity timestamps, timezone identifier, hardware identifiers, emails, or project display names are uploaded. Authentication separately returns existing user ID/username/display name/profile URL; tokens remain exclusively in VS Code SecretStorage.

AI attribution/AI-manual ratios are intentionally excluded. Existing reports are provenance claims and unknown external activity cannot safely establish authorship or human modification of generated code. Build/test/debug counts, character changes, Git activity, streak totals, and first/last activity timestamps are also excluded from this first session-summary contract. Some exist in local raw telemetry, but are not derived here from the session API. Streak **inputs** are derived server-side from active daily records, not fabricated client streak totals.

Existing collection exclusions apply before local tracking. Changing exclusions does not retroactively remove old history: enabling sync includes previously collected eligible days. Do not approve history upload if that history must remain only on the device. Per-project historical upload filtering and deleting selected cloud days are not implemented yet.

## Consent and commands

| Command | Behavior |
| --- | --- |
| Enable Profile Sync | New browser authorization requesting `stats:write`; explains categories and initial 90-day history. Cancelling does not enable sync. |
| Disable Profile Sync | Stops future uploads across windows sharing this installation's storage. Retains durable queue, uploaded data, and publication preferences. |
| Sync Now | Checkpoints local activity and tries up to ten queued days; cannot grant permission or override disabled consent. |
| Open Profile | Existing `https://stackstats.dev/u/{username}` action. |
| Manage Sync Privacy | Opens `/settings/sync`; publication and language visibility are separate explicit choices. |
| Disconnect Account | Disables this installation's sync, removes secrets and attempts server revocation. Local and uploaded history remain. |

Tracking Status shows connection/sync state, pending-day count, elapsed time since the last acknowledged PUT, and actionable errors. No normal retry notifications are emitted. Consent is deliberately **not a workspace-configurable boolean**: a repository cannot grant upload permission. Pausing collection does not automatically disable uploading previously collected history; use Disable Profile Sync for that.

Disable/Disconnect aborts this window's request and persists consent for other windows to observe before their next request. An already accepted/in-flight request cannot be recalled. If persisting Disable fails, the UI reports that only this window has stopped and asks you to retry. Other installations must be disabled individually; `/extension/connect` offers account-wide credential revocation. Offline disconnect cannot confirm server revocation. Previously uploaded aggregates remain until account/profile deletion (database cascade); a selective deletion UI is a next-step item.

## Architecture

```text
Existing SessionTracker → 15-second durable LocalSessionStore checkpoints
                                  ↓ strict read, at most every 5 minutes
latestSessions + dailyStatistics → core syncDay curator (not sidebar reducers)
                                  ↓ shared cross-window revision lease
account/origin/installation queue → up to 10 daily PUTs per 30-second batch
                                  ↓ AccountService access/refresh
sync_put_day: scope + owner + quota + validation + revision transaction
                                  ↓
sync_installations / sync_days (private, RLS and table privileges locked down)
                                  ↓ reusable SQL sync_aggregate reducer
private 7/30/90/lifetime API       explicit public allowlist → existing ProfileView
```

The existing 15-second extension timer schedules work without awaiting cloud requests. A process coalesces concurrent ticks. The coordinator checks at most every 30 seconds, enumerates persisted session history at most every five minutes (or Sync Now), and uploads only changed/unacknowledged days. `proper-lockfile` supplies cross-window leases/heartbeat/crash recovery for queue revisions and account refresh; network PUTs run outside the revision lease. Local checkpoints and UI updates do not wait for these operations.

The installation UUID is persisted in `globalStorage/installation/id.json`, seeded from the existing `globalState.installationId`, and survives extension updates/restarts. A separate `sync-salt.json` persists the private pseudonymization salt. Neither is a bearer credential. These files are private local metadata (0600, parent 0700); installation UUIDs contain no hardware information. Do not clone these files to another device: a clone is deliberately the same source namespace and may conflict. A fresh installation generates a fresh UUID. Storage failure blocks sync safely while local tracking continues.

Queue files live in `globalStorage/profile-sync-v1/<hash(origin:account:installation)>/queue.json`. They contain consent/grant ID, initial date floor, canonical daily payloads, revisions/acknowledgements, last-scan/success times, and retry state. No credentials or profile display names are stored there. Atomic temporary writes use fsync + rename. The local session store has an optional strict-read mode for sync: any corrupt/unreadable session defers reconciliation rather than overwriting a complete cloud day with partial history. Corrupt queue files are preserved and surfaced, never silently reset.

## Payload and revision contract

```json
{
  "schemaVersion": "1",
  "aggregationVersion": 1,
  "date": "2026-09-10",
  "revision": 3,
  "activeMs": 30000,
  "editCount": 2,
  "linesAdded": 4,
  "linesRemoved": 2,
  "sessionCount": 1,
  "fileCount": 1,
  "languages": [
    {"id":"typescript","activeMs":30000,"editCount":2,"linesAdded":4,"linesRemoved":2}
  ],
  "projects": [
    {"id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","activeMs":30000,"editCount":2,"linesAdded":4,"linesRemoved":2}
  ]
}
```

`packages/protocol/src/sync.ts` defines the portable TypeScript contract, canonicalizer and strict validator. The web app vendors that **exact file** as `src/lib/sync-contract.ts` because the repositories are deployed independently and use different Zod major versions. Run `node --import tsx scripts/check-sync-contract.mts /path/to/stack-stats-web` to verify exact parity and the SQL language allowlist. Future schema changes require coordinated versioning; publish the protocol package before adding more consumers.

Arrays are unique and sorted by ID. Every breakdown's four counters must sum to the daily totals. Unknown fields, including `userId`, are rejected. Numbers are nonnegative safe integers: revision 1..1e12, other counters ≤1e9, daily time ≤604,800,000ms (a protective bound allowing overlapping windows, not an assertion that a day lasts a week). Each breakdown is limited to 256 rows and a request to 65,536 UTF-8 bytes; SQL independently bounds JSONB size, so the effective bound is the stricter representation. Limits cause visible errors, never silently dropped projects or clamped counters. Future dates beyond tomorrow UTC are rejected; local calendar dates survive timezone travel, including DST days.

Under the queue lease, the coordinator strictly re-reads durable history, reuses the core reducers, and compares canonical content with `revision` normalized to 1. Unchanged content retains its revision. Changed content increments the durable per-day counter. No wall-clock ordering is used. Acknowledgement advances only if the queued revision/content still matches the sent day.

Server primary key `(user_id, installation_id, date)` prevents retry duplication. Equal revision/equal JSONB is a no-op; greater revision replaces one day; lower revision returns 409 `stale_revision`; equal revision/different content returns 409 `revision_conflict`. Transactions serialize writes and quotas per account. Never blindly increment a conflicting cached payload to overpower newer server history. Restore the original local queue/history from backup and investigate storage cloning/reset before retrying; v1 deliberately preserves server data and reports unresolved conflicts. Local deletion of session files is not a cloud deletion instruction.

## Initial history, offline retry, and multiple devices

First approval includes **today and the preceding 89 recorded local dates**, then all later dates while consent remains enabled. The persisted date floor survives retries, restarts, disable/re-enable, and renewed grants for that account. Older pre-consent dates are untouched locally and intentionally outside v1 upload scope. No raw-history backfill occurs.

The initial scan queues supported daily summaries and sends at most ten per batch. Closing VS Code midway loses no queue state; a response lost after commit safely retries the same PUT. Reconciliation discovers later recovery/corrections within the consent date range. Sessions stamped with another installation ID are excluded, preventing accidental upload of copied exports as this installation's activity.

Transient failures retain the queue and use persisted exponential backoff: one minute initially, doubling to 30 minutes plus up to 20% jitter. Manual Sync Now bypasses the delay, not consent. A 401 invokes the existing account service's refresh once before retrying; revoked/expired grants require new browser approval. Rate limits, server failures and offline errors never stop collection. Permanent malformed/conflict errors remain visible and queued; they are retried with the same bounded backoff and are not silently discarded.

Different installations contribute separate daily records. Duplicate deliveries and multiple windows sharing one installation do not add rows. **Cross-editor/device observation of the same physical work cannot yet be deduplicated**: time can overlap and shared files/projects are intentionally not globally identifiable. Server totals therefore sum recorded activity, not guaranteed unique human time. Imported/copied histories with unchanged installation IDs need care; independent collectors must use independent IDs.

A session crossing midnight counts once on each day. Combined counts are therefore named `sessionDays` and `fileDays`, never unique lifetime sessions/files. Projects are unique pseudonyms **per installation**, not globally unique repositories. Private active-date arrays provide timezone-preserving streak inputs. No client-supplied lifetime totals or streaks are trusted.

## Backend storage and APIs

Apply web migration `supabase/migrations/20260910000000_profile_sync.sql` **after** all existing migrations; no local SQLite migration or service-role key is needed.

| Table/change | Purpose |
| --- | --- |
| `extension_auth_codes.scope`, `extension_connections.scope` | Existing rows default to identity. Only a new explicit grant receives `stats:write`. |
| `extension_refresh_history` | Hash-only predecessor/successor history for scoped rotation/replay detection; cascades with connection. |
| `sync_installations` | Composite account/installation key, creation and last accepted upload times. |
| `sync_days` | Composite account/installation/date PK, revision, validated versioned daily JSONB, update time; indexed owner/date. |
| `sync_privacy` | Owner-only explicit publication controls, default false; separate from data storage. |
| `sync_rate_limits` | Persistent per-account one-minute upload quota. |

No browser/extension role has direct table privileges on sync/credential tables. Narrow definer RPCs use an empty search path and derive owners from verified opaque token possession or `auth.uid()`. Deleting an account/profile cascades its grants and synced data. `sync_aggregate` is not executable by browser or extension roles; the public wrapper builds a field allowlist and omits project IDs, installation IDs and active dates. This separation allows later per-metric/project/history controls without changing ingestion.

| Route | Auth and result |
| --- | --- |
| `POST /api/extension/authorize` | Existing cookie login + exact-origin approval; optional `scope:"stats:write"` binds the new scope to the PKCE code. |
| `POST /api/extension/exchange` | Existing S256 + one-time code + exact callback; scoped responses additionally include `syncGrant` (nonsecret connection UUID). |
| `POST /api/extension/refresh` | Identity-only request remains unchanged. Scoped credentials require `{refreshToken,nextRefreshToken}` and rotate. |
| `PUT /api/v1/sync/installations/{uuid}/days/{date}` | Opaque access token with `stats:write`; accepts the daily body above. Returns `{installationId,date,revision,unchanged}`. Never accepts an owner ID. |
| `GET /api/v1/sync/summary?period=7\|30\|90\|lifetime&to=YYYY-MM-DD` | Fresh browser login; private current-account SQL aggregates. `to` defaults to UTC today; optional local date aligns a chosen locale. No write-token stats-read scope. |
| `PUT /api/v1/sync/privacy` | Fresh browser login + exact Origin; `{publishProfile,publishLanguages}`. Upload credentials cannot change this. |
| `/settings/sync` | Private summary and publication controls. |
| `/u/{username}` | Existing profile design, curated published lifetime totals if explicitly enabled and at least one day exists. |

Upload functions enforce 60 requests/minute/account and at most 32 installations/account, including direct RPC use. Credential limits remain 20 active connections/account and 64 live access tokens/connection; scoped refresh history is capped at 4096 rotations per fixed 30-day grant. Gateway/IP limits should additionally protect anonymous malformed traffic. Never log Authorization headers, token bodies or responses. API bodies are bounded and error messages sanitized; requests use no-store and no-referrer headers.

## Authentication and security

Existing identity-only credentials are not upgraded. The new browser consent uses the existing Supabase account, exact callback allowlist, 90-second authorization code, S256 verifier and random state. Callback URLs contain no access/refresh tokens. Scoped credentials authorize only own-account daily writes and identity lookup; they cannot edit identity, manual statistics, appearance, or publication controls.

For scoped grants, AccountService saves a random proposed refresh successor in SecretStorage **before** posting it. The server stores only token hashes and atomically advances the refresh hash. Repeating the exact predecessor/current-successor pair recovers a lost response. Reusing a predecessor with a different successor revokes the connection family, including access tokens. The editor serializes refresh across windows; pending rotations survive crashes. Identity-only non-rotating credentials retain their old behavior, and the legacy refresh RPC explicitly rejects stats grants. Neither refresh path extends the fixed 30-day delegation. This follows the intent of [OAuth Security BCP refresh-token protections](https://www.rfc-editor.org/rfc/rfc9700.html#section-4.14).

Local privacy salts and aggregate queues are private metadata, not encryption against a compromised OS/editor. SecretStorage protects bearer credentials through VS Code's storage system. Sync remains self-reported collector data, not independently verified developer work. The hosting platform sees ordinary network metadata such as IP addresses and timing; pseudonymous project IDs still reveal recurring project activity to the account service.

## Profile precedence

Default: manual totals and manually chosen public languages continue to display exactly as before. Sync uploads are private and never mutate `profiles` or `profile_languages`.

After explicit **Use synced lifetime totals** and the first daily upload, published sync totals **replace** displayed manual totals, never add to them. File totals are labeled **File-days** and projects **Project identities**. Synced languages appear only when separately approved; otherwise that section is empty, without substituting manual languages. Owner controls lead to Sync Privacy. Turning publication off restores the existing public manual data. A rolling deployment/RPC failure fails closed to that preexisting manual source. Public summaries expose no individual historical dates or project pseudonyms.

## Exact staging and F5 procedure

1. Create/use an isolated **staging Supabase project**. In `stack-stats-web/.env.local`, set its existing public URL/anon key. Do not reuse production account data for tests and do not add a service-role key. Apply all migrations in filename order to staging using the existing Supabase workflow, including identity and `20260910000000_profile_sync.sql`. This code task does not apply changes to the hosted database.
2. Configure Supabase local Site URL `http://localhost:3000` and the `/auth/callback` redirect policy described in `EXTENSION_AUTH.md`, including the nested `next` destinations used by extension signup confirmation. Native callbacks use the existing extension ID; keep its allowlist unchanged. Test an existing staging user first to separate email-delivery configuration from sync.
3. In the web repo run `npm install`, then `STACK_STATS_APP_ORIGIN=http://localhost:3000 npm run dev`. Sign in at that origin and ensure the staging account has a profile/username. For deployment later, use HTTPS `https://stackstats.dev`; arbitrary staging HTTPS origins are intentionally not accepted by installed editor builds.
4. In `stack-stats`, run `pnpm install`, `pnpm build`. Open **`apps/vscode-extension` as the VS Code folder**. Choose the included **Run Stack Stats Extension (local account server)** launch configuration; its `STACK_STATS_AUTH_ORIGIN` is `http://localhost:3000`. Press **F5**. Use a separate VS Code profile if you want clean local history. For production, use the original **Run Stack Stats Extension** configuration after deploying web support.
5. Open a small test project in the Development Host. Edit twice several seconds apart and wait 15 seconds. Verify Today/Session. Without connecting, verify no `/api/v1/sync` uploads. Connect Account through the browser, allow the editor callback, and verify identity **with sync disabled**. No daily PUT should occur.
6. Run **Enable Profile Sync**. Verify the browser approval names `stats:write`, categories, 90-day bound and private default. Cancel once and confirm no upload. Start again, approve, and return to the editor. Run **Sync Now**. Tracking Status should show successful time and decreasing pending days. Verify private `sync_days` rows through the staging SQL dashboard, with token hashes only in credential tables.
7. Run Sync Now repeatedly without editing: the number of day rows and summed totals must stay constant. Edit, wait for a checkpoint and Sync Now: today's existing record receives a larger revision. Manually inspect HTTP status/metadata without logging bearer headers or request credentials.
8. Stop the local web server; edit/checkpoint/Sync Now. Pending state must retain local data. Reload the host, restart the server, and Sync Now (or allow backoff): each date resumes once. With >10 eligible dates, close/reopen partway through backfill and verify completion. Preexisting dates older than the persisted initial 90-day floor stay local.
9. In the browser visit `/settings/sync`. Before publication, `/u/{username}` still shows manual values. Approve totals: synced values replace the display and Files becomes File-days. Leave languages private, then enable them explicitly. Turn publication off and verify manual values return. Inspect `sync_public_profile` to confirm it has no project IDs/active dates.
10. Run **Disable Profile Sync**, edit again and restart the host: no uploads, tracking continues. Re-enable requires another browser approval. Test two editor windows sharing storage: no extra daily rows and disabling persists across them. A second device uses an independent UUID and adds an independent daily source.
11. Test expired access in the disposable/staging DB (expire the connection's access row), then Sync Now: AccountService refreshes without browser token copying. Revoke editor connections from `/extension/connect`, retry, and confirm local tracking survives and a new grant is required. Test Disconnect while offline; it removes local secrets and keeps local history.

Automated commands:

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm test:vscode:api
pnpm test:vscode
pnpm benchmark:sync
node --import tsx scripts/check-sync-contract.mts /path/to/stack-stats-web
pnpm --filter stack-stats-vscode package
```

In web: `npm test`, `npx next typegen`, `npx tsc --noEmit`, `npm run lint`, `npm run build`. Apply migrations to a disposable PostgreSQL/Supabase instance and run `supabase/tests/extension_identity.sql` and `supabase/tests/profile_sync.sql`; each fixture transaction rolls back. Never run fixture SQL in production.

## Performance, limits, and next steps

An inspection benchmark with 3,000 durable sessions / 300 historical days found a final first strict scan + ten mock PUTs around 0.35s, a repeat scan around 0.31s, and a 161KB 90-day queue (earlier concurrent runs: 0.75s / 0.49s). Actual upload latency is excluded. Reads are bounded to 16 concurrent session files; the five-minute history enumeration is linear in retained sessions. The queue rewrite/parse is linear in synced dates and capped at 25MB / 10,000 dates. SQL summaries scan indexed daily records and expand their bounded breakdowns; no redundant lifetime counters are stored. This is lightweight for the tested history, but a persistent changed-day index and per-day queue files should precede very large multi-year installations. Requests are asynchronous, capped at ten per batch, and never sent on each keystroke. Backend summaries and cross-window lease contention are the other mechanisms to watch in staging.

After this proves stable: add a browser/extension staging E2E suite and operational counters without payload/token logging; provide cloud deletion/export and finer per-project/history publication controls; then add an incremental changed-day index and measured aggregate-query caching if usage warrants it. Solve cross-collector provenance/deduplication before displaying AI ratios or treating overlapping device time as unique human time.

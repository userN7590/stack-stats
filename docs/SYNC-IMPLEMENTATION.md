# Aggregate sync implementation report

Implemented optional private daily-summary sync across the existing extension and web app. The existing collector, session API, SQLite v3, daemon, CLI, and seven native sidebar views remain in place. Account linking alone remains identity-only. The [complete design, payload, routes, migration, consent model, privacy limitations and exact staging/F5 procedure](SYNC.md) is the operational reference.

## Delivered behavior

- New browser-approved `stats:write` grant through existing Supabase login + PKCE; existing identity grants are not upgraded. Scoped refresh tokens rotate, recover lost replies, and detect conflicting predecessor reuse. Credentials and pending rotation secrets stay in VS Code SecretStorage.
- Persistent random installation UUID and private project pseudonymization salt; no hardware identity.
- Curated daily counters via existing core session reducers; durable account/origin/installation queue, canonical revisions, cross-window coordination, offline backoff and ten-day batches. Initial backfill is bounded to 90 calendar dates, resumes after restart, and never uploads raw history.
- Authenticated idempotent daily PUT with independent HTTP/SQL validation, database quotas and account ownership. Indexed private daily records support reusable 7/30/90/lifetime SQL summaries and active-date/streak inputs.
- Native Enable/Disable Profile Sync, Sync Now, Manage Sync Privacy and existing Open Profile actions, pending count and last success.
- Separate default-off web publication and language visibility. Published synced lifetime totals replace displayed manual values without changing saved manual data. No public project aliases or daily activity dates.

## Files added or changed in this task

`stack-stats`:

| Files | Purpose |
| --- | --- |
| `packages/protocol/src/sync.ts`, `packages/protocol/src/index.ts` | Versioned strict portable daily contract/export. |
| `packages/core/src/sync.ts`, `packages/core/src/index.ts` | Curate the existing daily reducer; safe language grouping/project alias injection. |
| `apps/vscode-extension/src/profile-sync.ts` | Installation/salt persistence, durable revision queue, batching/retry, consent and clean service state. |
| `apps/vscode-extension/src/exclusive.ts` | Cross-window leases with crash recovery. |
| `apps/vscode-extension/src/account-service.ts`, `vscode-account.ts` | Explicit scoped PKCE consent, SecretStorage rotation recovery, synchronized refresh. |
| `apps/vscode-extension/src/local-store.ts` | Optional strict history reads; existing callers retain previous behavior. |
| `apps/vscode-extension/src/extension.ts`, `sidebar-model.ts` | Background scheduling, state, commands and native UI integration. |
| `apps/vscode-extension/package.json`, `.vscode/launch.json` | Commands, v0.4.0, locking dependency, localhost F5 configuration. |
| `tests/profile-sync.test.ts`, `tests/account.test.ts`, `tests/vscode-api-smoke.cjs` | New regression and real editor checks. |
| `scripts/benchmark-sync.mts`, `scripts/check-sync-contract.mts`, `package.json`, `pnpm-lock.yaml` | Measurement, contract parity, scripts/dependencies. |
| `README.md`, `apps/vscode-extension/README.md`, `docs/ACCOUNTS.md`, `docs/SYNC.md`, this report | User, protocol, security and staging instructions. |
| `apps/vscode-extension/dist/extension.cjs`, `stack-stats-vscode-0.4.0.vsix` | Final build/package. |

`stack-stats-web`:

| Files | Purpose |
| --- | --- |
| `supabase/migrations/20260910000000_profile_sync.sql` | Scoped grant extension, rotation history, sync tables, validation, quota, daily PUT and private/public reducers. |
| `supabase/tests/profile_sync.sql` | Disposable SQL assertions for authorization, persistence and aggregation. |
| `src/lib/sync-contract.ts`, `sync-api.ts`, `synced-profile.ts` | Vendored contract, HTTP endpoints and profile precedence. |
| `src/lib/extension-auth.ts`, `extension-api.ts` | Scoped approval and rotating-refresh routing. |
| `src/app/api/v1/sync/installations/[installationId]/days/[date]/route.ts` | Daily PUT. |
| `src/app/api/v1/sync/summary/route.ts`, `privacy/route.ts` | Private summary query and owner-only publication update. |
| `src/app/settings/sync/page.tsx`, `src/components/dashboard/sync-privacy.tsx` | Private summaries and publication controls. |
| `src/app/extension/connect/page.tsx`, `src/components/auth/extension-consent.tsx` | Reuse login continuation; explicit upload consent text. |
| `src/app/u/[username]/page.tsx`, `src/components/profile/profile-view.tsx`, `src/lib/types.ts` | Optional synced source, honest count labels, existing design preserved. |
| `src/app/dashboard/page.tsx`, `src/proxy.ts` | Privacy navigation and cookie-independent upload routing. |
| `tests/sync.test.ts`, `README.md`, `docs/EXTENSION_AUTH.md`, `docs/SYNC.md`, this report | HTTP/privacy tests and documentation. |

Preexisting web auth changes were preserved. No commits, pushes, live migrations, account mutations, or deployments were performed.

## Validation results

- Extension/engine: **89 tests passed in 12 files**, including all prior session, SQLite, telemetry, API/CLI, collector, sidebar and auth tests. Loopback tests ran with local network permission; the initial sandbox-only attempt correctly could not bind loopback.
- Root TypeScript check and builds of all six workspace packages: passed.
- Real installed VS Code in isolated Development Host profiles: API/commands/native views/optional-sync state smoke test and actual editing/local tracking smoke test both passed.
- Web: **52 tests passed in 4 files**, Next route type generation, TypeScript, ESLint and production webpack build passed. Stale duplicate generated `.next/types` files were removed and regenerated; source files were preserved.
- Disposable PostgreSQL 16: all four migrations applied, existing identity SQL suite and new profile-sync SQL suite passed. Tests cover PKCE/scope, token rotation/replay, direct-table/function permissions, malformed payloads, identical/stale/conflicting/new revisions, multiple installations/accounts, quota, 7/30/90/lifetime reducers, private defaults/public allowlist, manual preservation, expiry/revocation and deletion cascade. Fixture transactions rolled back.
- Contract parity: extension/web exact source and SQL language allowlist agree.
- Final benchmark: **3,000 durable session files / 90 eligible dates; first scan + ten mock PUTs 354ms, repeat 309ms; queue 161,024 bytes**. Local fsync/strict reads included; network latency excluded. Earlier concurrent runs measured 754ms/491ms. The full-history scan is linear and occurs at most every five minutes automatically; large-history indexing remains the main performance follow-up.
- Final extension: **308.34KB bundled JavaScript; 71.88KB VSIX**, packaged successfully. Packaging notes the bundle size; it remains a single native UI extension bundle without a WebView.

Live Supabase email confirmation, deployed callback routing and real-account browser → editor → cloud synchronization require the documented staging run. Automated unit/SQL/editor tests do not claim that a hosted environment has been configured or deployed.

## Deliberate limits and next step

Only durable session snapshots from this installation are uploaded. Legacy SQLite-only file events and raw event history are not converted. AI ratios, authorship/modification claims, exact activity timestamps, characters, Git and workflow detail remain local/outside v1. Combined session/file counts are session-days/file-days. Project identities are per installation. Overlapping physical activity across independent collectors cannot yet be deduplicated.

Private upload and public display are separate; broad controls are implemented, finer metric/project/history choices and selective cloud deletion/export remain future work. Revision conflicts after restoring/cloning/resetting local storage fail visibly rather than overwriting newer server data. Initial history is explicitly limited to 90 dates and queue/request/database safety caps are documented.

Next: prove the whole consent/offline/publication cycle in isolated staging, automate that browser/editor E2E path, and add cloud deletion/export plus finer privacy controls before broad rollout. Optimize changed-day indexing and SQL summary caching only after measuring larger histories; solve cross-collector provenance before adding AI or unique-human-time claims.

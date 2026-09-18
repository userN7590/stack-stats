# Optional account connection

Stack Stats tracks locally by default. Connecting an account enables optional profile synchronization. **Account linking is still identity-only.** The separate [aggregate sync flow](SYNC.md) now adds explicit `stats:write` consent and refresh-token rotation; it never upgrades existing identity grants. No local history, file/project IDs, edits, sessions, source text, or prompts are sent to stackstats.dev by account linking.

## Use the extension

In **Account**, select **Connect account**. The browser opens the existing Stack Stats login/signup flow and then an approval page showing your username. New users choose a username through the existing profile form. Select **Connect VS Code**, approve the browser's request to open the editor, and the sidebar displays **@username · Connected**.

The Command Palette also offers **Connect Stack Stats Account**, **Disconnect Account**, **Open Profile**, and **Cancel Account Connection**. Open Profile opens `https://stackstats.dev/u/{username}` when connected; otherwise it starts account linking. Cancelling in the browser or extension returns to local-only operation. Closing the browser is not observable; the pending request expires after ten minutes. Restarting VS Code during that interval recovers the pending request from SecretStorage.

Disconnect removes credentials and pending linking material from VS Code SecretStorage and attempts to revoke that editor connection on the server. It never deletes local statistics, the web account, or the public profile. If offline, local removal still succeeds, but server revocation cannot be confirmed. Visit `https://stackstats.dev/extension/connect` while logged in to revoke all editor connections independently. If SecretStorage deletion fails, the UI explicitly reports the failure and asks you to retry.

Authentication failures never pause tracking. Activation does not await SecretStorage restoration or the network. Existing credentials are checked in the background, refreshed when needed, and rechecked at most every five minutes by the existing extension checkpoint/focus flow. Transient network/server errors retain credentials for retry. Expired/revoked credentials and deleted accounts require reconnection. The UI distinguishes Not connected, Connecting, Connected, Authentication expired, and Authentication error.

## Architecture

```text
VS Code AccountService → random state + S256 challenge
    ↓ open browser (no credentials in URL)
stackstats.dev/extension/connect
    ↓ existing Supabase cookie login/signup + current user check
explicit approval → one-time authorization code (90 seconds)
    ↓ VS Code URI handler: code + state only
HTTPS POST /api/extension/exchange: code + verifier + exact callback
    ↓ atomic PostgreSQL grant consumption
identity-only access/refresh credentials → VS Code SecretStorage
    ↓
GET /api/extension/account → user ID, username, display name, profile URL
```

The web app's existing Supabase identities and `profiles.user_id` remain authoritative. This is a narrow device delegation layer, not another user/password system. It does not copy the browser's Supabase access or refresh token into the editor. Identity credentials are opaque values and **are not Supabase JWTs**; they cannot call `save_profile`, update profile statistics, or authorize any telemetry endpoint.

The extension service (`account-service.ts`) depends only on SecretStorage, a browser/callback adapter, and HTTP. It owns state transitions, restoration, validation, refresh, cancellation, and bounded requests. `vscode-account.ts` adapts `registerUriHandler`, `env.asExternalUri`, and `context.secrets`. The sidebar consumes sanitized state. Future in-process sync code can depend on `getAccessToken()` and state events without importing UI or reading storage. The public extension API exposes account state/events only, never credentials.

## Protocol and storage

| Endpoint | Authorization / operation |
| --- | --- |
| `POST /api/extension/authorize` | Existing Supabase browser session, fresh `getUser()`, same-origin check, explicit approval; `{challenge,state,redirectUri}` → short-code callback |
| `POST /api/extension/exchange` | `{code,verifier,redirectUri}`; consumes a matching unexpired grant once |
| `POST /api/extension/refresh` | `{refreshToken}` → new 15-minute access token and current identity |
| `GET /api/extension/account` | `Authorization: Bearer <accessToken>` → `{account:{userId,username,displayName,profileUrl}}` |
| `POST /api/extension/revoke` | `{refreshToken}`; idempotently deletes the corresponding connection and access tokens |
| `POST /api/extension/revoke-all` | Same-origin authenticated browser request; revokes only the current user's editor connections and pending codes |

Exchange/refresh return `{accessToken,refreshToken,expiresAt,refreshExpiresAt,account}`. Identifiers and response fields are validated. Responses use `Cache-Control: no-store` and `Referrer-Policy: no-referrer`. Browser token endpoints do not depend on cookie middleware. HTTP requests have a ten-second extension timeout, reject redirects, and never log payloads/errors containing credentials.

Migration `20260909000000_extension_identity.sql` adds three RLS-enabled, directly inaccessible tables:

- `extension_auth_codes`: SHA-256 code hash, owner, S256 challenge, exact callback, creation/expiry timestamps.
- `extension_connections`: random connection ID, existing profile owner, SHA-256 refresh hash, creation and fixed 30-day expiry.
- `extension_access_tokens`: SHA-256 access hash, connection ID, 15-minute expiry.

Table access is revoked from `anon` and `authenticated`. Narrow `security definer` functions with an empty search path implement possession/ownership checks. Only authenticated users can issue grants or revoke all their connections. Exchange/refresh/account/revoke accept only high-entropy credential possession and expose no arbitrary owner parameter. Foreign keys cascade account/profile deletion into credential revocation. No service-role key is required.

The refresh credential is a **non-rotating, identity-only device credential with a fixed 30-day lifetime**, not an indefinitely renewed session. Independent short-lived access tokens avoid refresh-rotation races between VS Code windows and make lost refresh responses retryable. Revocation immediately invalidates all access tokens on that connection. This is a deliberate limited-scope tradeoff: do not broaden these credentials to private-data or write scopes without adopting refresh rotation or sender-constrained credentials and renewed consent. Possession of a stolen refresh credential could identify the account until revocation/expiry, so both token types use SecretStorage.

The database caps active connections at 20 per account and live access tokens at 64 per connection; grant issuance is also bounded. Expired entries are pruned opportunistically per owner/connection. Operators can periodically delete expired rows to reclaim inactive-account metadata. Configure platform request rate limits/redaction; never log Authorization headers, JSON token bodies, or successful token responses. No raw token is stored in the application database.

## Callback and environment security

The manifest retains the existing extension ID and adds `onUri`. Default backend callback allowlisting accepts exact `/auth/callback` URIs for the existing `undefined_publisher.stack-stats-vscode` identifier under `vscode`, `vscode-insiders`, `cursor`, and `windsurf`. A single bounded numeric `windowId` query parameter added by VS Code's `asExternalUri` is allowed on those native URIs; arbitrary query parameters are rejected. The complete routed URI is still bound exactly at approval and exchange. There are no wildcard or arbitrary redirect hosts. State is random, checked in constant time, and bound to a locally initiated pending request. Duplicate, unsolicited, expired and mismatched callbacks cannot establish a connection. PKCE uses a cryptographically random verifier; its S256 challenge travels to the browser while the verifier stays in SecretStorage until POST exchange.

`env.asExternalUri` is used for routing. Remote/Codespaces callback URLs are **not** broadly allowlisted: operators must configure exact trusted relay URIs in the web app's `STACK_STATS_EXTENSION_REDIRECT_URIS` JSON array before those environments can connect. Unsupported callbacks fail closed. Local tracking still works. A future Marketplace publisher ID similarly requires an explicit callback allowlist change and an extension-storage migration plan; this release preserves the existing ID.

Installed builds use only `https://stackstats.dev`. Development hosts may set `STACK_STATS_AUTH_ORIGIN=http://localhost:3000` (or loopback `127.0.0.1`) in their launch environment. Workspace settings cannot override the authentication server. Production and development credentials use separate SecretStorage keys. No token is placed in settings, CLI configuration, telemetry JSON/SQLite, output logs, or URLs.

SecretStorage stores the access/refresh tokens, expiries, and the four account identity fields. A separate temporary secret stores the verifier, random state, exact callback, and ten-minute deadline. Pending material is removed after completion/cancellation. SecretStorage is editor-managed secure storage, not a guarantee against a compromised editor/OS. Multiple windows receive storage-change notifications; local operations are serialized, cancelled in-flight responses cannot restore credentials after this window disconnects, and backend revocation remains authoritative.

## Deploy and test with F5

1. In `stack-stats-web`, apply existing migrations and then `supabase/migrations/20260909000000_extension_identity.sql` to a **development/staging Supabase project**. The implementation does not apply a migration to the live project automatically.
2. Configure the existing `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY`. Set `STACK_STATS_APP_ORIGIN=http://localhost:3000` for `npm run dev`; use `https://stackstats.dev` (the default) in production. No new secret environment variable is required.
3. Supabase's email confirmation redirects must allow the existing web `/auth/callback` with the extension continuation, e.g. `http://localhost:3000/auth/callback?next=**` and the equivalent production URL, scoped to those exact origins/paths. Keep the existing `{{ .ConfirmationURL }}` template. No VS Code token callback is sent through Supabase itself.
4. Run `npm run dev` in the web repository. In the extension repository run `pnpm install` and `pnpm build`, then open `apps/vscode-extension` in VS Code. Add `"env": {"STACK_STATS_AUTH_ORIGIN":"http://localhost:3000"}` to the **Run Stack Stats Extension** launch configuration for this test. Press F5.
5. In the development host, edit a file and confirm tracking works before connecting. Open Account → Connect account. Log in or sign up, create your profile if needed, and explicitly approve. Confirm the browser callback reaches the same development host and displays @username · Connected. Open Profile always uses the canonical public `https://stackstats.dev/u/{username}` URL; a staging-only username may not exist on production.
6. Cancel once in the browser and once in the editor. Retry; restart the host while login is pending. Reconnect, reload, and check restored identity. Disconnect while offline and confirm local-only state, retained telemetry, and no account deletion. Reconnect online; revoke all editors from `/extension/connect` and verify the editor reports expiry on its next validation (within five minutes).
7. In a staging database only, expire an access-token row and check refresh; expire/delete a connection or delete the test account and check reconnection is required. Simulate network/503 errors and confirm local tracking continues. Do not print credentials when inspecting requests.
8. Run `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm test:vscode:api`, `pnpm test:vscode`. In the web repo run `npm test`, `npm run lint`, `npx next typegen`, `npx tsc --noEmit`, and `npm run build`.

The automated suite tests auth state and PKCE, callback replay/validation, cancellation, restart recovery, storage/network failures, refresh, revocation, identity tampering, cross-window cancellation and disconnect races. Web tests exercise safe continuation, callback allowlists, CSRF, request limits, HTTP authentication/error sanitization, and identity-only responses. `supabase/tests/extension_identity.sql` runs transactional database assertions against a disposable migrated database. End-to-end real-account browser login still requires the configured staging project and the manual procedure above; mocks alone do not certify Supabase email or OS deep-link configuration.

## Implementation files and verification

Extension additions: `src/account-service.ts`, `src/vscode-account.ts`, `tests/account.test.ts`, this guide, and the v0.3.0 VSIX. Updated `src/extension.ts`, `src/sidebar-model.ts`, extension manifest/version, bundled README, root README, and `tests/vscode-api-smoke.cjs`. Core telemetry, daemon/CLI APIs, and SQLite schema were not changed for account linking.

Web additions: `src/lib/extension-auth.ts`, `extension-api.ts`, `auth-destination.ts`; `src/components/auth/extension-consent.tsx`; `/extension/connect` page/error boundary; six `/api/extension/*` route handlers; the migration and SQL assertions; `tests/extension-auth.test.ts`, `extension-api.test.ts`; and `vitest.config.mts`. Updated existing login/signup pages, AuthForm, confirmation callback, ProfileForm's optional success destination, proxy headers/routing, README and technical documentation. Login's ordinary dashboard callback remains compatible with the original Supabase redirect allowlist.

Verified locally: 73 extension/core tests, typechecking, all workspace builds, v0.3.0 packaging, and both real VS Code smoke tests passed. All 45 web tests, lint/typechecking and production build passed; PostgreSQL 16 in a disposable container passed the existing migrations plus the new migration and transactional security assertions. The live web deployment and Supabase database were not modified. Hosted real-account login and email delivery were not exercised.

## Optional aggregate synchronization

The separate [sync layer](SYNC.md) now implements explicit `stats:write` consent, scoped refresh-token rotation, canonical daily PUTs and private/public separation. The identity-only behavior described above remains supported. See that document for current schema, limitations and the full staging/F5 procedure.

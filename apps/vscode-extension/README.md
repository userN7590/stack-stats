# Stack Stats

Your coding activity, on your device. Stack Stats starts tracking automatically when you edit in VS Code, with no account, CLI setup, or running server required.

## Your sidebar

Select the **Stack Stats** icon in the Activity Bar. There are now two native panels:

- **Activity** puts Today first, with coding time and a compact set of line, file, edit, and session counts. Current session, This week, Languages, Projects, and Coding streak expand for detail. Today opens by default; the other groups stay collapsed until you need them. Weekly details include longest session, active days, and average active time. Language labels use familiar names such as TypeScript, with all recorded languages and projects still accessible.
- **Account** starts collapsed and shows a single optional connection action. When connected, expand your account for Open Profile/Disconnect, and Profile sync for pending days, last success, consent and privacy controls. **On this device → Troubleshooting** holds storage/history health, idle timeout, and daemon details. Errors are surfaced with short labels and explanatory tooltips.

Refresh and pause/resume are in the Activity toolbar. Settings and diagnostic reports are in its **…** menu. All existing Command Palette commands and old view-focus keybindings continue to work; Show Today/This Week/Current Session now expand and focus their group in Activity. No data, collection settings, sync consent or credentials are migrated or changed by this layout update.

The status bar shows the current session's estimated active time. Click it to open Current Session. Hiding the status bar does not pause tracking.

Views update automatically as you edit, at most once per second. Idle time does not make the counter tick upward. Historical snapshots load on startup, when returning to the VS Code window, or when refreshing. Other windows' changes appear after their next checkpoint and a history refresh. Everything works offline.

## Commands

Use the Command Palette:

| Command | Action |
| --- | --- |
| Stack Stats: Show Today | Expand Today in Activity |
| Stack Stats: Show This Week | Expand This week in Activity |
| Stack Stats: Show Current Session | Expand Current session in Activity |
| Stack Stats: Pause Tracking / Resume Tracking | Change background tracking across windows |
| Stack Stats: Refresh Stats | Checkpoint and reload local history |
| Stack Stats: Open Dashboard | Open https://stackstats.dev in your browser; no data is uploaded |
| Stack Stats: Open Settings | Open Stack Stats preferences |
| Stack Stats: Show Status | Inspect storage location and optional daemon delivery in the output channel |
| Stack Stats: Show Telemetry Privacy | Inspect collection controls and limitations |

Developer commands for raw telemetry, week comparison, and local daemon retry remain available. They are not needed for normal sidebar use.

## Optional account connection

Stack Stats tracks locally by default. Connecting an account enables optional profile synchronization. **Connecting alone does not enable telemetry synchronization.**

Use **Account → Connect account**, sign in or sign up on stackstats.dev, and approve the connection. The browser returns a short-lived authorization code to VS Code; long-lived credentials never appear in callback URLs. The sidebar shows **@username · Connected**. **Open Profile** opens your public profile; when disconnected, it starts linking. **Cancel Account Connection** or the browser Cancel action cancels a pending request; closing the browser times out after ten minutes.

**Disconnect Account** removes local account credentials without deleting your account or coding history. It also attempts server revocation; if offline, visit https://stackstats.dev/extension/connect later to revoke all editor connections. Storage failures are shown explicitly. Authentication errors never pause local tracking.

VS Code SecretStorage holds access/refresh credentials, their expiry times, user ID, username, display name and profile URL. Pending PKCE verifier/state data is also kept there temporarily. Nothing is stored in settings, telemetry files, SQLite, or logs. Access lasts 15 minutes; the identity-only refresh credential has a fixed 30-day lifetime and can be revoked. No coding history is uploaded by connecting. The web auth routes and database migration must be deployed before production linking is available.

## Preferences

Open Settings and search **Stack Stats**.

| Setting | Default | Effect |
| --- | --- | --- |
| `stackStats.enabled` | `true` | Automatically track eligible edits; pause retains history |
| `stackStats.showStatusBar` | `true` | Show the tracking status bar item |
| `stackStats.inactivityTimeoutMinutes` | `5` | Session grouping timeout, 1–60 minutes; applies immediately |
| `stackStats.includeProjectNames` | `false` | Opt into project names in future records; otherwise use private project labels |
| `stackStats.excludeFiles` / `excludeProjects` | `[]` | Additional exclusions using `*`, `**`, and `?` globs |
| `stackStats.collectFilesystem` / `collectGit` / `collectWorkflows` | `true` | Optional metadata collectors |
| `stackStats.collectDiagnostics` / `allowAttributionReports` | `false` | Opt into diagnostic counts / explicit provenance reports |
| `stackStats.rawRetentionDays` | `30` | Retention of acknowledged local raw batches; `0` retains indefinitely |

Changing the inactivity timeout does not change active-time estimation: only gaps of at most 60 seconds between eligible edits earn time. Reducing the timeout can close an already-idle session; recorded history is not recalculated.

## Privacy and measurement

Stack Stats stores metadata and counters, never source contents or prompts. Project/file identifiers are salted; common secret/generated paths are excluded by default. Additional exclusions apply to future collection. The sidebar uses the same local session summaries as existing APIs and never uploads them.

Lines mean gross editor newline-boundary changes, not a Git diff. Files edited means recorded file identities, not filesystem operations. Rename/Save As can create another identity. Activity counts do not establish authorship or productivity. Precise human/AI attribution and total working time cannot be inferred from these summaries.

Your local history survives closing VS Code. Checkpoints run every 15 seconds and on normal shutdown; an abrupt crash can lose recent uncheckpointed activity. Storage failures and incomplete history appear in the sidebar. Refresh retries, and **Show Status** provides the history location for troubleshooting. Existing session history is retained; raw-event retention is separate.

## Install and develop

Install a supplied `.vsix` using **Extensions → … → Install from VSIX…**, then reload VS Code if prompted. Open a folder and select Stack Stats in the Activity Bar. Tracking starts with your next eligible edit. Marketplace publication is not part of this build. Account linking and separately consented private aggregate synchronization are optional.

For development, from the repository root run `pnpm install` and `pnpm build`. Open `apps/vscode-extension` as the VS Code folder, press **F5**, and choose **Run Stack Stats Extension**. In the Extension Development Host, open a project and edit a file twice several seconds apart. Inspect Current Session and Today, then test pause/resume and the preferences above. The launch configuration builds the extension before starting the host.

To create an installable artifact, run `pnpm --filter stack-stats-vscode package` from the repository root. The bundle includes the sidebar icon and this documentation; it does not require workspace dependencies on the user's machine.

## Optional profile synchronization

Run **Stack Stats: Enable Profile Sync** and approve `stats:write` in your browser. This uploads private daily summaries for the last 90 local calendar days and subsequent activity: coding time, edit/line counts, daily file/session counts, standard language totals, and salted opaque project totals. No source, filenames, paths, project names, prompts, raw events, or AI authorship claims are uploaded. Existing local exclusions do not retroactively filter older history.

Account connection alone stays identity-only. **Disable Profile Sync** persists across restarts and windows, keeps local history and existing server records, and leaves public visibility unchanged. **Sync Now** retries up to ten days; it never overrides disabled consent. **Manage Sync Privacy** opens the separate default-off publication controls. **Open Profile** uses your existing profile.

Account → Profile sync shows pending days, last success, offline/pending and errors. Uploads run in batches, with durable bounded offline retries; local tracking never waits for the network. Multiple devices contribute independent records; overlapping activity cannot yet be deduplicated across editors. Combined file/session counts are file-days/session-days.

Credentials and pending refresh rotations use VS Code SecretStorage. A random installation UUID, private pseudonymization salt, daily aggregate queue, consent and retry metadata use private extension storage. No sync credentials go into settings, SQLite, logs, or callback URLs. Disconnect removes local credentials, disables this installation and attempts server revocation; uploaded records remain.

Publishing is a separate choice at stackstats.dev/settings/sync. Synced totals replace displayed manual totals only after explicit approval and an upload; manual values remain saved. Languages need their own publication approval. Projects and individual historical dates stay private.

For F5 against a local web server on localhost:3000, choose **Run Stack Stats Extension (local account server)**. The web repository needs the identity and profile-sync migrations applied to an isolated staging Supabase project. Full protocol, limits, privacy, initial-history behavior and testing instructions are in the source repository's `docs/SYNC.md`.

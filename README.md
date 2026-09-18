# Stack Stats

Local developer activity tracking for VS Code and compatible editors. Stack Stats groups observed edits into coding sessions, retains metadata locally, and calculates daily and weekly statistics. The extension works without an account, network connection, or running daemon. An optional authenticated loopback daemon mirrors session history to SQLite for CLI access.

Activity and lines changed are evidence of editor usage, **not measures of developer worth, skill, authorship, or productivity**.

## VS Code sidebar

Install [Stack Stats 0.5.0 from VSIX](apps/vscode-extension/stack-stats-vscode-0.5.0.vsix) using **Extensions → … → Install from VSIX…**, then reload if prompted. No CLI, account, or daemon is required. Tracking starts automatically on eligible edits.

Select the Stack Stats icon for two native panels: **Activity** and **Account**. Activity leads with Today’s coding time and compact counts; Current session, This week, Languages, Projects and Coding streak expand for detail. Today opens by default. Weekly metrics, timestamps and full language/project breakdowns remain available. Account starts collapsed and keeps connection/sync controls together; storage, history, idle timeout and daemon information live under **On this device → Troubleshooting**. Refresh and pause/resume are toolbar actions; settings and diagnostics are in **…**. Existing commands and legacy view-focus keybindings still work.

The sidebar updates automatically while editing. The status bar shows `Stack Stats • 1h 42m`, `Idle`, or `Paused`; click it to open Current Session. Empty, loading, incomplete-history and storage-error states explain what is available. Project labels remain private by default. The [extension user guide](apps/vscode-extension/README.md) is included in the installable package.

## Optional Stack Stats account

Account includes optional browser-based account linking, identity, disconnect, and Open Profile actions. Credentials and pending PKCE material use VS Code SecretStorage. Authentication never gates activation or local tracking. **Optional private daily-summary sync now requires separate browser approval.** See [sync consent, protocol, privacy and staging procedure](docs/SYNC.md). See [account architecture, security, backend setup and exact F5 procedure](docs/ACCOUNTS.md). The new web routes and migration must be deployed before connecting against stackstats.dev.

## Developer telemetry engine

Stack Stats now also exposes a versioned normalized-event engine for character edits, saves, file operations, context switches, filesystem notifications, Git observations, task/debug lifecycles, optional diagnostic counts and explicit attribution claims. The [telemetry architecture and collection matrix](docs/TELEMETRY.md) documents every signal, schema, query/API, exclusion, retention policy, performance limit and public/private recommendation. Existing session history and commands remain supported.

New commands: **Show Telemetry Today**, **Compare Telemetry Weeks**, and **Show Telemetry Privacy**. CLI: `pnpm stackstats telemetry --today`, `events --week`, and `compare --week`.

## What is tracked

- Session start and last observed edit time, estimated active duration, and ending reason when known.
- Distinct files and workspace projects, languages, edit operations, line boundaries added/removed, and total line changes.
- Daily active time, sessions, files, projects, line changes, and language/project breakdowns.
- Monday–Sunday weekly totals, active days, average time per active day, top languages/projects, longest session's active time within the week, and current coding streak.
- Unsaved/untitled documents and loose files outside a workspace, as well as files in multi-root workspaces.

Language percentages use **active time**, with edits as a ranking tie-breaker. A day with any observed edit is active even if its estimated duration is zero. The streak includes today when active, otherwise counts back from yesterday, so it does not disappear before your first edit of the day.

## Session and timing rules

1. A nonempty text edit in a visible document while the editor window is focused starts a session. Opening a window, reading, selecting, scrolling, opening/saving a file, switching tabs, or changing languages does not start or extend a session.
2. By default, edits less than **five minutes** apart stay in the same session, across files, languages, and workspace folders. At exactly five minutes without edits, the next edit starts a new session. `stackStats.inactivityTimeoutMinutes` can change grouping to 1–60 minutes; it does not change active-time estimation or rewrite history.
3. Active time is a conservative estimate: count elapsed time between consecutive focused edits only when the gap is **60 seconds or less**. A longer gap earns zero time. Tab/workspace and window-focus changes break this evidence interval without ending the session. This separates session grouping from time estimation.
4. The session ends at its **last observed edit**, not at the idle timer's firing time. There is no credit after the last edit, no periodic heartbeat credit, and no guaranteed minimum duration. One isolated edit can correctly have a duration of zero seconds.
5. Pausing or normal shutdown closes the session. On restart, history remains and a new session begins on the first edit; downtime is never credited. After a crash, the last checkpoint's end time remains the last known activity, even if an ending reason was not recorded. Clock rollback closes the current session rather than creating negative time.

For example, edits at 12:00:00 and 12:00:30 earn 30 seconds. An edit at 12:02:30 stays in that session but earns no additional time. Waiting until 12:07:30 ends that session; the next edit starts another.

Time is assigned to the previously edited file/language/project during a qualifying interval. Midnight intervals are split exactly using the collector's local timezone, including daylight saving transitions. Date keys are retained as originally recorded, so traveling does not move historical activity into another day. A session crossing midnight counts in each affected daily report and once in the weekly report. Week ranges are Monday inclusive through the following Monday exclusive.

### What “lines” means

The original collector already counted inserted newline boundaries. That behavior is retained and extracted into a pure function. Removed boundaries now use the removed range's line span; deleting a character no longer falsely counts as deleting a line.

- Inserting `a\nb` adds one line boundary. CRLF counts once.
- Removing a range spanning three line boundaries removes three.
- Replacing blocks counts both inserted and removed boundaries.
- Inline typing/replacement still records edits and activity but contributes zero line boundaries.
- Undo and redo count the operations actually observed; their counts do not cancel. These are gross editor changes, not a Git diff, unique authored lines, or committed changes.

No source snapshots are needed for these calculations. Formatters, code actions, completions, paste and AI-generated insertions affecting visible dirty documents may be included: VS Code does not reliably distinguish their authorship. Clean disk reloads, empty change notifications, unsupported document schemes and edits while unfocused are ignored. Undo/redo that returns a document to its clean state is still counted.

## Commands and status

Open the Command Palette and run:

| Command | Result |
| --- | --- |
| **Stack Stats: Show Today** | Open the Today sidebar view with local daily totals |
| **Stack Stats: Show Current Session** | Open Current Session with duration, start/last edit and changes |
| **Stack Stats: Show This Week** | Open This Week with weekly totals, active days, average and longest session |
| **Stack Stats: Show Status** | Collection state, daemon delivery state, pending sessions and exact local history directory |
| **Stack Stats: Pause Tracking** | Stop local collection across windows; retain and finish the current session |
| **Stack Stats: Resume Tracking** | Allow the next edit to start a session |
| **Stack Stats: Retry Local Daemon Sync** | Retry pending durable snapshots and telemetry batches immediately |
| **Stack Stats: Show Telemetry Today** | Derived edit, workflow, Git and attribution analytics |
| **Stack Stats: Compare Telemetry Weeks** | Compare this week's observations with last week's |
| **Stack Stats: Show Telemetry Privacy** | Collection policy, exclusions and measurement limits |
| **Stack Stats: Refresh Stats** | Checkpoint and reload local history; also available in view title bars |
| **Stack Stats: Open Dashboard** | Open https://stackstats.dev in the browser; no upload |
| **Stack Stats: Connect Stack Stats Account** | Optional secure browser sign-in and explicit editor approval |
| **Stack Stats: Disconnect Account** | Remove local credentials and attempt device revocation; preserve history/account |
| **Stack Stats: Open Profile** | Open the connected public profile, or connect first |
| **Stack Stats: Cancel Account Connection** | Cancel pending browser linking |
| **Stack Stats: Open Settings** | Open the Stack Stats configuration preferences |

Today, This Week and Current Session open native sidebar views. Developer/status/privacy commands retain the **Stack Stats** output channel; raw JSON is confined to explicit developer telemetry commands. Summaries include this window's newest activity and cached checkpointed history from other windows in the same profile/extension host. History reloads on activation, window focus, Today/Week commands, or Refresh Stats. Other windows must checkpoint before their changes can appear. All summaries work offline. An open session's duration can stay still: idle time is not ticking upward.

Settings:

- `stackStats.enabled`: `true` by default; the pause/resume commands change this application setting.
- `stackStats.showStatusBar`: `true` by default. Hiding it does not pause tracking or break an active interval.
- `stackStats.inactivityTimeoutMinutes`: `5` by default, integer 1–60. Changes apply immediately and may close an already-idle session; the 60-second active-time evidence rule stays fixed.
- `stackStats.includeProjectNames`: `false` by default. Projects use `Project <hash prefix>` labels. Opt in to workspace folder names for future records; this does not rewrite existing history.

Additional telemetry settings control project/file exclusions, filesystem/Git/workflow collection, optional diagnostics and attribution reports, and raw retention. See the [complete privacy controls](docs/TELEMETRY.md#privacy-controls-and-collection-costs).

## Storage, privacy and recovery

The extension uses VS Code's supported `ExtensionContext.globalStorageUri`, in a `sessions-v1` directory. **Show Status** displays the exact location. Each session has a UUID-named JSON file containing a versioned envelope and cumulative snapshot: timestamps, installation/editor identity, timezone, salted project/file IDs, classification, and daily counts/time by file, language and project. A separate `.synced` file records the last acknowledged revision. Source text, full paths, filenames, keystrokes, clipboard contents, tokens and credentials are not included in session records. Workspace display names are opt-in. The hash salt lives separately in local extension state and is not synced with activity.

Every 15 seconds, dirty sessions are checkpointed using a private temporary file, file flush and atomic rename. Successful checkpoints replace the previous snapshot. Acknowledgements cannot overwrite snapshots. Multiple windows own separate session IDs. Normal deactivation awaits a final local checkpoint. A crash can lose the last **up to approximately 15 seconds** of uncheckpointed edits (longer if the host is blocked or storage fails); it does not add idle time. Disk errors are visible in the status/output and pending changes remain in memory for retry. Corrupt or unsupported session files are preserved, skipped with an explicit incomplete-summary warning, and never silently replaced. Incomplete `.tmp` files are ignored. Back up the history directory before attempting manual repair.

The optional daemon receives metadata only at `127.0.0.1`, authenticated with the existing CLI token. Delivery has a three-second request timeout, exponential retry backoff up to five minutes, and a maximum of 20 snapshots per pass. Offline and paused-daemon snapshots stay local and are rediscovered after restart. SQLite uses WAL, transactional schema migration and revision-checked upserts: duplicate and out-of-order deliveries do not inflate totals. Only the latest revision of a session is stored, rather than every checkpoint. Local history remains after successful delivery.

No activity is sent to stackstats.dev or any cloud service. Project roots are labeled as workspaces; the extension does not assume a Git repository merely because Git integration is enabled. Local profiles, remote hosts and separate editor installations have separate history/salts. With Remote SSH/containers, data and the loopback daemon live on the machine running the extension host. The browser-only editor is unsupported.

Pause Tracking prevents future collection but preserves existing history and may continue delivering previously recorded activity to the local daemon. **CLI `pause` only pauses daemon ingestion; local editor collection continues.** Use the VS Code pause command when you want collection stopped. To erase history manually, pause collection and close the editor/daemon, then remove the reported `sessions-v1` directory, its sibling `telemetry-v2` directory, and the configured SQLite database (including its WAL/SHM files). This is destructive; back up first. Session and SQLite history have no automatic deletion policy; acknowledged raw telemetry defaults to 30-day local retention, as described in the telemetry guide.

## Architecture and data flow

```text
VS Code text changes → privacy-safe metadata + pure line counter
                    → core SessionTracker (in-memory daily contributions)
                    → versioned cumulative session snapshot every 15s
                    → atomic local session file → local Today/Week commands
                    → retry queue → authenticated daemon → SQLite → CLI
```

| Module | Responsibility |
| --- | --- |
| `packages/protocol/src/index.ts` | Strict runtime schemas for legacy saved-edit events and new revisioned session snapshots |
| `packages/core/src/lines.ts` | Source-free line-boundary counters |
| `packages/core/src/sessions.ts` | Editor-independent session state machine, idle and active-time rules |
| `packages/core/src/dates.ts` / `statistics.ts` | Calendar boundaries, distinct counts, latest-revision deduplication, daily/weekly aggregations and streaks |
| `apps/vscode-extension/src/extension.ts` | VS Code lifecycle/events, commands and one shared timer |
| `apps/vscode-extension/src/metadata.ts` | Cached salted identities and existing file classifications |
| `apps/vscode-extension/src/collector.ts` | Content/dirty-state event sequencing, first-edit confirmation and clean reload filtering |
| `apps/vscode-extension/src/local-store.ts` / `delivery.ts` | Atomic local persistence, validation, acknowledgements and bounded HTTP retries |
| `apps/vscode-extension/src/presentation.ts` | Plain-text reports and duration formatting |
| `apps/vscode-extension/src/stats-model.ts` | Disposable weekly snapshot cache and historical active dates, calling existing core summary reducers |
| `apps/vscode-extension/src/sidebar-model.ts` / `sidebar.ts` | Human-readable rows and native Tree Views/status bar; no persistence or duplicate aggregation logic |
| `packages/storage/src/index.ts` | SQLite schema v3 migration, sessions/day indexes and legacy event storage |
| `apps/daemon` / `apps/cli` | Local authenticated API and CLI summaries/control |

Snapshots use `editor.session_snapshot` protocol v1.0 and monotonic revisions within each session. This representation can later support backend synchronization, historical graphs, project timelines and another collector without storing raw edits. The storage envelope is versioned separately from the protocol and SQLite schema.

The original `editor.file_changed` protocol, events table, legacy aggregation and `/v1/summary` API remain supported. Existing saved-edit history is preserved. New collectors emit session snapshots instead of duplicate save events. Legacy history is **not** assigned invented session durations or merged into new session counters; inspect it with `summary --legacy`.

### Performance decisions

One 15-second timer drives expiry, checkpointing, retry scheduling and status updates. Session start and settings changes update the UI immediately; subsequent edit-driven refreshes use one coalesced timeout, at most once per second. The UI refresh uses cached weekly session snapshots and historical active dates with existing core reducers. It performs no disk/network I/O and does not scan raw telemetry. Keystroke processing retains numeric counters, never source text. There are no per-key disk/network writes. Optional Git observation and filesystem watching have separate bounded costs described in the telemetry guide. HTTP delivery does not block checkpointing. Session history enumeration happens on startup, window focus, explicit summary/refresh commands or manual retry, with at most 16 parallel snapshot reads and coalesced concurrent UI loads. Metadata grows with sessions and distinct day/file/language combinations, not keystroke count. Large histories may eventually need indexed local storage and retention controls.

## Install, run and test

Requirements: Node.js 22+, pnpm 10+, VS Code 1.95+ or a compatible desktop editor.

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm --filter stack-stats-vscode package
```

No lint configuration/script exists in this repository. Typechecking includes production code and TypeScript tests. Tests cover session grouping, exact timeout boundaries, focus/pause/shutdown intervals, clock rollback, rapid edits, line edits, midnight/DST, daily and weekly aggregation, distinct IDs, streaks, serialization, corrupted storage, offline delivery, checkpoint/ack races, migration, HTTP validation, duplicates and restart recovery. The existing real loopback test requires permission to bind a local port.

To test the actual installed VS Code application with an isolated temporary profile/workspace:

```sh
pnpm test:vscode
pnpm test:vscode:api  # real views/commands/files/tasks without a keyboard-focus prerequisite
```

On macOS the runner defaults to `/Applications/Visual Studio Code.app`; elsewhere it uses `code`. Set `VSCODE_EXECUTABLE` to an alternative executable if needed. This opens a temporary VS Code window; let it stay focused. It verifies real activation, every registered command, edits/save, timing, privacy, pause/resume, unsaved documents and local persistence. It does not touch your normal editor profile. Failure artifacts/logs are retained in the printed temporary directory; successful runs clean them up. A display and installed VS Code are required. The pure/integration test suite needs neither.

Optional CLI/daemon setup:

```sh
pnpm stackstats init
pnpm dev:daemon
# In another terminal:
pnpm stackstats status
pnpm stackstats summary --today
pnpm stackstats summary --week
pnpm stackstats summary --legacy --today
```

Set `STACK_STATS_HOME=/some/directory` before starting both CLI/daemon and the extension host to isolate the daemon configuration/database. Otherwise it uses `~/.stackstats`. The extension always keeps its own snapshots in VS Code global storage. If CLI setup happens after activation, reload the window to load the new config. CLI JSON summaries reflect successfully delivered snapshots and may lag the local editor report. `/v1/stats?period=today|week&date=YYYY-MM-DD` exposes the same session statistics.

## Manual VS Code verification

1. Run `pnpm install` and `pnpm build` from the repository root. Open `apps/vscode-extension` in VS Code. Press **F5** and select **Run Stack Stats Extension**. These steps use the newly built code; the repository's older `.vsix` is not updated automatically.
2. In the development host, open a folder. Run **Stack Stats: Show Status**, **Show Today** and **Show Current Session** before editing. Expect idle/no current session and no new activity from opening files. Existing history may already contribute to Today.
3. Edit a TypeScript file twice, roughly 10 seconds apart; include a newline. Run **Show Current Session**. Expect one session, approximately 10 seconds, and actual line-boundary counts. Delete one character: removed boundaries must not increase. Delete/paste multiple lines, undo and redo: both directions should be reflected. Save repeatedly without editing: totals must stay unchanged.
4. Switch to another file/language and edit; then another root in a multi-root workspace. Expect the same session within five minutes and additional file/language/project contributions. New workspace windows have their own sessions; Today includes their checkpointed history.
5. Create an untitled document, type before saving, and run **Show Today**. It must already be included. Saving it must not repeat the previous line counts. The untitled and saved identities can count as two files after later edits; see limitations below.
6. Stop editing for 90 seconds. The displayed duration must not advance. Edit again before five minutes: same session, with the long gap uncredited. Stop for at least five minutes (allow up to 15 seconds for the status refresh): idle. Edit again: a new session. Switch to another application for 20 seconds and return; that focus gap must not earn time.
7. Run **Pause Tracking**, edit, and verify totals do not change. **Resume Tracking** and edit: a new session starts. Reload/close and reopen the development host; past Today/Week history must remain, and reopening alone must not add activity. For crash testing, wait for a checkpoint first and remember the documented loss window.
8. If testing the daemon, initialize it before launching/reloading the development host, start it, and use **Retry Local Daemon Sync**. Compare CLI `summary --today` and `--week` with the editor. Stop the daemon, continue editing, reload the host, restart the daemon and retry. History must be delivered once, even after repeated retries.
9. Run **Show This Week** and inspect rankings, active days, average time and longest session. With a fresh history, these may legitimately be small or zero. Do not use legacy save-event counts as expected session totals.
10. Select the Stack Stats Activity Bar icon and inspect Activity and Account, expanding the activity groups. Type in a visible editor: counts should update within about one second without Refresh Stats. Expand language/project rows; check empty states in a fresh profile. Click the status bar and verify Current Session opens.
11. Open Stack Stats settings. Toggle `showStatusBar` off/on and confirm collection continues. Change `inactivityTimeoutMinutes` to 1 and wait at least one minute after the last edit (plus up to 15 seconds for expiry); restore 5 after testing. Pause/resume from the sidebar; history should remain visible and the status bar should show Paused.
12. Use Refresh Stats and focus another VS Code window and return to check checkpointed history reloads. Open Dashboard should open the public website only. Disconnect networking: all local views and tracking should still work. If a session file cannot be read, views should show an incomplete-history warning and preserve it for recovery.

The UI regression suite covers cached/live revision deduplication, streaks across week boundaries, date rollover, concurrent refresh/checkpoint races, history failures/recovery/deletion, honest empty/error states, native view/accessibility/command wiring, status visibility/disposal, and configurable timeout boundaries. Verified for v0.2.0: **58 tests across ten files**, typechecking, all workspace builds, both real VS Code smoke tests, and VSIX packaging passed. Loopback delivery tests require local-port access. No lint task is configured. The extension identifier is unchanged, preserving its existing global-storage namespace. The v0.2.0 VSIX bundles runtime dependencies; normal installation requires neither pnpm nor Node.js.

## Known limitations and next direction

- Active time approximates focused editing, and excludes reading, debugging, planning, terminal work and long pauses between edits. It is not total working time. Cross-window sessions are intentionally separate. Concurrent remote collectors/machines are not reconciled into a single wall-clock timeline.
- A new session begins after restart. Schema records from a crash may have no explicit ending reason. The last checkpoint is the recovery boundary, not a guarantee against disk failure or power loss.
- Rename/Save As and untitled-to-file transitions do not have a reliable shared identity yet. Earlier unsaved changes remain recorded without duplicate line counts, but later editing the saved/renamed file can increase unique files touched. Untitled documents use the only workspace root when unambiguous; otherwise they use “Loose files.”
- Notebook cells, virtual documents and browser-only VS Code are not collected. Edits to invisible files by workspace-wide tools are excluded. Formatter/AI edits in visible documents may be included and are not proof of human authorship.
- Session history is retained indefinitely as compact local files plus optional SQLite mirrors. New raw telemetry has its own configurable acknowledged-data retention. Git observations, exclusions, and rich queries are now implemented; there is no polished dashboard, cloud sync or team analytics. Account linking is optional and separate from telemetry. Resetting the daemon database also requires resetting `.synced` acknowledgements to replay already-delivered local history. See the telemetry guide for attribution and coverage limitations.

Highest-value next steps:

1. Broader storage retention, export and deletion commands beyond the implemented exclusions and raw-journal retention.
2. Historical graphs and project timelines using these tested daily aggregates.
3. Stable Save As/rename identity and stronger opt-in Git authorship evidence beyond observed commits.
4. Explicitly opt-in backend sync with schema negotiation, deletion propagation and user-controlled profile visibility.
5. Desktop/CLI collectors with cross-collector overlap reconciliation before team or skill analytics.

## License

MIT

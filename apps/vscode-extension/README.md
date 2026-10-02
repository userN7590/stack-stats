# Stack Stats

**Developer activity analytics and public developer profiles.**

Stack Stats turns your everyday coding in Visual Studio Code into a record you own. It tracks coding time, sessions, languages, projects and streaks on your device. When you're ready, you can publish the parts you choose to a public developer profile at [stackstats.dev](https://stackstats.dev) and link it from a portfolio, resume or application.

- **Works right after install.** No account, setup or server is needed.
- **Local first.** Your history stays on this device and works offline.
- **You decide what leaves your machine.** Private sync and your public profile are separate choices, each off until you turn it on.

## What you get

- **Coding time and sessions.** Time is estimated from your edits, so idle time is never counted.
- **Languages and projects,** ranked by active time. Project names stay private by default.
- **Streaks and weekly totals,** including active days and your longest session.
- **Lines and files edited.**
- **Workflow analytics:** when you code during the day, saves and file switches, task runs and debug sessions, and Git activity.
- **External changes and agent labels.** Changes made outside the editor are recorded separately from your coding time. Connect Claude Code or Codex to label the changes they report.
- **Optional private sync** and a **public developer profile** at `stackstats.dev/u/<username>`.

## Getting started

1. Install Stack Stats.
2. Select the **Stack Stats** icon in the Activity Bar.
3. Start coding.

Tracking starts with your next edit. The status bar shows the current session, and the sidebar has three panels:

- **Activity:** Today, current session, this week, languages, projects and your coding streak.
- **Agents:** external changes and optional agent connections.
- **Account:** the optional account, profile sync and your tracking level.

## How much Stack Stats tracks

Run **Stack Stats: Change Tracking Level**, or use **Account → On this device → Tracking level**. New installs use Moderate.

| Level | What it tracks |
| --- | --- |
| **Minimal** | Tracks coding time, sessions, streaks, languages, projects, lines and files. Nothing else. |
| **Moderate — Recommended** (default) | Everything in Minimal, plus hourly patterns, editor workflow, tasks and debugging, external file changes, Git activity and labels from agents you connect. |
| **Extensive** | Everything in Moderate, plus problem counts and reports from other extensions. Connecting AI tools stays your choice. |

Your tracking level only changes what this device collects from now on. Existing history is kept.

A level never turns on sync, publishes anything or connects an agent.

**Advanced settings** lets you turn each capability on or off; any other combination shows as **Custom**. **Pause Tracking** stops all collection at every level.

## Privacy: three separate layers

**1. Local collection (this device).** Stack Stats records timing and counts: when you edited, how much, in which language, and private IDs for projects and files. It never records source code, file contents, keystrokes, clipboard contents, prompts or command output.

Common secret and generated paths are always excluded, such as `.env` files, keys, `node_modules` and build output, and you can add your own exclusions. History is stored in VS Code's storage for this extension on your machine.

**2. Private sync (optional, off by default).** Nothing is uploaded until you connect an account **and** approve Profile Sync in your browser. Sync then uploads daily summaries for the last 90 days and new activity:

- coding time;
- edit and line counts;
- session counts and durations;
- file counts;
- language totals;
- project totals under private random-looking IDs.

Hour-of-day patterns are a separate setting. File names, paths, project names, source code, prompts and agent records are never uploaded.

**3. Public profile (optional).** Nothing becomes public by itself. On stackstats.dev you choose, metric by metric, what appears on your profile. Project activity is never published, and charts that reveal your daily schedule need a separate consent.

Run **Stack Stats: Show Telemetry Privacy** to see what your current settings collect, sync and publish.

**Network access.** Without an account, Stack Stats makes no network requests of its own. After you connect an account, it checks the connection with stackstats.dev from time to time. After you enable Profile Sync, it uploads the daily summaries described above. A local loopback service is used only if you set up the optional Stack Stats command-line tools. Local tracking never waits for the network.

## Agent integrations (optional)

At the Moderate and Extensive levels, external changes are tracked automatically. These are changes made outside the editor by terminals, scripts, AI agents or Git checkouts. They never count as coding time, and the writer is recorded as unknown.

To label an agent's changes, open the **Agents** panel and click **Connect** next to **Claude Code** or **Codex**:

1. Stack Stats shows exactly what it will add to that tool's settings and asks before changing anything.
2. For Codex, approve the Stack Stats hooks when Codex asks; Codex requires this for every new hook.
3. **Disconnect** removes only what Stack Stats added.

No JSON editing or Node.js install is needed.

What the hooks share:

- **Reported:** run start and end, tool-activity metadata and file paths. These are used only on this device to match changes.
- **Never reported:** prompts, responses, source code, commands and command output.

Agent and external-change records stay on this device. They are never synced or published.

A label shows which tool reported a change. It is not proof of authorship, and agent time is never added to your coding time.

## Account and sync (optional)

- **No account needed.** Stack Stats works fully on its own.
- **Connect account** (Account panel) opens stackstats.dev in your browser, where you sign in and approve this editor. VS Code first asks whether to open the external website. Connecting by itself uploads nothing.
- **Enable Profile Sync** asks for a separate approval in your browser before any daily summaries are uploaded. **Disable Profile Sync** stops uploads; your local history stays.
- **Publishing** is a third, separate step on stackstats.dev.

Credentials are kept in VS Code's secure SecretStorage, never in settings or logs. **Disconnect Account** removes them from this device and revokes the connection when online.

## Commands

Open the Command Palette and type **Stack Stats**:

| Command | What it does |
| --- | --- |
| Stack Stats: Show Today | Open today's activity in the sidebar |
| Stack Stats: Show This Week | Open this week's totals |
| Stack Stats: Pause Tracking / Resume Tracking | Stop or restart collection in every window |
| Stack Stats: Change Tracking Level | Choose Minimal, Moderate or Extensive |
| Stack Stats: Open Advanced Tracking Settings | Turn individual capabilities on or off |
| Stack Stats: Show Telemetry Privacy | What is collected locally, synced privately and public |
| Stack Stats: Manage Agent Integrations | Connect or disconnect Claude Code and Codex |
| Stack Stats: Show Agent Activity | Agent runs and external changes on this device |
| Stack Stats: Connect Stack Stats Account | Optional sign-in through your browser |
| Stack Stats: Enable Profile Sync | Optional private upload of daily summaries, after browser approval |
| Stack Stats: Open Profile | Open your public profile |
| Stack Stats: Disconnect All Agent Integrations | Remove Stack Stats hooks from agent settings |

## Settings

Most people only need **Change Tracking Level**. To see every option, open Settings and search for **Stack Stats**. Settings are grouped into Tracking, Privacy and storage, Agents, Profile sync and Display.

| Setting | Default | What it does |
| --- | --- | --- |
| `stackStats.excludeFiles` / `stackStats.excludeProjects` | `[]` | Extra files or projects to ignore, using `*`, `**` and `?` globs |
| `stackStats.includeProjectNames` | `false` | Record folder names for new activity instead of private project labels |
| `stackStats.syncHourlyActivity` | `false` | Include hour-of-day patterns in private sync |
| `stackStats.inactivityTimeoutMinutes` | `5` | Minutes without edits before a session ends |
| `stackStats.showStatusBar` | `true` | Show the current session in the status bar |

## What the numbers mean

- **Coding time** counts the gaps of 60 seconds or less between edits in a focused editor. Reading, planning and long pauses are not counted, so it is not total working time.
- **Lines** are gross line changes seen by the editor, including undo and redo, not a Git diff.
- **External changes** have line counts only for files open in the editor.
- **Separate devices.** Each device tracks independently. If you code on several devices at the same time, the overlapping time is counted on each one; it is not deduplicated.
- **Not a scorecard.** Activity is evidence of editor use, not a measure of skill, authorship or productivity.

## Requirements and limitations

- **Editor:** VS Code 1.95 or later on the desktop. The browser-based editor (vscode.dev) is not supported.
- **Restricted Mode:** VS Code disables Stack Stats in folders you have not trusted.
- **Remote:** with Remote SSH, WSL or containers, history is stored on the machine where the workspace runs.
- **Agent integrations** support Claude Code and Codex. They are verified on macOS; Linux and Windows support is implemented but not yet verified with real agents.

## Uninstalling

If you connected an agent, run **Stack Stats: Disconnect All Agent Integrations** before uninstalling, so no Stack Stats hooks remain in its settings. If you forget, leftover hooks stay harmless: Stack Stats pauses them when it is uninstalled.

When VS Code finishes removing Stack Stats, which can take a restart, it deletes the extension's storage. That includes your local history on this device. Summaries you synced stay in your stackstats.dev account.

If you connected an agent, the hook files and a backup of that tool's settings stay in the `.stackstats` folder in your home directory; delete that folder to remove them.

## Links

- Website: [stackstats.dev](https://stackstats.dev)
- Source code and issue tracker: [github.com/userN7590/stack-stats](https://github.com/userN7590/stack-stats) ([report an issue](https://github.com/userN7590/stack-stats/issues))
- Technical privacy and data details: [docs/TELEMETRY.md](https://github.com/userN7590/stack-stats/blob/main/docs/TELEMETRY.md)
- License: [MIT](https://github.com/userN7590/stack-stats/blob/main/LICENSE)

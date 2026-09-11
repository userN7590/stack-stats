# Stack Stats

Local-first, privacy-safe developer activity analytics.

Stack Stats records normalized engineering activity without storing source-code contents. This repository currently contains Milestone 1: a VS Code saved-edit event flowing through an authenticated loopback daemon into SQLite and a CLI summary.

> Stack Stats measures engineering activity, not developer worth. Lines changed and editor activity are not productivity scores.

## Architecture

- `packages/protocol` — versioned runtime schemas and shared event types
- `packages/core` — editor-independent aggregation
- `packages/storage` — SQLite persistence and migrations
- `apps/daemon` — authenticated HTTP service bound to `127.0.0.1`
- `apps/cli` — initialization, status, summaries, pause, and resume
- `apps/vscode-extension` — thin VS Code/Cursor-compatible collector

The extension sends event metadata only. It does not send source text or absolute file paths. Project and file IDs are locally salted hashes.

## Requirements

- Node.js 22+
- pnpm 10+
- VS Code 1.95+ (or a compatible fork)

## Install and test

```sh
corepack enable
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

## Run locally

Initialize local configuration and SQLite storage:

```sh
pnpm stackstats init
```

Start the daemon and leave it running:

```sh
pnpm dev:daemon
```

From another terminal:

```sh
pnpm stackstats status
pnpm stackstats summary --today
pnpm stackstats pause
pnpm stackstats resume
```

Set `STACK_STATS_HOME=/some/directory` before these commands to use an isolated data directory.

## Test the real VS Code collector

1. Run `pnpm stackstats init` and `pnpm dev:daemon`.
2. Run `pnpm --filter stack-stats-vscode build`.
3. Open `apps/vscode-extension` in VS Code.
4. Press **F5** and select **Extension Development Host** if prompted.
5. In the new VS Code window, open any folder, edit a file, and save it.
6. Run `pnpm stackstats summary --today` in the repository terminal.

The summary should show one edit event, the project, the language, the unique file count, and editor-observed lines added/removed. The counts represent edits observed by VS Code; they are deliberately separate from authoritative Git commit statistics.

## Protocol: `editor.file_changed` v1.0

Every event has an immutable UUID, an occurrence timestamp, adapter/session identity, privacy-safe project and file identity, language/category metadata, and change counters. The daemon supplies its own receipt timestamp. Unknown fields and unsupported versions are rejected.

The protocol is a discriminated union so later milestones can introduce `editor.activity_segment`, `git.commit_observed`, file lifecycle, and technology detection without coupling those sources together.

## Current limitations

- Events are emitted at save boundaries, not continuously.
- Line counters are editor-observed approximations.
- Create/delete/rename lifecycle events and durable offline retry are not implemented yet.
- No dashboard, Git collector, technology detector, account, or cloud service exists in this milestone.

## Next milestone

Milestone 2 will add active-time segments with idle detection, durable local delivery, reliable file lifecycle events, Git commit ingestion, and initial technology/test/documentation detectors. A React dashboard should follow after those metrics are stable.

## License

MIT

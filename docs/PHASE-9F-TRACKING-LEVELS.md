# Phase 9F: tracking levels and permission UX

Stack Stats now answers one question before anything else: **How much would you like Stack Stats to track?** Users pick **Minimal**, **Moderate — Recommended** or **Extensive**. Anything else reads as **Custom**. Every individual capability stays available under **Advanced settings**.

A tracking level changes **local collection only**. Private sync, public publication, the account and agent connections are separate consent layers. No level can change them.

Status: implemented and verified locally (§15). Not committed, pushed or published.

---

## 1. The configuration problem before 9F

Before this phase, Stack Stats had 16 settings. Nine of them affected collection, but:

- **Names were inconsistent:** `collectFilesystem`, `collectGit`, `collectWorkflows`, `collectDiagnostics`, `allowAttributionReports`, `agentIntegrations.claudeCode` and `agentIntegrations.codex`.
- **Some collection had no control at all.** The 15-second activity timeline (which feeds hourly patterns), saves, file switches, window focus and the save-participant subset were always on while tracking.
- **Nothing answered the simple question** of how much is being observed. A privacy-conscious user had to read setting descriptions that used internal terms ("provenance", "coalesced notification counts") to find out.
- **Collection, sync and publication were easy to conflate.** `syncHourlyActivity` sat in the same flat list as `collectGit`.

## 2. Settings inventory (from the implementation)

Classification:

- **A:** collection
- **B:** local analytics or presentation
- **C:** private sync
- **D:** publication
- **E:** agent integration
- **F:** operational
- **G:** unrelated

"Cloud" means data sent to stackstats.dev. The optional daemon is loopback-only and local.

| Key (`stackStats.`) | Default | Class | Changes local collection | Changes cloud | Changes public | In levels | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `enabled` | `true` | A (master) | Yes: all of it | Nothing new to sync while paused | No | **No** | Pause is separate from the level (§14) |
| `collectActivityTimeline` | `true` *(new)* | A | Yes | Indirect: hourly sync has nothing new to upload when off | No | Yes | Gates `editor.edit`, `activity.interval`, `session.lifecycle` and therefore the hourly projection. Pre-9F: always on |
| `collectEditorEvents` | `true` *(new)* | A | Yes | No | No | Yes | Gates `file.saved`, `file.lifecycle`, `context.switched`, `window.focus` and save-participant records. Pre-9F: always on |
| `collectWorkflows` | `true` | A | Yes | No | No | Yes | Task and debug lifecycles |
| `collectDiagnostics` | `false` | A | Yes | No | No | Yes | Severity counts |
| `collectFilesystem` | `true` | A | Yes | No: local only | No | Yes | `filesystem.changed` plus local external-change records |
| `collectGit` | `true` | A | Yes | No | No | Yes | Polling ≤ 1/min, trusted workspaces only |
| `collectAgentActivity` | `true` *(new)* | A / E | Yes | No: local only | No | Yes | Stack Stats-side acceptance of connected agents' hooks. Pre-9F: implied by each connection |
| `allowAttributionReports` | `false` | A / E | Yes: accepts claims | No (loopback daemon only) | No | Yes | API permission for cooperating extensions |
| `agentIntegrations.claudeCode` | `false` | E | Yes, for that agent | No | No | **No** | The connection itself; managed by Connect/Disconnect |
| `agentIntegrations.codex` | `false` | E | Yes, for that agent | No | No | **No** | Same |
| `excludeFiles` | `[]` | A (policy) | Narrows it | Excluded activity is never recorded, so never uploaded | No | **No** | Personal privacy policy, not depth |
| `excludeProjects` | `[]` | A (policy) | Narrows it | Same | No | **No** | Same |
| `includeProjectNames` | `false` | B | Labels in future session records | No: sync uses private aliases, never names | No | **No** | A labeling choice, not observation depth |
| `rawRetentionDays` | `30` | F | Deletes acknowledged raw batches | No | No | **No** | Levels must never delete history (§14) |
| `syncHourlyActivity` | `false` | C | No | Yes | No: publication is separate | **No** | Private sync layer |
| `inactivityTimeoutMinutes` | `5` | B | Session grouping only | Synced session counts follow grouping | No | **No** | Analytics definition, not observation |
| `showStatusBar` | `true` | B | No | No | No | **No** | Display |

- **D (publication)** has no editor setting. Publication is chosen per metric at `stackstats.dev/settings/sync`; **Manage Sync Privacy** only opens that page.
- **C** also includes the account credentials and sync consent. They live in SecretStorage and private extension storage, not in settings.
- No setting is class G.

`package.json` now groups settings into **Tracking**, **Privacy and storage**, **Agents**, **Profile sync** and **Display**, so the Settings UI shows the three layers apart.

## 3. Capability model

`apps/vscode-extension/src/tracking-levels.ts` is the single source of truth. It has no VS Code dependency. Each capability declares:

- a stable ID;
- a user-facing name, a one-line description and privacy text;
- its setting and default (tested against `package.json`);
- its requirements;
- any separate integration step;
- **its own level membership**.

Everything else is derived from that:

- `TRACKING_PRESETS`;
- the level summaries in the picker;
- Advanced settings;
- the privacy report;
- the plans that write settings;
- the documentation check in the tests.

| Capability | Setting | Minimal | Moderate | Extensive |
| --- | --- | --- | --- | --- |
| Coding activity | always on | ✓ | ✓ | ✓ |
| Hourly activity patterns | `collectActivityTimeline` | – | ✓ | ✓ |
| Editor workflow | `collectEditorEvents` | – | ✓ | ✓ |
| Tasks and debugging | `collectWorkflows` | – | ✓ | ✓ |
| Problem counts | `collectDiagnostics` | – | – | ✓ |
| External file changes | `collectFilesystem` | – | ✓ | ✓ |
| Git activity | `collectGit` | – | ✓ | ✓ |
| Agent activity | `collectAgentActivity` | – | ✓ | ✓ |
| Reports from other extensions | `allowAttributionReports` | – | – | ✓ |

What each capability controls in code:

| ID | What it gates |
| --- | --- |
| `coding_activity` | `SessionTracker` → `sessions-v1`: coding time, sessions, streaks, languages, projects, lines, files. Only Pause stops it |
| `activity_timeline` | `buffer.edit`, `buffer.interval`, `session.lifecycle` in `extension.ts`; hence `hourly-v1` |
| `editor_events` | `WorkflowCollectors` save/lifecycle/switch/focus emission; `observer.editorEdit` (save participants). Save *correlation* for external changes is kept |
| `tasks_debugging` | `WorkflowCollectors` task and debug listeners |
| `problem_counts` | `WorkflowCollectors` diagnostics sampling |
| `external_changes` | `WorkflowCollectors` `filesystem.changed`; `ExternalChangeObserver.active()` |
| `git_activity` | `GitObserver.poll` on the shared timer |
| `agent_activity` | Hook state file `integrations` = connection ∧ capability; inbox drain set |
| `extension_reports` | `api.reportAttribution` |

**Adding a capability** (for example `semantic_code_activity`) means one new entry in `definitions`, with `levels: { minimal: false, moderate: false, extensive: true }`, plus its `package.json` setting. Load-time checks and tests reject:

- a requirement declared out of order;
- a level that includes a capability without its requirement;
- a setting whose default disagrees with `package.json`.

## 4. Minimal

Tracks coding time, sessions, streaks, languages, projects, lines and files. Nothing else.

This is exactly the session engine: every number in the Activity panel still works. There is no timeline, no editor-workflow events, no tasks or debugging, no problem counts, no external changes, no Git and no agent labels. `telemetry-v2` then receives only the small `collector.coverage` records that say which sources are off.

## 5. Moderate — Recommended (default)

> Everything in Minimal, plus hourly patterns, editor workflow, tasks and debugging, external file changes, Git activity and labels from agents you connect.

**Moderate is exactly the collection Stack Stats shipped by default before this phase.** Choosing it as the default therefore does not change collection for anyone.

- External changes are tracked automatically, with the writer unknown.
- Agent labels are *accepted* from agents the user connects. No agent is connected by a level.

Git stays in Moderate even though the brief suggested it might belong to Extensive. It has been on by default since the telemetry engine shipped, it is metadata-only and bounded, and moving it would have made every existing default user read as Custom.

## 6. Extensive

> Everything in Moderate, plus problem counts and reports from other extensions. Connecting AI tools stays your choice.

These are the deepest signals Stack Stats itself can collect today.

- After switching to Extensive with no agent connected, the confirmation says *"Agent labels are available: connect Claude Code and Codex in the Agents panel."* It never connects them.
- Retention is deliberately **not** part of Extensive: switching back to a lower level would then delete history (§14).
- Extensive is a capability level, not a paid tier. A future Stack Stats Plus/Pro could add analytics or renderers built on Extensive-only data. Nothing here gates on an entitlement.

## 7. Custom matching

The level is **derived, never stored**. `resolveTracking` reads the capability settings once, and:

- anything that isn't `true` or `false` fails closed (off);
- a missing value means the default;
- a capability is effective only if it is requested and every requirement is effective.

`matchLevel` compares the effective set to each level for exact equality. No match means Custom.

- Turning off Hourly activity patterns at Moderate shows **Custom**. Turning it back on shows **Moderate** again.
- Matching uses *effective* collection. Settings whose only extras are blocked (agent activity on with external changes off) read as the level they actually behave as.

All 256 combinations of the eight toggles are enumerated in tests:

| Level | Combinations |
| --- | --- |
| Minimal | 4 |
| Moderate | 1 |
| Extensive | 1 |
| Custom | 250 |

## 8. Migration (existing installs)

Nothing is written on upgrade. The level is derived from the settings that already exist.

- The three new settings default to `true`, which is exactly the pre-9F always-on behavior.
- A pre-9F user with default settings reads as **Moderate**.
- A pre-9F user who opted into diagnostics *and* attribution reports reads as **Extensive**.
- Every other pre-9F combination reads as **Custom** (30 of the 32 combinations of the five pre-9F collection settings; tested).

Existing history, sync queues, consent, publication and hook files are untouched. New installs get Moderate, which equals the previous default.

**One intentional tightening.** Agent labels now need External file changes. Before 9F, a user who had turned off `collectFilesystem` but connected an agent still recorded explicit agent changes. Now those labels are inactive: fail closed, consistent with the user's choice not to observe changes outside the editor. The Agents panel and Advanced settings say why, as *Off · needs External file changes*.

## 9. Applying a level, and Advanced settings

**Applying a level** (`planLevel`):

- Writes only the eight capability settings (`CAPABILITY_SETTINGS`) to user settings.
- A value equal to its default removes the override instead. At Moderate, `settings.json` holds no Stack Stats capability keys.
- Order is dependency-safe: dependents switch off first, requirements switch on first.
- The confirmation names each layer separately, for example: *"Tracking level: Minimal. This applies to future activity on this device; existing history is kept. Claude Code stays connected, but Stack Stats ignores its activity at this level. Private sync: off · Public profile: unchanged."* **Undo** restores the exact previous values, including a Custom selection or malformed values.
- A failed write shows an error that names the resulting (honest) level.

**Change Tracking Level** is a native QuickPick:

- Title: *How much would you like Stack Stats to track?*
- Placeholder: *You can change this anytime. Tracking depth only affects data collected on this device. Cloud sync and public profile sharing are controlled separately.*
- One row per level, with its summary and a generated "Tracks…" or "Everything in … plus …" detail. The current level carries a check.
- A **Custom** row when applicable.
- **Advanced settings…** below a separator.

**Advanced settings** is a native QuickPick that stays open:

- Groups: *Always on while tracking*, *Detailed activity*, *Outside the editor*, *Agents and attribution*.
- Selecting a row toggles it. The title shows the resulting level, for example *Advanced tracking · Custom*.
- It re-renders when another window changes a setting.
- Coding activity is locked, with *use Pause Tracking to stop*.
- A requested but blocked capability shows *Off · needs …*.
- Footer: *Choose a tracking level…*, *Restore recommended tracking* (when not at Moderate) and *Open all Stack Stats settings*.

No webview was needed.

## 10. Capability dependencies

These are the two real dependencies:

| Capability | Needs | Why |
| --- | --- | --- |
| Agent activity | External file changes | Agent labels are applied to external changes. Correlated attribution needs watcher observations |
| Reports from other extensions | Hourly activity patterns | Reports must target existing `editor.edit` timeline records (`reportAttribution` rejects unknown targets) |

Rules, chosen to be easy to follow:

- **Turning B on** also turns on what it needs, and says so, for example *"Hourly activity patterns was turned on too, because Reports from other extensions needs it."*
- **Turning A off** also turns off what depends on it, and says so.
- **Contradictory settings** (edited by hand) resolve fail-closed and are named in Advanced settings and in the privacy report.

## 11. Agent integrations

A level never adds, removes or edits Claude Code or Codex configuration.

- **Hook side.** The hook state file's `integrations` is now *connection ∧ Agent activity*. At Minimal a connected agent's launcher and hook exit before recording: fail closed through Stack Stats' own state. The vendor entries stay installed.
- **Agents panel.** A connected agent shows **Connected · paused**, with **Resume agent labels** and **Disconnect**. External changes show *Off at your tracking level* and open the level picker. The panel title reads *Paused*.
- **Connect while labels are off.** The confirmation adds *"Agent activity is off at your current tracking level (Minimal). Continuing also turns on External file changes and Agent activity, so your tracking level becomes Custom."* Only after confirmation are those settings changed, then the Phase 9E.1 connect runs.
- **Moderate:** connecting is optional. **Extensive:** connecting is suggested, never performed.
- Show Agent Activity and Manage Agent Integrations use the same wording.

## 12. Sync separation

- No sync setting is part of the model. `syncHourlyActivity`, consent, grants and queues are never written by a level (tests and both smokes).
- If hourly sync is on while Hourly activity patterns is off, no new hourly data exists. Days without a projection upload `hourlyUtc: null`, never fabricated zeros. A day collected partly at each level carries the existing `partial: true` flag.
- The privacy report states this case explicitly.

## 13. Publication separation

Publication is server-side and per metric at `stackstats.dev/settings/sync`. The extension has no publication setting, and a level has no path to one.

Could a user accidentally publish data by selecting Extensive? **No.**

- Extensive writes only the eight local capability settings.
- Those settings feed only local stores (`sessions-v1`, `telemetry-v2`, `hourly-v1`, `provenance-v1`). None of those reach the network except through the separately consented profile sync, which uploads the same daily summaries at every level.
- The `extension_reports` claims go only to the optional loopback daemon, which rejects them unless `STACK_STATS_ALLOW_ATTRIBUTION=1`.

## 14. Privacy model

**Stack Stats: Show Telemetry Privacy** now prints:

- `Tracking level: … (recommended)` and whether tracking is paused;
- **1. Local collection (this device):** each capability that is on, with what it records and never records; what is off (and why, if blocked); exclusions; what is never collected; "affects future collection only";
- **2. Private sync:** account, profile sync state, the hourly-sync case above, and what is never uploaded;
- **3. Public profile:** "Nothing becomes public from this editor … A tracking level never publishes anything.";
- **Agents:** each connected agent, labeled or ignored at this level;
- **Troubleshooting:** local paths and the optional daemon state, last.

The report is tested against internal jargon ("telemetry", "collector", "reconciler", "v2", "daemon", "inbox").

Other privacy rules:

- **Pause is separate.** Pause collects nothing at any level. The level stays visible while paused, and pausing never changes it.
- **No data loss.** Changing levels only controls future collection. Sessions, timelines, hourly days, provenance and agent runs are never deleted or rewritten.
- **Security boundary.** No new network calls, cloud telemetry, sync or publication fields, vendor-config writes or content inspection.

## 15. Tests and validation

**New test files:**

| File | Tests | Covers |
| --- | --- | --- |
| `tests/tracking-levels.test.ts` | 21 | See the list below |
| `tests/tracking-controls.test.ts` | 8 | See the list below |
| `tests/workflow-collectors.test.ts` | 3 | Real collectors emit exactly each level's event types; save correlation survives with editor workflow off; no capability setting is read while handling events |

`tracking-levels.test.ts` covers:

- model integrity and derived presets;
- `package.json` parity: types, defaults, scope, descriptions without jargon, the Tracking section;
- generated summaries;
- clean install → Moderate;
- all 32 pre-9F combinations (unchanged collection except the documented tightening);
- all 256 toggle combinations → exact recognition;
- malformed values fail closed, and the snapshot is frozen;
- blocked dependents;
- resolve performance;
- plans from arbitrary starts reach exactly the level and touch only capability settings, with unrelated sync, agent, exclusion, retention and display values unchanged;
- override removal and write order;
- Custom → exact preset;
- dependency plans and messages;
- the Connect note;
- picker rows;
- confirmation messages;
- the three-layer privacy report;
- the matrix in this document;
- both READMEs leading with the same generated level summaries.

`tracking-controls.test.ts` covers, against a mocked VS Code:

- the QuickPick title, placeholder and items;
- the current check;
- level arguments;
- Extensive suggesting connection but never executing it;
- "already" messages;
- Undo restoring exact Custom and malformed values;
- the Custom row opening Advanced settings;
- honest write failure;
- Restore Recommended;
- the Advanced list: toggle, live title, active item, quiet unless linked, dependency message, locked row, another window's change re-rendering, Restore, disposal;
- agent activity turning on its requirement.

**Updated tests:**

- `sidebar.test.ts`: tracking level row, Custom, paused, status bar tooltip; agent rows paused by level.
- `sidebar-native.test.ts`: the Activity view description shows the level.
- `vscode-api-smoke.cjs` and `vscode-smoke.cjs`: §16.
- `scripts/test-vscode.mjs`: now isolates `CLAUDE_CONFIG_DIR` and `CODEX_HOME`, so smoke runs never read the developer's agent settings.

**Updated test counts:** `sidebar.test.ts` has 2 new tests. `sidebar-native.test.ts` has more assertions but no new tests.

| Check | Result |
| --- | --- |
| `pnpm test` | **336 passed, 27 files** (302 before this phase + 34 new) |
| `pnpm typecheck` | Passed |
| `pnpm build` | Passed: `extension.cjs` 509.8 KB, `agent-hook.cjs` 208.5 KB, `uninstall.cjs` 191.1 KB |
| `pnpm test:vscode:api` (real VS Code) | Passed, including §16 |
| `pnpm test:vscode` (real VS Code) | Passed, including §16 |
| VSIX packaging (to a scratch path; tracked VSIXs untouched) | Passed: 9 files, 200.24 KB |
| `pnpm benchmark:provenance` | Passed all built-in count checks |
| `check-sync-contract.mts` (read-only) and sync/profile-sync test files | v1 parity passed; 97 tests passed |
| `git diff --check` | Clean |

## 16. Real VS Code smoke coverage

**API smoke** (`pnpm test:vscode:api`) runs in a clean, isolated profile:

1. The profile starts at Moderate, with the exact default capability set.
2. A connected agent is accepted at Moderate.
3. **Minimal** pauses it in the hook state while its connection stays on. An external write records no change and no filesystem notification.
4. **Moderate** resumes labels and tracks a new external write.
5. **Extensive** turns on all nine capabilities.
6. Turning off Git → **Custom**. **Restore Recommended Tracking** → **Moderate**, with no overrides left in user settings.
7. Pause and resume leave the level unchanged. Show Telemetry Privacy runs.
8. Sync, hourly sync, account, profile sync, connections, retention and the pause setting are unchanged throughout.
9. Real Claude Code and Codex config files (isolated) are byte- and mtime-identical.

**Interactive smoke** (`pnpm test:vscode`):

1. The profile starts at Moderate.
2. At **Minimal**, a real focused edit still counts in the session, but adds nothing to the timeline or hourly patterns. An external write is not recorded.
3. At **Moderate**, an external write is recorded, and a real edit reaches the timeline again.
4. At **Extensive**, no agent is connected.
5. **Custom**, then **Moderate** again.
6. Edit totals stay coherent (+3 across the sequence), and no session history is removed.

## 17. Limitations

- **Coding activity is one capability.** The session engine computes time, languages, projects, lines and files from the same edits, so they cannot be switched off separately. Pause stops all of it.
- **Levels are ordinary VS Code settings.** With Settings Sync, a level follows the user's settings to their other machines.
- **Levels affect future collection.** A range that spans a level change mixes both. Hourly days collected partly at each level are partial (and flagged).
- **Coverage records.** The v2 protocol's fixed coverage vocabulary has no editor-workflow entry. The `editor` coverage record reflects the activity timeline.
- **Inbox records are purged.** When agent labels are paused, hook records not yet ingested (at most one 15-second tick) are purged, as with Phase 9E's per-agent opt-out.
- **Undo is only in the confirmation toast.** After dismissing it, choose the previous level or use Advanced settings.
- **No first-run prompt.** New users silently get Moderate, which equals the previous default. The level picker is reachable from the Activity view's **…** menu, **Account → On this device → Tracking level**, the Command Palette and the Settings UI.
- **Blocked capabilities read as the level they behave as.** A hand-edited contradictory setting can read as, for example, Minimal. Advanced settings shows the blocked request.

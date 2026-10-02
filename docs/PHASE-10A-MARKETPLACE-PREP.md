# Phase 10A: VS Code Marketplace release prep

This phase prepares Stack Stats for its first public Visual Studio Marketplace release:

- S² branding, with a Marketplace icon and an Activity Bar icon;
- a Marketplace-ready manifest and README;
- listing metadata and a screenshot plan;
- an audited package;
- repeatable VSIX tooling: a content check, and a clean-profile install test against the packaged build.

It also maps what changes when the real publisher ID is chosen.

Status: implemented and verified locally (§18). Not committed, pushed or published. No Marketplace account, publisher or token was created or used, and the web repository was only read.

**Release blocker: Publisher ID must be confirmed before final auth-release build.** See §6–§9.

**Dependency:** the uncommitted fix in `apps/vscode-extension/src/vscode-account.ts` (with `tests/vscode-account.test.ts`) is **required** for account linking in any real desktop build (§8.2). It is not part of this phase. Commit it separately before the release build.

Requirements were checked against the current official documentation, which the VS Code docs mark as approved 30 September 2026:

- `api/references/extension-manifest.md`, `api/working-with-extensions/publishing-extension.md`, `api/references/contribution-points.md` and `api/ux-guidelines/activity-bar.md` in microsoft/vscode-docs;
- https://code.visualstudio.com/brand;
- the installed VS Code 1.138.0 and vsce 3.9.2 / 4.0.0 sources.

---

## 1. Manifest audit (`apps/vscode-extension/package.json`)

| Field | Before | After | Notes |
| --- | --- | --- | --- |
| `name` | `stack-stats-vscode` | unchanged | Part of the extension ID. Keep it (§7) |
| `displayName` | `Stack Stats` | unchanged | No Marketplace listing uses it (public search, 1 October 2026) |
| `description` | "Privacy-safe, local-first developer activity analytics." | "Local-first developer activity analytics: coding time, sessions, languages, projects and streaks. Optional private sync and a public developer profile." | Search text and short listing description |
| `version` | `0.5.0` | unchanged | Recommend `0.6.0` together with the publisher (§10) |
| `publisher` | absent, so the ID is `undefined_publisher.stack-stats-vscode` | absent | **Blocker** (§6). Not guessed |
| `private` | `true` | `true` (kept) | Neither vsce 3.9.2 nor 4.0.0 reads it. `rust-lang.rust-analyzer` publishes with `"private": true`. It keeps `pnpm -r publish` from pushing the extension to npm. The root `package.json` `private` is the workspace root and is never packaged |
| `license` | `MIT` (at the end of the file) | `MIT` (moved up) | `LICENSE` is identical to the root one. It is packaged as `LICENSE.txt` and registered as the vsixmanifest License asset |
| `icon` | — | `resources/stack-stats-icon.png` | 256×256 PNG (§3) |
| `galleryBanner` | — | `{ "color": "#11110d", "theme": "dark" }` | The stackstats.dev background, so the Marketplace header matches the site |
| `categories` | `Other` | `Visualization`, `Other` | From the documented list. The closest peer, WakaTime, uses `Visualization` and `Education` |
| `keywords` | — | 15 (limit is 30) | §11 |
| `homepage` | — | `https://stackstats.dev` | Marketplace "Learn" link |
| `repository` | — (packaged with `--allow-missing-repository`) | `https://github.com/userN7590/stack-stats.git`, `directory: apps/vscode-extension` | Public; `main` equals the local `main` |
| `bugs` | — | `https://github.com/userN7590/stack-stats/issues` | Marketplace "Support" link; issues are enabled |
| `engines.vscode` | `^1.95.0` | unchanged | |
| `extensionKind` | unset | unchanged | VS Code 1.138 deduces `["workspace"]`: it runs where the files and agent configs are (Remote SSH, WSL, containers) |
| `capabilities` | unset | unchanged | Undeclared `untrustedWorkspaces` means VS Code disables Stack Stats in Restricted Mode (verified in the 1.138 source). Disclosed in the README; a possible follow-up |
| `activationEvents` | `onStartupFinished`, `onUri` | unchanged | `onUri` is the account callback |
| `contributes` | 33 commands, 3 views, 18 settings | Activity Bar icon path only | No command, view or setting changes |
| `scripts.package` | `pnpm build && vsce package --no-dependencies --allow-missing-repository` | `vsce package --no-dependencies` | |
| `scripts.vscode:prepublish` | — | `pnpm run build` | vsce runs it before every `package` and `publish`, so a stale `dist/` can't ship |
| `files` | `…resources/stack-stats.svg…` | the two new icon files | An exact allowlist; vsce fails if any entry matches nothing |

Packaging through pnpm prints `npm warn Unknown env config …` from `npm run vscode:prepublish`. These are pnpm's environment variables seen by npm; they are harmless and do not occur when vsce runs outside pnpm.

## 2. Branding audit

| Surface | Before | Result |
| --- | --- | --- |
| Marketplace / product icon | None: VS Code showed its generic placeholder | Canonical S² tile (§3) |
| Activity Bar icon | `resources/stack-stats.svg`, a generic "stacked layers" line drawing unrelated to the S² mark | **Removed**; replaced by a traced S² (§4) |
| Command and menu icons | Codicons only: `account`, `close`, `debug-pause`, `link-external`, `play`, `plug`, `refresh`, `settings`, `settings-gear`, `sign-in`, `sign-out`; tree rows use ThemeIcons | Kept: the UX guidelines prefer built-in product icons |
| README logos | None | None. Marketplace README images must be https and not SVG |
| Old artifacts | `apps/vscode-extension/stack-stats-vscode-0.1.0…0.5.0.vsix` | Untracked (`*.vsix` is gitignored) and never packaged; delete locally whenever convenient |
| stackstats.dev favicon | `src/app/favicon.ico` is still the default Next.js/Vercel triangle | Web follow-up (§19); the web repo was not modified |

**Microsoft / VS Code branding.**

- No VS Code logo appears in any asset or text, and nothing implies endorsement.
- The brand page forbids using the icon for your own product and "Visual Studio Code [Name]" naming. It allows "[Name] for Visual Studio Code". The README says "Visual Studio Code" first and "VS Code" afterwards, as the page asks.
- `stack-stats-vscode` is an identifier, not a product name, and follows common practice (`esbenp.prettier-vscode`, `dbaeumer.vscode-eslint`).
- "Claude Code" and "Codex" are named only as the supported integrations. Their logos are not used.

## 3. Marketplace icon

`apps/vscode-extension/resources/stack-stats-icon.png` is a 256×256 RGBA PNG of 10,936 bytes.

- **Design.** The unmodified white S² mark sits on a `#11110d` tile, the stackstats.dev background, which is how the website shows the mark.
  - The mark spans 70% of the tile width and is centered.
  - Tile corners have an 18% radius; the corners are transparent.
  - There is no wordmark and no VS Code branding.
- **Requirements.** The docs require a PNG of at least 128×128 and recommend 256×256 for Retina screens; SVG is rejected.
- **Checked on light and dark Marketplace surfaces** (`#ffffff`, `#f3f3f3`, `#1f1f1f`, `#11110d`) at 128, 64, 42 and 28 px, plus three alternative sizings and radii. The chosen one is the boldest at the 42 px Extensions-list size.
- **In VS Code.** The VSIX test loads the icon in the Extensions view and checks it decodes as a square PNG of at least 128 px (§17). The screenshot shows the S² tile next to "Stack Stats".

## 4. Activity Bar icon

`apps/vscode-extension/resources/stack-stats-activity-bar.svg` is a 2,083-byte, 24×24 `viewBox` SVG: one `<path fill="currentColor">`, with no script, style, image or links.

- **How VS Code renders it.** VS Code 1.138 paints extension Activity Bar icons as a CSS mask filled with `--vscode-activityBar-foreground`, so only the shape matters. The icon follows light, dark and high-contrast themes automatically. The docs ask for 24×24, centered, a single color, and SVG recommended. States inherit 60% opacity by default and 100% on hover or when active.
- **Shape.** The S² mark is traced from the canonical PNG with no redrawing, scaled to 22 units wide (about 0.9 to 23.1) and centered.
- **One optical adjustment.** At 24 px the canonical superscript "2" stroke is about 0.9 px. That is a hairline at 100% display scaling, and fainter still at the 60% inactive opacity. Only the 2 is thickened, by about 0.24 units per side, to about 1.4–1.6 px; the S is untouched. Without this, the 2 faded at 16 and 24 px in simulated Dark Modern, Light Modern, High Contrast and Dark+ renders. The adjustment keeps the S dominant and the mark recognizable. No wordmark is used.
- **In VS Code.** The VSIX test checks that the Activity Bar item uses the packaged SVG as its mask and that the mask decodes with visible pixels. It also saves a 4× screenshot of the rendered icon (§17).

## 5. Asset provenance

| Asset | SHA-256 | Derivation |
| --- | --- | --- |
| Source: `stack-stats-web/public/brand/stack-stats-mark.png` (read-only) | `80289029d765e766dc9704138d66887ee6877e9430608a78f7417087ce202a75` | 3668×2740 RGBA, pure white. Added in web commit `7dda0ba` (27 August 2026) and rendered by `src/components/ui/logo.tsx`. Byte-identical to the image supplied for this phase |
| `stack-stats-icon.png` | `c55dd7e9630d6026415eaa1c1e639a4008b1b9d0155b0c73e426af977b853841` | See the icon steps below |
| `stack-stats-activity-bar.svg` | `97a3877691e25523747144b4df853f5ab8a8f55e22893b0bc057d7a340b789f7` | See the SVG steps below |

**Marketplace icon steps** (Pillow 11.3):

1. Crop the alpha channel to the mark's bounds.
2. Lanczos-resample only the alpha channel to 179 px wide; the mark is pure white.
3. Composite it onto a 4× supersampled rounded `#11110d` tile.

**Activity Bar SVG steps:**

1. Lanczos-scale the alpha channel into a 1200×1200 canvas (50 px per unit).
2. Grow the 2 (source columns from 2711) by a 12 px octagonal dilation.
3. Trace with potrace 2.1.8 (npm, run from a scratch folder; not a project dependency) using `turdSize 4`, `alphaMax 1`, `optTolerance 0.2`.
4. Scale to 24 units, center exactly and round to 0.01.

## 6. Publisher-ID blocker

**Publisher ID must be confirmed before final auth-release build.**

- **No `publisher` today.** The package installs as `undefined_publisher.stack-stats-vscode`, and the vsixmanifest identity is `Publisher="undefined"`.
- **What vsce allows.** vsce packages without a publisher "for testing reasons", but `vsce publish` requires one. A VSIX uploaded in the web portal must also carry the publisher it is uploaded under. The release VSIX therefore has to be rebuilt after the ID exists. `pnpm check:vsix --release <file>` fails while `publisher` is missing.
- **Public availability (read-only, 1 October 2026).** `marketplace.visualstudio.com/publishers/{stackstats,stack-stats,StackStats}` all return 404, and public search finds no "Stack Stats" listing and no `stackstats.stack-stats-vscode`. A 404 does not prove an ID is free, because publishers without public extensions are not listed. Only creating the publisher confirms it.
- **Recommendation:** an all-lowercase ID, such as the expected `stackstats`.
  - The extension compares the callback authority exactly.
  - VS Code lowercases the storage folder names.
  - The web allowlist compares strings.

  Lowercase removes every case question.
- The ID cannot be changed after creation. The display name ("Stack Stats") can be.

## 7. Extension ID implications

The extension ID is `<publisher>.<name>`. Setting the publisher changes it from `undefined_publisher.stack-stats-vscode` to `<publisher>.stack-stats-vscode`. To VS Code, that is a different extension.

| Depends on the extension ID | Does not |
| --- | --- |
| Account callback authority, `vscode://<id>/auth/callback` (§8) | `stackStats.*` settings: user settings, so tracking level, exclusions and agent toggles carry over |
| The web callback allowlist | Command, view and view-container IDs |
| SecretStorage namespace (account credentials) | `~/.stackstats` (`STACK_STATS_HOME`): agent hook runtime, launcher, inbox, backups |
| `globalState` and `workspaceState` | Claude Code and Codex hook entries. They point at the version-stable launcher, so no reconnect and no new Codex approval |
| `globalStorageUri`: all local history (§9) | Optional CLI and daemon config |
| Log folder; Marketplace item URL; the web `VSCODE_EXTENSION_URL` | |

**Both builds installed at once.** Both register the same command IDs, view IDs and settings. In VS Code 1.138, `registerCommand` throws `command '…' already exists` for a duplicate in the same extension host, so whichever build activates second fails part-way and both observe edits. **Uninstall the VSIX build before installing the Marketplace build, after backing up its history (§9).**

**`name`.** Keep `stack-stats-vscode`. The publisher change is the only moment a rename would cost nothing extra, but there is no reason to: the suffix also separates a future JetBrains or Neovim client.

**Cursor and Windsurf** install from Open VSX, not the Microsoft Marketplace. If those callbacks should keep working, publish to Open VSX under the same namespace so the ID, and therefore the callback, matches.

## 8. Auth callback implications

### 8.1 Current behavior (code, verified against VS Code 1.138)

- **Extension** (`vscode-account.ts`):
  - The callback is `Uri.from({ scheme: env.uriScheme, authority: context.extension.id, path: "/auth/callback" })`, where `uriScheme` is `vscode`, `vscode-insiders`, `cursor` or `windsurf`, depending on the editor.
  - `env.asExternalUri` on desktop always appends `windowId=<n>` (VS Code's relay URL service).
  - The URI handler accepts only that exact scheme, authority and path with no fragment. It then checks the single `ss_state` in constant time against a locally started request, and exchanges the code over HTTPS with PKCE.
  - Credentials and pending material live in SecretStorage under `stackStats.account.v1:<origin>[:pending]`, inside the extension's namespace.
- **Web** (`stack-stats-web/src/lib/extension-auth.ts`, `validRedirect`, read-only):
  - It accepts exactly `${scheme}://undefined_publisher.stack-stats-vscode/auth/callback` for the four schemes, optionally with one numeric `windowId` (1–10 digits).
  - It also accepts exact URIs listed in `STACK_STATS_EXTENSION_REDIRECT_URIS`. **The `windowId` tolerance applies only to the hard-coded defaults.** An env-only allowlist entry for a new ID would therefore reject every desktop callback.
- **Database:** each grant stores its exact redirect URI. There is no allowlist in SQL.
- **Supabase Auth:** not involved. Editor callbacks never pass through Supabase redirect URLs, which list only `https://stackstats.dev/auth/callback?next=…`.
- **Link protection.** VS Code shows "Do you want … to open the external website?" before opening any non-trusted domain, and stackstats.dev is not trusted by default. Connect account, Open Dashboard, Open Profile and Manage Sync Privacy all show it until the user picks Open or trusts the domain. The README mentions it.

### 8.2 Required, uncommitted fix (not part of this phase)

- **Committed HEAD** passes a `Uri` object to `openExternal`. For URI objects, VS Code's opener uses `encodeURI(uri.toString(true))`. The nested `?windowId=` inside `redirectUri` becomes `%253F`, so the server receives `…/auth/callback%3FwindowId=…`. That fails `validRedirect`, which means **account linking fails on desktop VS Code**.
- **The uncommitted change** passes the string. VS Code then opens the URL as is, keeping it exactly as built. `tests/vscode-account.test.ts` models this for all four schemes.
- Both code paths were confirmed in the installed 1.138 bundles:
  - `ExtHostWindow.openUri`;
  - `MainThreadWindow.$openUri`;
  - the opener's `_resolveExternalUriOpenTarget`.
- The Phase 10A-only bundle still contains `openExternal(vscode4.Uri.parse(uri))`. The release must include the fix.

### 8.3 Exact changes once the publisher ID is known

1. **Extension:**
   - Add `"publisher": "<id>"` and bump to `0.6.0`.
   - The callback, the SecretStorage namespace and storage follow automatically; no auth code changes.
   - Update the `undefined_publisher` mentions in `docs/ACCOUNTS.md` and the root README.
   - `tests/vscode-account.test.ts` uses its own mock ID and stays valid.
2. **Web** (`stack-stats-web`, separate commit):
   - In `validRedirect`, add `${scheme}://<id>.stack-stats-vscode/auth/callback` to the hard-coded defaults for the four schemes.
   - Keep the `undefined_publisher` entries while VSIX testers migrate, then remove them.
   - Add allowlist tests for the new ID: `tests/extension-auth.test.ts`, `auth-callback.test.ts`, `auth-continuation.test.tsx`.
   - The SQL fixtures in `supabase/tests/*.sql` use the old string only as an exact-binding fixture; no change is needed.
   - Update `docs/EXTENSION_AUTH.md` and `docs/PRODUCTION_AUTH_SYNC.md`.
   - **Deploy before the extension is published**, so new-ID callbacks validate from day one.
3. **Supabase and auth configuration:** no change.
4. **Callback allowlist:** code defaults as above. Do not rely on `STACK_STATS_EXTENSION_REDIRECT_URIS` for desktop.
5. **Compatibility:**
   - Existing VSIX users keep linking while the old defaults stay.
   - The new build needs a fresh link: SecretStorage is per ID.
   - The sync grant must be approved again (§9).
6. **Testing plan:** described in §20.

## 9. Storage and SecretStorage migration implications

Verified in VS Code 1.138's extension-host source:

- `globalStorageUri` is `globalStorage/<id lowercased>`;
- `globalState` and `workspaceState` are keyed by `identifier.value`;
- SecretStorage is keyed by `ExtensionIdentifier.toKey`, the lowercased ID.

| Data | Location | Under a new ID |
| --- | --- | --- |
| Sessions, `telemetry-v2`, `hourly-v1`, `provenance-v1` | `globalStorageUri` | **Empty**: no history |
| Installation ID | `globalStorageUri/installation/id.json` (+ `globalState`) | New random ID |
| Sync privacy salt | `globalStorageUri/installation/sync-salt.json` | New salt, so new private project aliases |
| Profile-sync queue | `globalStorageUri/profile-sync-v1` (keyed by origin, user and installation) | New, empty queue |
| Privacy salt (file and project IDs) | `globalState.privacySalt` | New salt, unless the CLI config exists; then it derives from the CLI token as before |
| Account access and refresh tokens, pending PKCE | SecretStorage | **Gone**: reconnect, and approve sync again |
| Agent `connectedAt` | `globalState` | Gone: "Connected" shows "No activity received yet" until the next signal |
| Tracking level and other settings, agent toggles | user settings | Kept |
| Agent hooks, inbox, backups | `~/.stackstats` | Kept |

**Uninstalling deletes history.** Verified end to end in an isolated profile (§17). When VS Code finishes removing an uninstalled extension:

1. The first start after the uninstall marks it as removed.
2. A later start's cleanup runs `vscode:uninstall`.
3. It then **deletes `globalStorage/<id>`**, and only after that deletes the extension folder.

So uninstalling the VSIX build eventually deletes its history. The README now says this.

**Recommendation.** VSIX builds were only ever side-loaded by the developer and testers, so do **not** ship an automatic migration. One reason is that the old `privacySalt` lives in the other extension's `globalState`, which no API can read. Developer procedure, with VS Code fully closed:

1. Copy `~/Library/Application Support/Code/User/globalStorage/undefined_publisher.stack-stats-vscode/` somewhere safe, **before** uninstalling.
2. Run `code --uninstall-extension undefined_publisher.stack-stats-vscode`, then install the Marketplace build with `code --install-extension <id>.stack-stats-vscode`. CLI installs do not activate it.
3. Copy the backup into `globalStorage/<id>.stack-stats-vscode/`, then start VS Code. History, the installation ID and the sync salt continue.
4. Reconnect the account and approve Profile Sync again. Uploads continue for the same installation.
5. Optional: the old `privacySalt` can be carried over only by editing VS Code's `state.vscdb` while VS Code is closed. Without it, a project's private ID changes once, so a week that spans the switch can list it twice.

## 10. Version recommendation

**Release as `0.6.0` together with the publisher change.** Do not bump it in this phase.

- **Why a bump at all.** `0.5.0` was cut before Phase 9A (v2 sync), 9E (agent telemetry), 9E.1 (one-click integrations), 9F (tracking levels) and this branding. A VSIX called `0.5.0` already exists, so shipping different code under the same number would confuse support.
- **Why not now.** Without the publisher, every build is provisional: the ID, callbacks and storage change with it.
- **Why `0.6.0`.** It is an even minor version, which fits the docs' pre-release advice: release on `major.EVEN`, pre-release on `major.ODD`. The project stays below 1.0 while the sync and profile contracts are still evolving. Marketplace versions must be plain `major.minor.patch`.

## 11. Marketplace listing metadata (proposed)

| Item | Proposal |
| --- | --- |
| Title (`displayName`) | **Stack Stats** |
| Publisher display name | **Stack Stats** |
| Short description | "Local-first developer activity analytics: coding time, sessions, languages, projects and streaks. Optional private sync and a public developer profile." (in the manifest) |
| Long description | The packaged README is the Overview page (§12). There is no separate copy to maintain |
| Categories | `Visualization`, `Other` |
| Keywords / tags | coding stats, coding time, time tracking, developer analytics, activity tracking, productivity, streak, developer profile, portfolio, local-first, privacy, git, claude code, codex, ai agents |
| Optional tags (your decision) | `wakatime` is another company's trademark. Its own listing uses it, and adding it would help "WakaTime alternative" searches. It is left out by default. Also left out: `ai`, `career`, `resume` |
| Repository | https://github.com/userN7590/stack-stats |
| Homepage | https://stackstats.dev |
| Issues | https://github.com/userN7590/stack-stats/issues |
| License | MIT (`LICENSE.txt` in the package) |
| Pricing | Free (the default; no field needed) |
| Q&A | The default Marketplace Q&A tab is left on. If nobody will watch it, set `"qna": false`, or point it at GitHub issues, before publishing |
| Banner | `#11110d`, dark |
| Privacy information | Full three-layer explanation in the README. **stackstats.dev/privacy returns 404**: there is no public privacy page yet (§19). No URL was invented |

## 12. README structure

`apps/vscode-extension/README.md` was rewritten for someone discovering Stack Stats in the Marketplace. It is 10,754 bytes; the previous one was 14,421 and written for VSIX testers and developers.

- **Opening:** "Developer activity analytics and public developer profiles."
- **Sections:** What you get · Getting started · How much Stack Stats tracks · Privacy: three separate layers · Agent integrations · Account and sync · Commands (12) · Settings (6) · What the numbers mean · Requirements and limitations · Uninstalling · Links.
- **Questions it answers:**
  - What is it, and why install it?
  - What does it track (the levels table)?
  - What stays local?
  - Do I need an account? No.
  - What can go on my profile? Chosen metric by metric; project activity is never public.
  - How do agents work?
- **Removed:** the F5, pnpm, `localhost:3000` and staging-Supabase developer instructions. The root README and docs keep them.
- **Links** are absolute https only. vsce rewrites relative links against the repository root, not `apps/vscode-extension`, so relative links would break on the Marketplace or on GitHub. `check-vsix.mjs` enforces this.
- **Tests:** the level summaries are the generated strings that `tracking-levels.test.ts` requires. `## How much Stack Stats tracks` still comes before `## Commands`.
- **Root README:** two small fixes. The install line linked to a gitignored VSIX that 404s on GitHub. And "No activity is sent to stackstats.dev or any cloud service" was untrue since opt-in Profile Sync; it now says aggregates are uploaded only after separate approval.

**Claim audit.**

| Topic | What the README says | Implementation |
| --- | --- | --- |
| Coding time | Gaps of 60 seconds or less between focused edits; not total working time | Session rules |
| Lines | Gross editor line changes, including undo and redo; not a Git diff | `countLineChanges` |
| AI attribution | Labels show which tool reported a change; not proof of authorship; agent time never counts | Phase 9E |
| Agents | Claude Code and Codex only; connecting is optional and confirmed; Codex needs its own approval | Phase 9E.1 |
| Platforms | Verified on macOS; Linux and Windows not yet verified with real agents | 9E.1 §11 |
| Multiple devices | Overlapping time is counted on each device, not deduplicated | 9A §5 |
| Sync | Off until an account **and** a separate browser approval; 90 days of daily summaries; hourly is a separate setting; never names, paths, source or agent records | `profile-sync.ts`, 9A |
| Public profile | Chosen metric by metric on stackstats.dev; project activity never public; schedule charts need separate consent | Web `metric-registry.ts` |
| Network | No requests without an account; loopback only with the optional CLI | Code review of every `fetch` |
| Not claimed | Semantic understanding, perfect attribution, cross-device dedupe, JetBrains or Neovim, automatic agent connection, sync without consent | — |

The command titles "Show Telemetry Today", "Compare Telemetry Weeks" and "Show Telemetry Privacy" are unchanged, because tests and docs use them. A later UX pass could rename them, for example to "Show Privacy Report", so "telemetry" is not misread as usage reporting.

## 13. Screenshot plan

Marketplace images must be https and not SVG. Do not ship generated or seeded data.

| # | Shot | Shows | Source |
| --- | --- | --- | --- |
| 1 | **Activity sidebar** (hero) | Today expanded (coding time, lines, files, edits), This week, Languages, Coding streak; status bar `Stack Stats • …` | Your real profile after an ordinary coding day |
| 2 | **Public profile** | `stackstats.dev/u/<username>`: header, published stats, language chart | Browser, after at least two weeks of synced data. `/u/fil` currently shows 1 minute of coding time, which is too little. Fallback: `stackstats.dev/example`, captioned "Example profile" |
| 3 | **Tracking level picker** | "How much would you like Stack Stats to track?", Moderate — Recommended marked current | Any profile |
| 4 | **Agents panel** | External changes · Tracked automatically; Claude Code · Connected · last activity; Codex · Connect | Your profile with Claude Code connected |
| 5 (optional) | **Privacy report** or the **Connect confirmation** | The three layers, or what Stack Stats will add and never reports | Any profile |

**Capture instructions:**

- **Editor:** Dark Modern theme (matches stackstats.dev), zoom 0, default font. Window 1440×900 logical on a 2× display, giving 2880×1800 px; crop to the relevant region.
- **Hide:**
  - the Chat secondary sidebar, the minimap, the terminal and notifications;
  - other extensions' status bar items;
  - the Explorer, if file names are private.
- **Title bar:** a neutral or public folder. Keep `stackStats.includeProjectNames` off, so projects show as private labels.
- **Never visible:** email addresses, home-directory paths, private repository names, tokens or `localhost`.
- **Browser shot:** only metrics you have published, browser chrome cropped, signed out or in a private window, so no owner-only controls appear.
- **Files:** save PNGs of at most about 1.5 MB in `apps/vscode-extension/media/marketplace/`. They are not in `files`, so they never ship in the VSIX. Reference them from the README with absolute `https://raw.githubusercontent.com/userN7590/stack-stats/<release-tag>/apps/vscode-extension/media/marketplace/<name>.png` URLs pinned to the release tag.

**Automation.** `pnpm test:vsix --artifacts <dir>` saves real screenshots of every UI checkpoint from a clean profile:

- the sidebar;
- the Extensions view;
- the level picker;
- Advanced settings;
- the agent picker;
- needs attention;
- paused.

They suit review and shots 3–4. They show an empty history and VS Code's default layout (the Chat panel is open), so take the hero shots by hand as above.

## 14. Privacy and security summary

What the packaged extension does, in plain terms. This can feed a future public privacy and security page.

- **Editor events.** Stack Stats listens to VS Code's text-change, save, focus, task, debug and diagnostics events. It keeps timestamps, counts, the language and salted file and project IDs. It never keeps text, keystrokes or clipboard contents. Built-in exclusions (`.env*`, keys, `.ssh`, `.aws`, `secrets/`, `node_modules`, build output) are applied before anything is recorded.
- **File-system watcher.** One recursive workspace watcher, from VS Code's API, notices changes made outside the editor at the Moderate and Extensive levels. It never reads file contents. Line counts come only from documents already open in the editor.
- **Git.** At most once a minute, and only in trusted workspaces, Stack Stats runs the local `git` binary with read-only commands: `rev-parse`, `symbolic-ref`, `merge-base`, `rev-list`, `show -s`, `diff-tree --numstat`. It runs with fsmonitor, optional locks and terminal prompts off and a 2.5-second timeout. It keeps hashed branch and commit IDs and line counts, never messages, authors or remotes. Nothing is fetched.
- **Subprocesses.** `git` is the only one. The extension never starts Claude Code or Codex. Those tools run the Stack Stats hook themselves through a small launcher that uses the editor's own runtime.
- **Agent configuration.** Only after an explicit confirmation does Stack Stats write its own entries:
  - to Claude Code's user `settings.json` (`CLAUDE_CONFIG_DIR`);
  - to Codex's `hooks.json` (`CODEX_HOME`).

  Writes are atomic and check the file has not changed since it was read. There is one backup per file, ownership is recognized by exact signature, and Disconnect removes only those entries. Codex `config.toml` and its trust state are never written. The hook reports run lifecycle, tool metadata and file paths; it never reports prompts, responses, code, commands or output.
- **Browser sign-in.** PKCE with random state. It opens stackstats.dev after VS Code's link-protection prompt and returns through the `vscode://` handler. Tokens are exchanged over HTTPS POST and never appear in URLs.
- **Network.**
  - stackstats.dev only, over HTTPS, with no redirects followed, timeouts and size caps. Requests happen only after the account is connected (to validate it) or sync is approved (to upload).
  - A `127.0.0.1` daemon, only when the optional CLI config exists.
  - No third-party analytics.
- **Local storage:**
  - the VS Code extension storage folder: `sessions-v1`, `telemetry-v2`, `hourly-v1`, `provenance-v1`, `profile-sync-v1`, `installation/`;
  - `~/.stackstats`: agent inbox, hooks, backups, state.
- **SecretStorage:** account credentials and pending sign-in material only.
- **Uninstall:**
  - `vscode:uninstall` (`dist/uninstall.cjs`) pauses Stack Stats' own hook state, so leftover hooks record nothing. It never edits vendor files.
  - VS Code then deletes the extension's storage folder.
  - `~/.stackstats` stays and can be deleted by hand.

## 15. Package contents

Packaged with the repository's vsce 3.9.2 from the working tree, to a scratch path; the gitignored VSIX files in the repo were left untouched.

| Archive path | Bytes |
| --- | --- |
| `[Content_Types].xml` | 520 |
| `extension.vsixmanifest` | 3,097 |
| `extension/package.json` | 22,601 |
| `extension/readme.md` | 10,754 |
| `extension/LICENSE.txt` | 1,070 |
| `extension/dist/extension.cjs` | 522,009 (521,790 without the uncommitted account fix) |
| `extension/dist/agent-hook.cjs` | 213,495 |
| `extension/dist/uninstall.cjs` | 195,720 |
| `extension/resources/stack-stats-icon.png` | 10,936 |
| `extension/resources/stack-stats-activity-bar.svg` | 2,083 |

- **Totals:** 10 files, 215,977 bytes (210.92 KB). The Phase 10A-only build is 210.80 KB.
- **Identity:** `stack-stats-vscode` 0.5.0, publisher `undefined`, so it installs as `undefined_publisher.stack-stats-vscode@0.5.0`. Engine `^1.95.0`, `ExtensionKind: workspace`.
- **Not in the package:** sources, tests, docs, source maps, `.env` files, local databases, audit files, old VSIX files and screenshots. Workspace dependencies are bundled by esbuild (`--no-dependencies`).

## 16. Secret and path audit

`scripts/check-vsix.mjs` scans every packaged text file. It reports location and count only, never the matched text. Checked categories:

- home-directory and temporary paths (`/Users/…`, `/home/…`, `C:\Users\…`, `/private/tmp/…`, `/var/folders/`);
- hard-coded Node.js paths (`/usr/local/bin/node`, Homebrew, nvm);
- `file:///` URLs, emails, JWTs and private keys;
- OpenAI, Anthropic, GitHub, AWS and Slack token shapes;
- Supabase project URLs, keys, `service_role` and `SUPABASE_*KEY`;
- source maps.

**Result: passed.**

- The only hits are a code comment explaining macOS `/tmp` symlinks, and the expected loopback addresses: the optional daemon, and the development-only auth origin that installed builds cannot use.
- Phase 9E.1's runtime-derived hook paths hold: no machine-specific Node path is packaged.
- A doctored copy containing an extra `.env`, a `localhost` README link, a home path and a token was rejected with four errors.

The Phase 10A diff and new files were scanned for the same categories. Hits:

- the root README's pre-existing `127.0.0.1` daemon note;
- the scanner's own patterns;
- the runner's local DevTools endpoint.

No personal path, email, token or project name was added.

## 17. Clean-install results

`pnpm test:vsix` installs the VSIX with VS Code's own CLI into isolated profiles. User data, extensions, `STACK_STATS_HOME`, `CLAUDE_CONFIG_DIR` and `CODEX_HOME` are all temporary. The development path is an empty harness, so the only Stack Stats code that runs is the installed package; the test asserts that the extension loads from the isolated extensions folder. The real workbench is inspected through the DevTools protocol, and screenshots are saved.

| # | Check | Result |
| --- | --- | --- |
| 1 | Install | `--install-extension` succeeds; `--list-extensions` shows `undefined_publisher.stack-stats-vscode@0.5.0` |
| 2 | Activation | `onStartupFinished`; no activation errors in the logs |
| 3 | Icon renders | The Activity Bar mask is the packaged SVG and decodes. The Extensions view shows the PNG (square, at least 128 px). Screenshots |
| 4 | Activity panel | "Tracking · Moderate"; Today "Your next edit starts here"; Current session; This week; Languages; Projects; Coding streak |
| 5 | Agents panel | External changes · Tracked automatically; Claude Code and Codex · Not connected with Connect actions; Show agent activity |
| 6 | Account panel | Connect account · Optional; On this device · Moderate tracking |
| 7 | Moderate shown | Panel title, picker "Current" mark, API, privacy report |
| 8 | Local coding event | Interactive scenario: real focused edits create one session with 2 edits and +2 lines. Pause stops collection. Exclusions, tasks, external writes and levels all checked |
| 9 | Status bar | `Stack Stats • Idle`, then `Stack Stats • Paused` |
| 10 | Pause / Resume | All panels show Paused; Resume restores |
| 11 | Level picker | Title, the three levels, Advanced settings…; dismissing changes nothing |
| 12 | Advanced settings | "Advanced tracking · Moderate" lists every capability; dismissing changes nothing. Toggling is covered by the API smoke and unit tests |
| 13 | Show Telemetry Privacy | Output has "Tracking level: Moderate (recommended)" and the three numbered layers |
| 14 | Claude Code / Codex Connect | The confirmation is requested before any write. VS Code's test host refuses modal dialogs, and exactly two refusals are logged |
| 15 | Cancel does nothing | Vendor files byte- and mtime-identical; settings off; no hook runtime installed |
| 16 | No unexpected agent writes | Unchanged through pickers, status checks and levels, and in the API smoke |
| 17 | Account flow | Connect account reaches VS Code's link-protection prompt, which the test host refuses. It returns to local-only with "Could not open account sign-in" and nothing pending. The callback routes to the exact native form (`…/auth/callback?windowId=N`). **The browser leg can only be tested by hand** (§20) |
| 18 | No runtime errors | Log scan: no activation or registration errors. The output log has exactly the two expected refusals |
| — | Needs attention | Setting on with hooks missing shows "Needs attention" with Repair connection and Disconnect |
| — | Uninstall and reinstall | CLI uninstall, then VS Code restarts. VS Code ran the packaged `vscode:uninstall` (log: "Running post uninstall script" → "Finished" → "Deleted marked for removal extension from disk"): agent hooks paused, extension folder removed, **local history deleted**. Reinstall succeeds |

The developer's real `~/.stackstats/agent-inbox-v1/state.json` was unchanged (same mtime and size) across every run.

**Agent states.** "Connected", "Connected · last activity …", "No activity received yet", "Approve in Codex", "Connected · paused" and "Not detected" need a confirmed connection or real agent activity. They are covered by `agent-integrations.test.ts` and `sidebar.test.ts`. "Not connected" and "Needs attention" are verified in the real UI above. The giant JSON setup appears only under *Advanced: show manual setup*. The agent picker check asserts that no raw configuration is shown.

**Tracking levels.** A clean install resolves to Moderate.

- The API smoke asserts that a level change alters only the eight capability settings, and never sync, hourly sync, account, profile sync, connections, retention or vendor files.
- The interactive smoke asserts that no history is removed across level changes.

## 18. Validation and VSIX results

| Check | Result |
| --- | --- |
| `pnpm test` | Working tree: **336 passed, 27 files**. Phase 10A alone (throwaway worktree, without the uncommitted account work): **310 passed, 26 files** |
| `pnpm typecheck` | Passed (both trees) |
| `pnpm build` | Passed: `extension.cjs` 509.8 KB, `agent-hook.cjs` 208.5 KB, `uninstall.cjs` 191.1 KB. Unchanged from 9F: no runtime code changed |
| `pnpm test:vscode:api` (real VS Code) | Passed. One earlier run failed on the fixed 1-second wait for a macOS file-system event; it now polls (below) |
| `pnpm test:vscode` (real VS Code) | Passed |
| `pnpm test:vsix` (packaged VSIX, clean profiles) | Passed for both builds (working tree, and Phase 10A alone): seven UI checkpoints, the API smoke, uninstall and reinstall, and the interactive smoke |
| `pnpm check:vsix` | Passed (normal mode). `--release` fails as intended: no publisher |
| vsce 3.9.2 `package` / `ls` | Packaged with **no warnings**; `ls` lists exactly the 8 declared files |
| vsce 4.0.0 (latest) `package` | Same 10 files, 210.8 KB, no warnings; packaging validation identical to 3.9.2 |
| `pnpm benchmark:provenance` | Passed every built-in count check |
| Sync contract (`check-sync-contract.mts`, read-only, `stack-stats-web`) | v1 parity passed; `--require-v2` module parity passed. Sync test files: 116 passed (5 files) |
| `git diff --check` | Clean (both trees) |

**Phase 10A alone (worktree).** Typecheck, tests, build, packaging, `check:vsix`, `git diff --check` and the full `test:vsix` passed. Two earlier worktree runs happened while the screen was locked; they are not product failures. A locked screen keeps the test window from getting focus and throttles it, so the interactive smoke's focus check fails and the API smoke can time out. Run the real-VS Code tests with the screen unlocked.

**Running real-VS Code tests from an editor's own terminal.** A shell started by an editor extension inherits `ELECTRON_RUN_AS_NODE` and the editor's internal `VSCODE_*` variables. A fresh VS Code then exits at once, or starts with a broken file watcher. `test-vsix.mjs` strips them. For the existing scripts, run from a normal terminal or strip them:

```sh
env $(env | grep -E '^(ELECTRON|VSCODE)_' | cut -d= -f1 | sed 's/^/-u /') pnpm test:vscode:api
```

### Tooling added

- **`scripts/check-vsix.mjs`** (`pnpm check:vsix [--release] <file.vsix>`). Checks:
  - the exact archive contents against `files`;
  - that the main file, uninstall script and both icons resolve inside the package;
  - icon format and size;
  - an SVG safety check;
  - https repository, homepage and bugs links;
  - absolute https README links with no SVG images;
  - the path and secret scan.

  `--release` also requires a publisher.
- **`scripts/test-vsix.mjs`** + **`tests/vscode-vsix-smoke.cjs`** (`pnpm test:vsix [--vsix f] [--artifacts dir] [--keep] [--skip-interactive]`): the clean-install test above. Scenario folders are short, because macOS limits VS Code's IPC socket path to 103 characters.
- **`tests/vscode-api-smoke.cjs`** (test-only fix). The watcher assertion now waits up to 5 seconds instead of a fixed 1 second. It is listed separately in §21, so it can be dropped.

## 19. Remaining release blockers and follow-ups

| Item | Kind | Owner |
| --- | --- | --- |
| Publisher ID not confirmed | **Blocker** | You (§20) |
| Account callback encoding fix uncommitted (`vscode-account.ts` + its test) | **Blocker for account linking** | You: separate commit before the release build |
| Web callback allowlist for `<id>.stack-stats-vscode`, deployed before publishing | **Blocker for account linking** | Phase 10B (web) |
| `publisher` + version `0.6.0` in the manifest; rebuild; `check:vsix --release` | **Blocker** | Phase 10B |
| Manual account-link test under the real ID | **Blocker** | Phase 10B |
| Public privacy page (stackstats.dev/privacy is 404) | Strongly recommended before announcing; not a Marketplace requirement | Web |
| Marketplace screenshots | Recommended | You (§13) |
| Q&A tab decision; optional `wakatime` keyword | Decision | You |
| stackstats.dev favicon is the Next.js/Vercel default | Cosmetic | Web |
| `VSCODE_EXTENSION_URL` | After publication | Web (§20) |
| Restricted Mode: Stack Stats is disabled in untrusted folders | Possible follow-up (`untrustedWorkspaces: limited`; Git is already gated on trust) | Later |
| `telemetry-v2` batches are pruned only after the optional daemon acknowledges them, so without the CLI they are kept indefinitely; `rawRetentionDays` then only trims agent and external records | Follow-up | Later |
| "Telemetry" in command titles; the generic "Check local storage permissions" message for any command failure | UX follow-up | Later |
| Windows and Linux agent hooks not verified with real agents | Disclosed limitation | Later |

## 20. Exact steps after the publisher ID is confirmed

**Human (Marketplace), as currently documented:**

1. Sign in at https://marketplace.visualstudio.com/manage with the Microsoft account that will own the listing.
2. Choose **Create publisher**:
   - **ID:** lowercase, unique and permanent, for example `stackstats`.
   - **Name:** "Stack Stats".
3. Choose how to publish:
   - **Recommended for the first release:** upload the VSIX on that page (**New extension → Visual Studio Code**). No token is needed.
   - `vsce publish` with a Personal Access Token needs an Azure DevOps organization and a PAT scoped to *All accessible organizations*, *Marketplace (Manage)*. **Global PATs are retired on 1 December 2026.** For automated publishing, use Microsoft Entra ID (`vsce publish --azure-credential`, vsce 2.26.1 or later).
4. Send the confirmed publisher ID.
5. Publisher verification (the verified badge) is available only after six months on the Marketplace and a domain at least six months old: later.

**Engineering (Phase 10B):**

1. Commit the account callback fix (§8.2).
2. Extension: add `"publisher": "<id>"` and version `0.6.0`. Update the `undefined_publisher` mentions in docs and the README's install line.
3. Web:
   - add the new ID to the `validRedirect` defaults and add tests (§8.3);
   - run `npm test`, lint, typecheck and build;
   - include a `validRedirect` test for `vscode://<id>.stack-stats-vscode/auth/callback?windowId=1`;
   - deploy. The live check is the manual link in step 5: approval needs a signed-in browser.
4. Build: run `pnpm --filter stack-stats-vscode package --out <scratch>/stack-stats-vscode-0.6.0.vsix`, then `pnpm check:vsix --release <that file>` and `pnpm test:vsix --vsix <that file>`, with the screen unlocked.
5. Real profile:
   1. Back up and migrate history (§9).
   2. Uninstall the VSIX build; install `0.6.0` from the file.
   3. Connect account: link-protection prompt, then Open, then sign in and approve. Expect `@username · Connected`.
   4. Enable Profile Sync and approve; check Sync Now.
   5. Open Profile; Disconnect Account. Check revocation at `/extension/connect`.
   6. Repeat in VS Code Insiders if supported.
6. Capture screenshots (§13); add them to the README with tag-pinned URLs; repackage.
7. Upload the VSIX (or `vsce publish`).
8. Note the listing URL: `https://marketplace.visualstudio.com/items?itemName=<id>.stack-stats-vscode`.
9. Web: set `VSCODE_EXTENSION_URL` in `src/lib/distribution.ts` to that URL. Check the homepage CTA (`extensionInstallUrl` accepts only the official HTTPS listing). Deploy.
10. Run a clean production install from the Marketplace on a fresh VS Code profile, plus one account link.
11. Optional: publish to Open VSX under the same namespace for Cursor and Windsurf (§7).

## 21. Staging block (Phase 10A files only)

Do **not** stage `apps/vscode-extension/src/vscode-account.ts`, `tests/vscode-account.test.ts` or `docs/audits/`.

```sh
git add -- \
  README.md \
  package.json \
  apps/vscode-extension/README.md \
  apps/vscode-extension/package.json \
  apps/vscode-extension/resources/stack-stats.svg \
  apps/vscode-extension/resources/stack-stats-icon.png \
  apps/vscode-extension/resources/stack-stats-activity-bar.svg \
  scripts/check-vsix.mjs \
  scripts/test-vsix.mjs \
  tests/vscode-vsix-smoke.cjs \
  tests/vscode-api-smoke.cjs \
  docs/PHASE-10A-MARKETPLACE-PREP.md
git status --short   # vscode-account.ts, vscode-account.test.ts and docs/audits/ must stay unstaged
```

- `apps/vscode-extension/resources/stack-stats.svg` is a deletion; `git add` on the removed path stages it.
- `tests/vscode-api-smoke.cjs` holds only the watcher-wait fix. Leave it out if you prefer.

## 22. Commit command

```sh
git commit -m "Prepare VS Code Marketplace release (Phase 10A)" \
  -m "Add the canonical S² Marketplace icon and a traced S² Activity Bar icon, replacing the old layers icon. Make the manifest Marketplace-ready (description, categories, keywords, banner, repository, homepage, issues, prepublish build) without guessing a publisher. Rewrite the extension README for first-time Marketplace users with an audited three-layer privacy model. Add pnpm check:vsix (package contents, assets, links, path and secret scan) and pnpm test:vsix (installs the packaged VSIX into clean VS Code profiles and checks the real UI, smokes, and uninstall and reinstall). Document publisher, auth callback and storage migration implications." \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

The separate commit for the required account fix (§8.2) is your own work. Review it first; for example:

```sh
git add -- apps/vscode-extension/src/vscode-account.ts tests/vscode-account.test.ts
git commit -m "Pass account sign-in URLs to openExternal as strings"
```

**Next phase: 10B.** Confirm the publisher; add the publisher, `0.6.0` and the web callback allowlist; run a release build with `check:vsix --release` and `test:vsix`; test account linking by hand under the real ID; take screenshots; publish; set the web Marketplace link.

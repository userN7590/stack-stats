import type { SessionStatistics } from "@stack-stats/core";
import type { SidebarSummary } from "./stats-model.js";
import { formatDuration } from "./presentation.js";
import type { ProfileSyncState } from "./profile-sync.js";
import type { AccountState } from "./account-service.js";

export const sidebarViews = ["currentSession", "today", "thisWeek", "languages", "projects", "streak", "trackingStatus"] as const;
export type SidebarView = typeof sidebarViews[number];
export interface SidebarState {
  summary: SidebarSummary;
  enabled: boolean;
  ready: boolean;
  refreshing: boolean;
  historyError: boolean;
  storageError: boolean;
  idleMinutes: number;
  syncConfigured: boolean;
  account?: AccountState;
  profileSync?: ProfileSyncState;
}
export interface StatsRow {
  id: string;
  label: string;
  description?: string;
  tooltip?: string;
  icon?: string;
  command?: string;
  children?: StatsRow[];
  expanded?: boolean;
}
const number = (value: number) => value.toLocaleString();
const row = (id: string, label: string, description?: string, tooltip?: string, icon?: string): StatsRow => ({ id, label, description, tooltip, icon });
const estimate = "Estimated active coding time between nearby edits. Idle gaps and time after the last edit are not credited.";
const lines = "Gross editor line-boundary changes, including undo/redo. This is not a Git diff or a measure of authorship.";

function metrics(stats: SessionStatistics, sessions = true): StatsRow[] {
  return [
    row("time", "Active coding time", formatDuration(stats.activeMs), estimate, "clock"),
    ...(sessions ? [row("sessions", "Sessions", number(stats.sessions), undefined, "history")] : []),
    row("files", "Files edited", number(stats.filesTouched), "Distinct recorded file identities with editor activity; renames and Save As may create a new identity.", "files"),
    row("added", "Lines added", `+${number(stats.linesAdded)}`, lines, "diff-added"),
    row("removed", "Lines removed", `−${number(stats.linesRemoved)}`, lines, "diff-removed"),
    row("edits", "Edits", number(stats.editCount), "Observed edit operations; saves alone do not add edits.", "edit")
  ];
}

export function rowsForView(view: SidebarView, state: SidebarState): StatsRow[] {
  const { summary } = state;
  if (view === "trackingStatus") return [
    row("tracking", "Tracking", !state.enabled ? "Paused" : summary.current ? "Session open" : "Ready for edits", "Tracking starts automatically on eligible editor activity.", state.enabled ? "pulse" : "debug-pause"),
    row("storage", "Local storage", state.storageError ? "Needs attention" : "On this device", state.storageError ? "Recent activity may only be in memory. Check permissions and disk space, then refresh." : "Your summaries work offline without an account or a daemon.", state.storageError ? "warning" : "database"),
    row("history", "History", state.historyError ? "May be incomplete" : state.refreshing ? "Refreshing…" : state.ready ? "Loaded" : "Loading…", undefined, state.historyError ? "warning" : "history"),
    row("timeout", "Session idle timeout", `${state.idleMinutes}m`, "Groups edits into sessions. The separate active-time evidence gap remains 60 seconds."),
    row("sync", "Local daemon", state.syncConfigured ? "Configured (optional)" : "Not needed", "The daemon is optional for CLI access. No cloud connection is required."),
    ...accountRows(state.account ?? { status: "disconnected" }),
    ...profileSyncRows(state.profileSync ?? { status: "disabled", pendingDays: 0 }),
    { id: "toggle", label: state.enabled ? "Pause Tracking" : "Resume Tracking", icon: state.enabled ? "debug-pause" : "play", command: state.enabled ? "stackStats.pause" : "stackStats.resume" },
    { id: "settings", label: "Tracking settings", icon: "settings-gear", command: "stackStats.openSettings" }
  ];
  const warning: StatsRow[] = state.historyError && view !== "currentSession" ? [{ id: "error", label: "History may be incomplete", description: "Refresh to retry", icon: "warning", command: "stackStats.refreshStats", tooltip: "Showing available local data. Unreadable history is preserved; see Stack Stats output for details." }] : [];
  if (!state.ready && view !== "currentSession") return [...warning, row("loading", state.historyError ? "History unavailable" : "Loading local history…", undefined, undefined, state.historyError ? "warning" : "loading~spin")];
  let rows: StatsRow[];
  switch (view) {
    case "currentSession":
      rows = summary.current ? [
        ...metrics(summary.current, false),
        row("started", "Started", new Date(summary.session!.startedAt).toLocaleTimeString(), new Date(summary.session!.startedAt).toLocaleString()),
        row("lastEdit", "Last edit", new Date(summary.session!.endedAt).toLocaleTimeString(), "The duration does not tick upward while idle.")
      ] : [row("empty", state.enabled ? "No current session" : "Tracking is paused", state.enabled ? "Start editing to begin" : "History stays on this device", undefined, state.enabled ? "edit" : "debug-pause"),
        ...(!state.enabled ? [{ id: "resume", label: "Resume Tracking", icon: "play", command: "stackStats.resume" }] : [])];
      break;
    case "today":
    case "thisWeek": {
      const stats = view === "today" ? summary.today : summary.week;
      rows = [...(stats.sessions ? [] : [row("empty", "No coding activity yet", view === "today" ? "Today" : "This week")]), ...metrics(stats)];
      if (view === "thisWeek") rows.push(
        row("longest", "Longest session", summary.week.longestSession ? formatDuration(summary.week.longestSession.activeMs) : "No sessions yet", "Active time within this week; idle gaps are excluded.", "history"),
        row("days", "Active days", number(summary.week.activeDays)),
        row("average", "Average per active day", formatDuration(summary.week.averageActiveMs), estimate));
      break;
    }
    case "languages":
      rows = summary.week.languages.map(language => ({
        ...row(language.languageId, language.languageId, `${formatDuration(language.activeMs)}${summary.week.activeMs ? ` · ${Math.round(language.activeMs / summary.week.activeMs * 100)}%` : ""}`, "This week's language activity, ranked by active time, then edits. Zero time means no evidenced interval yet.", "code"),
        children: [row("edits", "Edits", number(language.editCount)), row("added", "Lines added", `+${number(language.linesAdded)}`, lines), row("removed", "Lines removed", `−${number(language.linesRemoved)}`, lines)]
      }));
      if (!rows.length) rows = [row("empty", "No languages recorded this week", "Appears as you edit")];
      break;
    case "projects":
      rows = summary.week.projects.map(project => ({
        ...row(project.projectId, project.displayName, formatDuration(project.activeMs), "This week's activity. Project names are private by default; opt in through settings to record names for future activity.", "folder"),
        children: [row("edits", "Edits", number(project.editCount)), row("added", "Lines added", `+${number(project.linesAdded)}`, lines), row("removed", "Lines removed", `−${number(project.linesRemoved)}`, lines)]
      }));
      if (!rows.length) rows = [row("empty", "No projects recorded this week", "Appears as you edit")];
      break;
    case "streak":
      rows = [row("current", "Current streak", `${number(summary.week.currentStreak)} ${summary.week.currentStreak === 1 ? "day" : "days"}`, "Consecutive recorded active days through today, or yesterday if you have not edited today. A day with an edit counts even with zero timed activity.", "flame"),
        row("days", "Active days this week", number(summary.week.activeDays))];
  }
  return [...warning, ...rows];
}

export function accountRows(account: AccountState): StatsRow[] {
  const connected = account.status === "connected" && account.account;
  const connecting = account.status === "connecting";
  const label = connected ? `Connected as @${account.account!.username}` : connecting ? "Connecting…" : account.status === "expired" ? "Authentication expired" : account.status === "error" ? "Authentication error" : "Not connected";
  return [
    row("account", "Stack Stats account", label, account.message ?? "Stack Stats tracks locally by default. Connecting an account enables optional profile synchronization. Connecting alone never uploads history.", connecting ? "loading~spin" : connected ? "account" : account.status === "error" || account.status === "expired" ? "warning" : "person"),
    ...(account.message ? [row("accountMessage", account.message)] : []),
    ...(connecting ? [{ id: "cancelAccount", label: "Cancel Account Connection", command: "stackStats.cancelAccountConnection", icon: "close" }] : [
      { id: "accountAction", label: connected ? "Open Profile" : "Connect Stack Stats Account", command: connected ? "stackStats.openProfile" : "stackStats.connectAccount", icon: connected ? "link-external" : "sign-in" }
    ]),
    ...(account.status !== "disconnected" ? [{ id: "disconnectAccount", label: "Disconnect Account", command: "stackStats.disconnectAccount", icon: "sign-out" }] : [])
  ];
}

export function statusBarPresentation(state: SidebarState) {
  const duration = state.summary.current?.activeMs ?? 0;
  return {
    text: !state.enabled ? "$(debug-pause) Stack Stats • Paused" : state.storageError ? "$(warning) Stack Stats • Storage error" : `$(pulse) Stack Stats • ${state.summary.current ? formatDuration(duration) : "Idle"}`,
    tooltip: `${!state.enabled ? "Tracking is paused." : state.summary.current ? `Current session: ${formatDuration(duration)} estimated active coding time.` : "Ready to track automatically when you edit."}\n${state.storageError ? "Local storage needs attention; recent activity may only be in memory.\n" : ""}Open the Stack Stats sidebar.`,
    warning: state.storageError
  };
}

export function profileSyncRows(sync: ProfileSyncState): StatsRow[] {
  const labels = { "not-connected": "Not connected", disabled: "Sync disabled", enabled: "Sync enabled · private uploads", syncing: "Syncing…", pending: "Offline / pending", error: "Sync error" };
  const enabled = !["disabled", "not-connected"].includes(sync.status);
  return [
    row("cloudSync", "Profile synchronization", labels[sync.status], "Daily aggregates only. Publishing is a separate choice on stackstats.dev.", sync.status === "syncing" ? "sync~spin" : sync.status === "error" ? "warning" : "cloud"),
    row("pendingDays", "Days pending", String(sync.pendingDays)),
    row("lastSync", "Last synced", sync.lastSyncedAt ? `${formatDuration(Math.max(0, Date.now() - sync.lastSyncedAt))} ago` : "Not yet"),
    ...(sync.message ? [row("syncMessage", sync.message)] : []),
    { id: "toggleProfileSync", label: enabled ? "Disable Profile Sync" : "Enable Profile Sync", command: enabled ? "stackStats.disableProfileSync" : "stackStats.enableProfileSync", icon: enabled ? "debug-pause" : "cloud-upload" },
    ...(enabled ? [{ id: "syncNow", label: "Sync Now", command: "stackStats.syncNow", icon: "sync" }] : []),
    { id: "syncPrivacy", label: "Manage Sync Privacy", command: "stackStats.syncPrivacy", icon: "shield" }
  ];
}

/** Two native panels; the original section identifiers remain command targets. */
export const nativeSidebarViews = ["today", "trackingStatus"] as const;
export type NativeSidebarView = typeof nativeSidebarViews[number];

function compactMetrics(stats: SessionStatistics, sessions = true): StatsRow[] {
  return [
    row("changes", "Lines changed", `+${number(stats.linesAdded)} / −${number(stats.linesRemoved)}`, `${number(stats.linesAdded)} lines added; ${number(stats.linesRemoved)} lines removed. ${lines}`, "diff"),
    ...metrics(stats, sessions).filter(item => ["files", "edits", "sessions"].includes(item.id))
  ];
}

const languageNames: Record<string, string> = {
  typescript: "TypeScript", typescriptreact: "TypeScript React", javascript: "JavaScript", javascriptreact: "JavaScript React",
  python: "Python", rust: "Rust", go: "Go", java: "Java", csharp: "C#", cpp: "C++", c: "C", ruby: "Ruby", php: "PHP",
  html: "HTML", css: "CSS", scss: "SCSS", json: "JSON", jsonc: "JSON with comments", yaml: "YAML", markdown: "Markdown",
  shellscript: "Shell", plaintext: "Plain text", sql: "SQL", swift: "Swift", kotlin: "Kotlin", dart: "Dart", vue: "Vue", svelte: "Svelte"
};

export function rowsForPanel(view: NativeSidebarView, state: SidebarState): StatsRow[] {
  if (view === "trackingStatus") return connectionRows(state);
  const { summary } = state;
  const current: StatsRow = {
    ...row("currentSession", "Current session", !state.enabled ? "Paused" : summary.current ? formatDuration(summary.current.activeMs) : "Ready to code", estimate, !state.enabled ? "debug-pause" : "pulse"),
    children: summary.current ? [...compactMetrics(summary.current, false), ...rowsForView("currentSession", state).filter(item => item.id === "started" || item.id === "lastEdit")]
      : rowsForView("currentSession", state)
  };
  const warnings: StatsRow[] = state.storageError ? [{ id: "storageWarning", label: "Activity could not be saved", description: "Retry", icon: "warning", command: "stackStats.refreshStats", tooltip: "Recent activity may only be in memory. Check disk space and permissions, then refresh." }] : [];
  if (state.historyError) warnings.push({ id: "historyWarning", label: "History may be incomplete", description: "Retry", icon: "warning", command: "stackStats.refreshStats", tooltip: "Available statistics are shown. Unreadable history is preserved for recovery." });
  if (!state.ready) return [...warnings, row("loading", state.historyError ? "History unavailable" : "Loading your activity…", undefined, undefined, state.historyError ? "warning" : "loading~spin"), current];
  const languages = rowsForView("languages", { ...state, historyError: false }).map(item => ({ ...item, label: languageNames[item.label] ?? item.label }));
  const projects = rowsForView("projects", { ...state, historyError: false });
  return [...warnings,
    { ...row("today", "Today", formatDuration(summary.today.activeMs), `${summary.today.date}. ${estimate}`, "clock"), expanded: true,
      children: summary.today.sessions ? compactMetrics(summary.today) : [{ ...row("empty", state.enabled ? "Your next edit starts here" : "Resume to start tracking", undefined, "Eligible edits are tracked automatically while tracking is enabled. No account is required.", state.enabled ? "edit" : "play"), ...(state.enabled ? {} : { command: "stackStats.resume" }) }] },
    current,
    { ...row("thisWeek", "This week", formatDuration(summary.week.activeMs), `Week of ${summary.week.from}. ${estimate}`, "calendar"),
      children: [...compactMetrics(summary.week), ...rowsForView("thisWeek", state).filter(item => ["longest", "days", "average"].includes(item.id))] },
    { ...row("languages", "Languages", summary.week.languages.length ? languages[0]!.label : "This week", "All languages this week, ranked by active time, then edits.", "code"), children: languages },
    { ...row("projects", "Projects", summary.week.projects.length ? `${number(summary.week.projects.length)} this week` : "This week", "All projects this week. Expand to see the existing private project labels.", "folder"), children: projects },
    { ...row("streak", "Coding streak", `${number(summary.week.currentStreak)} ${summary.week.currentStreak === 1 ? "day" : "days"}`, rowsForView("streak", state)[0]?.tooltip, "flame"),
      children: rowsForView("streak", state).filter(item => item.id === "days") }
  ];
}

function connectionRows(state: SidebarState): StatsRow[] {
  const account = state.account ?? { status: "disconnected" };
  const sync = state.profileSync ?? { status: "not-connected", pendingDays: 0 };
  const connected = account.status === "connected" && account.account;
  const connecting = account.status === "connecting";
  const accountError = account.status === "error" || account.status === "expired";
  const accountDetails = accountRows(account).filter(item => item.id !== "account" && item.id !== "accountMessage");
  const syncDetails = profileSyncRows(sync).filter(item => item.id !== "cloudSync" && item.id !== "syncMessage");
  const accountRow: StatsRow = account.status === "disconnected" ? {
    ...row("account", "Connect account", "Optional", "Stack Stats tracks locally by default. Connecting an account enables optional profile synchronization. Connecting alone never uploads history.", "account"), command: "stackStats.connectAccount"
  } : {
    ...row("account", connected ? `@${account.account!.username}` : connecting ? "Connecting account…" : account.status === "expired" ? "Sign in again" : "Account unavailable",
      connected ? "Connected" : accountError ? "Needs attention" : "Finish in browser", account.message, connecting ? "loading~spin" : accountError ? "warning" : "account"),
    expanded: accountError || connecting,
    children: [...(account.message ? [row("message", "Connection details", undefined, account.message, "info")] : []), ...accountDetails]
  };
  const syncLabels = { "not-connected": "Local only", disabled: "Off", enabled: "Up to date", syncing: "Syncing…", pending: "Waiting to sync", error: "Needs attention" };
  const syncDescription = sync.status === "pending" && sync.pendingDays > 0 ? `${number(sync.pendingDays)} ${sync.pendingDays === 1 ? "day" : "days"} pending`
    : sync.status === "enabled" && sync.lastSyncedAt !== undefined ? `Synced ${formatDuration(Math.max(0, Date.now() - sync.lastSyncedAt))} ago` : syncLabels[sync.status];
  const syncRow: StatsRow = {
    ...row("profileSync", "Profile sync", syncDescription, sync.message ?? "Optional daily aggregate uploads. Publishing on your profile is a separate choice.", sync.status === "error" ? "warning" : sync.status === "syncing" ? "sync~spin" : "cloud"),
    expanded: sync.status === "error",
    children: [row("privacy", "Private uploads", "Publishing is separate", "Enable Profile Sync requires browser approval. Manage Sync Privacy controls public visibility."),
      ...(sync.message ? [row("message", "Sync details", undefined, sync.message, "info")] : []), ...syncDetails]
  };
  const status = rowsForView("trackingStatus", state);
  return [accountRow,
    // A disconnected first-time user needs one invitation, not two competing ones.
    ...(account.status !== "disconnected" || sync.pendingDays > 0 || sync.lastSyncedAt !== undefined ? [syncRow] : []),
    { ...row("local", "On this device", state.storageError || state.historyError ? "Needs attention" : !state.enabled ? "Paused" : "Tracking locally", "Your activity stays available offline. Expand for tracking controls and troubleshooting.", state.storageError || state.historyError ? "warning" : "shield"),
      children: [status.find(item => item.id === "toggle")!, status.find(item => item.id === "settings")!,
        { ...row("diagnostics", "Troubleshooting", undefined, "Storage, history, idle timeout and optional local daemon details.", "tools"),
          children: [...status.filter(item => ["tracking", "storage", "history", "timeout", "sync"].includes(item.id)),
            { id: "status", label: "Open diagnostic report", command: "stackStats.showStatus", icon: "output" },
            { id: "retry", label: "Retry local daemon sync", command: "stackStats.retrySync", icon: "sync" }]
        }]
    }
  ];
}

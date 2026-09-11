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

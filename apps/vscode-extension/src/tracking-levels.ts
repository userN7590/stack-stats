/** Phase 9F: the single source of truth for what Stack Stats observes on this device.
 * Tracking levels, Advanced settings, the privacy report, the docs check and tests all
 * derive from the definitions below; nothing else lists level membership.
 *
 * A tracking level changes local collection only. Private sync, publication, the
 * account and agent connections are separate consent layers and have no setting
 * here, so no plan built by this module can touch them. Pause (stackStats.enabled)
 * is separate too: it stops all collection whatever the level. No VS Code
 * dependency, so everything here runs in plain unit tests. */

export const trackingLevels = ["minimal", "moderate", "extensive"] as const;
export type TrackingLevel = typeof trackingLevels[number];
/** Custom is never chosen directly: it is what any non-preset combination reads as. */
export type TrackingMode = TrackingLevel | "custom";
export const RECOMMENDED_LEVEL: TrackingLevel = "moderate";

export type CapabilityGroup = "core" | "detail" | "outside" | "attribution";
export interface CapabilityDefinition {
  name: string;
  /** Lowercase phrase used in generated level summaries. */
  short: string;
  /** One plain-English line: what it records. */
  description: string;
  /** What is kept, and what never is. */
  privacy: string;
  group: CapabilityGroup;
  /** `stackStats.<setting>`. Absent for core activity, which only Pause stops. */
  setting?: string;
  /** Must equal the package.json default (tested). */
  default: boolean;
  /** Capabilities declared earlier that must also be on for this one to work. */
  requires?: readonly string[];
  /** A separate explicit step, outside tracking levels, before this records anything. */
  integration?: string;
  /** Which levels include it. A new capability is added by adding one entry here. */
  levels: Readonly<Record<TrackingLevel, boolean>>;
}

const definitions = {
  coding_activity: {
    name: "Coding activity", short: "coding time, sessions, streaks, languages, projects, lines and files",
    description: "Coding time, sessions, streaks, languages, projects, and lines and files edited.",
    privacy: "Counts and private IDs from your edits in VS Code. Never source code, file names or keystrokes.",
    group: "core", default: true, levels: { minimal: true, moderate: true, extensive: true }
  },
  activity_timeline: {
    name: "Hourly activity patterns", short: "hourly patterns", setting: "collectActivityTimeline",
    description: "When during the day you code, plus typing detail such as characters and undo/redo counts.",
    privacy: "Timestamped 15-second activity records without any text. Uploaded only if you separately turn on hourly sync.",
    group: "detail", default: true, levels: { minimal: false, moderate: true, extensive: true }
  },
  editor_events: {
    name: "Editor workflow", short: "editor workflow", setting: "collectEditorEvents",
    description: "Saves, switches between files, window focus, and files created, renamed or deleted in VS Code.",
    privacy: "Event counts and private file IDs. Never file names or contents.",
    group: "detail", default: true, levels: { minimal: false, moderate: true, extensive: true }
  },
  tasks_debugging: {
    name: "Tasks and debugging", short: "tasks and debugging", setting: "collectWorkflows",
    description: "Build and test task runs and debug sessions started in VS Code.",
    privacy: "Task type, exit code and timing. Never commands, arguments, output or debug configuration.",
    group: "detail", default: true, levels: { minimal: false, moderate: true, extensive: true }
  },
  problem_counts: {
    name: "Problem counts", short: "problem counts", setting: "collectDiagnostics",
    description: "Error and warning counts for files you change.",
    privacy: "Counts by severity only. Never messages or code.",
    group: "detail", default: false, levels: { minimal: false, moderate: false, extensive: true }
  },
  external_changes: {
    name: "External file changes", short: "external file changes", setting: "collectFilesystem",
    description: "Changes made outside the editor by terminals, scripts, agents or checkouts. The writer stays unknown.",
    privacy: "Change counts, and line counts for files open in VS Code. Never file contents. Never counted as coding time.",
    group: "outside", default: true, levels: { minimal: false, moderate: true, extensive: true }
  },
  git_activity: {
    name: "Git activity", short: "Git activity", setting: "collectGit",
    description: "Branch switches and new commits, checked at most once a minute in trusted workspaces.",
    privacy: "Private commit and branch IDs and changed-line counts. Never commit messages, authors or remote URLs.",
    group: "outside", default: true, levels: { minimal: false, moderate: true, extensive: true }
  },
  agent_activity: {
    name: "Agent activity", short: "labels from agents you connect", setting: "collectAgentActivity",
    description: "Labels changes and runs from agents you connect in the Agents panel, such as Claude Code or Codex.",
    privacy: "Run times, tool types and line counts reported by connected agents. Never prompts, responses, commands or code.",
    integration: "Connect an agent in the Agents panel. A tracking level never connects one for you.",
    requires: ["external_changes"], group: "attribution", default: true, levels: { minimal: false, moderate: true, extensive: true }
  },
  extension_reports: {
    name: "Reports from other extensions", short: "reports from other extensions", setting: "allowAttributionReports",
    description: "Lets cooperating extensions label your edits as human- or AI-made. Labels are claims, not proof.",
    privacy: "Labels attached to existing activity records.",
    requires: ["activity_timeline"], group: "attribution", default: false, levels: { minimal: false, moderate: false, extensive: true }
  }
} satisfies Record<string, CapabilityDefinition>;

export type CapabilityId = keyof typeof definitions;
export interface Capability extends Omit<CapabilityDefinition, "requires"> { id: CapabilityId; requires: readonly CapabilityId[] }
export type TrackingCapabilities = Readonly<Record<CapabilityId, boolean>>;

export const CAPABILITIES: readonly Capability[] = Object.freeze((Object.keys(definitions) as CapabilityId[]).map((id) => {
  const definition: CapabilityDefinition = definitions[id];
  return Object.freeze({ ...definition, id, requires: Object.freeze([...(definition.requires ?? [])]) as readonly CapabilityId[], levels: Object.freeze({ ...definition.levels }) });
}));
const byId = new Map(CAPABILITIES.map((capability) => [capability.id, capability]));
export const capability = (id: CapabilityId): Capability => byId.get(id)!;
/** Every setting a tracking level may write. Nothing outside this list is ever written. */
export const CAPABILITY_SETTINGS: readonly string[] = Object.freeze(CAPABILITIES.flatMap((item) => item.setting ? [item.setting] : []));

/** Derived, never listed by hand: level → capabilities it includes. */
export const TRACKING_PRESETS: Readonly<Record<TrackingLevel, readonly CapabilityId[]>> = Object.freeze(Object.fromEntries(trackingLevels.map((level) =>
  [level, Object.freeze(CAPABILITIES.filter((item) => item.levels[level]).map((item) => item.id))])) as Record<TrackingLevel, readonly CapabilityId[]>);

// Fail at load, not in a user's editor, if a definition breaks the model's rules.
for (const [index, item] of CAPABILITIES.entries()) {
  if (!item.setting && !trackingLevels.every((level) => item.levels[level])) throw new Error(`${item.id} has no setting, so every level must include it`);
  if (!item.setting && !item.default) throw new Error(`${item.id} has no setting, so it must default on`);
  for (const required of item.requires) {
    const position = CAPABILITIES.findIndex((other) => other.id === required);
    if (position < 0 || position >= index) throw new Error(`${item.id} must be declared after ${required}`);
    for (const level of trackingLevels) if (item.levels[level] && !capability(required).levels[level]) throw new Error(`${level} includes ${item.id} without ${required}`);
  }
}

export const LEVELS: Readonly<Record<TrackingLevel, { label: string; summary: string; note?: string }>> = Object.freeze({
  minimal: { label: "Minimal", summary: "Basic coding statistics with the least observation." },
  moderate: { label: "Moderate", summary: "Rich development analytics with automatic external-change tracking." },
  extensive: { label: "Extensive", summary: "Deep workflow and provenance analytics.", note: "Connecting AI tools stays your choice." }
});
export const modeLabel = (mode: TrackingMode) => mode === "custom" ? "Custom" : LEVELS[mode].label;
export const levelTitle = (level: TrackingLevel) => level === RECOMMENDED_LEVEL ? `${LEVELS[level].label} — Recommended` : LEVELS[level].label;

const list = (items: readonly string[]) => items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
/** "Tracks …" for the smallest level, "Everything in <previous>, plus …" above it. */
export function levelDetail(level: TrackingLevel): string {
  const index = trackingLevels.indexOf(level);
  const note = LEVELS[level].note ? ` ${LEVELS[level].note}` : "";
  if (index === 0) return `Tracks ${list(TRACKING_PRESETS[level].map((id) => capability(id).short))}. Nothing else.${note}`;
  const previous = trackingLevels[index - 1]!;
  const added = TRACKING_PRESETS[level].filter((id) => !TRACKING_PRESETS[previous].includes(id)).map((id) => capability(id).short);
  return `Everything in ${LEVELS[previous].label}, plus ${list(added)}.${note}`;
}

// ── Resolving settings into an immutable snapshot ────────────────────────────────

/** Returns the stored value for `stackStats.<key>`, or undefined when unset. */
export type SettingsReader = (key: string) => unknown;
export interface TrackingSnapshot {
  readonly mode: TrackingMode;
  /** What is actually collected (requested, and every requirement on). */
  readonly capabilities: TrackingCapabilities;
  /** What the settings ask for. */
  readonly requested: TrackingCapabilities;
  /** Requested but inactive because a requirement is off. */
  readonly blocked: readonly CapabilityId[];
}

/** Missing means the default; anything that is not a boolean fails closed (off). */
const flag = (value: unknown, fallback: boolean) => value === undefined ? fallback : value === true;

export function matchLevel(capabilities: TrackingCapabilities): TrackingMode {
  return trackingLevels.find((level) => CAPABILITIES.every((item) => capabilities[item.id] === item.levels[level])) ?? "custom";
}

/** Cheap enough to run on every settings change; collectors then read plain fields. */
export function resolveTracking(read: SettingsReader): TrackingSnapshot {
  const requested = {} as Record<CapabilityId, boolean>, capabilities = {} as Record<CapabilityId, boolean>, blocked: CapabilityId[] = [];
  for (const item of CAPABILITIES) {
    requested[item.id] = item.setting ? flag(read(item.setting), item.default) : true;
    // Requirements are declared earlier, so a single pass resolves chains.
    capabilities[item.id] = requested[item.id] && item.requires.every((id) => capabilities[id]);
    if (requested[item.id] && !capabilities[item.id]) blocked.push(item.id);
  }
  return Object.freeze({ mode: matchLevel(capabilities), capabilities: Object.freeze(capabilities), requested: Object.freeze(requested), blocked: Object.freeze(blocked) });
}

// ── Plans: the exact settings writes, nothing else ──────────────────────────────

/** `value: undefined` removes the user override because the target is the default. */
export interface SettingChange { capability: CapabilityId; key: string; on: boolean; value: boolean | undefined }
const change = (item: Capability, on: boolean): SettingChange => ({ capability: item.id, key: item.setting!, on, value: on === item.default ? undefined : on });
const order = new Map(CAPABILITIES.map((item, index) => [item.id, index]));
/** Dependents switch off before their requirements; requirements switch on first. */
function ordered(changes: SettingChange[]): SettingChange[] {
  const rank = (item: SettingChange) => item.on ? order.get(item.capability)! : -order.get(item.capability)! - 1;
  return changes.sort((a, b) => Number(a.on) - Number(b.on) || rank(a) - rank(b));
}

/** Makes the requested settings exactly equal to the level; the result reads as that level. */
export function planLevel(level: TrackingLevel, read: SettingsReader): SettingChange[] {
  const { requested } = resolveTracking(read);
  return ordered(CAPABILITIES.filter((item) => item.setting && requested[item.id] !== item.levels[level]).map((item) => change(item, item.levels[level])));
}

/** Turning a capability on also turns on what it needs; turning one off also turns off
 * what depends on it. `also` names the others whose collection actually changes. */
export function planCapability(read: SettingsReader, id: CapabilityId, on: boolean): { changes: SettingChange[]; also: CapabilityId[] } {
  if (!capability(id).setting) return { changes: [], also: [] };
  const snapshot = resolveTracking(read), targets = new Set<CapabilityId>([id]);
  for (let grew = true; grew;) {
    grew = false;
    for (const item of CAPABILITIES) {
      const linked = on ? [...targets].some((target) => capability(target).requires.includes(item.id)) : item.requires.some((required) => targets.has(required));
      if (linked && !targets.has(item.id)) { targets.add(item.id); grew = true; }
    }
  }
  const affected = CAPABILITIES.filter((item) => targets.has(item.id));
  return { changes: ordered(affected.filter((item) => item.setting && snapshot.requested[item.id] !== on).map((item) => change(item, on))),
    also: affected.filter((item) => item.id !== id && snapshot.capabilities[item.id] !== on).map((item) => item.id) };
}

/** The reader as it will look once `changes` are written. */
export function withChanges(read: SettingsReader, changes: readonly SettingChange[]): SettingsReader {
  const next = new Map(changes.map((item) => [item.key, item.value ?? capability(item.capability).default]));
  return (key) => next.has(key) ? next.get(key) : read(key);
}

// ── User-facing copy (pure, so it is tested for jargon and accuracy) ─────────────

export const LEVEL_PICKER_TITLE = "How much would you like Stack Stats to track?";
export const LEVEL_PICKER_HINT = "You can change this anytime. Tracking depth only affects data collected on this device. Cloud sync and public profile sharing are controlled separately.";
export const SEPARATION_NOTE = "Private sync and your public profile are unchanged.";

export type PickerAction = { type: "level"; level: TrackingLevel } | { type: "advanced" } | { type: "toggle"; id: CapabilityId } | { type: "locked" }
  | { type: "restore" } | { type: "levels" } | { type: "settings" };
export interface PickerRow { label: string; description?: string; detail?: string; separator?: boolean; action?: PickerAction }

export function levelPickerRows(snapshot: TrackingSnapshot): PickerRow[] {
  const rows: PickerRow[] = trackingLevels.map((level) => ({ label: `${snapshot.mode === level ? "$(check) " : ""}${levelTitle(level)}`,
    description: `${snapshot.mode === level ? "Current · " : ""}${LEVELS[level].summary}`, detail: levelDetail(level), action: { type: "level", level } }));
  if (snapshot.mode === "custom") rows.push({ label: "$(check) Custom", description: "Current · your own selection", detail: "Open Advanced settings to review or change individual capabilities.", action: { type: "advanced" } });
  return [...rows, { label: "", separator: true }, { label: "$(settings-gear) Advanced settings…", description: "Choose individual capabilities", action: { type: "advanced" } }];
}

const groupLabels: Record<CapabilityGroup, string> = { core: "Always on while tracking", detail: "Detailed activity", outside: "Outside the editor", attribution: "Agents and attribution" };
export function advancedPickerRows(snapshot: TrackingSnapshot): PickerRow[] {
  const rows: PickerRow[] = [];
  for (const group of Object.keys(groupLabels) as CapabilityGroup[]) {
    rows.push({ label: groupLabels[group], separator: true });
    for (const item of CAPABILITIES.filter((entry) => entry.group === group)) {
      const on = snapshot.capabilities[item.id];
      if (!item.setting) { rows.push({ label: `$(lock) ${item.name}`, description: "Always on · use Pause Tracking to stop", detail: item.description, action: { type: "locked" } }); continue; }
      const missing = item.requires.filter((id) => !snapshot.capabilities[id]).map((id) => capability(id).name);
      rows.push({ label: `${on ? "$(pass-filled)" : "$(circle-large-outline)"} ${item.name}`,
        description: on ? "On" : snapshot.blocked.includes(item.id) ? `Off · needs ${list(missing)}` : "Off",
        detail: item.integration && on ? `${item.description} ${item.integration}` : item.description, action: { type: "toggle", id: item.id } });
    }
  }
  rows.push({ label: "", separator: true }, { label: "$(list-selection) Choose a tracking level…", action: { type: "levels" } });
  if (snapshot.mode !== RECOMMENDED_LEVEL) rows.push({ label: "$(discard) Restore recommended tracking", description: LEVELS[RECOMMENDED_LEVEL].label, action: { type: "restore" } });
  rows.push({ label: "$(gear) Open all Stack Stats settings", action: { type: "settings" } });
  return rows;
}

/** Confirmation after a level or capability change, naming each layer separately. */
export function levelChangedMessage(snapshot: TrackingSnapshot, context: { paused: boolean; sync: string; connected: readonly string[]; available: readonly string[] }): string {
  const parts = [`Tracking level: ${modeLabel(snapshot.mode)}. This applies to future activity on this device; existing history is kept.`];
  if (context.paused) parts.push("Tracking is paused, so nothing is collected until you resume.");
  if (!snapshot.capabilities.agent_activity && context.connected.length) parts.push(`${list(context.connected)} ${context.connected.length === 1 ? "stays" : "stay"} connected, but Stack Stats ignores ${context.connected.length === 1 ? "its" : "their"} activity at this level.`);
  else if (snapshot.capabilities.agent_activity && snapshot.mode === "extensive" && !context.connected.length && context.available.length) parts.push(`Agent labels are available: connect ${list(context.available)} in the Agents panel.`);
  parts.push(`${context.sync} · Public profile: unchanged.`);
  return parts.join(" ");
}

/** Shown before Connect when the current level ignores agents. */
export function agentLabelsNote(snapshot: TrackingSnapshot, plan: { changes: readonly SettingChange[] }, read: SettingsReader): string {
  const names = list(plan.changes.filter((item) => item.on).map((item) => capability(item.capability).name));
  const next = resolveTracking(withChanges(read, plan.changes)).mode;
  return `Agent activity is off at your current tracking level (${modeLabel(snapshot.mode)}). Continuing also turns on ${names}, so your tracking level becomes ${modeLabel(next)}.`;
}

export function capabilityChangedMessage(id: CapabilityId, on: boolean, also: readonly CapabilityId[], mode: TrackingMode): string {
  const names = list(also.map((other) => capability(other).name));
  const why = !also.length ? "" : on ? ` ${names} ${also.length === 1 ? "was" : "were"} turned on too, because ${capability(id).name} needs ${also.length === 1 ? "it" : "them"}.`
    : ` ${names} ${also.length === 1 ? "was" : "were"} turned off too, because ${also.length === 1 ? "it needs" : "they need"} ${capability(id).name}.`;
  return `${capability(id).name} is ${on ? "on" : "off"}.${why} Tracking level: ${modeLabel(mode)}.`;
}

export interface PrivacyContext {
  snapshot: TrackingSnapshot;
  paused: boolean;
  excludedFiles: number;
  excludedProjects: number;
  account: { connected: boolean; username?: string };
  /** "no-account" | "off" | "on", from the separately consented sync service. */
  sync: "no-account" | "off" | "on";
  hourlySync: boolean;
  agents: ReadonlyArray<{ name: string; connected: boolean }>;
  publicSettingsUrl: string;
  /** Troubleshooting lines, shown last. */
  storage: readonly string[];
}

/** The three consent layers, each stated on its own. */
export function formatPrivacy(context: PrivacyContext): string {
  const { snapshot } = context;
  const on = CAPABILITIES.filter((item) => snapshot.capabilities[item.id]), off = CAPABILITIES.filter((item) => !snapshot.capabilities[item.id]);
  const out = ["Stack Stats — Privacy", "",
    `Tracking level: ${modeLabel(snapshot.mode)}${snapshot.mode === RECOMMENDED_LEVEL ? " (recommended)" : ""}${context.paused ? " · tracking is paused: nothing is collected until you resume" : ""}`,
    "Three separate choices: what Stack Stats collects on this device, what it uploads privately to your account, and what appears publicly on stackstats.dev. Changing one never changes the others.",
    "", "1. Local collection (this device)", "  On:", ...on.map((item) => `    • ${item.name}: ${item.description} ${item.privacy}`)];
  if (off.length) out.push("  Off:", ...off.map((item) => `    • ${item.name}${snapshot.blocked.includes(item.id) ? ` (needs ${list(item.requires.filter((id) => !snapshot.capabilities[id]).map((id) => capability(id).name))})` : ""}`));
  out.push(`  Exclusions: ${context.excludedFiles} custom file pattern(s) plus built-in secret and generated-file exclusions; ${context.excludedProjects} project pattern(s).`,
    "  Never collected: source code, file contents, prompts, keystrokes, clipboard, commands or their output, commit messages, author names.",
    "  Changing the tracking level affects future collection only. Existing history is kept.",
    "", "2. Private sync (your Stack Stats account)",
    `  Account: ${context.account.connected ? `connected${context.account.username ? ` as @${context.account.username}` : ""}` : "not connected"}.`,
    `  Profile sync: ${context.sync === "on" ? "on. Private daily summaries: coding time, edits, lines, sessions, languages and private project totals." : context.sync === "off" ? "off." : "off (no account connected)."}`,
    `  Hourly patterns in sync: ${!context.hourlySync ? "off." : snapshot.capabilities.activity_timeline ? "on (uploaded only while profile sync is on)." : "on, but hourly activity patterns are not collected at this tracking level, so none are uploaded."}`,
    "  Never uploaded: agent and external-change records, file names, paths, project names, source code.",
    "", "3. Public profile (stackstats.dev)",
    `  Nothing becomes public from this editor. You choose what to publish at ${context.publicSettingsUrl}. A tracking level never publishes anything.`,
    "", "Agents");
  const connected = context.agents.filter((agent) => agent.connected);
  if (!connected.length) out.push("  No agents connected. Connecting one is always a separate, confirmed step in the Agents panel.");
  for (const agent of connected) out.push(`  ${agent.name}: connected · ${snapshot.capabilities.agent_activity ? "labels its changes on this device" : "ignored at this tracking level; its hook stays installed until you disconnect"}.`);
  if (context.storage.length) out.push("", "Troubleshooting", ...context.storage.map((line) => `  ${line}`));
  return out.join("\n");
}

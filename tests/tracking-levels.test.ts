import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CAPABILITIES, CAPABILITY_SETTINGS, LEVEL_PICKER_HINT, LEVEL_PICKER_TITLE, RECOMMENDED_LEVEL, TRACKING_PRESETS, advancedPickerRows, agentLabelsNote,
  capability, capabilityChangedMessage, formatPrivacy, levelChangedMessage, levelDetail, levelPickerRows, matchLevel, planCapability, planLevel,
  resolveTracking, trackingLevels, withChanges, type CapabilityId, type PrivacyContext, type SettingChange, type SettingsReader, type TrackingLevel } from "../apps/vscode-extension/src/tracking-levels.js";

const manifest = JSON.parse(readFileSync(resolve("apps/vscode-extension/package.json"), "utf8"));
const properties: Record<string, { type: string; default: unknown; scope: string; description: string; markdownDescription?: string }> =
  Object.assign({}, ...manifest.contributes.configuration.map((section: { properties: object }) => section.properties));
/** A settings.json stand-in: unset keys fall back to the package.json default, as VS Code does. */
function store(values: Record<string, unknown> = {}) {
  const data = new Map(Object.entries(values));
  const read: SettingsReader = (key) => data.has(key) ? data.get(key) : properties[`stackStats.${key}`]?.default;
  const write = (changes: readonly SettingChange[]) => { for (const change of changes) change.value === undefined ? data.delete(change.key) : data.set(change.key, change.value); };
  return { data, read, write };
}
/** Keys outside local collection that a level must never touch. */
const unrelated = { enabled: true, syncHourlyActivity: true, "agentIntegrations.claudeCode": true, "agentIntegrations.codex": false, includeProjectNames: true,
  excludeFiles: ["**/secret/**"], excludeProjects: ["client-*"], rawRetentionDays: 7, showStatusBar: false, inactivityTimeoutMinutes: 12 };
const JARGON = /telemetry|collector|reconcil|provenance ledger|event stream|v2|daemon|inbox|hook payload/i;

describe("capability model", () => {
  it("is one internally consistent source of truth", () => {
    expect(new Set(CAPABILITIES.map((item) => item.id)).size).toBe(CAPABILITIES.length);
    expect(new Set(CAPABILITY_SETTINGS).size).toBe(CAPABILITY_SETTINGS.length);
    expect(CAPABILITIES.filter((item) => !item.setting).map((item) => item.id)).toEqual(["coding_activity"]);
    for (const level of trackingLevels) {
      // Presets are derived from each capability's own level flags, never listed twice.
      expect(TRACKING_PRESETS[level]).toEqual(CAPABILITIES.filter((item) => item.levels[level]).map((item) => item.id));
      expect(TRACKING_PRESETS[level]).toContain("coding_activity");
      // Every preset satisfies its own dependencies, so applying one never reads as Custom.
      for (const id of TRACKING_PRESETS[level]) for (const required of capability(id).requires) expect(TRACKING_PRESETS[level]).toContain(required);
    }
    // Each level strictly contains the one below it.
    expect(TRACKING_PRESETS.minimal.every((id) => TRACKING_PRESETS.moderate.includes(id))).toBe(true);
    expect(TRACKING_PRESETS.moderate.every((id) => TRACKING_PRESETS.extensive.includes(id))).toBe(true);
    expect(TRACKING_PRESETS.minimal.length).toBeLessThan(TRACKING_PRESETS.moderate.length);
    expect(TRACKING_PRESETS.moderate.length).toBeLessThan(TRACKING_PRESETS.extensive.length);
    expect(Object.isFrozen(CAPABILITIES) && CAPABILITIES.every(Object.isFrozen) && Object.isFrozen(TRACKING_PRESETS)).toBe(true);
  });

  it("matches package.json: application-scoped booleans with the same defaults and plain descriptions", () => {
    for (const item of CAPABILITIES.filter((entry) => entry.setting)) {
      const property = properties[`stackStats.${item.setting}`]!;
      expect(property, item.setting).toMatchObject({ type: "boolean", default: item.default, scope: "application" });
      expect(property.markdownDescription).toContain(`**${item.name}.**`);
      expect(property.markdownDescription).toContain("command:stackStats.changeTrackingLevel");
      expect(`${property.description} ${property.markdownDescription}`).not.toMatch(JARGON);
    }
    const tracking = manifest.contributes.configuration.find((section: { title: string }) => section.title === "Tracking");
    expect(Object.keys(tracking.properties)).toEqual(["stackStats.enabled", ...CAPABILITY_SETTINGS.map((key) => `stackStats.${key}`)]);
    // Sync, publication, agent connections and display settings live in other sections.
    for (const key of ["syncHourlyActivity", "agentIntegrations.claudeCode", "agentIntegrations.codex", "enabled", "rawRetentionDays"]) expect(CAPABILITY_SETTINGS).not.toContain(key);
  });

  it("a developer adds a capability in one place", () => {
    // The level flags live on the capability; the summaries are generated from them.
    expect(levelDetail("minimal")).toBe("Tracks coding time, sessions, streaks, languages, projects, lines and files. Nothing else.");
    expect(levelDetail("moderate")).toBe("Everything in Minimal, plus hourly patterns, editor workflow, tasks and debugging, external file changes, Git activity and labels from agents you connect.");
    expect(levelDetail("extensive")).toBe("Everything in Moderate, plus problem counts and reports from other extensions. Connecting AI tools stays your choice.");
  });
});

describe("resolving settings", () => {
  it("gives a clean install the recommended level, which is exactly the pre-9F shipped default", () => {
    expect(RECOMMENDED_LEVEL).toBe("moderate");
    expect(resolveTracking(store().read).mode).toBe("moderate");
    expect(resolveTracking(() => undefined).mode).toBe("moderate");
    const defaults = resolveTracking(store().read).capabilities;
    expect(defaults).toMatchObject({ problem_counts: false, extension_reports: false, agent_activity: true, external_changes: true, git_activity: true });
  });

  it("derives pre-9F installs from their real settings without changing any collection they had", () => {
    const old = ["collectFilesystem", "collectGit", "collectWorkflows", "collectDiagnostics", "allowAttributionReports"] as const;
    const seen = new Map<string, number>();
    for (let mask = 0; mask < 2 ** old.length; mask++) {
      const values = Object.fromEntries(old.map((key, bit) => [key, Boolean(mask & (1 << bit))]));
      const { capabilities, mode } = resolveTracking(store({ ...values, ...unrelated }).read);
      // Before 9F the edit timeline, editor workflow and agent labels were always on.
      expect(capabilities).toEqual({ coding_activity: true, activity_timeline: true, editor_events: true, tasks_debugging: values.collectWorkflows,
        problem_counts: values.collectDiagnostics, external_changes: values.collectFilesystem, git_activity: values.collectGit,
        // The one intentional tightening: agent labels need external file changes (docs §12).
        agent_activity: values.collectFilesystem, extension_reports: values.allowAttributionReports });
      seen.set(mode, (seen.get(mode) ?? 0) + 1);
    }
    // Only the untouched default reads as Moderate and only the all-on set as Extensive.
    expect(Object.fromEntries(seen)).toEqual({ moderate: 1, extensive: 1, custom: 30 });
  });

  it("recognizes exactly each level and reads every other combination as Custom", () => {
    const toggles = CAPABILITIES.filter((item) => item.setting);
    const counts: Record<string, number> = {};
    for (let mask = 0; mask < 2 ** toggles.length; mask++) {
      const values = Object.fromEntries(toggles.map((item, bit) => [item.setting!, Boolean(mask & (1 << bit))]));
      const snapshot = resolveTracking(store(values).read);
      counts[snapshot.mode] = (counts[snapshot.mode] ?? 0) + 1;
      const exact = trackingLevels.filter((level) => CAPABILITIES.every((item) => snapshot.capabilities[item.id] === item.levels[level]));
      expect(snapshot.mode).toBe(exact[0] ?? "custom");
    }
    // Minimal also absorbs settings whose only extras are blocked by a missing requirement
    // (agent labels without external changes, reports without the timeline): 1 + 1 + 1 + 1.
    expect(counts).toMatchObject({ minimal: 4, moderate: 1, extensive: 1 });
    expect(counts.custom).toBe(2 ** toggles.length - 6);
  });

  it("fails closed on malformed values, uses defaults for missing ones, and freezes the snapshot", () => {
    const malformed = resolveTracking(store({ collectGit: "true", collectFilesystem: 1, collectWorkflows: null, collectDiagnostics: "yes", collectActivityTimeline: {} }).read);
    expect(malformed.capabilities).toMatchObject({ git_activity: false, external_changes: false, tasks_debugging: false, problem_counts: false, activity_timeline: false, coding_activity: true });
    expect(malformed.capabilities.agent_activity).toBe(false); // Its requirement failed closed too.
    expect(malformed.mode).toBe("custom");
    const snapshot = resolveTracking(store().read);
    expect(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.capabilities) && Object.isFrozen(snapshot.requested) && Object.isFrozen(snapshot.blocked)).toBe(true);
    expect(() => { (snapshot.capabilities as Record<CapabilityId, boolean>).git_activity = false; }).toThrow();
  });

  it("never reports a contradictory state: dependents without their requirement are inactive and named", () => {
    const snapshot = resolveTracking(store({ collectFilesystem: false, collectAgentActivity: true, collectActivityTimeline: false, allowAttributionReports: true }).read);
    expect(snapshot.requested).toMatchObject({ agent_activity: true, extension_reports: true });
    expect(snapshot.capabilities).toMatchObject({ agent_activity: false, extension_reports: false });
    expect(snapshot.blocked).toEqual(["agent_activity", "extension_reports"]);
    const agentRow = advancedPickerRows(snapshot).find((row) => row.action?.type === "toggle" && row.action.id === "agent_activity");
    expect(agentRow?.description).toBe("Off · needs External file changes");
  });

  it("resolves cheaply enough to rebuild on every settings change", () => {
    const { read } = store(unrelated);
    const started = performance.now();
    for (let i = 0; i < 20_000; i++) resolveTracking(read);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(matchLevel(resolveTracking(read).capabilities)).toBe("moderate");
  });
});

describe("applying a level", () => {
  it("reaches exactly that level from any starting point and writes only local collection settings", () => {
    const starts = [{}, { collectGit: false, collectDiagnostics: true }, { collectFilesystem: "no", allowAttributionReports: 1 },
      Object.fromEntries(CAPABILITY_SETTINGS.map((key) => [key, false])), Object.fromEntries(CAPABILITY_SETTINGS.map((key) => [key, true]))];
    for (const start of starts) for (const level of trackingLevels) {
      const settings = store({ ...unrelated, ...start });
      const changes = planLevel(level, settings.read);
      expect(changes.every((change) => CAPABILITY_SETTINGS.includes(change.key))).toBe(true);
      settings.write(changes);
      expect(resolveTracking(settings.read).mode).toBe(level);
      // Sync, publication, account, agent connection, exclusions and display settings are untouched.
      for (const [key, value] of Object.entries(unrelated)) expect(settings.data.get(key)).toEqual(value);
      expect(planLevel(level, settings.read)).toEqual([]);
    }
  });

  it("removes overrides that equal the default and writes explicit values otherwise", () => {
    const settings = store();
    const minimal = planLevel("minimal", settings.read);
    expect(minimal.map((change) => [change.key, change.value])).toEqual([
      ["collectAgentActivity", false], ["collectGit", false], ["collectFilesystem", false], ["collectWorkflows", false], ["collectEditorEvents", false], ["collectActivityTimeline", false]]);
    settings.write(minimal);
    const extensive = planLevel("extensive", settings.read);
    // Requirements switch on before the capabilities that need them.
    expect(extensive.map((change) => [change.key, change.value])).toEqual([
      ["collectActivityTimeline", undefined], ["collectEditorEvents", undefined], ["collectWorkflows", undefined], ["collectDiagnostics", true],
      ["collectFilesystem", undefined], ["collectGit", undefined], ["collectAgentActivity", undefined], ["allowAttributionReports", true]]);
    settings.write(extensive);
    settings.write(planLevel("moderate", settings.read));
    // Back at the recommended level, settings.json holds no Stack Stats capability overrides.
    expect(CAPABILITY_SETTINGS.filter((key) => settings.data.has(key))).toEqual([]);
  });

  it("leaves Custom as soon as the exact preset set is restored", () => {
    const settings = store();
    settings.write(planCapability(settings.read, "activity_timeline", false).changes);
    expect(resolveTracking(settings.read).mode).toBe("custom");
    settings.write(planCapability(settings.read, "activity_timeline", true).changes);
    expect(resolveTracking(settings.read).mode).toBe("moderate");
    settings.write(planCapability(settings.read, "problem_counts", true).changes);
    expect(resolveTracking(settings.read).mode).toBe("custom");
    settings.write(planCapability(settings.read, "extension_reports", true).changes);
    expect(resolveTracking(settings.read).mode).toBe("extensive");
  });
});

describe("capability dependencies", () => {
  it("turning a capability on also turns on what it needs, in a safe order", () => {
    const settings = store(Object.fromEntries(CAPABILITY_SETTINGS.map((key) => [key, false])));
    const agent = planCapability(settings.read, "agent_activity", true);
    expect(agent.changes.map((change) => change.key)).toEqual(["collectFilesystem", "collectAgentActivity"]);
    expect(agent.also).toEqual(["external_changes"]);
    const reports = planCapability(settings.read, "extension_reports", true);
    expect(reports.changes.map((change) => change.key)).toEqual(["collectActivityTimeline", "allowAttributionReports"]);
    expect(capabilityChangedMessage("extension_reports", true, reports.also, "custom"))
      .toBe("Reports from other extensions is on. Hourly activity patterns was turned on too, because Reports from other extensions needs it. Tracking level: Custom.");
  });

  it("turning a requirement off also turns off what depends on it, dependents first", () => {
    const settings = store({ allowAttributionReports: true, collectDiagnostics: true });
    const external = planCapability(settings.read, "external_changes", false);
    expect(external.changes.map((change) => change.key)).toEqual(["collectAgentActivity", "collectFilesystem"]);
    expect(external.also).toEqual(["agent_activity"]);
    expect(capabilityChangedMessage("external_changes", false, external.also, "custom"))
      .toBe("External file changes is off. Agent activity was turned off too, because it needs External file changes. Tracking level: Custom.");
    const timeline = planCapability(settings.read, "activity_timeline", false);
    expect(timeline.changes.map((change) => change.key)).toEqual(["allowAttributionReports", "collectActivityTimeline"]);
    // A blocked dependent is switched off too, but is not announced: its collection doesn't change.
    const blocked = store({ collectFilesystem: false });
    expect(planCapability(blocked.read, "external_changes", false)).toEqual({ changes: [expect.objectContaining({ key: "collectAgentActivity", value: false })], also: [] });
    expect(planCapability(settings.read, "coding_activity", false)).toEqual({ changes: [], also: [] });
  });

  it("explains before Connect what turning agent labels back on will change", () => {
    const settings = store(Object.fromEntries(CAPABILITY_SETTINGS.map((key) => [key, false])));
    const snapshot = resolveTracking(settings.read);
    const plan = planCapability(settings.read, "agent_activity", true);
    expect(agentLabelsNote(snapshot, plan, settings.read)).toBe("Agent activity is off at your current tracking level (Minimal). Continuing also turns on External file changes and Agent activity, so your tracking level becomes Custom.");
    expect(resolveTracking(withChanges(settings.read, plan.changes)).capabilities.agent_activity).toBe(true);
  });
});

describe("user-facing copy", () => {
  const snapshot = (level: TrackingLevel | Record<string, unknown>) => {
    const settings = store();
    if (typeof level === "string") settings.write(planLevel(level, settings.read)); else for (const [key, value] of Object.entries(level)) settings.data.set(key, value);
    return resolveTracking(settings.read);
  };

  it("asks one plain question and marks the current level, with Advanced settings secondary", () => {
    expect(LEVEL_PICKER_TITLE).toBe("How much would you like Stack Stats to track?");
    expect(LEVEL_PICKER_HINT).toMatch(/only affects data collected on this device.*Cloud sync and public profile sharing are controlled separately/);
    const rows = levelPickerRows(snapshot("moderate"));
    expect(rows.map((row) => row.label)).toEqual(["Minimal", "$(check) Moderate — Recommended", "Extensive", "", "$(settings-gear) Advanced settings…"]);
    expect(rows[1]).toMatchObject({ description: "Current · Rich development analytics with automatic external-change tracking.", action: { type: "level", level: "moderate" } });
    expect(rows[2]!.detail).toContain("Connecting AI tools stays your choice.");
    expect(rows[3]).toMatchObject({ separator: true });
    const custom = levelPickerRows(snapshot({ collectGit: false }));
    expect(custom.map((row) => row.label)).toEqual(["Minimal", "Moderate — Recommended", "Extensive", "$(check) Custom", "", "$(settings-gear) Advanced settings…"]);
    expect(custom[3]!.action).toEqual({ type: "advanced" });
    for (const row of [...rows, ...custom]) expect(`${row.label} ${row.description ?? ""} ${row.detail ?? ""}`).not.toMatch(JARGON);
  });

  it("groups Advanced settings, locks core activity and offers a way back to the recommended level", () => {
    const rows = advancedPickerRows(snapshot({ collectGit: false }));
    expect(rows.filter((row) => row.separator).map((row) => row.label)).toEqual(["Always on while tracking", "Detailed activity", "Outside the editor", "Agents and attribution", ""]);
    expect(rows[1]).toMatchObject({ label: "$(lock) Coding activity", description: "Always on · use Pause Tracking to stop", action: { type: "locked" } });
    expect(rows.find((row) => row.label.endsWith("Git activity"))).toMatchObject({ label: "$(circle-large-outline) Git activity", description: "Off", action: { type: "toggle", id: "git_activity" } });
    expect(rows.find((row) => row.label.endsWith("Agent activity"))?.detail).toContain("A tracking level never connects one for you.");
    expect(rows.map((row) => row.action?.type)).toEqual(expect.arrayContaining(["levels", "restore", "settings"]));
    expect(advancedPickerRows(snapshot("moderate")).some((row) => row.action?.type === "restore")).toBe(false);
    expect(rows.filter((row) => row.action?.type === "toggle")).toHaveLength(CAPABILITY_SETTINGS.length);
    for (const row of rows) expect(`${row.label} ${row.description ?? ""} ${row.detail ?? ""}`).not.toMatch(JARGON);
  });

  it("names each consent layer after a change, and never says anything became public", () => {
    const context = { paused: false, sync: "Private sync: off", connected: [] as string[], available: ["Claude Code", "Codex"] };
    expect(levelChangedMessage(snapshot("moderate"), context)).toBe("Tracking level: Moderate. This applies to future activity on this device; existing history is kept. Private sync: off · Public profile: unchanged.");
    expect(levelChangedMessage(snapshot("extensive"), context)).toContain("Agent labels are available: connect Claude Code and Codex in the Agents panel.");
    expect(levelChangedMessage(snapshot("minimal"), { ...context, paused: true, connected: ["Claude Code"] }))
      .toBe("Tracking level: Minimal. This applies to future activity on this device; existing history is kept. Tracking is paused, so nothing is collected until you resume. Claude Code stays connected, but Stack Stats ignores its activity at this level. Private sync: off · Public profile: unchanged.");
  });

  it("shows the three layers separately in the privacy report", () => {
    const base: PrivacyContext = { snapshot: snapshot("moderate"), paused: false, excludedFiles: 2, excludedProjects: 1, account: { connected: false }, sync: "no-account", hourlySync: false,
      agents: [{ name: "Claude Code", connected: true }, { name: "Codex", connected: false }], publicSettingsUrl: "https://stackstats.dev/settings/sync", storage: [] };
    const report = formatPrivacy(base);
    expect(report).toContain("Tracking level: Moderate (recommended)");
    const sections = ["1. Local collection (this device)", "2. Private sync (your Stack Stats account)", "3. Public profile (stackstats.dev)", "Agents"].map((heading) => report.indexOf(`\n${heading}\n`));
    expect(sections.every((position, index) => position > 0 && (index === 0 || position > sections[index - 1]!))).toBe(true);
    expect(report).toContain("  Off:\n    • Problem counts\n    • Reports from other extensions");
    expect(report).toContain("Profile sync: off (no account connected).");
    expect(report).toContain("A tracking level never publishes anything.");
    expect(report).toContain("Claude Code: connected · labels its changes on this device.");
    expect(report).not.toMatch(JARGON);
    const minimal = formatPrivacy({ ...base, snapshot: snapshot("minimal"), paused: true, sync: "on", hourlySync: true, account: { connected: true, username: "ada" } });
    expect(minimal).toContain("Tracking level: Minimal · tracking is paused: nothing is collected until you resume");
    expect(minimal).toContain("Account: connected as @ada.");
    expect(minimal).toContain("Hourly patterns in sync: on, but hourly activity patterns are not collected at this tracking level, so none are uploaded.");
    expect(minimal).toContain("Claude Code: connected · ignored at this tracking level; its hook stays installed until you disconnect.");
    expect(formatPrivacy({ ...base, snapshot: snapshot({ collectFilesystem: false }) })).toContain("• Agent activity (needs External file changes)");
  });
});

describe("documentation", () => {
  it("the Phase 9F level matrix matches the model", () => {
    const doc = readFileSync(resolve("docs/PHASE-9F-TRACKING-LEVELS.md"), "utf8");
    for (const item of CAPABILITIES) {
      const line = doc.split("\n").find((text) => text.startsWith(`| ${item.name} |`));
      expect(line, item.name).toBeDefined();
      const cells = line!.split("|").map((cell) => cell.trim());
      expect(cells.slice(3, 6), item.name).toEqual(trackingLevels.map((level) => item.levels[level] ? "✓" : "–"));
      expect(cells[2]).toBe(item.setting ? `\`${item.setting}\`` : "always on");
    }
  });

  it("user guides lead with the same generated level summaries", () => {
    for (const path of ["README.md", "apps/vscode-extension/README.md"]) {
      const guide = readFileSync(resolve(path), "utf8");
      for (const level of trackingLevels) expect(guide, `${path}: ${level}`).toContain(levelDetail(level));
      expect(guide.indexOf("## How much Stack Stats tracks")).toBeLessThan(guide.indexOf("## Commands"));
    }
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const manifest = JSON.parse(readFileSync(resolve("apps/vscode-extension/package.json"), "utf8"));
const defaults: Record<string, unknown> = Object.fromEntries(manifest.contributes.configuration
  .flatMap((section: { properties: Record<string, { default: unknown }> }) => Object.entries(section.properties))
  .map(([key, property]: [string, { default: unknown }]) => [key.replace(/^stackStats\./, ""), property.default]));

/** settings.json plus the VS Code windowing APIs the controls use. */
const host = vi.hoisted(() => ({
  settings: new Map<string, unknown>(), writes: [] as Array<[string, unknown]>, failOn: undefined as string | undefined,
  pick: undefined as ((items: any[], options: any) => any) | undefined, picks: [] as Array<{ items: any[]; options: any }>,
  info: [] as string[], errors: [] as string[], infoChoice: undefined as string | undefined,
  configListeners: new Set<(event: { affectsConfiguration(key: string): boolean }) => void>(),
  quickPicks: [] as any[], executed: [] as unknown[][]
}));
vi.mock("vscode", () => ({
  ConfigurationTarget: { Global: 1 },
  QuickPickItemKind: { Separator: -1 },
  workspace: {
    getConfiguration: () => ({
      get: (key: string, fallback?: unknown) => host.settings.has(key) ? host.settings.get(key) : defaults[key] ?? fallback,
      inspect: (key: string) => ({ globalValue: host.settings.get(key), defaultValue: defaults[key] }),
      update: async (key: string, value: unknown) => {
        if (host.failOn === key) throw new Error("settings.json is read-only");
        host.writes.push([key, value]);
        if (value === undefined) host.settings.delete(key); else host.settings.set(key, value);
        for (const listener of host.configListeners) listener({ affectsConfiguration: (section: string) => section === "stackStats" || section === `stackStats.${key}` });
      }
    }),
    onDidChangeConfiguration: (listener: any) => { host.configListeners.add(listener); return { dispose: () => host.configListeners.delete(listener) }; }
  },
  window: {
    showQuickPick: async (items: any[], options: any) => { host.picks.push({ items, options }); return host.pick?.(items, options); },
    showInformationMessage: async (message: string) => { host.info.push(message); return host.infoChoice; },
    showErrorMessage: async (message: string) => { host.errors.push(message); return undefined; },
    createQuickPick: () => {
      const listeners: Record<string, Array<(...args: any[]) => any>> = { accept: [], hide: [] };
      const pick = { items: [] as any[], activeItems: [] as any[], selectedItems: [] as any[], title: "", placeholder: "", busy: false, matchOnDetail: false, disposed: false,
        onDidAccept: (listener: any) => { listeners.accept!.push(listener); }, onDidHide: (listener: any) => { listeners.hide!.push(listener); },
        show: vi.fn(), hide: () => { for (const listener of listeners.hide!) listener(); }, dispose: () => { pick.disposed = true; },
        /** Test helper: select the row whose label ends with `label`, as the user would. */
        accept: async (label: string) => { pick.selectedItems = [pick.items.find((item: any) => item.label.endsWith(label))]; for (const listener of listeners.accept!) await listener(); } };
      host.quickPicks.push(pick);
      return pick;
    }
  },
  commands: { executeCommand: async (...args: unknown[]) => { host.executed.push(args); } }
}));
import { TrackingControls, readTracking } from "../apps/vscode-extension/src/tracking-controls.js";
import { CAPABILITY_SETTINGS } from "../apps/vscode-extension/src/tracking-levels.js";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const unrelated = { enabled: true, syncHourlyActivity: true, "agentIntegrations.claudeCode": true, "agentIntegrations.codex": false, excludeFiles: ["**/secret/**"], rawRetentionDays: 7, showStatusBar: false };
function controls(agents = { connected: ["Claude Code"], available: ["Codex"] }, paused = false) {
  const log = vi.fn();
  return { log, controls: new TrackingControls({ paused: () => paused, syncSummary: () => "Private sync: off", agents: () => agents, log }) };
}
beforeEach(() => {
  host.settings = new Map(Object.entries(unrelated)); host.writes = []; host.failOn = undefined; host.pick = undefined; host.picks = [];
  host.info = []; host.errors = []; host.infoChoice = undefined; host.configListeners.clear(); host.quickPicks = []; host.executed = [];
});
const unrelatedUntouched = () => {
  for (const [key, value] of Object.entries(unrelated)) expect(host.settings.get(key)).toEqual(value);
  expect(host.writes.every(([key]) => CAPABILITY_SETTINGS.includes(key))).toBe(true);
};

describe("Change Tracking Level", () => {
  it("asks how much to track, applies the chosen level and changes nothing but local collection", async () => {
    const { controls: ui } = controls();
    host.pick = (items) => items.find((item) => item.label === "Minimal");
    await ui.changeLevel();
    const [shown] = host.picks;
    expect(shown!.options).toMatchObject({ title: "How much would you like Stack Stats to track?", placeHolder: expect.stringContaining("Cloud sync and public profile sharing are controlled separately") });
    expect(shown!.items.map((item) => item.label)).toEqual(["Minimal", "$(check) Moderate — Recommended", "Extensive", "", "$(settings-gear) Advanced settings…"]);
    expect(shown!.items[3]).toMatchObject({ kind: -1 });
    expect(shown!.items.every((item) => item.kind === -1 || item.detail || item.description)).toBe(true);
    expect(readTracking().mode).toBe("minimal");
    unrelatedUntouched();
    expect(host.info[0]).toBe("Tracking level: Minimal. This applies to future activity on this device; existing history is kept. Claude Code stays connected, but Stack Stats ignores its activity at this level. Private sync: off · Public profile: unchanged.");
    host.picks = []; await ui.changeLevel();
    expect(host.picks[0]!.items[0].label).toBe("$(check) Minimal");
  });

  it("applies a level passed as an argument, suggests connecting agents for Extensive, and never connects one", async () => {
    const { controls: ui } = controls({ connected: [], available: ["Claude Code", "Codex"] });
    await ui.changeLevel("extensive");
    expect(host.picks).toEqual([]);
    expect(readTracking().mode).toBe("extensive");
    expect(host.info[0]).toContain("Agent labels are available: connect Claude Code and Codex in the Agents panel.");
    expect(host.executed).toEqual([]);
    unrelatedUntouched();
    await ui.changeLevel("extensive");
    expect(host.info.at(-1)).toBe("Tracking level is already Extensive.");
    await ui.changeLevel("everything");  // Unknown arguments fall back to the picker.
    expect(host.picks).toHaveLength(1);
  });

  it("Undo restores the exact previous settings, including a Custom selection", async () => {
    host.settings.set("collectGit", false); host.settings.set("collectDiagnostics", true); host.settings.set("collectFilesystem", "malformed");
    const before = new Map(host.settings);
    expect(readTracking().mode).toBe("custom");
    host.infoChoice = "Undo";
    const { controls: ui } = controls();
    await ui.changeLevel("moderate");
    await flush();
    expect(host.settings).toEqual(before);
    expect(readTracking().mode).toBe("custom");
    expect(host.info.at(-1)).toBe("Tracking level restored: Custom.");
    unrelatedUntouched();
  });

  it("shows Custom when settings match no level and opens Advanced settings from it", async () => {
    host.settings.set("collectActivityTimeline", false);
    const { controls: ui } = controls();
    host.pick = (items) => items.find((item) => item.label === "$(check) Custom");
    const done = ui.changeLevel();
    await flush();
    const advanced = host.quickPicks[0];
    expect(advanced.title).toBe("Advanced tracking · Custom");
    advanced.hide();
    await done;
    expect(advanced.disposed).toBe(true);
  });

  it("reports a settings write failure and leaves an honest Custom state", async () => {
    host.failOn = "collectFilesystem";
    const { controls: ui, log } = controls();
    expect(await ui.applyLevel("minimal")).toBe(false);
    expect(host.errors[0]).toBe("Stack Stats couldn't save every tracking setting. Your tracking level is now Custom; check that your settings file is writable, then try again.");
    expect(log).toHaveBeenCalledOnce();
    expect(host.info).toEqual([]);
    unrelatedUntouched();
  });

  it("Restore Recommended Tracking returns to Moderate from anywhere", async () => {
    const { controls: ui } = controls();
    await ui.applyLevel("extensive");
    await ui.setCapability("git_activity", false);
    expect(readTracking().mode).toBe("custom");
    await ui.applyLevel("moderate");
    expect(readTracking().mode).toBe("moderate");
    expect(CAPABILITY_SETTINGS.filter((key) => host.settings.has(key))).toEqual([]);
    unrelatedUntouched();
  });
});

describe("Advanced tracking settings", () => {
  it("toggles one capability at a time, keeps the list open and shows the resulting level", async () => {
    const { controls: ui } = controls();
    const done = ui.advanced();
    const pick = host.quickPicks[0];
    expect(pick.title).toBe("Advanced tracking · Moderate");
    expect(pick.items.filter((item: any) => item.kind === -1).map((item: any) => item.label)).toEqual(["Always on while tracking", "Detailed activity", "Outside the editor", "Agents and attribution", ""]);
    await pick.accept("Hourly activity patterns");
    expect(host.settings.get("collectActivityTimeline")).toBe(false);
    expect(pick.title).toBe("Advanced tracking · Custom");
    expect(pick.activeItems[0].label).toBe("$(circle-large-outline) Hourly activity patterns");
    expect(host.info).toEqual([]);  // Quiet unless another capability changed with it.
    await pick.accept("Hourly activity patterns");
    expect(host.settings.has("collectActivityTimeline")).toBe(false);
    expect(pick.title).toBe("Advanced tracking · Moderate");
    await pick.accept("External file changes");
    expect(host.info.at(-1)).toBe("External file changes is off. Agent activity was turned off too, because it needs External file changes. Tracking level: Custom.");
    await pick.accept("Coding activity");
    expect(host.info.at(-1)).toContain("Use Pause Tracking to stop all collection.");
    // Another window changes a setting while the list is open.
    await import("vscode").then((vscode) => vscode.workspace.getConfiguration("stackStats").update("collectFilesystem", undefined, 1 as any));
    expect(pick.title).toBe("Advanced tracking · Custom");
    await pick.accept("Restore recommended tracking");
    await done;
    expect(readTracking().mode).toBe("moderate");
    expect(pick.disposed).toBe(true);
    expect(host.configListeners.size).toBe(0);
    unrelatedUntouched();
  });

  it("turning agent activity on from Minimal also turns on what it needs, and says so", async () => {
    const { controls: ui } = controls();
    await ui.applyLevel("minimal");
    host.info = [];
    await ui.setCapability("agent_activity", true);
    expect(readTracking().capabilities).toMatchObject({ agent_activity: true, external_changes: true, git_activity: false });
    expect(host.info[0]).toBe("Agent activity is on. External file changes was turned on too, because Agent activity needs it. Tracking level: Custom.");
    expect(await ui.setCapability("coding_activity", false)).toBe(false);
    unrelatedUntouched();
  });
});

import * as vscode from "vscode";
import { CAPABILITIES, LEVEL_PICKER_HINT, LEVEL_PICKER_TITLE, RECOMMENDED_LEVEL, advancedPickerRows, capability, capabilityChangedMessage, levelChangedMessage,
  levelPickerRows, modeLabel, planCapability, planLevel, resolveTracking, trackingLevels, type CapabilityId, type PickerAction, type PickerRow,
  type SettingChange, type SettingsReader, type TrackingLevel, type TrackingSnapshot } from "./tracking-levels.js";

const configuration = () => vscode.workspace.getConfiguration("stackStats");
export const readSetting: SettingsReader = (key) => configuration().get(key);
/** Always read fresh: another window may have changed these application settings. */
export const readTracking = (): TrackingSnapshot => resolveTracking(readSetting);

export interface TrackingControlsOptions {
  paused(): boolean;
  /** e.g. "Private sync: off". Read only; tracking controls never change sync. */
  syncSummary(): string;
  /** Display names; used only for messages. Connections are never changed here. */
  agents(): { connected: string[]; available: string[] };
  log(message: string): void;
}
type Item = vscode.QuickPickItem & { action?: PickerAction };
const toItem = (row: PickerRow): Item => row.separator ? { label: row.label, kind: vscode.QuickPickItemKind.Separator }
  : { label: row.label, description: row.description, detail: row.detail, action: row.action };

/** Commands for tracking levels and Advanced settings. Every write goes through
 * `write`, which only ever receives capability settings from tracking-levels plans. */
export class TrackingControls {
  constructor(private readonly o: TrackingControlsOptions) {}

  private async write(changes: ReadonlyArray<Pick<SettingChange, "key"> & { value: unknown }>): Promise<boolean> {
    try {
      for (const change of changes) await configuration().update(change.key, change.value, vscode.ConfigurationTarget.Global);
      return true;
    } catch {
      this.o.log("Tracking settings could not be saved. Check that your VS Code settings file is writable and valid.");
      void vscode.window.showErrorMessage(`Stack Stats couldn't save every tracking setting. Your tracking level is now ${modeLabel(readTracking().mode)}; check that your settings file is writable, then try again.`);
      return false;
    }
  }

  /** Applies a plan built elsewhere (for example, Connect turning agent labels on). */
  apply(changes: readonly SettingChange[]): Promise<boolean> { return this.write(changes); }
  plan(id: CapabilityId, on: boolean) { return planCapability(readSetting, id, on); }

  async changeLevel(argument?: unknown): Promise<void> {
    const direct = trackingLevels.find((level) => level === argument);
    if (direct) { await this.applyLevel(direct); return; }
    const snapshot = readTracking();
    const picked = await vscode.window.showQuickPick(levelPickerRows(snapshot).map(toItem), {
      title: LEVEL_PICKER_TITLE, placeHolder: this.o.paused() ? `${LEVEL_PICKER_HINT} Tracking is paused; the level applies when you resume.` : LEVEL_PICKER_HINT,
      matchOnDescription: true, matchOnDetail: true });
    await this.run(picked?.action);
  }

  private async run(action?: PickerAction): Promise<void> {
    if (!action) return;
    if (action.type === "level") await this.applyLevel(action.level);
    else if (action.type === "advanced") await this.advanced();
    else if (action.type === "levels") await this.changeLevel();
    else if (action.type === "restore") await this.applyLevel(RECOMMENDED_LEVEL);
    else if (action.type === "settings") await vscode.commands.executeCommand("workbench.action.openSettings", "stackStats");
    else if (action.type === "toggle") await this.setCapability(action.id, !readTracking().capabilities[action.id], true);
    else void vscode.window.showInformationMessage("Coding activity is what Stack Stats is for, so it is on at every level. Use Pause Tracking to stop all collection.");
  }

  /** Only capability settings change. Undo restores their exact previous values,
   * including a Custom selection the level replaced. */
  async applyLevel(level: TrackingLevel): Promise<boolean> {
    const changes = planLevel(level, readSetting);
    if (!changes.length) { void vscode.window.showInformationMessage(`Tracking level is already ${modeLabel(level)}.`); return true; }
    const previous = changes.map((item) => ({ key: item.key, value: configuration().inspect(item.key)?.globalValue })).reverse();
    const saved = await this.write(changes);
    if (saved) {
      void vscode.window.showInformationMessage(levelChangedMessage(readTracking(), { paused: this.o.paused(), sync: this.o.syncSummary(), ...this.o.agents() }), "Undo")
        .then(async (choice) => { if (choice === "Undo" && await this.write(previous)) void vscode.window.showInformationMessage(`Tracking level restored: ${modeLabel(readTracking().mode)}.`); });
    }
    return saved;
  }

  async setCapability(id: CapabilityId, on: boolean, quietUnlessLinked = false): Promise<boolean> {
    if (!capability(id).setting) return false;
    const { changes, also } = this.plan(id, on);
    if (!changes.length) return true;
    const saved = await this.write(changes);
    if (saved && (!quietUnlessLinked || also.length)) void vscode.window.showInformationMessage(capabilityChangedMessage(id, on, also, readTracking().mode));
    return saved;
  }

  /** A native list that stays open: each selection toggles one capability and the
   * title shows the resulting level. Changes from other windows re-render it. */
  advanced(): Promise<void> {
    const pick = vscode.window.createQuickPick<Item>();
    pick.placeholder = "Select a capability to turn it on or off. Changes apply right away, only to this device.";
    pick.matchOnDetail = true;
    const render = (focus?: CapabilityId) => {
      const snapshot = readTracking();
      pick.title = `Advanced tracking · ${modeLabel(snapshot.mode)}`;
      pick.items = advancedPickerRows(snapshot).map(toItem);
      const active = pick.items.find((item) => item.action?.type === "toggle" && item.action.id === focus);
      if (active) pick.activeItems = [active];
    };
    render();
    let busy = false;
    const watcher = vscode.workspace.onDidChangeConfiguration((event) => { if (!busy && CAPABILITIES.some((item) => item.setting && event.affectsConfiguration(`stackStats.${item.setting}`))) render(); });
    return new Promise((resolve) => {
      let next: PickerAction | undefined;
      pick.onDidAccept(async () => {
        const action = pick.selectedItems[0]?.action;
        if (!action || busy) return;
        if (action.type !== "toggle") { next = action; pick.hide(); return; }
        busy = true; pick.busy = true;
        try { await this.run(action); } finally { busy = false; pick.busy = false; render(action.id); }
      });
      pick.onDidHide(() => {
        watcher.dispose(); pick.dispose();
        void this.run(next).catch(() => this.o.log("A tracking action could not complete; settings were left as they were.")).finally(resolve);
      });
      pick.show();
    });
  }
}

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StatsRow, SidebarState } from "../apps/vscode-extension/src/sidebar-model.js";
import { SessionSummaryCache } from "../apps/vscode-extension/src/stats-model.js";

const host = vi.hoisted(() => ({
  providers: new Map<string, { getChildren(row?: StatsRow): StatsRow[]; getTreeItem(row: StatsRow): any; refresh(): void }>(),
  visible: true, status: { show: vi.fn(), hide: vi.fn(), dispose: vi.fn(), text: "", command: "" },
  fire: vi.fn(), execute: vi.fn(), disposed: vi.fn()
}));
vi.mock("vscode", () => ({
  EventEmitter: class { event = vi.fn(); fire = host.fire; dispose = host.disposed; },
  TreeItem: class { constructor(public label: string, public collapsibleState: number) {} },
  ThemeIcon: class { constructor(public id: string) {} }, ThemeColor: class { constructor(public id: string) {} },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1 }, StatusBarAlignment: { Left: 1 },
  workspace: { getConfiguration: () => ({ get: () => host.visible }) },
  commands: { executeCommand: host.execute },
  window: {
    createStatusBarItem: () => host.status,
    createTreeView: (id: string, options: { treeDataProvider: any }) => {
      host.providers.set(id, options.treeDataProvider);
      return { dispose: host.disposed };
    }
  }
}));
import { StatsSidebar } from "../apps/vscode-extension/src/sidebar.js";

beforeEach(() => { vi.clearAllMocks(); host.providers.clear(); host.visible = true; });
describe("native VS Code sidebar adapter", () => {
  it("registers seven views, refreshes accessible rows, navigates commands, and disposes resources", async () => {
    const state: SidebarState = { summary: new SessionSummaryCache().summarize("2026-09-02"), enabled: true,
      ready: true, refreshing: false, historyError: false, storageError: false, idleMinutes: 5, syncConfigured: false };
    const ui = new StatsSidebar(state);
    expect(host.providers.size).toBe(7);
    const today = host.providers.get("stackStats.today")!;
    const time = today.getChildren().find(row => row.id.endsWith("/time"))!;
    expect(today.getTreeItem(time)).toMatchObject({ id: "today/time", label: "Active coding time", description: "0s", accessibilityInformation: { label: "Active coding time: 0s" } });
    ui.update({ ...state, enabled: false });
    expect(host.status.text).toContain("Paused");
    expect(host.fire).toHaveBeenCalledTimes(14);
    expect(host.status.command).toBe("stackStats.showCurrentSession");
    const tracking = host.providers.get("stackStats.trackingStatus")!;
    expect(tracking.getTreeItem(tracking.getChildren().find(row => row.id.endsWith("/toggle"))!).command.command).toBe("stackStats.resume");
    await ui.focus("thisWeek");
    expect(host.execute).toHaveBeenCalledWith("stackStats.thisWeek.focus");
    host.visible = false;
    ui.update(state);
    expect(host.status.hide).toHaveBeenCalledOnce();
    ui.dispose();
    expect(host.status.dispose).toHaveBeenCalledOnce();
    expect(host.disposed).toHaveBeenCalledTimes(14);
  });
});

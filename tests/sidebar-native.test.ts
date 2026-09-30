import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StatsRow, SidebarState } from "../apps/vscode-extension/src/sidebar-model.js";
import { SessionSummaryCache } from "../apps/vscode-extension/src/stats-model.js";
import { session } from "./fixtures.js";

const host = vi.hoisted(() => ({
  providers: new Map<string, { getChildren(row?: StatsRow): StatsRow[]; getParent(row: StatsRow): StatsRow | undefined; getTreeItem(row: StatsRow): any; refresh(): void }>(),
  views: new Map<string, { description?: string }>(),
  aliases: new Map<string, () => Promise<void>>(),
  visible: true, status: { show: vi.fn(), hide: vi.fn(), dispose: vi.fn(), text: "", command: "" },
  fire: vi.fn(), execute: vi.fn(), reveal: vi.fn(), disposed: vi.fn(), aliasDisposed: vi.fn()
}));
vi.mock("vscode", () => ({
  EventEmitter: class { event = vi.fn(); fire = host.fire; dispose = host.disposed; },
  TreeItem: class { constructor(public label: string, public collapsibleState: number) {} },
  ThemeIcon: class { constructor(public id: string) {} }, ThemeColor: class { constructor(public id: string) {} },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 }, StatusBarAlignment: { Left: 1 },
  workspace: { getConfiguration: () => ({ get: () => host.visible }) },
  commands: { executeCommand: host.execute, registerCommand: (id: string, callback: () => Promise<void>) => { host.aliases.set(id, callback); return { dispose: host.aliasDisposed }; } },
  window: {
    createStatusBarItem: () => host.status,
    createTreeView: (id: string, options: { treeDataProvider: any }) => {
      host.providers.set(id, options.treeDataProvider);
      const view = { dispose: host.disposed, reveal: host.reveal, description: undefined as string | undefined };
      host.views.set(id, view);
      return view;
    }
  }
}));
import { StatsSidebar } from "../apps/vscode-extension/src/sidebar.js";

beforeEach(() => { vi.clearAllMocks(); host.providers.clear(); host.views.clear(); host.aliases.clear(); host.visible = true; });
const state = (): SidebarState => ({ summary: new SessionSummaryCache().summarize("2026-09-02"), enabled: true,
  ready: true, refreshing: false, historyError: false, storageError: false, idleMinutes: 5, syncConfigured: false });
describe("native VS Code sidebar adapter", () => {
  it("registers the native panels, preserves old focus commands, and reveals the requested section", async () => {
    const ui = new StatsSidebar(state());
    expect([...host.providers.keys()]).toEqual(["stackStats.today", "stackStats.agents", "stackStats.trackingStatus"]);
    const activity = host.providers.get("stackStats.today")!;
    const today = activity.getChildren().find(row => row.id === "today/today")!;
    expect(activity.getTreeItem(today)).toMatchObject({ label: "Today", description: "0s", collapsibleState: 2 });
    expect(activity.getTreeItem(today).accessibilityInformation.label).toContain("Today: 0s");
    await ui.focus("thisWeek");
    expect(host.execute).toHaveBeenLastCalledWith("stackStats.today.focus");
    expect(host.reveal).toHaveBeenLastCalledWith(expect.objectContaining({ id: "today/thisWeek" }), { focus: true, select: true, expand: 1 });
    for (const section of ["currentSession", "thisWeek", "languages", "projects", "streak"]) {
      await host.aliases.get(`stackStats.${section}.focus`)!();
      expect(host.reveal).toHaveBeenLastCalledWith(expect.objectContaining({ id: `today/${section}` }), expect.objectContaining({ expand: 1 }));
    }
    expect(host.status.command).toBe("stackStats.showCurrentSession");
    ui.update({ ...state(), trackingMode: "custom" });
    expect(host.views.get("stackStats.today")!.description).toBe("Tracking · Custom");
    ui.update({ ...state(), enabled: false });
    expect(host.status.text).toContain("Paused");
    expect(host.views.get("stackStats.today")!.description).toBe("Paused");
    host.visible = false; ui.update(state()); expect(host.status.hide).toHaveBeenCalledOnce();
    ui.dispose(); expect(host.status.dispose).toHaveBeenCalledOnce(); expect(host.disposed).toHaveBeenCalledTimes(6); expect(host.aliasDisposed).toHaveBeenCalledTimes(5);
  });
  it("updates expanded descendants even when VS Code passes a stale parent object", () => {
    const view = state(); const snapshot = session("2026-09-02T12:00:00Z");
    view.summary = new SessionSummaryCache().summarize("2026-09-02", snapshot);
    const ui = new StatsSidebar(view); const activity = host.providers.get("stackStats.today")!;
    const oldToday = activity.getChildren().find(row => row.id === "today/today")!;
    expect(activity.getChildren(oldToday).find(row => row.id.endsWith("/changes"))?.description).toBe("+4 / −2");
    snapshot.revision++; snapshot.days[0]!.contributions[0]!.linesAdded = 9;
    ui.update({ ...view, summary: new SessionSummaryCache().summarize("2026-09-02", snapshot) });
    const changes = activity.getChildren(oldToday).find(row => row.id.endsWith("/changes"))!;
    expect(changes.description).toBe("+9 / −2");
    expect(activity.getParent(changes)?.id).toBe(oldToday.id);
    expect(activity.getChildren(oldToday).map(row => row.id)).toEqual(oldToday.children!.map(row => row.id));
    ui.dispose();
  });
});

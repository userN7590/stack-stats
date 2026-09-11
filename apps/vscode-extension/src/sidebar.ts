import * as vscode from "vscode";
import { rowsForView, sidebarViews, statusBarPresentation, type SidebarState, type SidebarView, type StatsRow } from "./sidebar-model.js";

class StatsProvider implements vscode.TreeDataProvider<StatsRow>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<StatsRow | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  constructor(private readonly view: SidebarView, private readonly state: () => SidebarState) {}
  refresh(): void { this.changed.fire(undefined); }
  getChildren(element?: StatsRow): StatsRow[] {
    // Full ancestor IDs keep expanded language/project rows stable across updates.
    return (element?.children ?? (element ? [] : rowsForView(this.view, this.state())))
      .map(row => ({ ...row, id: `${element?.id ?? this.view}/${row.id}` }));
  }
  getTreeItem(row: StatsRow): vscode.TreeItem {
    const item = new vscode.TreeItem(row.label, row.children?.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    item.id = row.id;
    item.description = row.description;
    item.tooltip = row.tooltip ?? `${row.label}${row.description ? `: ${row.description}` : ""}`;
    item.accessibilityInformation = { label: `${row.label}${row.description ? `: ${row.description}` : ""}` };
    if (row.icon) item.iconPath = new vscode.ThemeIcon(row.icon);
    if (row.command) item.command = { command: row.command, title: row.label };
    return item;
  }
  dispose(): void { this.changed.dispose(); }
}

/** Native views share one snapshot and no timers, filesystem access or reducers. */
export class StatsSidebar implements vscode.Disposable {
  private readonly entries = sidebarViews.map(id => {
    const provider = new StatsProvider(id, () => this.state);
    const view = vscode.window.createTreeView(`stackStats.${id}`, { treeDataProvider: provider, showCollapseAll: id === "languages" || id === "projects" });
    return { id, provider, view };
  });
  private readonly status = vscode.window.createStatusBarItem("stackStats.tracking", vscode.StatusBarAlignment.Left, 20);
  constructor(private state: SidebarState) {
    this.status.name = "Stack Stats Tracking";
    this.status.command = "stackStats.showCurrentSession";
    this.update(state);
  }
  update(state: SidebarState): void {
    this.state = state;
    for (const { id, provider, view } of this.entries) {
      view.description = id === "languages" || id === "projects" ? "This week" : id === "today" ? state.summary.today.date : id === "thisWeek" ? `Week of ${state.summary.week.from}` : undefined;
      view.message = state.storageError ? "Local storage needs attention. Recent activity may only be in memory." : undefined;
      provider.refresh();
    }
    const status = statusBarPresentation(state);
    this.status.text = status.text;
    this.status.tooltip = status.tooltip;
    this.status.backgroundColor = status.warning ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
    if (vscode.workspace.getConfiguration("stackStats").get("showStatusBar", true)) this.status.show();
    else this.status.hide();
  }
  async focus(view: SidebarView): Promise<void> {
    await vscode.commands.executeCommand(`stackStats.${view}.focus`);
  }
  dispose(): void {
    this.status.dispose();
    for (const { provider, view } of this.entries) { view.dispose(); provider.dispose(); }
  }
}

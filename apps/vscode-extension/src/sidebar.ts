import * as vscode from "vscode";
import { rowsForPanel, nativeSidebarViews, sidebarViews, statusBarPresentation, type SidebarState, type SidebarView, type NativeSidebarView, type StatsRow } from "./sidebar-model.js";

class StatsProvider implements vscode.TreeDataProvider<StatsRow>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<StatsRow | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private roots: StatsRow[] = [];
  private rows = new Map<string, StatsRow>();
  private parents = new Map<string, StatsRow>();
  constructor(private readonly view: NativeSidebarView, private readonly state: () => SidebarState) {}
  refresh(): void {
    this.rows.clear(); this.parents.clear();
    const identify = (input: StatsRow[], parent?: StatsRow): StatsRow[] => input.map(value => {
      const row = { ...value, id: `${parent?.id ?? this.view}/${value.id}` };
      this.rows.set(row.id, row);
      if (parent) this.parents.set(row.id, parent);
      if (value.children) row.children = identify(value.children, row);
      return row;
    });
    this.roots = identify(rowsForPanel(this.view, this.state()));
    this.changed.fire(undefined);
  }
  getChildren(element?: StatsRow): StatsRow[] {
    // VS Code can pass an older expanded element after a refresh. Resolve its
    // stable ID against the current snapshot so nested live counts stay fresh.
    return element ? this.rows.get(element.id)?.children ?? [] : this.roots;
  }
  getParent(element: StatsRow): StatsRow | undefined { return this.parents.get(element.id); }
  find(id: string): StatsRow | undefined { return this.rows.get(`${this.view}/${id}`); }
  getTreeItem(row: StatsRow): vscode.TreeItem {
    row = this.rows.get(row.id) ?? row;
    const item = new vscode.TreeItem(row.label, row.children?.length
      ? row.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None);
    item.id = row.id;
    item.description = row.description;
    item.tooltip = row.tooltip ?? `${row.label}${row.description ? `: ${row.description}` : ""}`;
    item.accessibilityInformation = { label: `${row.label}${row.description ? `: ${row.description}` : ""}${row.tooltip ? `. ${row.tooltip}` : ""}` };
    if (row.icon) item.iconPath = new vscode.ThemeIcon(row.icon);
    if (row.command) item.command = { command: row.command, title: row.label };
    return item;
  }
  dispose(): void { this.changed.dispose(); }
}

/** Native panels share one snapshot; no collection, I/O, timers or aggregation. */
export class StatsSidebar implements vscode.Disposable {
  private readonly entries = nativeSidebarViews.map(id => {
    const provider = new StatsProvider(id, () => this.state);
    const view = vscode.window.createTreeView(`stackStats.${id}`, { treeDataProvider: provider, showCollapseAll: false });
    return { id, provider, view };
  });
  private readonly aliases: vscode.Disposable[] = [];
  private readonly status = vscode.window.createStatusBarItem("stackStats.tracking", vscode.StatusBarAlignment.Left, 20);
  constructor(private state: SidebarState) {
    // Preserve old view-focus command IDs for keybindings and other callers.
    for (const id of sidebarViews) if (!(nativeSidebarViews as readonly string[]).includes(id)) {
      this.aliases.push(vscode.commands.registerCommand(`stackStats.${id}.focus`, () => this.focus(id)));
    }
    this.status.name = "Stack Stats Tracking";
    this.status.command = "stackStats.showCurrentSession";
    this.update(state);
  }
  update(state: SidebarState): void {
    this.state = state;
    for (const { id, provider, view } of this.entries) {
      view.description = id === "today" ? !state.enabled ? "Paused" : state.refreshing ? "Refreshing…" : "Tracking" : state.account?.status === "connected" ? `@${state.account.account?.username ?? "Connected"}` : state.account?.status === "connecting" ? "Connecting…" : state.account?.status === "error" || state.account?.status === "expired" ? "Needs attention" : "Optional";
      view.message = undefined;
      provider.refresh();
    }
    const status = statusBarPresentation(state);
    this.status.text = status.text;
    this.status.tooltip = status.tooltip;
    this.status.backgroundColor = status.warning ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
    if (vscode.workspace.getConfiguration("stackStats").get("showStatusBar", true)) this.status.show();
    else this.status.hide();
  }
  async focus(section: SidebarView): Promise<void> {
    const id = section === "trackingStatus" ? "trackingStatus" : "today";
    const entry = this.entries.find(item => item.id === id)!;
    await vscode.commands.executeCommand(`stackStats.${id}.focus`);
    const row = entry.provider.find(section === "trackingStatus" ? "profileSync" : section);
    if (row) await entry.view.reveal(row, { focus: true, select: true, expand: 1 });
  }
  dispose(): void {
    this.status.dispose();
    for (const alias of this.aliases) alias.dispose();
    for (const { provider, view } of this.entries) { view.dispose(); provider.dispose(); }
  }
}

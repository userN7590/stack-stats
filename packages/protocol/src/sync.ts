/** Daily sync v1. Dependency-free so the web repository can vendor this exact
 * contract until @stack-stats/protocol is published. Reject unknown fields. */
export interface SyncCounters { activeMs: number; editCount: number; linesAdded: number; linesRemoved: number }
export interface SyncBreakdown extends SyncCounters { id: string }
export interface SyncDay extends SyncCounters {
  schemaVersion: "1";
  aggregationVersion: 1;
  date: string;
  revision: number;
  sessionCount: number;
  fileCount: number;
  languages: SyncBreakdown[];
  projects: SyncBreakdown[];
}
export const SYNC_MAX_BYTES = 65_536;
export const SYNC_COUNTERS = ["activeMs", "editCount", "linesAdded", "linesRemoved"] as const;
export const SYNC_LANGUAGES = "other plaintext javascript javascriptreact typescript typescriptreact python java c cpp csharp go rust ruby php swift kotlin scala dart elixir erlang clojure haskell lua perl r julia matlab objective-c objective-cpp shellscript powershell bat html css scss less sass json jsonc yaml xml toml markdown mdx sql graphql dockerfile makefile cmake terraform hcl vue svelte astro groovy fsharp ocaml nim zig solidity proto diff git-commit git-rebase ignore ini properties csv latex tex bibtex assembly verilog vhdl vb razor handlebars pug coffeescript restructuredtext".split(" ");
export const syncInstallationPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export function validSyncDate(value: unknown): value is string {
  return typeof value === "string" && /^20\d\d-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
function object(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw new Error("Invalid sync payload");
}
function count(value: unknown, max = 1_000_000_000): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) throw new Error("Invalid sync counter");
}
export function parseSyncDay(input: unknown): SyncDay {
  object(input, ["schemaVersion", "aggregationVersion", "date", "revision", "sessionCount", "fileCount", "languages", "projects", ...SYNC_COUNTERS]);
  if (input.schemaVersion !== "1" || input.aggregationVersion !== 1 || !validSyncDate(input.date)) throw new Error("Unsupported sync schema or date");
  count(input.revision, 1_000_000_000_000); if (input.revision === 0) throw new Error("Invalid revision");
  for (const key of [...SYNC_COUNTERS, "sessionCount", "fileCount"] as const) count(input[key], key === "activeMs" ? 604_800_000 : 1_000_000_000);
  for (const key of ["languages", "projects"] as const) {
    const values = input[key];
    if (!Array.isArray(values) || values.length > 256) throw new Error("Invalid breakdown");
    let previous = "";
    const sums = { activeMs: 0, editCount: 0, linesAdded: 0, linesRemoved: 0 };
    for (const value of values) {
      object(value, ["id", ...SYNC_COUNTERS]);
      if (typeof value.id !== "string" || value.id <= previous || (key === "languages" ? !SYNC_LANGUAGES.includes(value.id) : !/^[a-f0-9]{64}$/.test(value.id))) throw new Error("Invalid breakdown identity/order");
      previous = value.id;
      for (const metric of SYNC_COUNTERS) { count(value[metric]); sums[metric] += value[metric]; }
    }
    if (SYNC_COUNTERS.some(metric => sums[metric] !== input[metric])) throw new Error("Breakdown totals disagree");
  }
  // Fixed property order is also the client's canonical content representation.
  return { schemaVersion: "1", aggregationVersion: 1, date: input.date, revision: input.revision,
    activeMs: input.activeMs as number, editCount: input.editCount as number, linesAdded: input.linesAdded as number, linesRemoved: input.linesRemoved as number,
    sessionCount: input.sessionCount as number, fileCount: input.fileCount as number,
    languages: (input.languages as SyncBreakdown[]).map(canonicalBreakdown), projects: (input.projects as SyncBreakdown[]).map(canonicalBreakdown) };
}
function canonicalBreakdown(value: SyncBreakdown): SyncBreakdown {
  return { id: value.id, activeMs: value.activeMs, editCount: value.editCount, linesAdded: value.linesAdded, linesRemoved: value.linesRemoved };
}

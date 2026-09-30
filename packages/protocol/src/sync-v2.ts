/** Daily aggregate v2. Dependency-free and separately vendorable from sync v1.
 * Session-local dates and the optional UTC-hour population must never be added. */
import { SYNC_COUNTERS, SYNC_LANGUAGES, validSyncDate, type SyncBreakdown, type SyncCounters } from "./sync.js";

export const SYNC_V2_MAX_BYTES = 65_536;
export const SYNC_V2_MAX_PROJECTS = 128;
export const SYNC_V2_MAX_LANGUAGES = 128;
/** Exclusive upper bounds; the final bucket is >= the last bound. Bucket 0 is exactly zero milliseconds. */
export const SYNC_V2_SESSION_DURATION_BOUNDS_MS = [1, 60_000, 300_000, 900_000, 1_800_000, 3_600_000, 7_200_000, 14_400_000] as const;
const MAX_COUNT = 1_000_000_000;
const MAX_DAY_ACTIVE_MS = 604_800_000;
const MAX_COHORT_ACTIVE_MS = 1_000_000_000_000;

export interface SyncSessionDurations extends SyncCounters {
  count: number;
  minActiveMs: number | null;
  maxActiveMs: number | null;
  histogram: number[];
}
export interface SyncHourlyUtc {
  source: "telemetry-v2";
  dateBasis: "UTC";
  activeMsByHour: number[];
  editCountByHour: number[];
  linesAddedByHour: number[];
  linesRemovedByHour: number[];
  coverage: {
    firstObservedDate: string;
    lastObservedDate: string;
    partial: true;
    frozen: boolean;
    /** Input was offered after compaction; it may have been a retry, not a new observation. */
    lateInputIgnored: boolean;
  };
}
export interface SyncDayV2 extends SyncCounters {
  schemaVersion: "2";
  aggregationVersion: 1;
  date: string;
  revision: number;
  sessionDays: number;
  sessionStarts: number;
  incompleteSessionStarts: number;
  fileCount: number;
  languageCount: number;
  projectCount: number;
  languages: SyncBreakdown[];
  projects: SyncBreakdown[];
  projectOverflow: SyncCounters & { projectCount: number };
  /** Finalized sessions owned by their original local start date, including all their days. */
  sessionDurations: SyncSessionDurations;
  /** Separate UTC-date population; null means unavailable, not zero. */
  hourlyUtc: SyncHourlyUtc | null;
  coverage: {
    source: "sessions-v1";
    dateBasis: "collector-local";
    firstObservedDate: string | null;
    lastObservedDate: string | null;
    uploadFromDate: string;
    historyCompleteness: "unknown";
    partial: true;
  };
}

function object(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length
    || keys.some(key => !Object.hasOwn(value, key))) throw new Error("Invalid sync v2 object");
}
function count(value: unknown, max = MAX_COUNT): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) throw new Error("Invalid sync v2 counter");
}
function counters(input: Record<string, unknown>, maxActiveMs = MAX_DAY_ACTIVE_MS): SyncCounters {
  for (const key of SYNC_COUNTERS) count(input[key], key === "activeMs" ? maxActiveMs : MAX_COUNT);
  return { activeMs: input.activeMs as number, editCount: input.editCount as number, linesAdded: input.linesAdded as number, linesRemoved: input.linesRemoved as number };
}
const empty = (): SyncCounters => ({ activeMs: 0, editCount: 0, linesAdded: 0, linesRemoved: 0 });
function sum(rows: readonly SyncCounters[]): SyncCounters {
  const total = empty();
  for (const row of rows) for (const key of SYNC_COUNTERS) total[key] += row[key];
  return total;
}
function sameCounters(a: SyncCounters, b: SyncCounters): boolean { return SYNC_COUNTERS.every(key => a[key] === b[key]); }

function breakdown(value: unknown, kind: "languages" | "projects"): SyncBreakdown[] {
  if (!Array.isArray(value) || value.length > (kind === "languages" ? SYNC_V2_MAX_LANGUAGES : SYNC_V2_MAX_PROJECTS)) throw new Error("Invalid sync v2 breakdown");
  let previous = "";
  return Array.from(value, row => {
    object(row, ["id", ...SYNC_COUNTERS]);
    if (typeof row.id !== "string" || row.id <= previous || (kind === "languages" ? !SYNC_LANGUAGES.includes(row.id) : !/^[a-f0-9]{64}$/.test(row.id))) {
      throw new Error("Invalid sync v2 breakdown identity/order");
    }
    previous = row.id;
    return { id: row.id, ...counters(row) };
  });
}

function sessionDurations(value: unknown): SyncSessionDurations {
  object(value, ["count", ...SYNC_COUNTERS, "minActiveMs", "maxActiveMs", "histogram"]);
  count(value.count);
  const totals = counters(value, MAX_COHORT_ACTIVE_MS);
  if (!Array.isArray(value.histogram) || value.histogram.length !== SYNC_V2_SESSION_DURATION_BOUNDS_MS.length + 1) throw new Error("Invalid session duration histogram");
  const histogram = Array.from(value.histogram, item => { count(item); return item; });
  if (histogram.reduce((a, b) => a + b, 0) !== value.count) throw new Error("Session histogram count disagrees");
  if (value.count === 0) {
    if (value.minActiveMs !== null || value.maxActiveMs !== null || !sameCounters(totals, empty())) throw new Error("Invalid empty session cohort");
    return { count: 0, ...totals, minActiveMs: null, maxActiveMs: null, histogram };
  }
  count(value.minActiveMs, MAX_COHORT_ACTIVE_MS); count(value.maxActiveMs, MAX_COHORT_ACTIVE_MS);
  if (value.minActiveMs > value.maxActiveMs || value.maxActiveMs > totals.activeMs
    || value.minActiveMs * (value.count - 1) + value.maxActiveMs > totals.activeMs
    || value.maxActiveMs * (value.count - 1) + value.minActiveMs < totals.activeMs) throw new Error("Session duration totals disagree");
  const bin = (ms: number) => { const index = SYNC_V2_SESSION_DURATION_BOUNDS_MS.findIndex(bound => ms < bound); return index === -1 ? histogram.length - 1 : index; };
  const first = histogram.findIndex(n => n > 0);
  let last = histogram.length - 1;
  while (histogram[last] === 0) last--;
  if (first !== bin(value.minActiveMs) || last !== bin(value.maxActiveMs)) throw new Error("Session duration bounds disagree");
  const minActiveMs = value.minActiveMs, maxActiveMs = value.maxActiveMs;
  const low = (i: number) => Math.max(i === 0 ? 0 : SYNC_V2_SESSION_DURATION_BOUNDS_MS[i - 1]!, minActiveMs);
  const high = (i: number) => Math.min(i === histogram.length - 1 ? maxActiveMs : SYNC_V2_SESSION_DURATION_BOUNDS_MS[i]! - 1, maxActiveMs);
  let minimum = 0, maximum = 0;
  histogram.forEach((n, i) => {
    if (!n) return;
    if (low(i) > high(i)) throw new Error("Session histogram has no feasible duration");
    minimum += n * low(i);
    maximum += n * high(i);
  });
  // Both extrema must be represented, not just lie within the occupied bins.
  // The existing cohort bound also rules out distinct extrema for count=1.
  minimum += maxActiveMs - low(last);
  maximum -= high(first) - minActiveMs;
  if (totals.activeMs < minimum || totals.activeMs > maximum) throw new Error("Session histogram duration disagrees");
  return { count: value.count, ...totals, minActiveMs: value.minActiveMs, maxActiveMs: value.maxActiveMs, histogram };
}

function hourly(value: unknown, date: string): SyncHourlyUtc | null {
  if (value === null) return null;
  object(value, ["source", "dateBasis", "activeMsByHour", "editCountByHour", "linesAddedByHour", "linesRemovedByHour", "coverage"]);
  if (value.source !== "telemetry-v2" || value.dateBasis !== "UTC") throw new Error("Invalid hourly population");
  const array = (key: string, max: number): number[] => {
    const input = value[key];
    if (!Array.isArray(input) || input.length !== 24) throw new Error("Invalid hourly bins");
    const result = Array.from(input, item => { count(item, max); return item; });
    count(result.reduce((a, b) => a + b, 0), max);
    return result;
  };
  object(value.coverage, ["firstObservedDate", "lastObservedDate", "partial", "frozen", "lateInputIgnored"]);
  const coverage = value.coverage;
  if (coverage.firstObservedDate !== date || coverage.lastObservedDate !== date || coverage.partial !== true
    || typeof coverage.frozen !== "boolean" || typeof coverage.lateInputIgnored !== "boolean"
    || (coverage.lateInputIgnored && !coverage.frozen)) throw new Error("Invalid hourly coverage");
  return { source: "telemetry-v2", dateBasis: "UTC", activeMsByHour: array("activeMsByHour", MAX_DAY_ACTIVE_MS),
    editCountByHour: array("editCountByHour", MAX_COUNT), linesAddedByHour: array("linesAddedByHour", MAX_COUNT), linesRemovedByHour: array("linesRemovedByHour", MAX_COUNT),
    coverage: { firstObservedDate: date, lastObservedDate: date, partial: true, frozen: coverage.frozen, lateInputIgnored: coverage.lateInputIgnored } };
}

/** Rejects unknown fields and noncanonical identities; returns a fixed property order. */
export function parseSyncDayV2(input: unknown): SyncDayV2 {
  const encoded = JSON.stringify(input);
  if (typeof encoded !== "string" || new TextEncoder().encode(encoded).byteLength > SYNC_V2_MAX_BYTES) throw new Error("Sync v2 payload exceeds size limit");
  object(input, ["schemaVersion", "aggregationVersion", "date", "revision", ...SYNC_COUNTERS, "sessionDays", "sessionStarts", "incompleteSessionStarts", "fileCount",
    "languageCount", "projectCount", "languages", "projects", "projectOverflow", "sessionDurations", "hourlyUtc", "coverage"]);
  if (input.schemaVersion !== "2" || input.aggregationVersion !== 1 || !validSyncDate(input.date)) throw new Error("Unsupported sync v2 schema or date");
  count(input.revision, 1_000_000_000_000); if (!input.revision) throw new Error("Invalid sync v2 revision");
  const total = counters(input);
  for (const key of ["sessionDays", "sessionStarts", "incompleteSessionStarts", "fileCount", "languageCount", "projectCount"]) count(input[key]);
  const languages = breakdown(input.languages, "languages"), projects = breakdown(input.projects, "projects");
  object(input.projectOverflow, ["projectCount", ...SYNC_COUNTERS]);
  count(input.projectOverflow.projectCount);
  const projectOverflow = { projectCount: input.projectOverflow.projectCount, ...counters(input.projectOverflow) };
  if (projectOverflow.projectCount === 0 && !sameCounters(projectOverflow, empty())) throw new Error("Invalid project overflow");
  if (projectOverflow.projectCount > 0 && projects.length !== SYNC_V2_MAX_PROJECTS) throw new Error("Project overflow requires a full identity page");
  if (input.languageCount !== languages.length || input.projectCount !== projects.length + projectOverflow.projectCount
    || !sameCounters(sum(languages), total) || !sameCounters(sum([...projects, projectOverflow]), total)) throw new Error("Sync v2 breakdown totals disagree");
  if ((input.fileCount as number) < (input.projectCount as number)) throw new Error("Distinct project count exceeds composite file count");
  if (input.sessionDays === 0 && (!sameCounters(total, empty()) || input.fileCount !== 0 || input.languageCount !== 0 || input.projectCount !== 0)) {
    throw new Error("Day without session contributions must have empty daily counters and dimensions");
  }
  if ((input.sessionDays as number) > 0 && (input.fileCount === 0 || input.languageCount === 0 || input.projectCount === 0)) throw new Error("Session day requires contribution identities");
  const durations = sessionDurations(input.sessionDurations);
  if (input.sessionStarts !== durations.count + (input.incompleteSessionStarts as number)) throw new Error("Session start cohort disagrees");
  object(input.coverage, ["source", "dateBasis", "firstObservedDate", "lastObservedDate", "uploadFromDate", "historyCompleteness", "partial"]);
  const coverage = input.coverage;
  if (coverage.source !== "sessions-v1" || coverage.dateBasis !== "collector-local" || coverage.historyCompleteness !== "unknown" || coverage.partial !== true
    || !validSyncDate(coverage.uploadFromDate) || coverage.uploadFromDate > input.date) throw new Error("Invalid session coverage");
  if (coverage.firstObservedDate === null || coverage.lastObservedDate === null) {
    if (coverage.firstObservedDate !== null || coverage.lastObservedDate !== null) throw new Error("Invalid session coverage dates");
  } else if (!validSyncDate(coverage.firstObservedDate) || !validSyncDate(coverage.lastObservedDate)
    || coverage.firstObservedDate > coverage.lastObservedDate || coverage.lastObservedDate > input.date) throw new Error("Invalid session coverage dates");
  if ((input.sessionDays as number) + (input.sessionStarts as number) > 0 && coverage.lastObservedDate !== input.date) throw new Error("Session coverage omits current observations");
  return { schemaVersion: "2", aggregationVersion: 1, date: input.date, revision: input.revision, ...total,
    sessionDays: input.sessionDays as number, sessionStarts: input.sessionStarts as number, incompleteSessionStarts: input.incompleteSessionStarts as number,
    fileCount: input.fileCount as number, languageCount: input.languageCount as number, projectCount: input.projectCount as number,
    languages, projects, projectOverflow, sessionDurations: durations, hourlyUtc: hourly(input.hourlyUtc, input.date),
    coverage: { source: "sessions-v1", dateBasis: "collector-local", firstObservedDate: coverage.firstObservedDate as string | null,
      lastObservedDate: coverage.lastObservedDate as string | null, uploadFromDate: coverage.uploadFromDate, historyCompleteness: "unknown", partial: true } };
}

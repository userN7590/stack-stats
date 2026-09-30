import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { mkdir, readdir, readFile, stat, unlink } from "node:fs/promises";
import { AGENT_INBOX_MAX_RECORD_BYTES, agentInboxRecordSchema, agentIntegrationStateSchema, type AgentInboxRecord, type AgentIntegrationState, type AgentTool } from "@stack-stats/protocol";
import { atomicWrite } from "./local-store.js";
import { exclusive } from "./exclusive.js";

/** Agent hook handoff. Lives beside the optional daemon config so hooks started by
 * terminal agents (outside VS Code) can reach it; STACK_STATS_HOME isolates it.
 * Nothing is created here unless an agent integration has been enabled. */
export const agentHome = (env: NodeJS.ProcessEnv = process.env) => env.STACK_STATS_HOME ?? join(homedir(), ".stackstats");
export const AGENT_INBOX_MAX_RECORDS = 5_000;
export const AGENT_INBOX_MAX_AGE_MS = 14 * 86_400_000;
export const HOOK_SCRIPT_NAME = "stack-stats-agent-hook-v1.cjs";
const RECORD_NAME = /^(\d{13})-([a-f0-9-]{36})\.json$/;

export const inboxPaths = (home: string) => {
  const directory = join(home, "agent-inbox-v1");
  return { directory, records: join(directory, "records"), state: join(directory, "state.json"), dropped: join(directory, "dropped"), hook: join(home, "hooks", HOOK_SCRIPT_NAME) };
};

/** Hook side (synchronous, dependency-light). Fails closed on missing/invalid state. */
export function readIntegrationState(home: string): AgentIntegrationState | undefined {
  try {
    const text = readFileSync(inboxPaths(home).state, "utf8");
    if (text.length > 64 * 1024) return undefined;
    const parsed = agentIntegrationStateSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch { return undefined; }
}

/** Atomic write of one metadata-only record; a full inbox counts a drop instead. */
export function writeInboxRecord(home: string, record: AgentInboxRecord): "written" | "full" {
  const paths = inboxPaths(home);
  mkdirSync(paths.records, { recursive: true, mode: 0o700 });
  if (readdirSync(paths.records).length >= AGENT_INBOX_MAX_RECORDS) {
    let dropped = 0;
    try { dropped = Number(readFileSync(paths.dropped, "utf8")) || 0; } catch { /* first drop */ }
    writeSmall(paths.dropped, String(dropped + 1));
    return "full";
  }
  const text = JSON.stringify(agentInboxRecordSchema.parse(record));
  if (Buffer.byteLength(text) > AGENT_INBOX_MAX_RECORD_BYTES) return "full";
  writeSmall(join(paths.records, `${String(Date.parse(record.observedAt)).padStart(13, "0")}-${record.recordId}.json`), text);
  return "written";
}
function writeSmall(path: string, text: string) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = openSync(temporary, "wx", 0o600);
  try { writeSync(handle, text); fsyncSync(handle); } finally { closeSync(handle); }
  try { renameSync(temporary, path); } catch (error) { try { unlinkSync(temporary); } catch { /* already gone */ } throw error; }
}

export interface DrainResult { claimed: number; unclaimed: number; invalid: number; expired: number; disabled: number; overflowDropped: number }

/** Extension side. One lease-holding window at a time reads records; the handler
 * must persist what it claims durably before returning, then claimed files are
 * deleted. Unclaimed records (another workspace) wait until they expire. */
export class AgentInbox {
  readonly paths: ReturnType<typeof inboxPaths>;
  constructor(readonly home: string, private readonly now: () => number = Date.now) { this.paths = inboxPaths(home); }

  async writeState(state: AgentIntegrationState): Promise<void> {
    await mkdir(this.paths.directory, { recursive: true, mode: 0o700 });
    await atomicWrite(this.paths.state, JSON.stringify(agentIntegrationStateSchema.parse(state)));
  }
  async exists(): Promise<boolean> { try { await stat(this.paths.directory); return true; } catch { return false; } }

  /** Copy the bundled hook to a version-stable path so vendor settings survive
   * extension upgrades. Rewritten only when the bundled content changes. */
  async installHook(bundled: string): Promise<string> {
    const [source, current] = await Promise.all([readFile(bundled), readFile(this.paths.hook).catch(() => undefined)]);
    if (!current || !current.equals(source)) {
      await mkdir(join(this.home, "hooks"), { recursive: true, mode: 0o700 });
      await atomicWrite(this.paths.hook, source.toString("utf8"));
    }
    return this.paths.hook;
  }

  async drain(handler: (records: AgentInboxRecord[]) => Promise<Set<string>>, enabled: ReadonlySet<AgentTool>, limit = 500): Promise<DrainResult> {
    const result: DrainResult = { claimed: 0, unclaimed: 0, invalid: 0, expired: 0, disabled: 0, overflowDropped: 0 };
    let names: string[];
    try { names = (await readdir(this.paths.records)).filter((name) => RECORD_NAME.test(name)).sort().slice(0, limit); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return result; throw error; }
    await exclusive(this.paths.directory, async (check) => {
      const valid: Array<{ name: string; record: AgentInboxRecord }> = [];
      for (const name of names) {
        const path = join(this.paths.records, name);
        let record: AgentInboxRecord | undefined;
        try {
          if ((await stat(path)).size > AGENT_INBOX_MAX_RECORD_BYTES) throw new Error("oversized");
          const parsed = agentInboxRecordSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
          if (parsed.success && name.endsWith(`-${parsed.data.recordId}.json`)) record = parsed.data;
        } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; }
        // Invalid, expired and disabled-tool records hold transient paths; delete
        // them rather than quarantining them.
        if (!record) { result.invalid++; check(); await unlink(path).catch(() => undefined); continue; }
        if (Date.parse(record.observedAt) < this.now() - AGENT_INBOX_MAX_AGE_MS) { result.expired++; check(); await unlink(path).catch(() => undefined); continue; }
        if (!enabled.has(record.tool)) { result.disabled++; check(); await unlink(path).catch(() => undefined); continue; }
        valid.push({ name, record });
      }
      if (valid.length) {
        const claimed = await handler(valid.map(({ record }) => record));
        for (const { name, record } of valid) {
          if (!claimed.has(record.recordId)) { result.unclaimed++; continue; }
          check(); await unlink(join(this.paths.records, name)).catch(() => undefined); result.claimed++;
        }
      }
      try {
        const dropped = Number(await readFile(this.paths.dropped, "utf8")) || 0;
        check(); await unlink(this.paths.dropped);
        result.overflowDropped = dropped;
      } catch { /* No overflow recorded. */ }
    });
    return result;
  }
}

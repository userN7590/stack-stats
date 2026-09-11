import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { stackStatsEventSchema, type SessionSnapshot } from "@stack-stats/protocol";

export function serializeSession(session: SessionSnapshot): string {
  return JSON.stringify({ storageVersion: 1, session: stackStatsEventSchema.parse(session) });
}

export function deserializeSession(text: string): SessionSnapshot {
  const envelope = JSON.parse(text) as { storageVersion?: unknown; session?: unknown };
  if (envelope?.storageVersion !== 1) throw new Error("Unsupported local storage version");
  const session = stackStatsEventSchema.parse(envelope.session);
  if (session.eventType !== "editor.session_snapshot") throw new Error("Expected a session snapshot");
  return session;
}

export async function atomicWrite(path: string, text: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(text, "utf8"); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => undefined); }
}

/** One compact file per session, never per keystroke. UUIDs give simultaneous
 * windows independent ownership. Acknowledgements are separate files so retrying
 * another window's snapshot cannot overwrite that window's newer revision.
 * Startup, window focus, explicit reports/refresh and manual retry enumerate this
 * metadata folder. Live sidebar updates use a separate disposable summary cache.
 */
export class LocalSessionStore {
  constructor(readonly directory: string, private readonly warn: (message: string) => void) {}

  async initialize(): Promise<void> { await mkdir(this.directory, { recursive: true, mode: 0o700 }); }

  async save(session: SessionSnapshot): Promise<void> {
    await atomicWrite(join(this.directory, `${session.sessionId}.json`), serializeSession(session));
  }

  async list(strict = false): Promise<SessionSnapshot[]> {
    const files = (await readdir(this.directory)).filter((name) => /^[\da-f-]{36}\.json$/.test(name));
    const sessions: SessionSnapshot[] = [];
    let incomplete = false;
    // Bound parallel reads even with years of local history.
    for (let i = 0; i < files.length; i += 16) {
      await Promise.all(files.slice(i, i + 16).map(async (file) => {
        try {
          const session = deserializeSession(await readFile(join(this.directory, file), "utf8"));
          if (file !== `${session.sessionId}.json`) throw new Error("Session filename mismatch");
          sessions.push(session);
        } catch { incomplete = true; this.warn(`A session file could not be read (${file}); preserved for recovery. Summary may be incomplete.`); }
      }));
    }
    if (strict && incomplete) throw new Error("Incomplete local history; sync deferred");
    return sessions;
  }

  async pending(): Promise<SessionSnapshot[]> {
    const sessions = await this.list();
    const pending: SessionSnapshot[] = [];
    for (const session of sessions) {
      let revision = 0;
      try { revision = Number(await readFile(join(this.directory, `${session.sessionId}.synced`), "utf8")); }
      catch { /* Missing acknowledgement means safe to resend. */ }
      if (!Number.isSafeInteger(revision) || revision < session.revision) pending.push(session);
    }
    return pending;
  }

  async acknowledge(session: SessionSnapshot): Promise<void> {
    await atomicWrite(join(this.directory, `${session.sessionId}.synced`), String(session.revision));
  }
}

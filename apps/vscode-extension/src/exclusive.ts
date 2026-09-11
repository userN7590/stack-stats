import { mkdir } from "node:fs/promises";
import lockfile from "proper-lockfile";
/** Cross-window lease with heartbeat and crash recovery. Callers must check the
 * lease before durable commits; a compromised lease must never continue writes. */
export async function exclusive<T>(directory: string, action: (check: () => void) => Promise<T>): Promise<T> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let compromised = false;
  const release = await lockfile.lock(directory, { realpath: false, stale: 120_000, update: 10_000,
    retries: { retries: 3, minTimeout: 100, maxTimeout: 500 }, onCompromised: () => { compromised = true; } });
  const check = () => { if (compromised) throw new Error("Local lock expired; retry safely"); };
  try { check(); return await action(check); } finally { await release().catch(() => undefined); }
}

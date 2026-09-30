import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { SYNC_LANGUAGES } from "@stack-stats/protocol";

const run = promisify(execFile);
const temporary: string[] = [];
const script = resolve("scripts/check-sync-contract.mts");
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "stack-stats-contract-check-"));
  temporary.push(directory);
  await Promise.all([
    mkdir(join(directory, "src/lib/stack-stats-protocol"), { recursive: true }),
    mkdir(join(directory, "supabase/migrations"), { recursive: true })
  ]);
  const source = await readFile(resolve("packages/protocol/src/sync.ts"), "utf8");
  await Promise.all([
    writeFile(join(directory, "src/lib/sync-contract.ts"), source),
    writeFile(join(directory, "supabase/migrations/20260910000000_profile_sync.sql"), `select string_to_array('${[...SYNC_LANGUAGES].reverse().join(" ")}',' ');`)
  ]);
  return { directory, source };
}

function check(directory: string, ...args: string[]) {
  return run(process.execPath, ["--import", "tsx", script, ...args, directory], { timeout: 10_000 });
}

describe("sync contract parity command", () => {
  it("keeps the existing v1 consumer valid without requiring a web v2 migration", async () => {
    const { directory } = await fixture();
    const result = await check(directory);
    expect(result.stdout).toContain("V1 extension, web and SQL language contracts agree");
    expect(result.stdout).toContain("V2 server support was not checked");
  });

  it("rejects a changed v1 source or SQL language allowlist", async () => {
    const { directory, source } = await fixture();
    await writeFile(join(directory, "src/lib/sync-contract.ts"), `${source}\n// unexpected drift\n`);
    await expect(check(directory)).rejects.toMatchObject({ stderr: expect.stringContaining("V1 sync contracts differ") });
    await writeFile(join(directory, "src/lib/sync-contract.ts"), source);
    await writeFile(join(directory, "supabase/migrations/20260910000000_profile_sync.sql"), "select string_to_array('other python',' ');");
    await expect(check(directory)).rejects.toMatchObject({ stderr: expect.stringContaining("SQL language allowlist differs") });
  });

  it("requires both exact v2 bundle files when the future consumer opts into that check", async () => {
    const { directory, source } = await fixture();
    await expect(check(directory, "--require-v2")).rejects.toThrow();
    const v2 = await readFile(resolve("packages/protocol/src/sync-v2.ts"), "utf8");
    await Promise.all([
      writeFile(join(directory, "src/lib/stack-stats-protocol/sync.ts"), source),
      writeFile(join(directory, "src/lib/stack-stats-protocol/sync-v2.ts"), v2)
    ]);
    expect((await check(directory, "--require-v2")).stdout).toContain("V2 module source parity passed");
    await writeFile(join(directory, "src/lib/stack-stats-protocol/sync-v2.ts"), `${v2}\n// drift\n`);
    await expect(check(directory, "--require-v2")).rejects.toMatchObject({ stderr: expect.stringContaining("V2 sync module bundle differs") });
  });

  it("rejects unknown flags and duplicate mode flags", async () => {
    const { directory } = await fixture();
    await expect(check(directory, "--unknown")).rejects.toMatchObject({ stderr: expect.stringContaining("Usage:") });
    await expect(check(directory, "--require-v2", "--require-v2")).rejects.toMatchObject({ stderr: expect.stringContaining("Usage:") });
  });
});

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { PrivacyPolicy } from "@stack-stats/core";
import { GitObserver, parseNumstat } from "../apps/vscode-extension/src/git-observer.js";
import { TelemetryBuffer } from "../apps/vscode-extension/src/telemetry-buffer.js";
import { hash } from "./telemetry-fixtures.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("bounded Git metadata collection", () => {
  it("parses null-delimited binary/unusual paths and applies exclusions before totals", () => {
    expect(parseNumstat("3\t2\tsrc/a\tfile.ts\0-\t-\timage.png\0" + "5\t0\t.env\0", (path) => path !== ".env")).toEqual({ filesChanged: 2, linesAdded: 3, linesRemoved: 2, binaryFiles: 1 });
  });

  it("observes real commits and branch changes without messages, identities, source or remote URLs", async () => {
    const root = await mkdtemp(join(tmpdir(), "stack-git-")); directories.push(root);
    const git = async (...args: string[]) => (await promisify(execFile)("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-C", root, ...args], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } })).stdout;
    await git("init", "-b", "private-branch-name");
    await git("config", "user.email", "private@example.test"); await git("config", "user.name", "Private Author");
    await writeFile(join(root, "code.ts"), "initial\n"); await git("add", "."); await git("commit", "-m", "private initial message");
    const buffer = new TelemetryBuffer("test"), observer = new GitObserver(buffer, hash);
    await observer.poll([root], new PrivacyPolicy(), Date.now());
    expect(buffer.drain().map((event) => event.eventType)).toEqual(["git.repository"]);
    await writeFile(join(root, "code.ts"), "initial\nnew line\n"); await writeFile(join(root, ".env"), "SECRET=should_not_count\n");
    await git("add", "."); await git("commit", "-m", "private second message");
    await observer.poll([root], new PrivacyPolicy(), Date.now() + 60_001);
    const events = buffer.drain();
    const commit = events.find((event) => event.eventType === "git.commit_observed");
    expect(commit?.data).toMatchObject({ filesChanged: 1, linesAdded: 1, linesRemoved: 0 });
    const serialized = JSON.stringify(events);
    for (const secret of ["private", "SECRET", "new line", "code.ts", "@example", root]) expect(serialized).not.toContain(secret);
    await git("checkout", "-b", "other-private-branch");
    await observer.poll([root], new PrivacyPolicy(), Date.now() + 120_002);
    expect(buffer.drain().map((event) => event.eventType)).toEqual(["git.head_changed"]);
  });

  it("cancels late observations when policy changes or tracking stops", async () => {
    let finish!: (value: string) => void;
    const buffer = new TelemetryBuffer("test");
    const observer = new GitObserver(buffer, hash, async (_root, args) => {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return new Promise<string>((resolve) => { finish = resolve; });
      return args[0] === "symbolic-ref" ? "refs/heads/main" : "a".repeat(40);
    });
    const running = observer.poll(["/work"], new PrivacyPolicy(), Date.now());
    observer.reset(); finish("/work"); await running;
    expect(buffer.drain()).toEqual([]);
  });
});

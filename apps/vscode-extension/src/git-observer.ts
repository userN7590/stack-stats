import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import type { PrivacyPolicy } from "@stack-stats/core";
import type { TelemetryBuffer } from "./telemetry-buffer.js";

export type GitRunner = (root: string, args: string[]) => Promise<string>;
export const runGit: GitRunner = async (root, args) => {
  const result = await promisify(execFile)("git", ["--no-pager", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-C", root, ...args], {
    timeout: 2500, maxBuffer: 2 * 1024 * 1024, encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" }
  });
  return result.stdout;
};

/** Git's -z numstat format exposes paths transiently for exclusions, never source
 * contents. Rename detection is disabled so each row has one unambiguous path. */
export function parseNumstat(value: string, allowed: (path: string) => boolean) {
  let filesChanged = 0, linesAdded = 0, linesRemoved = 0, binaryFiles = 0;
  for (const row of value.split("\0")) {
    if (!row) continue;
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(row);
    if (!match || !allowed(match[3]!)) continue;
    filesChanged++;
    if (match[1] === "-" || match[2] === "-") binaryFiles++;
    else { linesAdded += Number(match[1]); linesRemoved += Number(match[2]); }
  }
  return { filesChanged, linesAdded, linesRemoved, binaryFiles };
}

export class GitObserver {
  private readonly states = new Map<string, { head: string | null; branch: string | null }>();
  private busy = false;
  private nextPoll = 0;
  private cursor = 0;
  private generation = 0;
  constructor(private readonly buffer: TelemetryBuffer, private readonly hash: (value: string) => string, private readonly git: GitRunner = runGit) {}

  reset(): void { this.states.clear(); this.nextPoll = 0; this.generation++; }

  async poll(roots: readonly string[], policy: PrivacyPolicy, now = Date.now()): Promise<void> {
    if (this.busy || now < this.nextPoll) return;
    this.busy = true; this.nextPoll = now + 60_000;
    const generation = this.generation;
    try {
      // Round robin prevents large multi-root workspaces from starving later roots.
      for (let i = 0; i < Math.min(4, roots.length); i++) {
        const root = roots[this.cursor++ % roots.length]!;
        if (!policy.allowsProject(root)) continue;
        if (generation !== this.generation) return;
        try { await this.observe(root, policy, now, generation); }
        catch { if (generation === this.generation) this.buffer.emit("collector.coverage", { capability: "git", state: "gap", reason: "unavailable" }, {}, now, "git"); }
      }
    } finally { this.busy = false; }
  }

  private async observe(workspace: string, policy: PrivacyPolicy, now: number, generation: number): Promise<void> {
    const deadline = Date.now() + 5000;
    let root: string;
    try { root = (await this.git(workspace, ["rev-parse", "--show-toplevel"])).trim(); }
    catch { return; } // A non-repository workspace is normal, not an error.
    if (!policy.allowsProject(root)) return;
    const headText = await this.git(root, ["rev-parse", "--verify", "HEAD"]).catch(() => "");
    const head = /^[a-f0-9]{40,64}$/.test(headText.trim()) ? headText.trim() : null;
    const branch = (await this.git(root, ["symbolic-ref", "--quiet", "HEAD"]).catch(() => "")).trim() || null;
    if (generation !== this.generation) return;
    const repositoryId = this.hash(root);
    const context = { projectId: this.hash(workspace) };
    const previous = this.states.get(workspace);
    const data = { repositoryId, headId: head ? this.hash(head) : null, branchId: branch ? this.hash(branch) : null };
    if (!previous) this.buffer.emit("git.repository", data, context, now, "git");
    else if (previous.head !== head || previous.branch !== branch) {
      this.buffer.emit("git.head_changed", { ...data, previousHeadId: previous.head ? this.hash(previous.head) : null,
        previousBranchId: previous.branch ? this.hash(previous.branch) : null }, context, now, "git");
      // Only inspect new reachable commits on the same branch. A checkout/reset
      // is not a commit, nor is a newly observed commit necessarily user-authored.
      if (head && previous.head !== head && previous.branch === branch) {
        const advances = previous.head ? await this.git(root, ["merge-base", "--is-ancestor", previous.head, head]).then(() => true).catch(() => false) : true;
        if (advances) {
          const commits = (await this.git(root, ["rev-list", "--max-count=21", previous.head ? `${previous.head}..${head}` : head])).trim().split("\n").filter((id) => /^[a-f0-9]{40,64}$/.test(id));
          if (generation !== this.generation) return;
          if (commits.length > 20) this.buffer.emit("collector.coverage", { capability: "git", state: "gap", reason: "history_limit" }, context, now, "git");
          for (const commit of commits.slice(0, 20).reverse()) {
            if (Date.now() > deadline) { this.buffer.emit("collector.coverage", { capability: "git", state: "gap", reason: "history_limit" }, context, Date.now(), "git"); break; }
            const info = (await this.git(root, ["show", "-s", "--format=%cI%x00%P", commit])).trim().split("\0");
            const revisions = info[1] ? [`${commit}^`, commit] : [commit];
            const stats = await this.git(root, ["diff-tree", "--root", "--no-commit-id", "--numstat", "-z", "-r",
              "--no-renames", "--no-ext-diff", "--no-textconv", ...revisions, "--", workspace]);
            if (generation !== this.generation) return;
            const counts = parseNumstat(stats, (path) => policy.allows(workspace, join(root, path)));
            if (!counts.filesChanged) continue;
            this.buffer.emit("git.commit_observed", { repositoryId, commitId: this.hash(commit),
              committedAt: new Date(info[0]!).toISOString(), parentCount: info[1]?.split(" ").filter(Boolean).length ?? 0, ...counts }, context, now, "git");
          }
        }
      }
    }
    this.states.set(workspace, { head, branch });
  }
}

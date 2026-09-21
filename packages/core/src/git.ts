import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitFileChange {
  status: string;
  path: string;
}

export interface GitCommitInfo {
  hash: string;
  short: string;
  subject: string;
  author: string;
  date: string;
}

export interface GitStatus {
  isRepo: boolean;
  root: string | null;
  branch: string | null;
  detached: boolean;
  dirty: boolean;
  changes: GitFileChange[];
  ahead: number;
  behind: number;
  lastCommit: GitCommitInfo | null;
  remote: string | null;
}

export async function git(cwd: string, args: string[], options: { timeoutMs?: number; maxBuffer?: number } = {}): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: options.timeoutMs ?? 30_000,
    maxBuffer: options.maxBuffer ?? 20 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout;
}

async function tryGit(cwd: string, args: string[]): Promise<string | null> {
  try {
    return await git(cwd, args);
  } catch {
    return null;
  }
}

export async function isRepo(cwd: string): Promise<boolean> {
  if (!existsSync(cwd)) return false;
  const out = await tryGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  return out?.trim() === "true";
}

export async function status(cwd: string): Promise<GitStatus> {
  const empty: GitStatus = { isRepo: false, root: null, branch: null, detached: false, dirty: false, changes: [], ahead: 0, behind: 0, lastCommit: null, remote: null };
  if (!(await isRepo(cwd))) return empty;
  const root = (await tryGit(cwd, ["rev-parse", "--show-toplevel"]))?.trim() ?? null;
  const porcelain = (await tryGit(cwd, ["status", "--porcelain=v1", "--branch"])) ?? "";
  const lines = porcelain.split(/\r?\n/).filter((l) => l.length > 0);
  let branch: string | null = null;
  let detached = false;
  let ahead = 0;
  let behind = 0;
  const changes: GitFileChange[] = [];
  for (const line of lines) {
    if (line.startsWith("## ")) {
      const head = line.slice(3);
      if (head.startsWith("No commits yet on ")) branch = head.slice("No commits yet on ".length).split(/\s/)[0] ?? null;
      else if (head.startsWith("HEAD (no branch)")) detached = true;
      else branch = head.split("...")[0]?.split(" ")[0] ?? null;
      const aheadMatch = /ahead (\d+)/.exec(head);
      const behindMatch = /behind (\d+)/.exec(head);
      if (aheadMatch) ahead = Number(aheadMatch[1]);
      if (behindMatch) behind = Number(behindMatch[1]);
      continue;
    }
    changes.push({ status: line.slice(0, 2).trim() || "??", path: line.slice(3).trim() });
  }
  const remote = (await tryGit(cwd, ["remote", "get-url", "origin"]))?.trim() || null;
  const log = await tryGit(cwd, ["log", "-1", "--format=%H%x1f%h%x1f%s%x1f%an%x1f%cI"]);
  let lastCommit: GitCommitInfo | null = null;
  if (log && log.trim()) {
    const [hash = "", short = "", subject = "", author = "", date = ""] = log.trim().split("\x1f");
    lastCommit = { hash, short, subject, author, date };
  }
  return { isRepo: true, root, branch, detached, dirty: changes.length > 0, changes, ahead, behind, lastCommit, remote };
}

export interface FileSnapshot {
  status: string;
  mtimeMs: number;
  size: number;
}

/** Dirty files with their mtime/size, so a later comparison can tell "still dirty" from "changed again". */
export async function snapshot(cwd: string): Promise<{ isRepo: boolean; changes: GitFileChange[]; files: Map<string, FileSnapshot> }> {
  const current = await status(cwd);
  const files = new Map<string, FileSnapshot>();
  for (const change of current.changes) {
    const full = join(cwd, change.path);
    try {
      const stat = statSync(full);
      files.set(change.path, { status: change.status, mtimeMs: stat.mtimeMs, size: stat.size });
    } catch {
      files.set(change.path, { status: change.status, mtimeMs: 0, size: -1 });
    }
  }
  return { isRepo: current.isRepo, changes: current.changes, files };
}

/** Files that are new, newly dirty, or dirty-and-modified since the snapshot. */
export async function changedFilesSince(cwd: string, before: Map<string, FileSnapshot>): Promise<string[]> {
  const after = await snapshot(cwd);
  const changed: string[] = [];
  for (const [path, now] of after.files) {
    const prev = before.get(path);
    if (!prev || prev.status !== now.status || prev.mtimeMs !== now.mtimeMs || prev.size !== now.size) changed.push(path);
  }
  for (const path of before.keys()) if (!after.files.has(path)) changed.push(path);
  return changed.sort();
}

export async function diff(cwd: string, options: { staged?: boolean; stat?: boolean; paths?: string[] } = {}): Promise<string> {
  const args = ["diff"];
  if (options.staged) args.push("--cached");
  if (options.stat) args.push("--stat");
  if (options.paths?.length) args.push("--", ...options.paths);
  return (await tryGit(cwd, args)) ?? "";
}

export async function log(cwd: string, limit = 20): Promise<GitCommitInfo[]> {
  const out = await tryGit(cwd, ["log", `-${limit}`, "--format=%H%x1f%h%x1f%s%x1f%an%x1f%cI"]);
  if (!out) return [];
  return out
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((line) => {
      const [hash = "", short = "", subject = "", author = "", date = ""] = line.split("\x1f");
      return { hash, short, subject, author, date };
    });
}

export async function branches(cwd: string): Promise<{ current: string | null; all: string[] }> {
  const out = (await tryGit(cwd, ["branch", "--format=%(refname:short)%09%(HEAD)"])) ?? "";
  let current: string | null = null;
  const all: string[] = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [name = "", head = ""] = line.split("\t");
    all.push(name);
    if (head.trim() === "*") current = name;
  }
  return { current, all };
}

export async function createBranch(cwd: string, name: string, checkout = true): Promise<void> {
  if (!/^[A-Za-z0-9._/-]+$/.test(name)) throw new Error(`Invalid branch name "${name}"`);
  await git(cwd, checkout ? ["checkout", "-b", name] : ["branch", name]);
}

export async function checkout(cwd: string, ref: string): Promise<void> {
  await git(cwd, ["checkout", ref]);
}

export async function commit(cwd: string, message: string, options: { all?: boolean; paths?: string[] } = {}): Promise<GitCommitInfo> {
  if (!message.trim()) throw new Error("Commit message is empty");
  if (options.paths?.length) await git(cwd, ["add", "--", ...options.paths]);
  else if (options.all) await git(cwd, ["add", "-A"]);
  await git(cwd, ["commit", "-m", message]);
  const [head] = await log(cwd, 1);
  if (!head) throw new Error("Commit did not produce a HEAD");
  return head;
}

/**
 * Push the current branch. A branch with no upstream is pushed to `origin` and
 * set to track it, which is what a person means the first time they push.
 */
export async function push(cwd: string): Promise<{ branch: string; remote: string; output: string }> {
  const branch = (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  if (branch === "HEAD") throw new Error("HEAD is detached; check out a branch before pushing");
  const upstream = await tryGit(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  const remote = upstream ? upstream.trim().split("/")[0]! : "origin";
  const args = upstream ? ["push"] : ["push", "-u", remote, branch];
  const output = await git(cwd, args, { timeoutMs: 120_000 });
  return { branch, remote, output: output.trim() };
}

export async function worktreeAdd(cwd: string, path: string, branch: string): Promise<void> {
  await git(cwd, ["worktree", "add", "-b", branch, path]);
}

export async function worktreeRemove(cwd: string, path: string, force = false): Promise<void> {
  await git(cwd, force ? ["worktree", "remove", "--force", path] : ["worktree", "remove", path]);
}

export async function worktrees(cwd: string): Promise<{ path: string; branch: string | null; head: string | null }[]> {
  const out = (await tryGit(cwd, ["worktree", "list", "--porcelain"])) ?? "";
  const result: { path: string; branch: string | null; head: string | null }[] = [];
  let current: { path: string; branch: string | null; head: string | null } | null = null;
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice(9), branch: null, head: null };
      result.push(current);
    } else if (current && line.startsWith("HEAD ")) current.head = line.slice(5);
    else if (current && line.startsWith("branch ")) current.branch = line.slice(7).replace("refs/heads/", "");
  }
  return result;
}

export async function init(cwd: string): Promise<void> {
  await git(cwd, ["init", "-q"]);
}

export function gitDirExists(cwd: string): boolean {
  return existsSync(join(cwd, ".git"));
}

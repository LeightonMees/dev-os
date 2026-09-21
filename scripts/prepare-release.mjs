#!/usr/bin/env node
// Build a publishable copy of DEV in a new directory, with a fresh single-commit
// history and everything private left behind.
//
// This never touches the working repository. It copies out, so the thing you
// publish is a tree you can read in full before anyone else sees it.
//
//   node scripts/prepare-release.mjs --out ../DEV-public                  first release: fresh history
//   node scripts/prepare-release.mjs --out ../DEV-public -m "fix: ..."    later: commit on top of it
//   node scripts/prepare-release.mjs --out ../DEV-public --force          throw the copy away and start over
//
// When --out already holds a git repository, the tree is synchronised into it
// and committed as the next commit, so the public history grows normally and
// the remote you added stays put. Afterwards, read the tree, then push.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");

/**
 * Paths that must never reach a public repository. Two kinds live here: private
 * content (the project catalogue, machine-specific agent instructions), and
 * local state that would be noise or a leak (caches, keys, build output).
 */
const EXCLUDE = new Set([
  // --- private content ---
  "docs/ecosystem", // the maintainer's private project catalogue
  "scripts/ecosystem", // scanners that embed machine paths
  "CLAUDE.md", // machine-specific agent instructions and disk layout
  "AGENTS.md", // same, for a different agent
  ".mcp.json", // absolute paths to local MCP servers
  ".claude",
  ".codex",
  ".dev",
  // --- local state and secrets ---
  ".env",
  ".dev-home",
  ".playwright-mcp",
  // --- build output and dependencies ---
  "node_modules",
  "dist",
  "target",
  ".git",
]);

/** Files that must exist in the release, or publishing is premature. */
const REQUIRED = [
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md",
  ".env.example",
  ".gitignore",
  ".github/workflows/ci.yml",
  "package.json",
];

/** Anything matching these in the copied tree is a release blocker. */
const FORBIDDEN_CONTENT = [
  { label: "an OpenAI-style secret key", re: /\bsk-[A-Za-z0-9_-]{16,}/ },
  { label: "a GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { label: "an AWS access key id", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: "a private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: "the author's home directory", re: /C:\\Users\\user\b/ },
  // The maintainer's projects disk. A default that points here works on one
  // machine in the world and fails silently everywhere else.
  { label: "a hard-coded G:\\Desktop path", re: /G:\\\\?Desktop|G:\/Desktop/ },
  // A bare mention of OneDrive is fine (DEV refuses to create projects in one).
  // A OneDrive *path* belongs to whoever built the release.
  { label: "a personal OneDrive path", re: /OneDrive - |[A-Za-z]:\\[^\n"']*OneDrive/ },
];

/** Extensions worth scanning as text. Everything else is treated as opaque. */
const TEXT = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".md", ".yml", ".yaml", ".css", ".html", ".toml", ".rs", ".cmd", ".sh", ".example"]);

function parseArgs(argv) {
  const out = { force: false, message: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--out") out.out = argv[i + 1];
    if (argv[i] === "--force") out.force = true;
    if (argv[i] === "-m" || argv[i] === "--message") out.message = argv[i + 1] ?? null;
  }
  return out;
}

function walk(dir, base, hit) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = relative(base, full).split(sep).join("/");
    if (entry.isDirectory()) walk(full, base, hit);
    else hit(full, rel);
  }
}

const args = parseArgs(process.argv.slice(2));
if (!args.out) {
  console.error("Usage: node scripts/prepare-release.mjs --out <directory> [--force]");
  process.exit(2);
}

const OUT = resolve(args.out);
if (OUT === ROOT) {
  console.error("Refusing to write the release into the working repository.");
  process.exit(2);
}
// Update mode: the copy is already a repository (with, presumably, the public
// remote attached). Empty it of everything but .git and lay the fresh tree down,
// so deletions in the source become deletions in the release too.
const updating = existsSync(join(OUT, ".git")) && !args.force;
if (existsSync(OUT) && !updating) {
  if (!args.force) {
    console.error(`${OUT} already exists and is not a git repository. Pass --force to replace it.`);
    process.exit(2);
  }
  rmSync(OUT, { recursive: true, force: true });
}
if (updating) {
  for (const entry of readdirSync(OUT)) {
    if (entry === ".git") continue;
    rmSync(join(OUT, entry), { recursive: true, force: true });
  }
}

// ----- copy, minus everything excluded -----
mkdirSync(OUT, { recursive: true });
let copied = 0;
for (const entry of readdirSync(ROOT, { withFileTypes: true })) {
  if (EXCLUDE.has(entry.name)) continue;
  const from = join(ROOT, entry.name);
  const to = join(OUT, entry.name);
  cpSync(from, to, {
    recursive: true,
    filter: (src) => {
      const rel = relative(ROOT, src).split(sep).join("/");
      if (rel === "") return true;
      if (EXCLUDE.has(rel) || EXCLUDE.has(basename(src)) || basename(src).endsWith(".dev-home")) return false;
      // Nested build output and local state, wherever it appears.
      // Any DEV home, including one with a mangled name, is local state.
      if (/(^|\/)(node_modules|dist|target|[^/]*\.dev-home)(\/|$)/.test(rel)) return false;
      if (/(^|\/)\.env(\.|$)/.test(rel) && !rel.endsWith(".env.example")) return false;
      if (statSync(src).isFile()) copied += 1;
      return true;
    },
  });
}

// ----- verify what came out -----
const problems = [];
for (const required of REQUIRED) {
  if (!existsSync(join(OUT, required))) problems.push(`missing required file: ${required}`);
}
for (const gone of ["docs/ecosystem", "CLAUDE.md", "AGENTS.md", ".mcp.json", ".env", ".dev-home"]) {
  if (existsSync(join(OUT, gone))) problems.push(`private path was copied: ${gone}`);
}

let scanned = 0;
walk(OUT, OUT, (full, rel) => {
  const dot = rel.lastIndexOf(".");
  const ext = dot === -1 ? "" : rel.slice(dot);
  if (!TEXT.has(ext)) return;
  if (rel === "scripts/prepare-release.mjs") return; // this file names the patterns it hunts
  let text;
  try {
    text = readFileSync(full, "utf8");
  } catch {
    return;
  }
  scanned += 1;
  for (const { label, re } of FORBIDDEN_CONTENT) {
    if (re.test(text)) problems.push(`${rel} contains ${label}`);
  }
});

if (problems.length > 0) {
  console.error(`\nRelease blocked. ${problems.length} problem(s):\n`);
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error("\nNothing was published. Fix these, then run again with --force.\n");
  process.exit(1);
}

const git = (...a) => execFileSync("git", a, { cwd: OUT, stdio: "pipe" }).toString().trim();
if (updating) {
  // ----- next commit on the existing public history -----
  git("add", "-A");
  const staged = git("status", "--porcelain");
  if (staged === "") {
    console.log(`\nRelease tree at ${OUT} already matches the source; nothing to commit.`);
    process.exit(0);
  }
  const message = args.message ?? `Release ${new Date().toISOString().slice(0, 10)}`;
  execFileSync("git", ["commit", "-q", "-m", message], { cwd: OUT, stdio: "pipe" });
  const changed = staged.split("\n").length;
  console.log(`\nRelease tree updated at ${OUT}`);
  console.log(`  ${copied} files synced, ${scanned} text files scanned, ${changed} path(s) changed, committed as "${message}".`);
  console.log("\nNothing private was found. Review, then push:");
  console.log(`  cd ${OUT} && git show --stat HEAD && git push\n`);
} else {
  // ----- fresh history: one commit, nothing recoverable behind it -----
  git("init", "-q", "-b", "main");
  git("add", "-A");
  execFileSync("git", ["commit", "-q", "-m", "DEV: initial public release\n\nA local development operating system: one core, a control plane, a CLI and a desktop app."], { cwd: OUT, stdio: "pipe" });
  const count = git("rev-list", "--count", "HEAD");
  console.log(`\nRelease tree ready at ${OUT}`);
  console.log(`  ${copied} files copied, ${scanned} text files scanned, ${count} commit in history.`);
  console.log("\nNothing private was found. Read the tree yourself before publishing:");
  console.log(`  cd ${OUT} && git ls-files | less\n`);
}

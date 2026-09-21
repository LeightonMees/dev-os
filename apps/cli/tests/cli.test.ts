import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const nodeExe = process.execPath.includes(" ") ? `"${process.execPath}"` : process.execPath;

import { parseArgs, flagList, flagString } from "../src/args.ts";

const BIN = resolve(import.meta.dirname, "..", "bin", "dev.mjs");

function tempRoot(): string {
  const preferred = process.platform === "win32" && existsSync("F:\\tmp") ? "F:\\tmp\\dev-tests" : tmpdir();
  mkdirSync(preferred, { recursive: true });
  return mkdtempSync(join(preferred, "cli-"));
}

function dev(home: string, args: string[], options: { cwd?: string; expectFail?: boolean } = {}): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [BIN, ...args, "--home", home], { encoding: "utf8", cwd: options.cwd ?? home, env: { ...process.env, NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (error) {
    const e = error as { status: number; stdout: string; stderr: string };
    if (!options.expectFail) throw new Error(`dev ${args.join(" ")} failed (${e.status}): ${e.stderr}${e.stdout}`);
    return { code: e.status, out: `${e.stdout}${e.stderr}` };
  }
}

test("argument parser handles flags, values, repeats and booleans", () => {
  const parsed = parseArgs(["task", "add", "hello world", "--verify", "npm test", "--verify=npm run lint", "--json", "--depends", "a,b", "--", "--literal"]);
  assert.deepEqual(parsed.positionals, ["task", "add", "hello world", "--literal"]);
  assert.equal(parsed.flags.json, true);
  assert.deepEqual(flagList(parsed.flags, "verify"), ["npm test", "npm run lint"]);
  assert.deepEqual(flagList(parsed.flags, "depends"), ["a", "b"]);
  assert.equal(flagString(parsed.flags, "missing"), undefined);
});

test("help, version and unknown commands behave", () => {
  const home = tempRoot();
  try {
    assert.match(dev(home, ["--help"]).out, /dev <command>/);
    assert.match(dev(home, ["task", "--help"]).out, /dev task <command>/);
    assert.match(dev(home, ["version"]).out, /^dev \d+\.\d+\.\d+/);
    const unknown = dev(home, ["nonsense"], { expectFail: true });
    assert.equal(unknown.code, 1);
    assert.match(unknown.out, /Unknown command/);
    const unknownJson = dev(home, ["nonsense", "--json"], { expectFail: true });
    assert.match(unknownJson.out, /"error"/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("project → task → run → show works through the CLI with --json and shared state", () => {
  const home = tempRoot();
  const repo = tempRoot();
  try {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    writeFileSync(join(repo, "README.md"), "# t\n");

    assert.match(dev(home, ["project", "list"]).out, /No projects yet/);
    const added = JSON.parse(dev(home, ["project", "add", repo, "--name", "cli-proj", "--json"]).out) as { id: string; name: string };
    assert.equal(added.name, "cli-proj");
    const listed = JSON.parse(dev(home, ["project", "list", "--json"]).out) as { id: string }[];
    assert.equal(listed[0]?.id, added.id);

    const node = process.execPath.includes(" ") ? `"${process.execPath}"` : process.execPath;
    const task = JSON.parse(dev(home, ["task", "add", "make file", "--project", added.id, "--command", `${node} -e "require('fs').writeFileSync('x.txt','1')"`, "--verify-file", "x.txt", "--json"]).out) as { id: string; status: string };
    assert.equal(task.status, "READY");

    const run = JSON.parse(dev(home, ["task", "run", task.id, "--project", added.id, "--json"]).out) as { task: { status: string }; execution: { changedFiles: string[] } };
    assert.equal(run.task.status, "DONE");
    assert.deepEqual(run.execution.changedFiles, ["x.txt"]);

    const shown = JSON.parse(dev(home, ["task", "show", task.id, "--project", added.id, "--json"]).out) as { evidence: { passed: boolean }[]; artifacts: unknown[] };
    assert.ok(shown.evidence.every((e) => e.passed));
    assert.ok(shown.artifacts.length >= 1);

    const fromCwd = dev(home, ["task", "list"], { cwd: repo }).out;
    assert.match(fromCwd, /make file/, "project inferred from cwd");

    const status = JSON.parse(dev(home, ["status", "--json"]).out) as { counts: { DONE: number } };
    assert.equal(status.counts.DONE, 1);

    const bad = dev(home, ["task", "move", task.id, "flying", "--project", added.id], { expectFail: true });
    assert.equal(bad.code, 1);
    const events = JSON.parse(dev(home, ["events", "--project", added.id, "--json"]).out) as { type: string }[];
    assert.ok(events.some((e) => e.type === "TASK_COMPLETED"));
    assert.match(dev(home, ["task", "context", task.id, "--project", added.id]).out, /Context preview/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("artifacts are listable project-wide and inspectable by id", () => {
  const home = tempRoot();
  const repo = tempRoot();
  try {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    writeFileSync(join(repo, "README.md"), "# t\n");
    const project = JSON.parse(dev(home, ["project", "add", repo, "--name", "arts", "--json"]).out) as { id: string };
    const task = JSON.parse(dev(home, ["task", "add", "say hi", "--project", project.id, "--command", `${nodeExe} -e "console.log('hi')"`, "--json"]).out) as { id: string };
    dev(home, ["task", "run", task.id, "--project", project.id]);

    const listed = JSON.parse(dev(home, ["artifacts", "--project", project.id, "--json"]).out) as { id: string; kind: string; taskId: string }[];
    assert.ok(listed.some((a) => a.kind === "log"), "a run always leaves a log artifact");
    assert.ok(listed.every((a) => a.taskId === task.id));

    const logs = JSON.parse(dev(home, ["artifacts", "--project", project.id, "--kind", "log", "--json"]).out) as { kind: string }[];
    assert.ok(logs.length >= 1 && logs.every((a) => a.kind === "log"), "--kind filters");

    const shown = dev(home, ["artifacts", "show", listed[0]!.id]).out;
    assert.match(shown, /path/);
    assert.match(shown, new RegExp(listed[0]!.id));

    const human = dev(home, ["artifacts", "--project", project.id]).out;
    assert.match(human, /KIND/);
    assert.match(human, /say hi/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

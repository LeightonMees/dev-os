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

test("flows drawn in the app can be listed, inspected and run headless from the CLI", () => {
  const home = tempRoot();
  const repo = tempRoot();
  try {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    writeFileSync(join(repo, "README.md"), "# t\n");
    const project = JSON.parse(dev(home, ["project", "add", repo, "--name", "flowy", "--json"]).out) as { id: string };
    assert.match(dev(home, ["flow", "list", "--project", project.id]).out, /No flows/);

    // Flows are authored in the app; seed one the way the control plane would store it.
    const flowId = execFileSync(process.execPath, [resolve("apps/cli/tests/seed-flow.mjs"), home, project.id, `${nodeExe} -e "console.log('hello from a flow')"`], { encoding: "utf8" }).trim();

    const listed = JSON.parse(dev(home, ["flow", "list", "--project", project.id, "--json"]).out) as { id: string; name: string }[];
    assert.equal(listed[0]?.id, flowId);
    assert.match(dev(home, ["flow", "show", "greet", "--project", project.id]).out, /say\s+shell/);

    const run = dev(home, ["flow", "run", flowId, "--project", project.id]);
    assert.match(run.out, /say\s+passed/);
    assert.match(run.out, /greet passed \(1 steps\)/);
    const runs = JSON.parse(dev(home, ["flow", "runs", flowId, "--json"]).out) as { status: string; steps: { output: string }[] }[];
    assert.equal(runs[0]?.status, "PASSED");
    assert.match(runs[0]?.steps[0]?.output ?? "", /hello from a flow/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a flow exports to portable JSON and imports back into another project", () => {
  const home = tempRoot();
  const repo = tempRoot();
  const other = tempRoot();
  try {
    for (const dir of [repo, other]) {
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
      writeFileSync(join(dir, "README.md"), "# t\n");
    }
    const a = JSON.parse(dev(home, ["project", "add", repo, "--name", "source", "--json"]).out) as { id: string };
    const b = JSON.parse(dev(home, ["project", "add", other, "--name", "target", "--json"]).out) as { id: string };
    const flowId = execFileSync(process.execPath, [resolve("apps/cli/tests/seed-flow.mjs"), home, a.id, `${nodeExe} -e "console.log('portable')"`], { encoding: "utf8" }).trim();

    const exported = dev(home, ["flow", "export", flowId]).out;
    const file = JSON.parse(exported) as { name: string; nodes: unknown[]; edges: unknown[]; id?: string; projectId?: string };
    assert.equal(file.name, "greet");
    assert.equal(file.nodes.length, 1);
    assert.equal(file.id, undefined, "no ids in the file");
    assert.equal(file.projectId, undefined, "no project in the file: it belongs wherever it is imported");
    const path = join(home, "greet.flow.json");
    writeFileSync(path, exported);

    const imported = JSON.parse(dev(home, ["flow", "import", path, "--project", b.id, "--name", "greet-copy", "--json"]).out) as { id: string; name: string; projectId: string; problems: unknown[] };
    assert.equal(imported.name, "greet-copy");
    assert.equal(imported.projectId, b.id);
    assert.deepEqual(imported.problems, []);
    assert.notEqual(imported.id, flowId);
    assert.match(dev(home, ["flow", "run", imported.id, "--project", b.id]).out, /greet-copy passed/);

    // A file that is not a flow is refused with the reason, not stored.
    writeFileSync(join(home, "junk.json"), JSON.stringify({ hello: 1 }));
    assert.throws(() => dev(home, ["flow", "import", join(home, "junk.json"), "--project", b.id]), /does not contain a flow/);
  } finally {
    for (const dir of [home, repo, other]) rmSync(dir, { recursive: true, force: true });
  }
});

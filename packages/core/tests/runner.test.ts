import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { autoRun, formatTimeout, runTask, timeoutFor } from "../src/index.ts";
import { nodeExe, openTestDev, tempRepo, tempRoot } from "./helpers.ts";

test("a shell task runs, captures changed files, passes verification, records evidence and reaches DONE", async () => {
  const { dev, cleanup } = openTestDev();
  const repo = tempRepo();
  try {
    const project = dev.projects.add({ path: repo.path, name: "runner" });
    const task = dev.tasks.create({
      projectId: project.id,
      title: "write greeting",
      command: `${nodeExe} -e "require('fs').writeFileSync('greeting.txt','hello from DEV'); console.log('wrote greeting')"`,
      verification: [{ kind: "file-exists", path: "greeting.txt" }, { kind: "command", command: `${nodeExe} -e "process.exit(require('fs').readFileSync('greeting.txt','utf8').includes('hello')?0:1)"`, label: "content check" }],
      status: "READY",
    });
    const seen: string[] = [];
    dev.events.on((e) => seen.push(e.type));

    const execution = await runTask(dev, task.id);
    assert.equal(execution.status, "succeeded");
    assert.equal(execution.exitCode, 0);
    assert.deepEqual(execution.changedFiles, ["greeting.txt"]);
    assert.ok(execution.logPath && existsSync(execution.logPath), "log artifact written");
    assert.ok(readFileSync(execution.logPath, "utf8").includes("# worker finished"));

    const after = dev.tasks.get(task.id);
    assert.equal(after?.status, "DONE");
    assert.ok(after?.resultSummary?.includes("Changed 1 file(s): greeting.txt"));

    const evidence = dev.evidence.list(task.id);
    assert.deepEqual(evidence.map((e) => [e.kind, e.passed]), [["command-exit", true], ["file-exists", true], ["verification", true]]);
    const artifacts = dev.artifacts.list({ taskId: task.id }).map((a) => a.kind).sort();
    assert.ok(artifacts.includes("log"));
    assert.ok(artifacts.includes("report"));

    for (const type of ["WORKER_SELECTED", "TASK_STARTED", "COMMAND_STARTED", "COMMAND_OUTPUT", "COMMAND_FINISHED", "FILE_CHANGED", "VERIFICATION_STARTED", "VERIFICATION_PASSED", "EVIDENCE_RECORDED", "TASK_COMPLETED"]) {
      assert.ok(seen.includes(type), `expected event ${type}`);
    }
    assert.ok(!dev.events.list({ taskId: task.id }).some((e) => e.type === "COMMAND_OUTPUT"), "raw output is transient, never stored as events");
  } finally {
    cleanup();
    repo.cleanup();
  }
});

test("a failing command becomes structured BLOCKED state with a next action", async () => {
  const { dev, cleanup } = openTestDev();
  const repo = tempRepo();
  try {
    const project = dev.projects.add({ path: repo.path, name: "fail" });
    const task = dev.tasks.create({ projectId: project.id, title: "explode", command: `${nodeExe} -e "console.error('kaboom'); process.exit(3)"`, status: "READY" });
    const execution = await runTask(dev, task.id);
    assert.equal(execution.status, "failed");
    assert.equal(execution.exitCode, 3);
    const after = dev.tasks.get(task.id);
    assert.equal(after?.status, "BLOCKED");
    assert.equal(after?.failure?.kind, "process-failed");
    assert.match(after?.failure?.reason ?? "", /code 3: kaboom/);
    assert.match(after?.failure?.nextAction ?? "", /dev task retry/);
    assert.equal(after?.failure?.executionId, execution.id);
    assert.equal(dev.evidence.list(task.id)[0]?.passed, false);
  } finally {
    cleanup();
    repo.cleanup();
  }
});

test("verification failure blocks the task even when the worker succeeded", async () => {
  const { dev, cleanup } = openTestDev();
  const repo = tempRepo();
  try {
    const project = dev.projects.add({ path: repo.path, name: "verify" });
    const task = dev.tasks.create({ projectId: project.id, title: "ok worker, bad tests", command: `${nodeExe} -e "console.log('fine')"`, verification: [{ kind: "command", command: `${nodeExe} -e "process.exit(1)"`, label: "tests" }], status: "READY" });
    const execution = await runTask(dev, task.id);
    assert.equal(execution.status, "failed");
    const after = dev.tasks.get(task.id);
    assert.equal(after?.status, "BLOCKED");
    assert.equal(after?.failure?.kind, "verification-failed");
    assert.ok(dev.events.list({ taskId: task.id }).some((e) => e.type === "VERIFICATION_FAILED"));
  } finally {
    cleanup();
    repo.cleanup();
  }
});

test("timeouts and cancellation are structured too", async () => {
  const { dev, cleanup } = openTestDev();
  const repo = tempRepo();
  try {
    const project = dev.projects.add({ path: repo.path, name: "slow" });
    const slow = dev.tasks.create({ projectId: project.id, title: "sleep", command: `${nodeExe} -e "setTimeout(()=>{}, 30000)"`, status: "READY" });
    const timedOut = await runTask(dev, slow.id, { timeoutMs: 1500 });
    assert.equal(timedOut.status, "timeout");
    const failure = dev.tasks.get(slow.id)?.failure;
    assert.equal(failure?.kind, "timeout");
    assert.match(failure?.reason ?? "", /second/);
    assert.match(failure?.nextAction ?? "", /longer cap/i);
    assert.equal(failure?.data?.timeoutMs, 1500);

    dev.tasks.retry(slow.id);
    const running = runTask(dev, slow.id);
    await new Promise((r) => setTimeout(r, 800));
    const live = dev.executions.list({ taskId: slow.id, status: "running" })[0];
    assert.ok(live, "execution is visible as running while it runs");
    assert.ok(dev.executions.requestCancel(live.id));
    const cancelled = await running;
    assert.equal(cancelled.status, "cancelled");
    // Cancelling a run stops the work and returns the task to the queue; it is not discarded.
    assert.equal(dev.tasks.get(slow.id)?.status, "READY");
  } finally {
    cleanup();
    repo.cleanup();
  }
});

test("review-required projects park verified tasks in REVIEW until approved", async () => {
  const { dev, cleanup } = openTestDev();
  const repo = tempRepo();
  try {
    const project = dev.projects.add({ path: repo.path, name: "review", config: { reviewRequired: true } });
    const task = dev.tasks.create({ projectId: project.id, title: "needs eyes", command: `${nodeExe} -e "console.log('ok')"`, status: "READY" });
    await runTask(dev, task.id);
    assert.equal(dev.tasks.get(task.id)?.status, "REVIEW");
    dev.evidence.record({ taskId: task.id, kind: "human-approval", passed: true, summary: "looks right" });
    assert.equal(dev.tasks.setStatus(task.id, "DONE").status, "DONE");
  } finally {
    cleanup();
    repo.cleanup();
  }
});

test("auto-run executes a dependency chain in order and hands results downstream", async () => {
  const { dev, cleanup } = openTestDev();
  const repo = tempRepo();
  try {
    const project = dev.projects.add({ path: repo.path, name: "chain" });
    const a = dev.tasks.create({ projectId: project.id, title: "A", command: `${nodeExe} -e "require('fs').writeFileSync('a.txt','A')"`, status: "READY" });
    const b = dev.tasks.create({ projectId: project.id, title: "B", command: `${nodeExe} -e "require('fs').appendFileSync('a.txt','B')"`, dependsOn: [a.id] });
    const c = dev.tasks.create({ projectId: project.id, title: "C", command: `${nodeExe} -e "process.exit(require('fs').readFileSync('a.txt','utf8')==='AB'?0:1)"`, dependsOn: [b.id] });
    const report = await autoRun(dev, { projectId: project.id });
    assert.deepEqual(report.ran.map((r) => [r.title, r.status]), [["A", "DONE"], ["B", "DONE"], ["C", "DONE"]]);
    assert.equal(report.stoppedBecause, "no-runnable-tasks");
    assert.equal(dev.tasks.get(c.id)?.status, "DONE");
  } finally {
    cleanup();
    repo.cleanup();
  }
});

test("autopilot promotes a backlog task with satisfied deps and runs it", async () => {
  const { dev, cleanup } = openTestDev();
  const repo = tempRepo();
  try {
    const project = dev.projects.add({ path: repo.path, name: "auto-promote" });
    const task = dev.tasks.create({
      projectId: project.id,
      title: "from backlog",
      command: `${nodeExe} -e "require('fs').writeFileSync('promoted.txt','ok')"`,
      status: "BACKLOG",
    });
    const types: string[] = [];
    const off = dev.events.on((e) => types.push(e.type));
    const report = await autoRun(dev, { projectId: project.id, promoteBacklog: true, maxTasks: 1 });
    off();
    assert.equal(report.ran.length, 1);
    assert.equal(report.ran[0]?.status, "DONE");
    assert.equal(report.stoppedBecause, "max-tasks");
    assert.equal(dev.tasks.get(task.id)?.status, "DONE");
    assert.ok(types.includes("AUTO_RUN_STARTED"));
    assert.ok(types.includes("AUTO_RUN_FINISHED"));
  } finally {
    cleanup();
    repo.cleanup();
  }
});

test("autopilot skips needsHuman and unmet deps, and says so when nothing can start", async () => {
  const { dev, cleanup } = openTestDev();
  const repo = tempRepo();
  try {
    const project = dev.projects.add({ path: repo.path, name: "auto-skip" });
    const blocker = dev.tasks.create({ projectId: project.id, title: "blocker", status: "BACKLOG", needsHuman: "decide the approach" });
    const waiting = dev.tasks.create({ projectId: project.id, title: "waiting", status: "BACKLOG", dependsOn: [blocker.id] });
    const human = dev.tasks.create({ projectId: project.id, title: "ask first", status: "BACKLOG", needsHuman: "pick a colour" });
    const free = dev.tasks.create({
      projectId: project.id,
      title: "free",
      command: `${nodeExe} -e "require('fs').writeFileSync('free.txt','ok')"`,
      status: "BACKLOG",
    });
    const report = await autoRun(dev, { projectId: project.id, promoteBacklog: true, maxTasks: 1 });
    assert.equal(report.ran[0]?.title, "free");
    assert.equal(dev.tasks.get(free.id)?.status, "DONE");
    assert.equal(dev.tasks.get(human.id)?.status, "BACKLOG");
    assert.equal(dev.tasks.get(waiting.id)?.status, "BACKLOG");

    const empty = await autoRun(dev, { projectId: project.id, promoteBacklog: true });
    assert.equal(empty.ran.length, 0);
    assert.equal(empty.stoppedBecause, "no-runnable-tasks");
    assert.match(empty.detail ?? "", /no Backlog task/i);
  } finally {
    cleanup();
    repo.cleanup();
  }
});

test("autopilot sees a promotable task past the default list cap of 500", async () => {
  const { dev, cleanup } = openTestDev();
  const repo = tempRepo();
  try {
    const project = dev.projects.add({ path: repo.path, name: "auto-cap" });
    const stuck = dev.tasks.create({ projectId: project.id, title: "stuck-0", status: "BACKLOG", needsHuman: "wait" });
    for (let i = 1; i < 501; i++) {
      dev.tasks.create({ projectId: project.id, title: `stuck-${i}`, status: "BACKLOG", needsHuman: "wait", dependsOn: [stuck.id] });
    }
    const free = dev.tasks.create({
      projectId: project.id,
      title: "the one",
      command: `${nodeExe} -e "require('fs').writeFileSync('cap.txt','ok')"`,
      status: "BACKLOG",
    });
    assert.ok((dev.tasks.list({ projectId: project.id, status: "BACKLOG" }).length ?? 0) <= 500);
    const report = await autoRun(dev, { projectId: project.id, promoteBacklog: true, maxTasks: 1 });
    assert.equal(report.ran[0]?.title, "the one");
    assert.equal(dev.tasks.get(free.id)?.status, "DONE");
  } finally {
    cleanup();
    repo.cleanup();
  }
});

test("agent timeout is 2 hours, shell is 30 minutes, and a timeout retry doubles", () => {
  const shell = { timeoutMs: 30 * 60 * 1000, agentTimeoutMs: 2 * 60 * 60 * 1000 };
  assert.equal(timeoutFor("shell", shell), 30 * 60 * 1000);
  assert.equal(timeoutFor("cli-agent", shell), 2 * 60 * 60 * 1000);
  assert.equal(timeoutFor("cli-agent", shell, { kind: "timeout", reason: "", nextAction: "", at: "", data: { timeoutMs: 2 * 60 * 60 * 1000 } }), 4 * 60 * 60 * 1000);
  assert.equal(formatTimeout(30 * 60 * 1000), "30 minutes");
  assert.equal(formatTimeout(2 * 60 * 60 * 1000), "2 hours");
});

test("an execution abandoned by a control-plane restart is reaped and its task leaves WORKING with a reason", async () => {
  const { dev, cleanup } = openTestDev();
  const repo = tempRepo();
  try {
    const project = dev.projects.add({ path: repo.path, name: "abandoned" });
    const task = dev.tasks.create({ projectId: project.id, title: "long job", status: "READY" });
    // What a run in flight looks like when the process hosting it disappears.
    const execution = dev.executions.create({ taskId: task.id, projectId: project.id, workerId: "claude-code", cwd: repo.path });
    dev.tasks.setStatus(task.id, "WORKING", { reason: "worker claude-code" });

    const reaped = dev.executions.reapStale(0);
    assert.equal(reaped.length, 1, "the orphaned execution is reaped");
    assert.equal(reaped[0]?.executionId, execution.id);
    assert.equal(reaped[0]?.taskId, task.id);
    assert.equal(dev.executions.get(execution.id)?.status, "failed");

    // The control plane blocks each reaped task; without this the task is stuck in WORKING forever.
    for (const { executionId, taskId } of reaped) {
      const live = dev.tasks.get(taskId);
      if (live?.status === "WORKING") dev.tasks.block(taskId, { kind: "abandoned", reason: "The run was cut off because the control plane restarted while it was working.", nextAction: "Read the log, check the repository, then run it again.", executionId });
    }

    const after = dev.tasks.get(task.id);
    assert.equal(after?.status, "BLOCKED", "an abandoned task does not stay WORKING");
    assert.equal(after?.failure?.kind, "abandoned");
    assert.match(after?.failure?.reason ?? "", /control plane restarted/);
    assert.ok(after?.failure?.nextAction, "the user is told what to do next");
    assert.equal(dev.executions.reapStale(0).length, 0, "reaping twice changes nothing");
  } finally {
    cleanup();
    repo.cleanup();
  }
});

test("a worker refused permission to run commands fails the task instead of looking successful", async () => {
  const { wasPermissionBlocked } = await import("../src/execution/runner.ts");
  // The wording Claude Code actually uses when a non-interactive session cannot get approval.
  assert.ok(wasPermissionBlocked("Test execution is blocked by permission rules. Let me check what's allowed."));
  assert.ok(wasPermissionBlocked("I can't execute tests or servers in this session (permission-blocked, non-interactive)."));
  assert.ok(wasPermissionBlocked("The command wasn't run — it requires approval and the permission prompt was declined"));
  // Ordinary summaries, including ones that merely mention permissions, are not treated as blocked.
  assert.equal(wasPermissionBlocked("Added a permissions table to the docs and ran the tests."), false);
  assert.equal(wasPermissionBlocked("All 12 tests pass."), false);
  assert.equal(wasPermissionBlocked(""), false);
});

test("worktree isolation runs the task on its own branch and leaves the checkout untouched", async () => {
  const { dev, cleanup } = openTestDev();
  const repo = tempRepo();
  try {
    const project = dev.projects.add({ path: repo.path, name: "isolated" });
    // Project-scoped setting, the way a real project would opt in.
    mkdirSync(join(repo.path, ".dev"), { recursive: true });
    writeFileSync(join(repo.path, ".dev", "config.json"), JSON.stringify({ git: { isolation: "worktree" } }));
    const task = dev.tasks.create({
      projectId: project.id,
      title: "write a note in isolation",
      command: `${nodeExe} -e "require('fs').writeFileSync('note.txt','from the worktree')"`,
      verification: [{ kind: "file-exists", path: "note.txt" }],
      status: "READY",
    });
    const seen: string[] = [];
    dev.events.on((e) => seen.push(e.type));

    const execution = await runTask(dev, task.id);
    assert.equal(execution.status, "succeeded");
    assert.deepEqual(execution.changedFiles, ["note.txt"]);
    assert.equal(dev.tasks.get(task.id)?.status, "DONE");

    // The user's checkout never saw the file; the branch did.
    assert.ok(!existsSync(join(repo.path, "note.txt")), "checkout is untouched");
    const onBranch = execFileSync("git", ["show", `dev/${task.id}:note.txt`], { cwd: repo.path }).toString();
    assert.equal(onBranch, "from the worktree");
    const mainLog = execFileSync("git", ["log", "--oneline", "main"], { cwd: repo.path }).toString().trim().split("\n");
    assert.equal(mainLog.length, 1, "main has only the initial commit");

    // The worktree directory itself is cleaned up; the branch is the record.
    assert.ok(!existsSync(execution.cwd), `worktree removed: ${execution.cwd}`);
    assert.notEqual(execution.cwd, repo.path, "the execution records where it actually ran");
    assert.ok(seen.includes("WORKTREE_CREATED") && seen.includes("WORKTREE_COMMITTED"), seen.join(","));
    assert.match(dev.tasks.get(task.id)?.resultSummary ?? "", /branch dev\//);
  } finally {
    repo.cleanup();
    cleanup();
  }
});

test("worktree isolation on a plain directory falls back to running in place, and says so", async () => {
  const { dev, cleanup } = openTestDev();
  const dir = tempRoot();
  try {
    const project = dev.projects.add({ path: dir, name: "plain" });
    mkdirSync(join(dir, ".dev"), { recursive: true });
    writeFileSync(join(dir, ".dev", "config.json"), JSON.stringify({ git: { isolation: "worktree" } }));
    const task = dev.tasks.create({ projectId: project.id, title: "plain run", command: `${nodeExe} -e "console.log('ok')"`, status: "READY" });
    const execution = await runTask(dev, task.id);
    assert.equal(execution.status, "succeeded");
    assert.equal(execution.cwd, dir);
    assert.match(readFileSync(execution.logPath as string, "utf8"), /not a git repository; running in place/);
  } finally {
    cleanup();
  }
});

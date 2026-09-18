import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { autoRun, runTask } from "../src/index.ts";
import { nodeExe, openTestDev, tempRepo } from "./helpers.ts";

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
    assert.equal(dev.tasks.get(slow.id)?.failure?.kind, "timeout");

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

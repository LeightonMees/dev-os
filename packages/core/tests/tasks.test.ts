import assert from "node:assert/strict";
import { test } from "node:test";

import { TRANSITIONS, canTransition, TASK_STATUSES } from "../src/index.ts";
import { openTestDev } from "./helpers.ts";

test("every status has a transition row and DONE is only reachable with evidence", () => {
  for (const status of TASK_STATUSES) assert.ok(Array.isArray(TRANSITIONS[status]));
  assert.ok(canTransition("READY", "WORKING"));
  assert.ok(!canTransition("BACKLOG", "DONE"));
  assert.ok(!canTransition("DONE", "WORKING"));
});

test("create, move, block, retry and cancel a task with readable errors", () => {
  const { dev, home, cleanup } = openTestDev();
  try {
    const project = dev.projects.add({ path: home, name: "p" });
    const task = dev.tasks.create({ projectId: project.id, title: "first", requirements: ["r1"], acceptance: ["a1"] });
    assert.equal(task.status, "BACKLOG");
    assert.equal(task.ordinal, 1);

    assert.throws(() => dev.tasks.setStatus(task.id, "WORKING"), /Cannot move task .* from BACKLOG to WORKING/);
    dev.tasks.setStatus(task.id, "READY");
    dev.tasks.setStatus(task.id, "WORKING");
    assert.throws(() => dev.tasks.setStatus(task.id, "DONE"), /no passing evidence/);

    const blocked = dev.tasks.block(task.id, { kind: "process-failed", reason: "exit 1", nextAction: "fix it" });
    assert.equal(blocked.status, "BLOCKED");
    assert.equal(blocked.failure?.kind, "process-failed");

    const retried = dev.tasks.retry(task.id);
    assert.equal(retried.status, "READY");
    assert.equal(retried.retryCount, 1);
    assert.equal(retried.failure, null, "retry clears the failure");

    dev.tasks.setStatus(task.id, "WORKING");
    dev.evidence.record({ taskId: task.id, kind: "command-exit", passed: true, summary: "exit 0" });
    const done = dev.tasks.setStatus(task.id, "DONE");
    assert.equal(done.status, "DONE");

    const events = dev.events.list({ taskId: task.id }).map((e) => e.type);
    assert.ok(events.includes("TASK_CREATED"));
    assert.ok(events.includes("TASK_BLOCKED"));
    assert.ok(events.includes("TASK_COMPLETED"));

    const other = dev.tasks.create({ projectId: project.id, title: "second" });
    dev.tasks.setStatus(other.id, "CANCELLED", { reason: "not needed" });
    assert.equal(dev.tasks.get(other.id)?.status, "CANCELLED");
    assert.equal(dev.tasks.counts(project.id).DONE, 1);
  } finally {
    cleanup();
  }
});

test("dependency graph: gating, cycles, promotion and runnable set", () => {
  const { dev, home, cleanup } = openTestDev();
  try {
    const project = dev.projects.add({ path: home, name: "graph" });
    const schema = dev.tasks.create({ projectId: project.id, title: "schema", status: "READY" });
    const api = dev.tasks.create({ projectId: project.id, title: "api", dependsOn: [schema.id] });
    const ui = dev.tasks.create({ projectId: project.id, title: "ui", dependsOn: [api.id] });

    assert.throws(() => dev.tasks.addDependency(schema.id, ui.id), /cycle/);
    assert.throws(() => dev.tasks.addDependency(api.id, api.id), /itself/);
    assert.throws(() => dev.tasks.setStatus(api.id, "READY"), /still depends on/);

    assert.deepEqual(dev.tasks.runnable(project.id).map((t) => t.id), [schema.id]);
    assert.deepEqual(dev.tasks.order(project.id).map((t) => t.title), ["schema", "api", "ui"]);

    dev.tasks.setStatus(schema.id, "WORKING");
    dev.evidence.record({ taskId: schema.id, kind: "verification", passed: true, summary: "ok" });
    dev.tasks.setStatus(schema.id, "DONE");

    assert.equal(dev.tasks.get(api.id)?.status, "READY", "dependent promoted when its dependencies are done");
    assert.equal(dev.tasks.get(ui.id)?.status, "BACKLOG", "transitive dependent stays in backlog");
    assert.deepEqual(dev.tasks.runnable(project.id).map((t) => t.id), [api.id]);
    assert.ok(dev.events.list({ taskId: api.id }).some((e) => e.type === "TASK_READY"));

    assert.equal(dev.tasks.resolve("2", project.id)?.id, api.id, "ordinal lookup");
    assert.equal(dev.tasks.resolve(ui.id.slice(0, 8))?.id, ui.id, "prefix lookup");
  } finally {
    cleanup();
  }
});

test("projects resolve by id, name and path and reject duplicates", () => {
  const { dev, home, cleanup } = openTestDev();
  try {
    const project = dev.projects.add({ path: home, name: "Alpha", goal: "ship" });
    assert.equal(dev.projects.resolve("alpha")?.id, project.id);
    assert.equal(dev.projects.resolve(home)?.id, project.id);
    assert.throws(() => dev.projects.add({ path: home }), /already registered/);
    assert.throws(() => dev.projects.add({ path: home + "-missing" }), /does not exist/);
    const updated = dev.projects.update(project.id, { milestone: "M1", config: { reviewRequired: true } });
    assert.equal(updated.milestone, "M1");
    assert.equal(updated.config.reviewRequired, true);
    dev.projects.remove(project.id);
    assert.equal(dev.projects.list().length, 0);
  } finally {
    cleanup();
  }
});

import assert from "node:assert/strict";
import { test } from "node:test";

import { applyPlan, extractJson, type PlanProposal } from "../src/index.ts";
import { openTestDev } from "./helpers.ts";

test("events are durable, filterable and streamable by id; transient ones are not stored", () => {
  const { dev, home, cleanup } = openTestDev();
  try {
    const project = dev.projects.add({ path: home, name: "ev" });
    const start = dev.events.latestId();
    const seen: string[] = [];
    const off = dev.events.on((e) => seen.push(e.type));
    dev.events.emit("GIT_COMMIT", { projectId: project.id, data: { hash: "abc" } });
    dev.events.emitTransient("COMMAND_OUTPUT", { projectId: project.id, data: { chunk: "x" } });
    off();
    dev.events.emit("GIT_COMMIT", { projectId: project.id, data: { hash: "def" } });
    assert.deepEqual(seen, ["GIT_COMMIT", "COMMAND_OUTPUT"]);
    const since = dev.events.list({ sinceId: start });
    assert.deepEqual(since.map((e) => e.data.hash), ["abc", "def"]);
    assert.deepEqual(dev.events.list({ projectId: project.id, types: ["GIT_COMMIT"], limit: 1 }).map((e) => e.data.hash), ["def"]);
  } finally {
    cleanup();
  }
});

test("extractJson tolerates prose and code fences around the plan", () => {
  const plan = { milestone: "m", tasks: [{ title: "a" }] };
  assert.deepEqual(extractJson(`Here you go:\n\`\`\`json\n${JSON.stringify(plan)}\n\`\`\`\nDone.`), plan);
  assert.deepEqual(extractJson(JSON.stringify(plan)), plan);
  assert.equal(extractJson("no json here"), null);
  assert.equal(extractJson('{"not":"a plan"}'), null);
});

test("applyPlan creates tasks, wires dependencies, promotes roots to READY and records a decision", () => {
  const { dev, home, cleanup } = openTestDev();
  try {
    const project = dev.projects.add({ path: home, name: "plan" });
    const proposal: PlanProposal = {
      goal: "add auth",
      milestone: "Auth v1",
      summary: "sessions first, then routes",
      workerId: "test",
      notes: [],
      nexusMatches: [],
      capabilities: [{ kind: "skill", name: "auth-implementation-patterns", reason: "auth" }],
      tasks: [
        { title: "session store", outcome: "", requirements: [], acceptance: [], dependsOn: [], verification: [], files: [], effort: "low" },
        { title: "login route", outcome: "", requirements: [], acceptance: [], dependsOn: [0], verification: [{ kind: "command", command: "npm test" }], files: [], effort: "medium" },
        { title: "logout route", outcome: "", requirements: [], acceptance: [], dependsOn: [1, 0], verification: [], files: [], effort: "low" },
      ],
    };
    const created = applyPlan(dev, project, proposal);
    assert.equal(created.length, 3);
    assert.equal(dev.tasks.get(created[0]!.id)?.status, "READY");
    assert.equal(dev.tasks.get(created[1]!.id)?.status, "BACKLOG");
    assert.deepEqual(dev.tasks.get(created[2]!.id)?.dependsOn.sort(), [created[0]!.id, created[1]!.id].sort());
    assert.equal(dev.tasks.get(created[1]!.id)?.capabilities[0]?.name, "auth-implementation-patterns");
    assert.equal(dev.projects.get(project.id)?.milestone, "Auth v1");
    assert.equal(dev.decisions.list(project.id).length, 1);
    assert.ok(dev.events.list({ projectId: project.id }).some((e) => e.type === "PLAN_APPLIED"));
  } finally {
    cleanup();
  }
});

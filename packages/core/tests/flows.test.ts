import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { evaluateCondition, interpolate, referencedSteps, runFlow, validateFlow, type FlowEdge, type FlowNode } from "../src/index.ts";
import { nodeExe, openTestDev, tempRepo } from "./helpers.ts";

/** A command step that writes something and says so, without depending on a shell's built-ins. */
function writes(id: string, label: string, file: string, text: string, x = 0, y = 0): FlowNode {
  return { id, kind: "shell", label, x, y, command: `${nodeExe} -e "require('fs').writeFileSync('${file}','${text}'); console.log('wrote ${file}')"` };
}

function edge(from: string, to: string, when: FlowEdge["when"] = null): FlowEdge {
  return { id: `${from}->${to}${when ? `:${when}` : ""}`, from, to, when };
}

test("a flow runs its steps in edge order, passes output forward, and records every step", async () => {
  const { dev, cleanup } = openTestDev();
  const repo = tempRepo();
  try {
    const project = dev.projects.add({ path: repo.path, name: "flows" });
    const flow = dev.flows.create({
      projectId: project.id,
      name: "two steps",
      nodes: [
        writes("a", "first", "one.txt", "hello"),
        // The second step reads what the first printed, which is the whole point of a flow.
        { id: "b", kind: "shell", label: "second", x: 200, y: 0, command: `${nodeExe} -e "require('fs').writeFileSync('two.txt', process.argv[1])" "{{first.output}}"` },
      ],
      edges: [edge("a", "b")],
    });

    const seen: string[] = [];
    dev.events.on((e) => seen.push(e.type));
    const report = await runFlow(dev, { flowId: flow.id });

    assert.equal(report.status, "PASSED", report.detail ?? "");
    assert.deepEqual(report.steps.map((s) => s.nodeId), ["a", "b"], "ran in edge order");
    assert.ok(existsSync(join(repo.path, "one.txt")));
    assert.match(readFileSync(join(repo.path, "two.txt"), "utf8"), /wrote one\.txt/, "the second step received the first step's output");

    assert.ok(seen.includes("FLOW_RUN_STARTED") && seen.includes("FLOW_RUN_FINISHED"));
    const runs = dev.flows.runs(flow.id);
    assert.equal(runs[0]?.status, "PASSED");
    const nodeRuns = dev.flows.nodeRuns(runs[0]!.id);
    assert.equal(nodeRuns.length, 2);
    assert.ok(nodeRuns.every((n) => n.status === "PASSED" && n.finishedAt), "every step is recorded as finished");
    assert.equal(nodeRuns[0]?.workerId, "shell");
  } finally {
    cleanup();
    repo.cleanup();
  }
});

test("a condition takes one branch, and the branch not taken is recorded as skipped rather than passed", async () => {
  const { dev, cleanup } = openTestDev();
  const repo = tempRepo();
  try {
    const project = dev.projects.add({ path: repo.path, name: "branching" });
    const flow = dev.flows.create({
      projectId: project.id,
      name: "branch",
      nodes: [
        writes("probe", "probe", "probe.txt", "STATUS=green"),
        { id: "check", kind: "condition", label: "is it green?", x: 200, y: 0, expression: '{{probe.output}} contains "wrote"' },
        writes("yes", "on true", "yes.txt", "took the true branch", 400, -80),
        writes("no", "on false", "no.txt", "took the false branch", 400, 80),
      ],
      edges: [edge("probe", "check"), edge("check", "yes", "true"), edge("check", "no", "false")],
    });

    const report = await runFlow(dev, { flowId: flow.id });
    assert.equal(report.status, "PASSED", report.detail ?? "");

    assert.ok(existsSync(join(repo.path, "yes.txt")), "the true branch ran");
    assert.equal(existsSync(join(repo.path, "no.txt")), false, "the false branch did not run");

    const steps = new Map(report.steps.map((s) => [s.nodeId, s]));
    assert.equal(steps.get("yes")?.status, "PASSED");
    // The distinction the whole feature rests on: not run is not the same as succeeded.
    assert.equal(steps.get("no")?.status, "SKIPPED");
    assert.match(steps.get("check")?.detail ?? "", /contains/, "the condition records why it went the way it did");

    const nodeRuns = dev.flows.nodeRuns(dev.flows.runs(flow.id)[0]!.id);
    assert.equal(nodeRuns.find((n) => n.nodeId === "no")?.status, "SKIPPED");
  } finally {
    cleanup();
    repo.cleanup();
  }
});

test("a failing step stops the run and says which step failed and why", async () => {
  const { dev, cleanup } = openTestDev();
  const repo = tempRepo();
  try {
    const project = dev.projects.add({ path: repo.path, name: "failing" });
    const flow = dev.flows.create({
      projectId: project.id,
      name: "fails midway",
      nodes: [
        writes("a", "first", "one.txt", "ok"),
        { id: "b", kind: "shell", label: "the broken one", x: 200, y: 0, command: `${nodeExe} -e "console.error('nope'); process.exit(3)"` },
        writes("c", "never reached", "three.txt", "should not exist", 400, 0),
      ],
      edges: [edge("a", "b"), edge("b", "c")],
    });

    const report = await runFlow(dev, { flowId: flow.id });
    assert.equal(report.status, "FAILED");
    assert.match(report.detail ?? "", /the broken one/, "the run says which step failed");
    assert.match(report.detail ?? "", /exit 3/, "and why");
    assert.equal(existsSync(join(repo.path, "three.txt")), false, "nothing downstream of a failure runs");
    assert.equal(dev.flows.runs(flow.id)[0]?.status, "FAILED");
  } finally {
    cleanup();
    repo.cleanup();
  }
});

test("a join waits for both sides and runs once", async () => {
  const { dev, cleanup } = openTestDev();
  const repo = tempRepo();
  try {
    const project = dev.projects.add({ path: repo.path, name: "join" });
    const flow = dev.flows.create({
      projectId: project.id,
      name: "diamond",
      nodes: [
        writes("start", "start", "s.txt", "go"),
        writes("left", "left", "l.txt", "left"),
        writes("right", "right", "r.txt", "right"),
        // Appends, so running twice would be visible in the file.
        { id: "join", kind: "shell", label: "join", x: 600, y: 0, command: `${nodeExe} -e "require('fs').appendFileSync('j.txt','once')"` },
      ],
      edges: [edge("start", "left"), edge("start", "right"), edge("left", "join"), edge("right", "join")],
    });

    const report = await runFlow(dev, { flowId: flow.id });
    assert.equal(report.status, "PASSED", report.detail ?? "");
    assert.equal(readFileSync(join(repo.path, "j.txt"), "utf8"), "once", "the join ran exactly once");
    assert.equal(report.steps.filter((s) => s.nodeId === "join").length, 1);
  } finally {
    cleanup();
    repo.cleanup();
  }
});

test("a flow that cannot run says so before running anything", async () => {
  const { dev, cleanup } = openTestDev();
  const repo = tempRepo();
  try {
    const project = dev.projects.add({ path: repo.path, name: "invalid" });

    // A command step with no command.
    const empty = dev.flows.create({ projectId: project.id, name: "empty step", nodes: [{ id: "a", kind: "shell", label: "does nothing", x: 0, y: 0, command: "" }], edges: [] });
    await assert.rejects(runFlow(dev, { flowId: empty.id }), /command step with no command/);

    // A loop, which this version cannot run and must not pretend to.
    const looped = dev.flows.create({
      projectId: project.id,
      name: "loop",
      nodes: [writes("a", "a", "a.txt", "a"), writes("b", "b", "b.txt", "b")],
      edges: [edge("a", "b"), edge("b", "a")],
    });
    await assert.rejects(runFlow(dev, { flowId: looped.id }), /loop/);

    // An unlabelled branch out of a condition.
    const unlabelled = dev.flows.create({
      projectId: project.id,
      name: "unlabelled branch",
      nodes: [{ id: "c", kind: "condition", label: "test", x: 0, y: 0, expression: "1 == 1" }, writes("d", "d", "d.txt", "d")],
      edges: [edge("c", "d")],
    });
    assert.ok(validateFlow(unlabelled).some((p) => /labelled true or false/.test(p.message)));

    assert.equal(existsSync(join(repo.path, "a.txt")), false, "an invalid flow runs nothing at all");
  } finally {
    cleanup();
    repo.cleanup();
  }
});

test("conditions compare values without evaluating code, and say plainly when they cannot", () => {
  const steps = [
    { nodeId: "n1", label: "tests", status: "PASSED", output: "12 passing, 0 failing", exitCode: 0 },
    { nodeId: "n2", label: "lint", status: "FAILED", output: "", exitCode: 2 },
  ];

  assert.equal(evaluateCondition('{{tests.output}} contains "passing"', steps).value, true);
  assert.equal(evaluateCondition('{{tests.output}} does not contain "failing"', steps).value, false);
  assert.equal(evaluateCondition('{{tests.output}} matches "\\d+ passing"', steps).value, true);
  assert.equal(evaluateCondition("{{lint.output}} is empty", steps).value, true);
  assert.equal(evaluateCondition("{{lint.output}} is not empty", steps).value, false);
  assert.equal(evaluateCondition("{{tests.exitCode}} == 0", steps).value, true);
  assert.equal(evaluateCondition("{{lint.exitCode}} > 1", steps).value, true);
  assert.equal(evaluateCondition("{{tests.status}} == PASSED", steps).value, true);
  // Steps are addressable by label or by id, because the user names them, not us.
  assert.equal(evaluateCondition('{{n1.output}} contains "passing"', steps).value, true);

  // Every decision carries its reason, so the history says why the flow branched.
  assert.match(evaluateCondition('{{tests.output}} contains "passing"', steps).because, /contains/);

  // A reference to a step that has not run is an error, never a silent empty string.
  assert.throws(() => evaluateCondition('{{nothing.output}} contains "x"', steps), /No earlier step called "nothing"/);
  assert.throws(() => evaluateCondition("{{tests.nonsense}} == 1", steps), /not something a step has/);
  assert.throws(() => evaluateCondition('{{tests.output}} > 5', steps), /compares numbers/);

  // The operator scanner must not find a word operator inside ordinary text.
  const wordy = [{ nodeId: "n3", label: "build", status: "PASSED", output: "the build maintains compatibility", exitCode: 0 }];
  assert.equal(evaluateCondition('{{build.output}} contains "maintains"', wordy).value, true);
});

test("templates substitute earlier output and refuse to half-substitute", () => {
  const steps = [{ nodeId: "n1", label: "probe", status: "PASSED", output: "v2.1.0", exitCode: 0 }];
  assert.equal(interpolate("echo {{probe.output}}", steps), "echo v2.1.0");
  assert.equal(interpolate("exit {{probe.exitCode}}", steps), "exit 0");
  // A prompt silently missing the output it was meant to act on is worse than a run that stops.
  assert.throws(() => interpolate("echo {{missing.output}}", steps), /No earlier step called "missing"/);
  assert.deepEqual(referencedSteps("{{a.output}} and {{b.status}} and {{a.exitCode}}"), ["a", "b"]);
});

test("a human step waits for the person's answer, hands the answer on, and a decline stops the run", async () => {
  const { dev, cleanup } = openTestDev();
  const repo = tempRepo();
  try {
    const project = dev.projects.add({ path: repo.path, name: "ask" });
    const flow = dev.flows.create({
      projectId: project.id,
      name: "ask then act",
      nodes: [
        { id: "q", kind: "human", label: "ship", x: 0, y: 0, prompt: "Ship it? Reply with the release note." },
        { id: "w", kind: "shell", label: "write", x: 200, y: 0, command: `${nodeExe} -e "require('fs').writeFileSync('note.txt', process.argv[1])" "{{ship.output}}"` },
      ],
      edges: [edge("q", "w")],
    });

    // Nobody has answered yet: the run must be waiting, with the question filed where the person looks.
    const running = runFlow(dev, { flowId: flow.id });
    await new Promise((r) => setTimeout(r, 700));
    const pending = dev.approvals.list({ status: "pending" });
    assert.equal(pending.length, 1, "exactly one question is waiting");
    assert.equal(pending[0]!.action, "human-input");
    assert.equal(pending[0]!.reason, "Ship it? Reply with the release note.");
    assert.equal(dev.flows.runs(flow.id)[0]?.status, "RUNNING", "the run is paused, not failed");

    dev.approvals.resolve(pending[0]!.id, "approved", "user", "v1.2: faster sync");
    const report = await running;
    assert.equal(report.status, "PASSED", report.detail ?? "");
    assert.equal(report.steps[0]?.output, "v1.2: faster sync", "the answer is the step's output");
    assert.equal(readFileSync(join(repo.path, "note.txt"), "utf8"), "v1.2: faster sync", "the next step received the answer");

    // Declining stops the run and says so; nothing downstream runs.
    const second = runFlow(dev, { flowId: flow.id });
    await new Promise((r) => setTimeout(r, 700));
    const again = dev.approvals.list({ status: "pending" });
    dev.approvals.resolve(again[0]!.id, "denied", "user", "not yet");
    const declined = await second;
    assert.equal(declined.status, "FAILED");
    assert.match(declined.detail ?? "", /declined: not yet/);
    assert.equal(declined.steps.length, 1, "the write step never ran");

    // A cancelled run stops waiting instead of leaving a question that no run will ever read.
    const controller = new AbortController();
    const third = runFlow(dev, { flowId: flow.id, signal: controller.signal });
    await new Promise((r) => setTimeout(r, 700));
    controller.abort();
    const cancelled = await third;
    assert.equal(cancelled.status, "CANCELLED");
  } finally {
    cleanup();
    repo.cleanup();
  }
});

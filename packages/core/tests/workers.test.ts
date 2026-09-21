import assert from "node:assert/strict";
import { test } from "node:test";

import { Db, EventBus, ExecutionStore, WorkerRegistry, WorkerUnavailableError, StreamJsonParser, DEFAULT_CONFIG, type DevConfig, type Worker, type Task } from "../src/index.ts";
import { NO_EFFORT } from "../src/workers/efforts.ts";
import { openTestDev } from "./helpers.ts";

function fakeWorker(id: string, ok: boolean, capabilities: Worker["capabilities"] = ["code"]): Worker {
  return {
    id,
    name: id,
    type: "cli-agent",
    capabilities,
    configRef: "test",
    efforts: NO_EFFORT,
    probe: async () => ({ ok, checkedAt: new Date().toISOString(), detail: ok ? "fine" : "missing" }),
    run: async () => ({ ok: true, exitCode: 0, timedOut: false, cancelled: false, launchError: null, summary: "done", commandLine: id, usage: null, durationMs: 1 }),
  };
}

function taskStub(patch: Partial<Task> = {}): Task {
  return {
    id: "tsk_x",
    projectId: "prj_x",
    title: "t",
    milestone: null,
    epic: null,
    kind: "ticket",
    risk: "normal",
    needsHuman: null,
    outcome: "",
    requirements: [],
    acceptance: [],
    status: "READY",
    dependsOn: [],
    workerId: null,
    capabilities: [],
    effort: "medium",
    reasoningEffort: null,
    command: null,
    promptOverride: null,
    files: [],
    verification: [],
    resultSummary: null,
    failure: null,
    retryCount: 0,
    ordinal: 1,
    createdAt: "",
    updatedAt: "",
    ...patch,
  };
}

function registry(workers: Worker[], preferences: string[], byCapability: DevConfig["workers"]["preferencesByCapability"] = {}) {
  const db = new Db(":memory:");
  const config = structuredClone(DEFAULT_CONFIG);
  config.workers.preferences = preferences;
  config.workers.preferencesByCapability = byCapability;
  return new WorkerRegistry(workers, db, new EventBus(db), new ExecutionStore(db), config);
}

test("routing: command tasks go to shell, explicit worker wins, preference order picks the first healthy", async () => {
  const shell = fakeWorker("shell", true, ["shell"]);
  const down = fakeWorker("down", false);
  const up = fakeWorker("up", true);
  const reg = registry([shell, down, up], ["down", "up"]);

  const viaCommand = await reg.select(taskStub({ command: "echo hi" }));
  assert.equal(viaCommand.worker.id, "shell");

  const explicit = await reg.select(taskStub({ workerId: "up" }));
  assert.equal(explicit.worker.id, "up");
  assert.match(explicit.reason, /assigned on the task/);

  const byPreference = await reg.select(taskStub());
  assert.equal(byPreference.worker.id, "up", "skips the unhealthy worker");

  await assert.rejects(reg.select(taskStub({ workerId: "down" })), WorkerUnavailableError);
  await assert.rejects(reg.select(taskStub({ workerId: "nope" })), /Unknown worker/);

  const info = reg.info("up");
  assert.equal(info?.health?.ok, true, "health probe was recorded");
  assert.equal(info?.stats.executions, 0);
});

test("routing fails clearly when nothing healthy offers the capability", async () => {
  const reg = registry([fakeWorker("down", false)], ["down"]);
  await assert.rejects(reg.select(taskStub()), /unavailable/);
});

test("stream-json parser extracts assistant text, tool calls, result and usage", () => {
  const out: string[] = [];
  const events: string[] = [];
  const parser = new StreamJsonParser({ onOutput: (c) => out.push(c), onEvent: (e) => events.push(e.kind) });
  parser.feed(JSON.stringify({ type: "system", model: "claude-x" }) + "\n");
  parser.feed(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Looking at the file" }, { type: "tool_use", name: "Read", input: { file_path: "a.ts" } }] } }) + "\n");
  parser.feed('{"type":"result","subtype":"success","is_error":false,"result":"All done","usage":{"input_tokens":10,"output_tokens":5},"total_cost_usd":0.01}\n');
  parser.feed("not json at all\n");
  parser.flush();
  assert.equal(parser.finalText, "All done");
  assert.equal(parser.isError, false);
  assert.equal(parser.usage?.total_cost_usd, 0.01);
  assert.deepEqual(events, ["system", "assistant", "tool", "result"]);
  assert.ok(out.join("").includes("→ Read a.ts"));
  assert.ok(out.join("").includes("not json at all"));
});

test("routing follows the per-capability preference and steps around a worker that is out of quota", async () => {
  const planner = fakeWorker("planner", true, ["code", "plan"]);
  const coder = fakeWorker("coder", true, ["code", "plan"]);
  // The user's own judgement about their tools: one is better at planning, the other at code.
  const reg = registry([planner, coder], ["planner", "coder"], { plan: ["planner"], code: ["coder"] });
  const task = taskStub();

  assert.equal((await reg.select(task, { capability: "plan" })).worker.id, "planner");
  const coded = await reg.select(task, { capability: "code" });
  assert.equal(coded.worker.id, "coder");
  assert.match(coded.reason, /preferred worker for "code"/);

  // The coder says it is out of quota: the work moves to one with headroom instead of failing.
  reg.rateLimited("coder", "rate limit reached for model X", 60_000);
  assert.ok(reg.rateLimitedFor("coder"), "the limit is remembered");
  assert.equal((await reg.select(task, { capability: "code" })).worker.id, "planner", "a worker with headroom takes the work");

  // Naming the exhausted worker explicitly says so plainly rather than trying and failing.
  await assert.rejects(() => reg.select(taskStub({ workerId: "coder" }), { capability: "code" }), /out of quota/);

  // Once the window passes it is back in the running.
  reg.rateLimited("coder", "brief", -1);
  assert.equal(reg.rateLimitedFor("coder"), null);
  assert.equal((await reg.select(task, { capability: "code" })).worker.id, "coder");
});

test("a real rate-limit message sidelines the worker for as long as the provider asks", () => {
  const reg = registry([fakeWorker("groq", true)], ["groq"]);
  // The exact shape Groq returns, from a real 429 in this project's logs.
  const groqError = '429 from https://api.groq.com/openai/v1: {"error":{"message":"Rate limit reached for model `openai/gpt-oss-120b` in organization `org_x` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Used 7224, Requested 1823. Please try again in 7.852499999s.","type":"tokens","code":"rate_limit_exceeded"}}';
  assert.equal(reg.noteIfRateLimited("groq", groqError), true);
  const limited = reg.rateLimitedFor("groq");
  assert.ok(limited, "the worker is sidelined");
  assert.ok(limited.msLeft > 7000 && limited.msLeft <= 9000, `waits the ~7.85s the provider asked for, got ${limited.msLeft}ms`);

  // Ordinary failures are not rate limits and must not sideline anything.
  assert.equal(reg.noteIfRateLimited("groq", "TypeError: cannot read property 'x' of undefined"), false);
  assert.equal(reg.noteIfRateLimited("groq", ""), false);
});

test("benchmark advice ranks the workers this machine has, and never invents one it does not", async () => {
  const { suggestRouting, BENCHMARK_EVIDENCE } = await import("../src/workers/benchmarks.ts");
  // Every row must carry its source and the date it was read, or it is not evidence.
  for (const row of BENCHMARK_EVIDENCE) {
    assert.match(row.source, /^https:\/\//, `${row.benchmark} cites a source`);
    assert.match(row.readOn, /^\d{4}-\d{2}-\d{2}$/, `${row.benchmark} records when it was read`);
    assert.ok(row.scores.length > 0, `${row.benchmark} has scores`);
  }

  const suggestions = suggestRouting({
    workers: [
      { id: "claude-code", capabilities: ["code", "plan", "research"], model: null, healthy: true },
      { id: "codex", capabilities: ["code", "plan", "research"], model: "gpt-5.6-sol", healthy: true },
      { id: "grok", capabilities: ["code", "plan"], model: "grok-4.6", healthy: true },
    ],
  });
  const code = suggestions.find((s) => s.capability === "code");
  assert.ok(code, "code has advice");
  // No worker is favoured a priori: the order is whatever the weighted evidence says, and on the
  // current table the GPT family leads for code by winning both uncontaminated benchmarks.
  assert.equal(code.order[0], "codex", "the worker that wins the sound benchmarks is ranked first");
  assert.ok(code.order.includes("grok"), "a worker a benchmark does name is ranked, not omitted");
  const plan = suggestions.find((s) => s.capability === "plan");
  assert.equal(plan?.order[0], "codex", "the reasoning benchmarks put the GPT family first for planning");

  // A discounted benchmark must not overturn the ones it lost. SWE-bench Verified ranks the Claude
  // family far above the GPT family; it is contaminated, weighted down, and does not decide "code".
  const verified = code.evidence.find((e) => e.benchmark === "SWE-bench Verified");
  assert.ok(verified && verified.weight < 1 && verified.caveat, "a benchmark below full weight says why");
  assert.ok(code.evidence.length >= 2, "no capability is decided by a single leaderboard");
  assert.equal(code.confidence, "strong", "several full-weight benchmarks agreeing reads as strong");

  // A capability resting on one source must admit it rather than sounding authoritative.
  const thin = suggestions.find((s) => s.capability === "research");
  assert.equal(thin?.confidence, "weak");
  assert.match(thin?.because ?? "", /thin evidence/);

  // A worker no benchmark row names is not given a rank it did not earn.
  const unranked = suggestRouting({ workers: [{ id: "ollama", capabilities: ["plan"], model: "qwen2.5-coder:7b", healthy: true }] });
  assert.equal(unranked.find((s) => s.capability === "plan")?.order.includes("ollama"), false);

  // A worker that is down is reported as unavailable rather than recommended.
  const offline = suggestRouting({ workers: [{ id: "claude-code", capabilities: ["code"], model: null, healthy: false }] });
  assert.deepEqual(offline.find((s) => s.capability === "code")?.order, []);
  assert.deepEqual(offline.find((s) => s.capability === "code")?.unavailable, ["claude-code"]);

  // A capability whose benchmark leader no worker offers says so, rather than going silent.
  const noResearcher = suggestRouting({ workers: [{ id: "claude-code", capabilities: ["code"], model: null, healthy: true }] });
  const research = noResearcher.find((s) => s.capability === "research");
  assert.ok(research, "research still appears");
  assert.deepEqual(research.order, []);
  assert.match(research.because, /not offered for "research" by any worker here/);
});

test("model and reasoning effort are separate dials, and each worker is given the one it accepts", async () => {
  const { clampEffort, CLAUDE_CODE_EFFORTS, OPENCODE_EFFORTS, NO_EFFORT, effortForTaskSize } = await import("../src/workers/efforts.ts");
  const { ClaudeCodeWorker } = await import("../src/workers/claude-code.ts");
  const { CodexWorker } = await import("../src/workers/codex.ts");
  const { OpenCodeWorker } = await import("../src/workers/cli-agents.ts");

  // Every ladder says where it came from, so a documented list is never mistaken for a probed one.
  for (const support of [CLAUDE_CODE_EFFORTS, OPENCODE_EFFORTS]) {
    assert.ok(support.source.length > 0, "an effort ladder cites its source");
    assert.ok(support.flag, "an effort ladder says how the level is passed");
  }

  // A worker with no dial is given nothing at all rather than a flag it would reject.
  assert.equal(clampEffort(NO_EFFORT, "high"), null);
  // A fixed ladder takes the strongest level it actually has instead of erroring on one it lacks.
  assert.equal(clampEffort(CLAUDE_CODE_EFFORTS, "max"), "max");
  assert.equal(clampEffort({ ...CLAUDE_CODE_EFFORTS, levels: ["low", "medium", "high"] }, "max"), "high");
  assert.equal(clampEffort(CLAUDE_CODE_EFFORTS, "minimal"), "low", "a level below the ladder gets its weakest rung");
  // A CLI that takes any string gets the value through untouched, including one DEV does not know.
  assert.equal(clampEffort(OPENCODE_EFFORTS, "provider-specific-thing"), "provider-specific-thing");
  assert.equal(clampEffort(CLAUDE_CODE_EFFORTS, "nonsense"), null, "a fixed ladder does not guess at an unknown value");

  // Model and effort are set independently: "opus" is the model, "low" is the effort.
  const claude = new ClaudeCodeWorker({ command: "claude", model: "opus", effort: "low", permissionMode: "acceptEdits" });
  const args = claude.buildArgs({ reasoningEffort: "max", readOnly: false });
  assert.deepEqual([args[args.indexOf("--model") + 1], args[args.indexOf("--effort") + 1]], ["opus", "low"], "the worker's configured level wins over the run's");
  assert.deepEqual(
    (() => {
      const a = new ClaudeCodeWorker({ command: "claude", model: "fable", effort: null, permissionMode: "acceptEdits" }).buildArgs({ reasoningEffort: "high", readOnly: false });
      return [a[a.indexOf("--model") + 1], a[a.indexOf("--effort") + 1]];
    })(),
    ["fable", "high"],
    "with no configured level the run's level is used",
  );

  // Codex with no level set must leave the user's own ~/.codex config alone.
  const codexBare = new CodexWorker({ command: "codex", model: null, effort: null }).buildArgs({ reasoningEffort: null, readOnly: false });
  assert.equal(codexBare.includes("--config"), false, "no level set means no model_reasoning_effort override");
  const codexSet = new CodexWorker({ command: "codex", model: null, effort: "xhigh" }).buildArgs({ reasoningEffort: null, readOnly: false });
  assert.ok(codexSet.includes('model_reasoning_effort="xhigh"'));

  // OpenCode spells the dial --variant. It has no --reasoning-effort flag, and passing one fails the run.
  const opencode = new OpenCodeWorker({ command: "opencode", model: "anthropic/claude-sonnet-5", effort: "high", briefDir: "." }).buildArgs("brief.md", { cwd: ".", readOnly: false, reasoningEffort: null });
  assert.ok(opencode.includes("--variant"), "OpenCode is given --variant");
  assert.equal(opencode.includes("--reasoning-effort"), false, "OpenCode is never given a flag it does not have");
  assert.equal(opencode[opencode.indexOf("--variant") + 1], "high");

  // The task's size estimate is only the fallback for the dial, not the dial itself.
  assert.equal(effortForTaskSize("low"), "low");
});

test("routing: with no preference stated, a worker's record on this machine outranks the benchmark order", async () => {
  const { dev, cleanup } = openTestDev();
  try {
    const project = dev.projects.add({ path: null, name: "record" });
    const task = dev.tasks.create({ projectId: project.id, title: "t", status: "READY" });
    // Two healthy workers with identical capabilities; only their history differs.
    const steady = fakeWorker("steady", true);
    const flaky = fakeWorker("flaky", true);
    const record = (workerId: string, outcomes: ("succeeded" | "failed")[], ms: number) => {
      for (const status of outcomes) {
        const e = dev.executions.create({ taskId: task.id, projectId: project.id, workerId, cwd: "." });
        dev.executions.finish(e.id, { status, exitCode: status === "succeeded" ? 0 : 1, changedFiles: [], summary: "", command: null, usage: null });
        dev.db.run("UPDATE executions SET duration_ms = ? WHERE id = ?", ms, e.id);
      }
    };
    record("flaky", ["succeeded", "failed", "failed", "succeeded"], 500);
    record("steady", ["succeeded", "succeeded", "succeeded"], 900);

    const config = structuredClone(DEFAULT_CONFIG);
    config.workers.preferences = [];
    config.workers.preferencesByCapability = {};
    // Register flaky first so that hard-coded order would pick it if nothing else did.
    const reg = new WorkerRegistry([flaky, steady], dev.db, dev.events, dev.executions, config);
    const chosen = await reg.select(taskStub({ projectId: project.id }));
    assert.equal(chosen.worker.id, "steady", "3 of 3 beats 2 of 4");
    assert.match(chosen.reason, /on this machine it has finished 3 of 3 runs/);

    // A stated preference still wins over any record.
    config.workers.preferences = ["flaky"];
    const preferred = await new WorkerRegistry([flaky, steady], dev.db, dev.events, dev.executions, config).select(taskStub({ projectId: project.id }));
    assert.equal(preferred.worker.id, "flaky");

    // Fewer than three finished runs is not a record: a one-hit wonder is not promoted.
    const rookie = fakeWorker("rookie", true);
    record("rookie", ["succeeded"], 10);
    config.workers.preferences = [];
    const withRookie = await new WorkerRegistry([rookie, steady], dev.db, dev.events, dev.executions, config).select(taskStub({ projectId: project.id }));
    assert.equal(withRookie.worker.id, "steady");
  } finally {
    cleanup();
  }
});

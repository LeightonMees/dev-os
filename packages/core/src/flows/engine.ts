import type { Dev } from "../dev.ts";
import type { ReasoningEffort } from "../schemas.ts";

import { evaluateCondition, FlowExpressionError, interpolate, type StepResult } from "./expressions.ts";
import { downstream, startNodes, validateFlow, type Flow, type FlowNode, type FlowRunStatus } from "./schemas.ts";

export interface RunFlowOptions {
  flowId: string;
  signal?: AbortSignal;
  /** Cap on how many steps one run may execute. A guard against a graph larger than intended. */
  maxSteps?: number;
  onStep?: (event: { nodeId: string; label: string; status: string; detail?: string }) => void;
  /** Live output from a running step, for the run view. Never stored as events. */
  onOutput?: (nodeId: string, chunk: string) => void;
}

export interface FlowRunReport {
  runId: string;
  status: FlowRunStatus;
  detail: string | null;
  steps: { nodeId: string; label: string; status: string; output: string; detail: string | null }[];
}

/**
 * Run one flow to completion.
 *
 * The order comes from the edges, not from the order the user happened to draw the nodes in: a step
 * runs once every step pointing at it has finished, which makes a diamond join wait for both sides
 * rather than firing twice. A condition marks the branch it did not take as SKIPPED along with
 * everything reachable only through that branch, so the run history distinguishes "did not run"
 * from "ran and passed" — a distinction the whole point of a branch depends on.
 *
 * Failure stops the run. A flow is a procedure the user asked for in order; carrying on past a
 * failed step would run later steps against a state their author never anticipated.
 */
export async function runFlow(dev: Dev, options: RunFlowOptions): Promise<FlowRunReport> {
  const flow = dev.flows.get(options.flowId);
  if (!flow) throw new Error(`Unknown flow ${options.flowId}`);
  const project = dev.projects.get(flow.projectId);
  if (!project) throw new Error(`Flow ${flow.name} belongs to a project that no longer exists`);
  if (!project.path) throw new Error(`"${project.name}" has no path on disk, so a flow cannot run in it`);

  const problems = validateFlow(flow);
  if (problems.length > 0) {
    throw new Error(`This flow cannot run yet:\n${problems.map((p) => `  - ${p.message}`).join("\n")}`);
  }

  const run = dev.flows.startRun(flow);
  dev.events.emit("FLOW_RUN_STARTED", { projectId: flow.projectId, data: { flowId: flow.id, runId: run.id, name: flow.name, steps: flow.nodes.length } });

  const results = new Map<string, StepResult>();
  const done = new Set<string>();
  const skipped = new Set<string>();
  const report: FlowRunReport["steps"] = [];
  const maxSteps = options.maxSteps ?? 200;
  let status: FlowRunStatus = "PASSED";
  let detail: string | null = null;

  const byId = new Map(flow.nodes.map((n) => [n.id, n]));
  /** Edges whose branch was actually taken. Local to this run: two runs must never see each other. */
  const fired = new Set<string>();
  /** Edges that must have fired for a node to be reachable at all. Repeat arrows do not gate. */
  const incoming = (id: string) => flow.edges.filter((e) => e.to === id && !e.loop);
  /** How many times each repeat arrow has been followed this run. */
  const loops = new Map<string, number>();

  try {
    let queue = startNodes(flow).map((n) => n.id);
    let executed = 0;

    while (queue.length > 0) {
      if (options.signal?.aborted) {
        status = "CANCELLED";
        detail = "cancelled";
        break;
      }
      const nodeId = queue.shift() as string;
      if (done.has(nodeId) || skipped.has(nodeId)) continue;
      const node = byId.get(nodeId);
      if (!node) continue;

      // Wait for every predecessor. A node reached from two branches runs once, after both settle.
      const preds = incoming(nodeId);
      const unsettled = preds.filter((e) => !done.has(e.from) && !skipped.has(e.from));
      if (unsettled.length > 0) {
        // Its turn has not come; it will be queued again when the last predecessor finishes.
        continue;
      }
      // Reachable only through branches that were not taken: never ran, and says so.
      if (preds.length > 0 && preds.every((e) => skipped.has(e.from) || !fired.has(e.id))) {
        markSkipped(nodeId, "no branch reached this step");
        queue.push(...flow.edges.filter((e) => e.from === nodeId).map((e) => e.to));
        continue;
      }

      if (executed >= maxSteps) {
        status = "FAILED";
        detail = `Stopped after ${maxSteps} steps. Raise the limit if the flow is meant to be this long.`;
        break;
      }
      executed++;

      const outcome = await runNode(dev, { flow, run, node, project, results, options });
      report.push({ nodeId, label: node.label, status: outcome.status, output: outcome.output, detail: outcome.detail });
      options.onStep?.({ nodeId, label: node.label, status: outcome.status, detail: outcome.detail ?? undefined });

      if (outcome.status === "FAILED") {
        status = "FAILED";
        detail = `"${node.label}" failed: ${outcome.detail ?? "no detail"}`;
        break;
      }
      if (outcome.status === "CANCELLED") {
        status = "CANCELLED";
        detail = "cancelled";
        break;
      }

      done.add(nodeId);
      results.set(nodeId, { nodeId, label: node.label, status: outcome.status, output: outcome.output, exitCode: outcome.exitCode });

      // Follow the edges this step actually opened. A condition opens one branch; anything else
      // opens all of them.
      for (const edge of flow.edges.filter((e) => e.from === nodeId)) {
        const taken = node.kind === "condition" ? edge.when === (outcome.branch ? "true" : "false") : true;
        if (edge.loop) {
          // A repeat arrow re-arms its target and everything after it, up to its limit. Past the
          // limit it is simply not followed, and the run carries on along the other arrows.
          if (!taken) continue;
          const count = loops.get(edge.id) ?? 0;
          const limit = edge.maxLoops ?? 10;
          if (count >= limit) {
            const target = byId.get(edge.to);
            report.push({ nodeId: edge.to, label: target?.label ?? edge.to, status: "SKIPPED", output: "", detail: `repeat limit of ${limit} reached; not repeating` });
            options.onStep?.({ nodeId: edge.to, label: target?.label ?? edge.to, status: "SKIPPED", detail: `repeat limit of ${limit} reached` });
            continue;
          }
          loops.set(edge.id, count + 1);
          for (const id of downstream(flow, edge.to)) {
            done.delete(id);
            skipped.delete(id);
            for (const inner of flow.edges) if (inner.from === id) fired.delete(inner.id);
          }
          options.onStep?.({ nodeId: edge.to, label: byId.get(edge.to)?.label ?? edge.to, status: "RUNNING", detail: `repeat ${count + 1} of at most ${limit}` });
          queue.push(edge.to);
          continue;
        }
        if (taken) fired.add(edge.id);
        queue.push(edge.to);
      }
      // Re-queue anything now unblocked, so a join fires as soon as its last input settles.
      queue.push(...flow.nodes.filter((n) => !done.has(n.id) && !skipped.has(n.id) && incoming(n.id).some((e) => e.from === nodeId)).map((n) => n.id));
    }
  } catch (error) {
    status = "FAILED";
    detail = (error as Error).message;
  }

  dev.flows.finishRun(run.id, status, detail);
  dev.events.emit("FLOW_RUN_FINISHED", { projectId: flow.projectId, data: { flowId: flow.id, runId: run.id, status, detail, steps: report.length } });
  return { runId: run.id, status, detail, steps: report };

  function markSkipped(id: string, why: string): void {
    skipped.add(id);
    dev.flows.recordSkipped(run.id, id, why);
    const node = byId.get(id);
    report.push({ nodeId: id, label: node?.label ?? id, status: "SKIPPED", output: "", detail: why });
    options.onStep?.({ nodeId: id, label: node?.label ?? id, status: "SKIPPED", detail: why });
  }
}

interface NodeOutcome {
  status: "PASSED" | "FAILED" | "CANCELLED";
  output: string;
  detail: string | null;
  exitCode: number | null;
  /** For a condition: which way it went. */
  branch?: boolean;
}

/** Run one node, whatever kind it is, and record it. */
async function runNode(
  dev: Dev,
  ctx: {
    flow: Flow;
    run: { id: string };
    node: FlowNode;
    project: { id: string; name: string; path: string | null };
    results: Map<string, StepResult>;
    options: RunFlowOptions;
  },
): Promise<NodeOutcome> {
  const { node, run, project, results, options } = ctx;
  const steps = [...results.values()];

  // A human step files the question in Attention and waits. The answer is the
  // step's output, so later steps can build on what the person said; a decline
  // fails the step, because a run that carried on past "no" would be lying.
  if (node.kind === "human") {
    const record = dev.flows.startNode(run.id, node.id, null);
    let question: string;
    try {
      question = interpolate(node.prompt ?? "", steps);
    } catch (error) {
      const message = (error as Error).message;
      dev.flows.finishNode(record.id, "FAILED", "", message);
      return { status: "FAILED", output: "", detail: message, exitCode: null };
    }
    const approval = dev.approvals.request({ projectId: project.id, action: "human-input", reason: question });
    const answered = await waitForAnswer(dev, approval.id, options.signal);
    if (answered === null) {
      dev.flows.finishNode(record.id, "CANCELLED", "", "cancelled while waiting for an answer");
      return { status: "CANCELLED", output: "", detail: "cancelled while waiting for an answer", exitCode: null };
    }
    if (answered.status === "denied") {
      const detail = answered.note ? `declined: ${answered.note}` : "declined";
      dev.flows.finishNode(record.id, "FAILED", answered.note ?? "", detail);
      return { status: "FAILED", output: answered.note ?? "", detail, exitCode: null };
    }
    const answer = answered.note ?? "approved";
    dev.flows.finishNode(record.id, "PASSED", answer, null);
    return { status: "PASSED", output: answer, detail: null, exitCode: null };
  }

  // A condition does no work outside DEV, so it is evaluated here rather than handed to a worker.
  if (node.kind === "condition") {
    const record = dev.flows.startNode(run.id, node.id, null);
    try {
      const { value, because } = evaluateCondition(node.expression ?? "", steps);
      dev.flows.finishNode(record.id, "PASSED", String(value), because);
      return { status: "PASSED", output: String(value), detail: because, exitCode: null, branch: value };
    } catch (error) {
      const message = error instanceof FlowExpressionError ? error.message : (error as Error).message;
      dev.flows.finishNode(record.id, "FAILED", "", message);
      return { status: "FAILED", output: "", detail: message, exitCode: null };
    }
  }

  // Resolve references to earlier steps before anything is run, so a bad reference fails the step
  // cleanly instead of sending a half-substituted command to a shell.
  let command: string | null = null;
  let prompt = "";
  try {
    if (node.kind === "shell") command = interpolate(node.command ?? "", steps);
    else prompt = interpolate(node.prompt ?? "", steps);
  } catch (error) {
    const record = dev.flows.startNode(run.id, node.id, null);
    const message = (error as Error).message;
    dev.flows.finishNode(record.id, "FAILED", "", message);
    return { status: "FAILED", output: "", detail: message, exitCode: null };
  }

  const capability = node.kind === "shell" ? "shell" : ((node.capability as "code" | "plan" | "review" | "research") ?? "code");
  let worker;
  try {
    worker = (await dev.workers.select({ command, workerId: node.workerId ?? null }, { capability, requested: node.workerId ?? null })).worker;
  } catch (error) {
    const record = dev.flows.startNode(run.id, node.id, null);
    const message = (error as Error).message;
    dev.flows.finishNode(record.id, "FAILED", "", message);
    return { status: "FAILED", output: "", detail: message, exitCode: null };
  }

  const record = dev.flows.startNode(run.id, node.id, worker.id);
  let output = "";
  const controller = new AbortController();
  options.signal?.addEventListener("abort", () => controller.abort(), { once: true });

  const result = await worker.run({
    taskId: `${run.id}:${node.id}`,
    cwd: project.path as string,
    prompt,
    command,
    effort: "medium",
    reasoningEffort: (node.reasoningEffort as ReasoningEffort | null) ?? null,
    timeoutMs: dev.config.workers.timeoutMs,
    signal: controller.signal,
    readOnly: node.readOnly ?? false,
    onOutput: (chunk) => {
      output += chunk;
      // Bounded: a long-running command must not grow the row without limit.
      if (output.length > 100_000) output = output.slice(-100_000);
      options.onOutput?.(node.id, chunk);
    },
  });

  if (dev.workers.noteIfRateLimited(worker.id, result.summary)) {
    const message = `${worker.id} is out of quota: ${result.summary}`;
    dev.flows.finishNode(record.id, "FAILED", output.trim(), message);
    return { status: "FAILED", output: output.trim(), detail: message, exitCode: result.exitCode };
  }

  const status = result.cancelled ? "CANCELLED" : result.ok ? "PASSED" : "FAILED";
  const summary = node.kind === "prompt" ? result.summary : output.trim();
  const detail = result.ok
    ? null
    : result.timedOut
      ? `timed out after ${Math.round(result.durationMs / 1000)}s`
      : result.launchError
        ? result.launchError
        : `exit ${result.exitCode}: ${result.summary || "no output"}`;
  dev.flows.finishNode(record.id, status, summary, detail, worker.id);
  return { status, output: summary, detail, exitCode: result.exitCode };
}

/**
 * Poll the approval until a person resolves it, or the run is cancelled. Half a
 * second is quick enough that an answer in the app feels immediate and slow
 * enough that a run waiting overnight costs nothing.
 */
async function waitForAnswer(dev: Dev, approvalId: string, signal?: AbortSignal): Promise<{ status: "approved" | "denied"; note: string | null } | null> {
  for (;;) {
    if (signal?.aborted) return null;
    const current = dev.approvals.get(approvalId);
    if (!current) return null;
    if (current.status === "approved" || current.status === "denied") return { status: current.status, note: current.note };
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

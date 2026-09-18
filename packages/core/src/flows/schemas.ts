// Executable agent workflows: a graph of steps DEV can run end to end.
//
// A flow is deliberately not a task. A task is a unit of work with an outcome, verification and
// evidence; a flow is a procedure — "run this command, ask a model about the output, branch on the
// answer, do the next thing". They compose (a flow step can be any worker DEV has) but they are
// stored and run separately, because a flow has no acceptance criteria of its own and must not
// pretend to.
//
// Three node kinds in this version, each of which does real work:
//   * `shell`     — a command, run by the shell worker in the project directory
//   * `prompt`    — a brief for an agent worker, routed the same way a task is
//   * `condition` — a branch on what earlier steps produced
//
// Human-input and loop nodes are the next kinds; they are deliberately absent rather than present
// and inert, so nothing in the editor is a control that cannot work.

export const FLOW_NODE_KINDS = ["shell", "prompt", "condition"] as const;
export type FlowNodeKind = (typeof FLOW_NODE_KINDS)[number];

export const FLOW_RUN_STATUSES = ["RUNNING", "PASSED", "FAILED", "CANCELLED"] as const;
export type FlowRunStatus = (typeof FLOW_RUN_STATUSES)[number];

/**
 * A node's own outcome. `SKIPPED` is distinct from `PASSED`: a branch not taken did not succeed,
 * it never ran, and a run view that blurs the two lies about what happened.
 */
export const FLOW_NODE_STATUSES = ["PENDING", "RUNNING", "PASSED", "FAILED", "SKIPPED", "CANCELLED"] as const;
export type FlowNodeStatus = (typeof FLOW_NODE_STATUSES)[number];

export interface FlowNode {
  id: string;
  kind: FlowNodeKind;
  /** Shown on the canvas. Free text; defaults to something derived from the node's content. */
  label: string;
  /** Canvas position. Layout only — it never affects execution order, which comes from the edges. */
  x: number;
  y: number;

  // ----- shell -----
  /** The command to run. Required for `shell`, ignored otherwise. */
  command?: string | null;

  // ----- prompt -----
  /** The brief given to the worker. Required for `prompt`. May reference earlier nodes (see below). */
  prompt?: string | null;
  /** A specific worker, or null to route by capability the way a task does. */
  workerId?: string | null;
  /** Which kind of work this is, for routing. Defaults to "code". */
  capability?: string | null;
  /** How hard the model should think. null = the worker's own configured level. */
  reasoningEffort?: string | null;
  /** True when the step must not modify files — a review or analysis pass. */
  readOnly?: boolean;

  // ----- condition -----
  /**
   * The test, as a small expression over earlier nodes (see `evaluateCondition`). Required for
   * `condition`. Outgoing edges carry `when: "true" | "false"` to say which branch they are.
   */
  expression?: string | null;
}

export interface FlowEdge {
  id: string;
  from: string;
  to: string;
  /**
   * Which branch of a condition node this edge leaves by. null on edges from any other kind.
   * An edge out of a condition with no branch set is a defect the validator reports.
   */
  when?: "true" | "false" | null;
}

export interface Flow {
  id: string;
  projectId: string;
  name: string;
  description: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  createdAt: string;
  updatedAt: string;
}

export interface FlowNodeRun {
  id: string;
  runId: string;
  nodeId: string;
  status: FlowNodeStatus;
  /** What the step produced: command output, the agent's closing summary, or the branch taken. */
  output: string;
  /** Why it failed or was skipped, in the user's terms. null when it simply passed. */
  detail: string | null;
  /** The worker that ran it, for a prompt or shell node. */
  workerId: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface FlowRun {
  id: string;
  flowId: string;
  projectId: string;
  status: FlowRunStatus;
  /** Why the run ended as it did. */
  detail: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/** A problem with a flow's shape, found before anything is run. */
export interface FlowProblem {
  nodeId: string | null;
  edgeId: string | null;
  message: string;
}

/**
 * Check a flow can actually be run, and say plainly what is wrong when it cannot. This runs before
 * a flow executes and again in the editor, so a broken graph is visible while it is being drawn
 * rather than only when it fails halfway through.
 */
export function validateFlow(flow: Pick<Flow, "nodes" | "edges">): FlowProblem[] {
  const problems: FlowProblem[] = [];
  const ids = new Set(flow.nodes.map((n) => n.id));
  if (flow.nodes.length === 0) problems.push({ nodeId: null, edgeId: null, message: "A flow needs at least one step." });

  for (const node of flow.nodes) {
    if (node.kind === "shell" && !node.command?.trim()) problems.push({ nodeId: node.id, edgeId: null, message: `"${node.label}" is a command step with no command.` });
    if (node.kind === "prompt" && !node.prompt?.trim()) problems.push({ nodeId: node.id, edgeId: null, message: `"${node.label}" is a prompt step with no prompt.` });
    if (node.kind === "condition") {
      if (!node.expression?.trim()) problems.push({ nodeId: node.id, edgeId: null, message: `"${node.label}" is a condition with no test.` });
      const out = flow.edges.filter((e) => e.from === node.id);
      if (out.some((e) => e.when !== "true" && e.when !== "false")) {
        problems.push({ nodeId: node.id, edgeId: null, message: `Every arrow out of the condition "${node.label}" must be labelled true or false.` });
      }
    }
  }

  for (const edge of flow.edges) {
    if (!ids.has(edge.from)) problems.push({ nodeId: null, edgeId: edge.id, message: "An arrow starts from a step that no longer exists." });
    if (!ids.has(edge.to)) problems.push({ nodeId: null, edgeId: edge.id, message: "An arrow points at a step that no longer exists." });
  }

  for (const id of findCycle(flow)) {
    problems.push({ nodeId: id, edgeId: null, message: "These steps form a loop. Flows run forwards only until loop steps exist." });
  }

  const starts = flow.nodes.filter((n) => !flow.edges.some((e) => e.to === n.id));
  if (flow.nodes.length > 0 && starts.length === 0) problems.push({ nodeId: null, edgeId: null, message: "Every step has something before it, so there is nowhere to start." });

  return problems;
}

/** Node ids that take part in a cycle. Empty when the graph is a DAG. */
export function findCycle(flow: Pick<Flow, "nodes" | "edges">): string[] {
  const state = new Map<string, "open" | "done">();
  const inCycle = new Set<string>();
  const stack: string[] = [];
  const visit = (id: string): void => {
    const seen = state.get(id);
    if (seen === "done") return;
    if (seen === "open") {
      // Everything from this id up the stack is part of the loop.
      for (const member of stack.slice(stack.indexOf(id))) inCycle.add(member);
      return;
    }
    state.set(id, "open");
    stack.push(id);
    for (const edge of flow.edges.filter((e) => e.from === id)) visit(edge.to);
    stack.pop();
    state.set(id, "done");
  };
  for (const node of flow.nodes) visit(node.id);
  return [...inCycle];
}

/** Steps with nothing before them: where a run begins. */
export function startNodes(flow: Pick<Flow, "nodes" | "edges">): FlowNode[] {
  return flow.nodes.filter((n) => !flow.edges.some((e) => e.to === n.id));
}

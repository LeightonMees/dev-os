import type { EventBus } from "../events/bus.ts";
import { newId, now } from "../ids.ts";
import type { Db, Row } from "../persistence/db.ts";
import { json } from "../persistence/db.ts";

import { validateFlow, type Flow, type FlowEdge, type FlowNode, type FlowNodeRun, type FlowNodeStatus, type FlowRun, type FlowRunStatus } from "./schemas.ts";

export interface FlowInput {
  projectId: string;
  name: string;
  description?: string;
  nodes?: FlowNode[];
  edges?: FlowEdge[];
}

export interface FlowPatch {
  name?: string;
  description?: string;
  nodes?: FlowNode[];
  edges?: FlowEdge[];
}

/**
 * Flows and their run history.
 *
 * A flow is stored as its graph, not as a script: the nodes and edges the user drew are exactly
 * what is persisted, so the canvas and the engine can never disagree about what the flow is. Runs
 * are stored separately and never rewrite the flow, so editing a flow leaves its history intact and
 * an old run still says what it actually did rather than what the flow says today.
 */
export class FlowStore {
  readonly #db: Db;
  readonly #events: EventBus;

  constructor(db: Db, events: EventBus) {
    this.#db = db;
    this.#events = events;
  }

  create(input: FlowInput): Flow {
    if (!input.name?.trim()) throw new Error("A flow needs a name");
    const project = this.#db.get("SELECT id FROM projects WHERE id = ?", input.projectId);
    if (!project) throw new Error(`Unknown project ${input.projectId}`);
    const ts = now();
    const flow: Flow = {
      id: newId("flw"),
      projectId: input.projectId,
      name: input.name.trim(),
      description: input.description?.trim() ?? "",
      nodes: input.nodes ?? [],
      edges: input.edges ?? [],
      createdAt: ts,
      updatedAt: ts,
    };
    this.#db.run(
      "INSERT INTO flows (id, project_id, name, description, nodes_json, edges_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      flow.id,
      flow.projectId,
      flow.name,
      flow.description,
      JSON.stringify(flow.nodes),
      JSON.stringify(flow.edges),
      flow.createdAt,
      flow.updatedAt,
    );
    this.#events.emit("FLOW_SAVED", { projectId: flow.projectId, data: { flowId: flow.id, name: flow.name, created: true } });
    return flow;
  }

  update(id: string, patch: FlowPatch): Flow {
    const current = this.get(id);
    if (!current) throw new Error(`Unknown flow ${id}`);
    const next: Flow = {
      ...current,
      name: patch.name?.trim() || current.name,
      description: patch.description ?? current.description,
      nodes: patch.nodes ?? current.nodes,
      edges: patch.edges ?? current.edges,
      updatedAt: now(),
    };
    this.#db.run(
      "UPDATE flows SET name = ?, description = ?, nodes_json = ?, edges_json = ?, updated_at = ? WHERE id = ?",
      next.name,
      next.description,
      JSON.stringify(next.nodes),
      JSON.stringify(next.edges),
      next.updatedAt,
      id,
    );
    this.#events.emit("FLOW_SAVED", { projectId: next.projectId, data: { flowId: next.id, name: next.name, created: false } });
    return next;
  }

  remove(id: string): void {
    const flow = this.get(id);
    if (!flow) return;
    this.#db.run("DELETE FROM flows WHERE id = ?", id);
    this.#events.emit("FLOW_DELETED", { projectId: flow.projectId, data: { flowId: id, name: flow.name } });
  }

  get(id: string): Flow | undefined {
    const row = this.#db.get("SELECT * FROM flows WHERE id = ?", id);
    return row ? rowToFlow(row) : undefined;
  }

  list(projectId?: string | null): Flow[] {
    const rows = projectId
      ? this.#db.all("SELECT * FROM flows WHERE project_id = ? ORDER BY updated_at DESC", projectId)
      : this.#db.all("SELECT * FROM flows ORDER BY updated_at DESC");
    return rows.map(rowToFlow);
  }

  /** Whether this flow can be run right now, and what is wrong if not. */
  problems(id: string) {
    const flow = this.get(id);
    if (!flow) throw new Error(`Unknown flow ${id}`);
    return validateFlow(flow);
  }

  // ----- runs -----

  startRun(flow: Flow): FlowRun {
    const run: FlowRun = { id: newId("fr"), flowId: flow.id, projectId: flow.projectId, status: "RUNNING", detail: null, startedAt: now(), finishedAt: null };
    this.#db.run(
      "INSERT INTO flow_runs (id, flow_id, project_id, status, detail, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      run.id,
      run.flowId,
      run.projectId,
      run.status,
      run.detail,
      run.startedAt,
      run.finishedAt,
    );
    return run;
  }

  finishRun(runId: string, status: FlowRunStatus, detail: string | null): void {
    this.#db.run("UPDATE flow_runs SET status = ?, detail = ?, finished_at = ? WHERE id = ?", status, detail, now(), runId);
  }

  startNode(runId: string, nodeId: string, workerId: string | null): FlowNodeRun {
    const node: FlowNodeRun = { id: newId("fnr"), runId, nodeId, status: "RUNNING", output: "", detail: null, workerId, startedAt: now(), finishedAt: null };
    this.#db.run(
      "INSERT INTO flow_node_runs (id, run_id, node_id, status, output, detail, worker_id, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      node.id,
      node.runId,
      node.nodeId,
      node.status,
      node.output,
      node.detail,
      node.workerId,
      node.startedAt,
      node.finishedAt,
    );
    return node;
  }

  finishNode(id: string, status: FlowNodeStatus, output: string, detail: string | null, workerId?: string | null): void {
    this.#db.run(
      "UPDATE flow_node_runs SET status = ?, output = ?, detail = ?, worker_id = COALESCE(?, worker_id), finished_at = ? WHERE id = ?",
      status,
      output,
      detail,
      workerId ?? null,
      now(),
      id,
    );
  }

  /** A step that never ran because its branch was not taken. Recorded, not omitted. */
  recordSkipped(runId: string, nodeId: string, detail: string): void {
    const ts = now();
    this.#db.run(
      "INSERT INTO flow_node_runs (id, run_id, node_id, status, output, detail, worker_id, started_at, finished_at) VALUES (?, ?, ?, 'SKIPPED', '', ?, NULL, ?, ?)",
      newId("fnr"),
      runId,
      nodeId,
      detail,
      ts,
      ts,
    );
  }

  run(id: string): FlowRun | undefined {
    const row = this.#db.get("SELECT * FROM flow_runs WHERE id = ?", id);
    return row ? rowToRun(row) : undefined;
  }

  runs(flowId: string, limit = 20): FlowRun[] {
    return this.#db.all("SELECT * FROM flow_runs WHERE flow_id = ? ORDER BY started_at DESC LIMIT ?", flowId, limit).map(rowToRun);
  }

  nodeRuns(runId: string): FlowNodeRun[] {
    return this.#db.all("SELECT * FROM flow_node_runs WHERE run_id = ? ORDER BY started_at ASC", runId).map(rowToNodeRun);
  }

  /** Runs still marked running, so a control-plane restart can reap what it abandoned. */
  running(): FlowRun[] {
    return this.#db.all("SELECT * FROM flow_runs WHERE status = 'RUNNING'").map(rowToRun);
  }
}

function rowToFlow(row: Row): Flow {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    name: String(row.name),
    description: String(row.description ?? ""),
    nodes: json<FlowNode[]>(row.nodes_json, []),
    edges: json<FlowEdge[]>(row.edges_json, []),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function rowToRun(row: Row): FlowRun {
  return {
    id: String(row.id),
    flowId: String(row.flow_id),
    projectId: String(row.project_id),
    status: String(row.status) as FlowRunStatus,
    detail: (row.detail as string | null) ?? null,
    startedAt: String(row.started_at),
    finishedAt: (row.finished_at as string | null) ?? null,
  };
}

function rowToNodeRun(row: Row): FlowNodeRun {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    nodeId: String(row.node_id),
    status: String(row.status) as FlowNodeStatus,
    output: String(row.output ?? ""),
    detail: (row.detail as string | null) ?? null,
    workerId: (row.worker_id as string | null) ?? null,
    startedAt: String(row.started_at),
    finishedAt: (row.finished_at as string | null) ?? null,
  };
}

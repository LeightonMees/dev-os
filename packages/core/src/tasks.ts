import type { EventBus } from "./events/bus.ts";
import { newId, now } from "./ids.ts";
import type { Db, Row } from "./persistence/db.ts";
import { json } from "./persistence/db.ts";
import {
  TASK_STATUSES,
  type CapabilityRef,
  type Effort,
  type ReasoningEffort,
  type Task,
  type TaskFailure,
  type TaskKind,
  type TaskRisk,
  type TaskStatus,
  type VerificationSpec,
} from "./schemas.ts";

/** Legal status moves. Anything not listed is rejected with a readable error. */
export const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  BACKLOG: ["READY", "CANCELLED"],
  READY: ["WORKING", "BACKLOG", "BLOCKED", "CANCELLED"],
  // READY: a cancelled run returns the task to the queue rather than throwing it away.
  WORKING: ["REVIEW", "DONE", "BLOCKED", "READY", "CANCELLED"],
  BLOCKED: ["READY", "CANCELLED"],
  REVIEW: ["DONE", "BLOCKED", "READY", "CANCELLED"],
  DONE: ["READY"],
  CANCELLED: ["BACKLOG"],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTaskStatus(value: string): value is TaskStatus {
  return (TASK_STATUSES as readonly string[]).includes(value);
}

export interface TaskInput {
  projectId: string;
  title: string;
  milestone?: string | null;
  epic?: string | null;
  kind?: TaskKind;
  risk?: TaskRisk;
  needsHuman?: string | null;
  outcome?: string;
  requirements?: string[];
  acceptance?: string[];
  status?: TaskStatus;
  dependsOn?: string[];
  workerId?: string | null;
  capabilities?: CapabilityRef[];
  effort?: Effort;
  reasoningEffort?: ReasoningEffort | null;
  command?: string | null;
  files?: string[];
  verification?: VerificationSpec[];
}

export interface TaskPatch {
  title?: string;
  milestone?: string | null;
  epic?: string | null;
  kind?: TaskKind;
  risk?: TaskRisk;
  needsHuman?: string | null;
  outcome?: string;
  requirements?: string[];
  acceptance?: string[];
  workerId?: string | null;
  capabilities?: CapabilityRef[];
  effort?: Effort;
  reasoningEffort?: ReasoningEffort | null;
  command?: string | null;
  /** null clears the override and returns the task to assembled context. */
  promptOverride?: string | null;
  files?: string[];
  verification?: VerificationSpec[];
  resultSummary?: string | null;
  failure?: TaskFailure | null;
  retryCount?: number;
}

export interface TaskFilter {
  projectId?: string;
  status?: TaskStatus | TaskStatus[];
  milestone?: string;
  epic?: string;
  kind?: TaskKind;
  /** Cap on rows. `null` means no cap (autopilot must see the whole backlog). Default 500. */
  limit?: number | null;
}

export class TaskStore {
  readonly #db: Db;
  readonly #events: EventBus;

  constructor(db: Db, events: EventBus) {
    this.#db = db;
    this.#events = events;
  }

  create(input: TaskInput): Task {
    if (!input.title?.trim()) throw new Error("A task needs a title");
    const project = this.#db.get("SELECT id FROM projects WHERE id = ?", input.projectId);
    if (!project) throw new Error(`Unknown project ${input.projectId}`);
    const ts = now();
    const ordinal = Number(this.#db.get("SELECT COALESCE(MAX(ordinal), 0) + 1 AS n FROM tasks WHERE project_id = ?", input.projectId)?.n ?? 1);
    const task: Task = {
      id: newId("tsk"),
      projectId: input.projectId,
      title: input.title.trim(),
      milestone: input.milestone?.trim() || null,
      epic: input.epic?.trim() || null,
      kind: input.kind ?? "ticket",
      risk: input.risk ?? "normal",
      needsHuman: input.needsHuman?.trim() || null,
      outcome: input.outcome?.trim() ?? "",
      requirements: input.requirements ?? [],
      acceptance: input.acceptance ?? [],
      status: input.status ?? "BACKLOG",
      dependsOn: [],
      workerId: input.workerId ?? null,
      capabilities: input.capabilities ?? [],
      effort: input.effort ?? "medium",
      reasoningEffort: input.reasoningEffort ?? null,
      command: input.command ?? null,
      promptOverride: null,
      files: input.files ?? [],
      verification: input.verification ?? [],
      resultSummary: null,
      failure: null,
      retryCount: 0,
      ordinal,
      createdAt: ts,
      updatedAt: ts,
    };
    this.#db.transaction(() => {
      this.#db.run(
        `INSERT INTO tasks (id, project_id, title, milestone, epic, kind, risk, needs_human, outcome, requirements_json, acceptance_json, status, worker_id, capabilities_json, effort, reasoning_effort, command, files_json, verification_json, ordinal, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        task.id,
        task.projectId,
        task.title,
        task.milestone,
        task.epic,
        task.kind,
        task.risk,
        task.needsHuman,
        task.outcome,
        JSON.stringify(task.requirements),
        JSON.stringify(task.acceptance),
        task.status,
        task.workerId,
        JSON.stringify(task.capabilities),
        task.effort,
        task.reasoningEffort,
        task.command,
        JSON.stringify(task.files),
        JSON.stringify(task.verification),
        task.ordinal,
        ts,
        ts,
      );
      for (const dep of input.dependsOn ?? []) this.#insertDependency(task.id, dep);
    });
    task.dependsOn = this.dependencies(task.id);
    this.#events.emit("TASK_CREATED", { projectId: task.projectId, taskId: task.id, data: { title: task.title, status: task.status } });
    this.#touchProject(task.projectId);
    return task;
  }

  get(id: string): Task | undefined {
    const row = this.#db.get("SELECT * FROM tasks WHERE id = ?", id);
    if (!row) return undefined;
    return this.#hydrate(row);
  }

  /** Accept a full id or a unique prefix / ordinal number within a project. */
  resolve(ref: string, projectId?: string): Task | undefined {
    const direct = this.get(ref);
    if (direct) return direct;
    if (projectId && /^\d+$/.test(ref)) {
      const row = this.#db.get("SELECT * FROM tasks WHERE project_id = ? AND ordinal = ?", projectId, Number(ref));
      if (row) return this.#hydrate(row);
    }
    const rows = projectId
      ? this.#db.all("SELECT * FROM tasks WHERE project_id = ? AND id LIKE ?", projectId, `${ref}%`)
      : this.#db.all("SELECT * FROM tasks WHERE id LIKE ?", `${ref}%`);
    if (rows.length === 1) return this.#hydrate(rows[0] as Row);
    return undefined;
  }

  list(filter: TaskFilter = {}): Task[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.projectId) {
      where.push("project_id = ?");
      params.push(filter.projectId);
    }
    if (filter.status) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      where.push(`status IN (${statuses.map(() => "?").join(",")})`);
      params.push(...statuses);
    }
    if (filter.milestone) {
      where.push("milestone = ?");
      params.push(filter.milestone);
    }
    if (filter.epic) {
      where.push("epic = ?");
      params.push(filter.epic);
    }
    if (filter.kind) {
      where.push("kind = ?");
      params.push(filter.kind);
    }
    const unlimited = filter.limit === null;
    const sql = `SELECT * FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY ordinal ASC, created_at ASC${unlimited ? "" : " LIMIT ?"}`;
    const rows = unlimited ? this.#db.all(sql, ...params) : this.#db.all(sql, ...params, filter.limit ?? 500);
    return rows.map((row) => this.#hydrate(row));
  }

  update(id: string, patch: TaskPatch): Task {
    const current = this.get(id);
    if (!current) throw new Error(`Unknown task ${id}`);
    const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    const next: Task = { ...current, ...defined, updatedAt: now() } as Task;
    this.#db.run(
      `UPDATE tasks SET title = ?, milestone = ?, epic = ?, kind = ?, risk = ?, needs_human = ?, outcome = ?, requirements_json = ?, acceptance_json = ?, worker_id = ?, capabilities_json = ?, effort = ?, reasoning_effort = ?, command = ?, files_json = ?, verification_json = ?, result_summary = ?, failure_json = ?, retry_count = ?, prompt_override = ?, updated_at = ? WHERE id = ?`,
      next.title,
      next.milestone,
      next.epic,
      next.kind,
      next.risk,
      next.needsHuman,
      next.outcome,
      JSON.stringify(next.requirements),
      JSON.stringify(next.acceptance),
      next.workerId,
      JSON.stringify(next.capabilities),
      next.effort,
      next.reasoningEffort,
      next.command,
      JSON.stringify(next.files),
      JSON.stringify(next.verification),
      next.resultSummary,
      next.failure ? JSON.stringify(next.failure) : null,
      next.retryCount,
      next.promptOverride ?? null,
      next.updatedAt,
      id,
    );
    this.#events.emit("TASK_UPDATED", { projectId: next.projectId, taskId: id, data: { fields: Object.keys(defined) } });
    this.#touchProject(next.projectId);
    return next;
  }

  remove(id: string): void {
    const task = this.get(id);
    if (!task) throw new Error(`Unknown task ${id}`);
    this.#db.run("DELETE FROM tasks WHERE id = ?", id);
    this.#events.emit("TASK_DELETED", { projectId: task.projectId, taskId: id, data: { title: task.title } });
  }

  // ----- state machine -----

  /**
   * Move a task. Rules:
   *  - the move must be in TRANSITIONS
   *  - READY requires every dependency DONE (unless force)
   *  - DONE requires at least one passing evidence record (unless force)
   * On DONE, dependents whose dependencies are all DONE are promoted BACKLOG -> READY.
   */
  setStatus(id: string, to: TaskStatus, options: { reason?: string; force?: boolean; failure?: TaskFailure | null; resultSummary?: string } = {}): Task {
    const task = this.get(id);
    if (!task) throw new Error(`Unknown task ${id}`);
    const from = task.status;
    if (from === to) return task;
    if (!canTransition(from, to)) {
      throw new Error(`Cannot move task ${id} from ${from} to ${to}. Allowed: ${TRANSITIONS[from].join(", ") || "none"}`);
    }
    if (to === "READY" && !options.force) {
      const unmet = this.unmetDependencies(id);
      if (unmet.length > 0) {
        throw new Error(`Task ${id} still depends on ${unmet.map((t) => `${t.id} (${t.status})`).join(", ")}. Finish those first or use --force.`);
      }
    }
    if (to === "DONE" && !options.force) {
      const passing = this.#db.get("SELECT COUNT(*) AS n FROM evidence WHERE task_id = ? AND passed = 1", id);
      if (Number(passing?.n ?? 0) === 0) {
        throw new Error(`Task ${id} has no passing evidence. Run it, or approve it with a reason (that records human-approval evidence).`);
      }
    }
    const ts = now();
    const failure = to === "BLOCKED" ? (options.failure ?? task.failure) : to === "DONE" || to === "READY" ? null : task.failure;
    const resultSummary = options.resultSummary ?? task.resultSummary;
    this.#db.run(
      "UPDATE tasks SET status = ?, failure_json = ?, result_summary = ?, updated_at = ? WHERE id = ?",
      to,
      failure ? JSON.stringify(failure) : null,
      resultSummary,
      ts,
      id,
    );
    this.#events.emit("TASK_STATUS_CHANGED", { projectId: task.projectId, taskId: id, data: { from, to, reason: options.reason ?? null } });
    if (to === "BLOCKED") this.#events.emit("TASK_BLOCKED", { projectId: task.projectId, taskId: id, data: { failure } });
    if (to === "DONE") {
      this.#events.emit("TASK_COMPLETED", { projectId: task.projectId, taskId: id, data: { title: task.title } });
      this.promoteDependents(id);
    }
    if (to === "CANCELLED") this.#events.emit("TASK_CANCELLED", { projectId: task.projectId, taskId: id, data: { reason: options.reason ?? null } });
    this.#touchProject(task.projectId);
    return this.get(id) as Task;
  }

  /** BLOCKED -> READY with the retry counter bumped. */
  retry(id: string): Task {
    const task = this.get(id);
    if (!task) throw new Error(`Unknown task ${id}`);
    if (task.status !== "BLOCKED" && task.status !== "REVIEW") {
      throw new Error(`Only BLOCKED or REVIEW tasks can be retried (task is ${task.status})`);
    }
    this.#db.run("UPDATE tasks SET retry_count = retry_count + 1 WHERE id = ?", id);
    return this.setStatus(id, "READY", { reason: "retry", force: true });
  }

  block(id: string, failure: Omit<TaskFailure, "at">): Task {
    return this.setStatus(id, "BLOCKED", { failure: { ...failure, at: now() }, reason: failure.kind });
  }

  // ----- dependency graph -----

  addDependency(taskId: string, dependsOnId: string): void {
    if (taskId === dependsOnId) throw new Error("A task cannot depend on itself");
    const a = this.get(taskId);
    const b = this.get(dependsOnId);
    if (!a) throw new Error(`Unknown task ${taskId}`);
    if (!b) throw new Error(`Unknown task ${dependsOnId}`);
    if (a.projectId !== b.projectId) throw new Error("Dependencies must stay inside one project");
    if (this.#reaches(dependsOnId, taskId)) {
      throw new Error(`Adding ${taskId} -> ${dependsOnId} would create a cycle`);
    }
    this.#insertDependency(taskId, dependsOnId);
    this.#events.emit("TASK_UPDATED", { projectId: a.projectId, taskId, data: { fields: ["dependsOn"], added: dependsOnId } });
  }

  removeDependency(taskId: string, dependsOnId: string): void {
    this.#db.run("DELETE FROM task_dependencies WHERE task_id = ? AND depends_on_id = ?", taskId, dependsOnId);
    const task = this.get(taskId);
    if (task) this.#events.emit("TASK_UPDATED", { projectId: task.projectId, taskId, data: { fields: ["dependsOn"], removed: dependsOnId } });
  }

  dependencies(taskId: string): string[] {
    return this.#db.all("SELECT depends_on_id FROM task_dependencies WHERE task_id = ? ORDER BY depends_on_id", taskId).map((r) => String(r.depends_on_id));
  }

  dependents(taskId: string): string[] {
    return this.#db.all("SELECT task_id FROM task_dependencies WHERE depends_on_id = ? ORDER BY task_id", taskId).map((r) => String(r.task_id));
  }

  unmetDependencies(taskId: string): Task[] {
    return this.dependencies(taskId)
      .map((dep) => this.get(dep))
      .filter((t): t is Task => !!t && t.status !== "DONE");
  }

  /** READY tasks whose dependencies are all DONE: the ones DEV may execute now. */
  runnable(projectId?: string): Task[] {
    return this.list({ projectId, status: "READY" }).filter((t) => this.unmetDependencies(t.id).length === 0);
  }

  /** Dependents of a finished task that are now unblocked move BACKLOG -> READY. */
  promoteDependents(taskId: string): Task[] {
    const promoted: Task[] = [];
    for (const depId of this.dependents(taskId)) {
      const dep = this.get(depId);
      if (!dep || dep.status !== "BACKLOG") continue;
      if (this.unmetDependencies(depId).length > 0) continue;
      this.#db.run("UPDATE tasks SET status = 'READY', updated_at = ? WHERE id = ?", now(), depId);
      this.#events.emit("TASK_STATUS_CHANGED", { projectId: dep.projectId, taskId: depId, data: { from: "BACKLOG", to: "READY", reason: `dependency ${taskId} done` } });
      this.#events.emit("TASK_READY", { projectId: dep.projectId, taskId: depId, data: { because: taskId } });
      promoted.push(this.get(depId) as Task);
    }
    return promoted;
  }

  /** Topological order of a project's tasks (dependencies first). */
  order(projectId: string): Task[] {
    const tasks = this.list({ projectId });
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const seen = new Set<string>();
    const out: Task[] = [];
    const visit = (t: Task) => {
      if (seen.has(t.id)) return;
      seen.add(t.id);
      for (const dep of t.dependsOn) {
        const d = byId.get(dep);
        if (d) visit(d);
      }
      out.push(t);
    };
    for (const t of tasks) visit(t);
    return out;
  }

  /** Milestones and epics in a project with per-status counts, in first-seen order. */
  structure(projectId: string): { milestones: { name: string; counts: Record<TaskStatus, number>; epics: { name: string; counts: Record<TaskStatus, number> }[] }[]; unassigned: number } {
    const tasks = this.list({ projectId });
    const empty = () => Object.fromEntries(TASK_STATUSES.map((s) => [s, 0])) as Record<TaskStatus, number>;
    const milestones = new Map<string, { name: string; counts: Record<TaskStatus, number>; epics: Map<string, { name: string; counts: Record<TaskStatus, number> }> }>();
    let unassigned = 0;
    for (const t of tasks) {
      if (!t.milestone) {
        unassigned++;
        continue;
      }
      const m = milestones.get(t.milestone) ?? { name: t.milestone, counts: empty(), epics: new Map() };
      m.counts[t.status]++;
      if (t.epic) {
        const e = m.epics.get(t.epic) ?? { name: t.epic, counts: empty() };
        e.counts[t.status]++;
        m.epics.set(t.epic, e);
      }
      milestones.set(t.milestone, m);
    }
    return { milestones: Array.from(milestones.values()).map((m) => ({ name: m.name, counts: m.counts, epics: Array.from(m.epics.values()) })), unassigned };
  }

  counts(projectId?: string): Record<TaskStatus, number> {
    const rows = projectId
      ? this.#db.all("SELECT status, COUNT(*) AS n FROM tasks WHERE project_id = ? GROUP BY status", projectId)
      : this.#db.all("SELECT status, COUNT(*) AS n FROM tasks GROUP BY status");
    const counts = Object.fromEntries(TASK_STATUSES.map((s) => [s, 0])) as Record<TaskStatus, number>;
    for (const row of rows) counts[row.status as TaskStatus] = Number(row.n);
    return counts;
  }

  // ----- internals -----

  #insertDependency(taskId: string, dependsOnId: string): void {
    const exists = this.#db.get("SELECT 1 FROM tasks WHERE id = ?", dependsOnId);
    if (!exists) throw new Error(`Unknown dependency task ${dependsOnId}`);
    this.#db.run("INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_id) VALUES (?, ?)", taskId, dependsOnId);
  }

  /** Does `from` reach `to` by following dependency edges? */
  #reaches(from: string, to: string): boolean {
    const stack = [from];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (current === to) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      stack.push(...this.dependencies(current));
    }
    return false;
  }

  #touchProject(projectId: string): void {
    this.#db.run("UPDATE projects SET updated_at = ? WHERE id = ?", now(), projectId);
  }

  #hydrate(row: Row): Task {
    const task = rowToTask(row);
    task.dependsOn = this.dependencies(task.id);
    return task;
  }
}

export function rowToTask(row: Row): Task {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    title: String(row.title),
    milestone: (row.milestone as string | null) ?? null,
    epic: (row.epic as string | null) ?? null,
    kind: ((row.kind as TaskKind | null) ?? "ticket") as TaskKind,
    risk: ((row.risk as TaskRisk | null) ?? "normal") as TaskRisk,
    needsHuman: (row.needs_human as string | null) ?? null,
    outcome: String(row.outcome ?? ""),
    requirements: json<string[]>(row.requirements_json, []),
    acceptance: json<string[]>(row.acceptance_json, []),
    status: row.status as TaskStatus,
    dependsOn: [],
    workerId: (row.worker_id as string | null) ?? null,
    capabilities: json<CapabilityRef[]>(row.capabilities_json, []),
    effort: (row.effort as Effort) ?? "medium",
    reasoningEffort: (row.reasoning_effort as ReasoningEffort | null) ?? null,
    command: (row.command as string | null) ?? null,
    promptOverride: (row.prompt_override as string | null) ?? null,
    files: json<string[]>(row.files_json, []),
    verification: json<VerificationSpec[]>(row.verification_json, []),
    resultSummary: (row.result_summary as string | null) ?? null,
    failure: json<TaskFailure | null>(row.failure_json, null),
    retryCount: Number(row.retry_count ?? 0),
    ordinal: Number(row.ordinal ?? 0),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

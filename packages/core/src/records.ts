// Decisions, artifacts, evidence, approvals, executions and context snapshots.
// Small stores with the same shape: create / get / list, JSON columns hydrated.

import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

import type { EventBus } from "./events/bus.ts";
import { newId, now } from "./ids.ts";
import type { Db, Row } from "./persistence/db.ts";
import { json } from "./persistence/db.ts";
import type {
  Approval,
  ApprovalStatus,
  Artifact,
  ArtifactKind,
  ContextSection,
  ContextSnapshot,
  Decision,
  Evidence,
  EvidenceKind,
  Execution,
  ExecutionStatus,
} from "./schemas.ts";

// ---------- decisions ----------

export class DecisionStore {
  readonly db: Db;
  readonly events: EventBus;

  constructor(db: Db, events: EventBus) {
    this.db = db;
    this.events = events;
  }

  record(input: { projectId: string; title: string; decision: string; reason?: string; alternatives?: string[]; tags?: string[]; revisit?: string | null }): Decision {
    const decision: Decision = {
      id: newId("dec"),
      projectId: input.projectId,
      title: input.title.trim(),
      decision: input.decision.trim(),
      reason: input.reason?.trim() ?? "",
      alternatives: input.alternatives ?? [],
      tags: (input.tags ?? []).map((t) => t.toLowerCase()),
      revisit: input.revisit ?? null,
      createdAt: now(),
    };
    this.db.run(
      "INSERT INTO decisions (id, project_id, title, decision, reason, alternatives_json, tags_json, revisit, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      decision.id,
      decision.projectId,
      decision.title,
      decision.decision,
      decision.reason,
      JSON.stringify(decision.alternatives),
      JSON.stringify(decision.tags),
      decision.revisit,
      decision.createdAt,
    );
    this.events.emit("DECISION_RECORDED", { projectId: input.projectId, data: { id: decision.id, title: decision.title } });
    return decision;
  }

  get(id: string): Decision | undefined {
    const row = this.db.get("SELECT * FROM decisions WHERE id = ?", id);
    return row ? rowToDecision(row) : undefined;
  }

  list(projectId: string): Decision[] {
    return this.db.all("SELECT * FROM decisions WHERE project_id = ? ORDER BY created_at DESC", projectId).map(rowToDecision);
  }

  /** Decisions whose title/tags/decision share words with the query. Cheap keyword relevance. */
  relevant(projectId: string, query: string, limit = 5): Decision[] {
    const words = keywords(query);
    if (words.length === 0) return [];
    return this.list(projectId)
      .map((d) => {
        const hay = `${d.title} ${d.tags.join(" ")} ${d.decision}`.toLowerCase();
        const score = words.reduce((n, w) => n + (hay.includes(w) ? 1 : 0), 0);
        return { d, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.d);
  }

  remove(id: string): void {
    this.db.run("DELETE FROM decisions WHERE id = ?", id);
  }
}

export function keywords(text: string): string[] {
  const stop = new Set(["the", "a", "an", "and", "or", "to", "of", "in", "for", "on", "with", "add", "make", "use", "this", "that", "is", "are", "it", "be", "as", "by", "from", "at"]);
  return Array.from(new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !stop.has(w))));
}

function rowToDecision(row: Row): Decision {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    title: String(row.title),
    decision: String(row.decision),
    reason: String(row.reason ?? ""),
    alternatives: json<string[]>(row.alternatives_json, []),
    tags: json<string[]>(row.tags_json, []),
    revisit: (row.revisit as string | null) ?? null,
    createdAt: String(row.created_at),
  };
}

// ---------- artifacts ----------

export class ArtifactStore {
  readonly db: Db;
  readonly events: EventBus;

  constructor(db: Db, events: EventBus) {
    this.db = db;
    this.events = events;
  }

  add(input: { projectId: string; taskId?: string | null; executionId?: string | null; kind: ArtifactKind; name: string; path: string; meta?: Record<string, unknown> }): Artifact {
    const size = existsSync(input.path) ? statSync(input.path).size : 0;
    const artifact: Artifact = {
      id: newId("art"),
      projectId: input.projectId,
      taskId: input.taskId ?? null,
      executionId: input.executionId ?? null,
      kind: input.kind,
      name: input.name,
      path: input.path,
      size,
      createdAt: now(),
      meta: input.meta ?? {},
    };
    this.db.run(
      "INSERT INTO artifacts (id, project_id, task_id, execution_id, kind, name, path, size, created_at, meta_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      artifact.id,
      artifact.projectId,
      artifact.taskId,
      artifact.executionId,
      artifact.kind,
      artifact.name,
      artifact.path,
      artifact.size,
      artifact.createdAt,
      JSON.stringify(artifact.meta),
    );
    this.events.emit("ARTIFACT_CREATED", {
      projectId: artifact.projectId,
      taskId: artifact.taskId,
      executionId: artifact.executionId,
      data: { id: artifact.id, kind: artifact.kind, name: artifact.name, size },
    });
    return artifact;
  }

  get(id: string): Artifact | undefined {
    const row = this.db.get("SELECT * FROM artifacts WHERE id = ?", id);
    return row ? rowToArtifact(row) : undefined;
  }

  /**
   * Save an edited copy of a text artifact. The original file is never touched:
   * a worker's output stays exactly as the worker wrote it, so evidence that
   * cites an execution keeps pointing at what actually ran. The edit becomes
   * the next version in a chain, written beside its original as `name.vN.ext`.
   */
  revise(id: string, content: string): Artifact {
    const source = this.get(id);
    if (!source) throw new Error(`Unknown artifact ${id}`);
    const rootId = typeof source.meta.rootId === "string" ? source.meta.rootId : source.id;
    const version = this.versions(rootId).length + 1;
    const ext = extname(source.path);
    const base = basename(source.path, ext);
    const path = join(dirname(source.path), `${base}.v${version}${ext}`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
    return this.add({
      projectId: source.projectId,
      taskId: source.taskId,
      executionId: source.executionId,
      kind: source.kind,
      name: source.name,
      path,
      meta: { ...source.meta, rootId, version, revisedFrom: source.id },
    });
  }

  /** Every version of an artifact chain, oldest first. */
  versions(rootId: string): Artifact[] {
    return this.db
      .all("SELECT * FROM artifacts WHERE id = ? OR json_extract(meta_json, '$.rootId') = ? ORDER BY created_at ASC", rootId, rootId)
      .map(rowToArtifact);
  }

  list(filter: { projectId?: string; taskId?: string; executionId?: string; limit?: number } = {}): Artifact[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.projectId) { where.push("project_id = ?"); params.push(filter.projectId); }
    if (filter.taskId) { where.push("task_id = ?"); params.push(filter.taskId); }
    if (filter.executionId) { where.push("execution_id = ?"); params.push(filter.executionId); }
    return this.db
      .all(`SELECT * FROM artifacts ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC LIMIT ?`, ...params, filter.limit ?? 200)
      .map(rowToArtifact);
  }
}

function rowToArtifact(row: Row): Artifact {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    taskId: (row.task_id as string | null) ?? null,
    executionId: (row.execution_id as string | null) ?? null,
    kind: row.kind as ArtifactKind,
    name: String(row.name),
    path: String(row.path),
    size: Number(row.size ?? 0),
    createdAt: String(row.created_at),
    meta: json(row.meta_json, {}),
  };
}

// ---------- evidence ----------

export class EvidenceStore {
  readonly db: Db;
  readonly events: EventBus;

  constructor(db: Db, events: EventBus) {
    this.db = db;
    this.events = events;
  }

  record(input: { taskId: string; executionId?: string | null; kind: EvidenceKind; passed: boolean; summary: string; data?: Record<string, unknown>; artifactId?: string | null }): Evidence {
    const task = this.db.get("SELECT project_id FROM tasks WHERE id = ?", input.taskId);
    if (!task) throw new Error(`Unknown task ${input.taskId}`);
    const evidence: Evidence = {
      id: newId("evd"),
      taskId: input.taskId,
      executionId: input.executionId ?? null,
      kind: input.kind,
      passed: input.passed,
      summary: input.summary,
      data: input.data ?? {},
      artifactId: input.artifactId ?? null,
      createdAt: now(),
    };
    this.db.run(
      "INSERT INTO evidence (id, task_id, execution_id, kind, passed, summary, data_json, artifact_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      evidence.id,
      evidence.taskId,
      evidence.executionId,
      evidence.kind,
      evidence.passed ? 1 : 0,
      evidence.summary,
      JSON.stringify(evidence.data),
      evidence.artifactId,
      evidence.createdAt,
    );
    this.events.emit("EVIDENCE_RECORDED", {
      projectId: String(task.project_id),
      taskId: evidence.taskId,
      executionId: evidence.executionId,
      data: { id: evidence.id, kind: evidence.kind, passed: evidence.passed, summary: evidence.summary },
    });
    return evidence;
  }

  list(taskId: string): Evidence[] {
    return this.db.all("SELECT * FROM evidence WHERE task_id = ? ORDER BY created_at ASC", taskId).map(rowToEvidence);
  }

  forExecution(executionId: string): Evidence[] {
    return this.db.all("SELECT * FROM evidence WHERE execution_id = ? ORDER BY created_at ASC", executionId).map(rowToEvidence);
  }
}

function rowToEvidence(row: Row): Evidence {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    executionId: (row.execution_id as string | null) ?? null,
    kind: row.kind as EvidenceKind,
    passed: Number(row.passed) === 1,
    summary: String(row.summary),
    data: json(row.data_json, {}),
    artifactId: (row.artifact_id as string | null) ?? null,
    createdAt: String(row.created_at),
  };
}

// ---------- approvals ----------

export class ApprovalStore {
  readonly db: Db;
  readonly events: EventBus;

  constructor(db: Db, events: EventBus) {
    this.db = db;
    this.events = events;
  }

  request(input: { projectId?: string | null; taskId?: string | null; executionId?: string | null; action: string; reason?: string }): Approval {
    const approval: Approval = {
      id: newId("apr"),
      projectId: input.projectId ?? null,
      taskId: input.taskId ?? null,
      executionId: input.executionId ?? null,
      action: input.action,
      reason: input.reason ?? "",
      status: "pending",
      requestedAt: now(),
      resolvedAt: null,
      resolvedBy: null,
      note: null,
    };
    if (approval.taskId) this.db.run("UPDATE tasks SET needs_human = ?, updated_at = ? WHERE id = ?", approval.reason || approval.action, now(), approval.taskId);
    this.db.run(
      "INSERT INTO approvals (id, project_id, task_id, execution_id, action, reason, status, requested_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      approval.id,
      approval.projectId,
      approval.taskId,
      approval.executionId,
      approval.action,
      approval.reason,
      approval.status,
      approval.requestedAt,
    );
    this.events.emit("APPROVAL_REQUESTED", { projectId: approval.projectId, taskId: approval.taskId, executionId: approval.executionId, data: { id: approval.id, action: approval.action, reason: approval.reason } });
    return approval;
  }

  resolve(id: string, status: Exclude<ApprovalStatus, "pending">, by = "user", note: string | null = null): Approval {
    const current = this.get(id);
    if (!current) throw new Error(`Unknown approval ${id}`);
    if (current.status !== "pending") throw new Error(`Approval ${id} is already ${current.status}`);
    const ts = now();
    this.db.run("UPDATE approvals SET status = ?, resolved_at = ?, resolved_by = ?, note = ? WHERE id = ?", status, ts, by, note, id);
    if (current.taskId) {
      const task = this.db.get("SELECT needs_human FROM tasks WHERE id = ?", current.taskId);
      if (task && task.needs_human) this.db.run("UPDATE tasks SET needs_human = NULL, updated_at = ? WHERE id = ?", ts, current.taskId);
    }
    this.events.emit("APPROVAL_RESOLVED", { projectId: current.projectId, taskId: current.taskId, executionId: current.executionId, data: { id, status, by, note, action: current.action } });
    return { ...current, status, resolvedAt: ts, resolvedBy: by, note };
  }

  get(id: string): Approval | undefined {
    const row = this.db.get("SELECT * FROM approvals WHERE id = ?", id);
    return row ? rowToApproval(row) : undefined;
  }

  list(filter: { projectId?: string; status?: ApprovalStatus } = {}): Approval[] {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.projectId) { where.push("project_id = ?"); params.push(filter.projectId); }
    if (filter.status) { where.push("status = ?"); params.push(filter.status); }
    return this.db.all(`SELECT * FROM approvals ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY requested_at DESC LIMIT 200`, ...params).map(rowToApproval);
  }
}

function rowToApproval(row: Row): Approval {
  return {
    id: String(row.id),
    projectId: (row.project_id as string | null) ?? null,
    taskId: (row.task_id as string | null) ?? null,
    executionId: (row.execution_id as string | null) ?? null,
    action: String(row.action),
    reason: String(row.reason ?? ""),
    status: row.status as ApprovalStatus,
    requestedAt: String(row.requested_at),
    resolvedAt: (row.resolved_at as string | null) ?? null,
    resolvedBy: (row.resolved_by as string | null) ?? null,
    note: (row.note as string | null) ?? null,
  };
}

// ---------- executions ----------

export class ExecutionStore {
  readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  create(input: { taskId: string; projectId: string; workerId: string; cwd: string; command?: string | null; logPath?: string | null; contextSnapshotId?: string | null }): Execution {
    const execution: Execution = {
      id: newId("exe"),
      taskId: input.taskId,
      projectId: input.projectId,
      workerId: input.workerId,
      status: "running",
      startedAt: now(),
      finishedAt: null,
      exitCode: null,
      command: input.command ?? null,
      cwd: input.cwd,
      logPath: input.logPath ?? null,
      changedFiles: [],
      error: null,
      durationMs: null,
      contextSnapshotId: input.contextSnapshotId ?? null,
      summary: null,
      cancelRequested: false,
      usage: null,
    };
    this.db.run(
      "INSERT INTO executions (id, task_id, project_id, worker_id, status, started_at, command, cwd, log_path, context_snapshot_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      execution.id,
      execution.taskId,
      execution.projectId,
      execution.workerId,
      execution.status,
      execution.startedAt,
      execution.command,
      execution.cwd,
      execution.logPath,
      execution.contextSnapshotId,
    );
    return execution;
  }

  finish(id: string, patch: { status: ExecutionStatus; exitCode?: number | null; error?: string | null; changedFiles?: string[]; summary?: string | null; usage?: Record<string, unknown> | null; command?: string | null }): Execution {
    const current = this.get(id);
    if (!current) throw new Error(`Unknown execution ${id}`);
    const finishedAt = now();
    const durationMs = Math.max(0, Date.parse(finishedAt) - Date.parse(current.startedAt));
    this.db.run(
      "UPDATE executions SET status = ?, finished_at = ?, exit_code = ?, error = ?, changed_files_json = ?, duration_ms = ?, summary = ?, usage_json = ?, command = COALESCE(?, command) WHERE id = ?",
      patch.status,
      finishedAt,
      patch.exitCode ?? null,
      patch.error ?? null,
      JSON.stringify(patch.changedFiles ?? current.changedFiles),
      durationMs,
      patch.summary ?? current.summary,
      patch.usage ? JSON.stringify(patch.usage) : null,
      patch.command ?? null,
      id,
    );
    return this.get(id) as Execution;
  }

  setContextSnapshot(id: string, snapshotId: string): void {
    this.db.run("UPDATE executions SET context_snapshot_id = ? WHERE id = ?", snapshotId, id);
  }

  requestCancel(id: string): boolean {
    const result = this.db.run("UPDATE executions SET cancel_requested = 1 WHERE id = ? AND status = 'running'", id);
    return Number(result.changes) > 0;
  }

  cancelRequested(id: string): boolean {
    return Number(this.db.get("SELECT cancel_requested FROM executions WHERE id = ?", id)?.cancel_requested ?? 0) === 1;
  }

  get(id: string): Execution | undefined {
    const row = this.db.get("SELECT * FROM executions WHERE id = ?", id);
    return row ? rowToExecution(row) : undefined;
  }

  list(filter: { taskId?: string; projectId?: string; workerId?: string; status?: ExecutionStatus; limit?: number } = {}): Execution[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.taskId) { where.push("task_id = ?"); params.push(filter.taskId); }
    if (filter.projectId) { where.push("project_id = ?"); params.push(filter.projectId); }
    if (filter.workerId) { where.push("worker_id = ?"); params.push(filter.workerId); }
    if (filter.status) { where.push("status = ?"); params.push(filter.status); }
    return this.db
      .all(`SELECT * FROM executions ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY started_at DESC LIMIT ?`, ...params, filter.limit ?? 100)
      .map(rowToExecution);
  }

  /** Executions left "running" by a process that died. Mark them failed. */
  /**
   * Executions still marked running that nothing is running any more: the control plane restarted,
   * the machine rebooted, or the process crashed. Returns the tasks they belonged to so the caller
   * can take them out of WORKING — a task left WORKING with no live process is stuck forever.
   */
  reapStale(olderThanMs: number): { executionId: string; taskId: string }[] {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    const orphans = this.db.all("SELECT id, task_id FROM executions WHERE status = 'running' AND started_at < ?", cutoff).map((row) => ({ executionId: String(row.id), taskId: String(row.task_id) }));
    if (orphans.length === 0) return [];
    this.db.run(
      "UPDATE executions SET status = 'failed', finished_at = ?, error = 'execution abandoned: the process that ran it exited' WHERE status = 'running' AND started_at < ?",
      now(),
      cutoff,
    );
    return orphans;
  }

  workerStats(workerId: string): { executions: number; succeeded: number; failed: number; avgDurationMs: number | null; lastRunAt: string | null } {
    const row = this.db.get(
      "SELECT COUNT(*) AS n, SUM(status = 'succeeded') AS ok, SUM(status IN ('failed','timeout')) AS bad, AVG(duration_ms) AS avg, MAX(started_at) AS last FROM executions WHERE worker_id = ?",
      workerId,
    );
    return {
      executions: Number(row?.n ?? 0),
      succeeded: Number(row?.ok ?? 0),
      failed: Number(row?.bad ?? 0),
      avgDurationMs: row?.avg == null ? null : Math.round(Number(row.avg)),
      lastRunAt: (row?.last as string | null) ?? null,
    };
  }
}

export function rowToExecution(row: Row): Execution {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    projectId: String(row.project_id),
    workerId: String(row.worker_id),
    status: row.status as ExecutionStatus,
    startedAt: String(row.started_at),
    finishedAt: (row.finished_at as string | null) ?? null,
    exitCode: row.exit_code == null ? null : Number(row.exit_code),
    command: (row.command as string | null) ?? null,
    cwd: String(row.cwd),
    logPath: (row.log_path as string | null) ?? null,
    changedFiles: json<string[]>(row.changed_files_json, []),
    error: (row.error as string | null) ?? null,
    durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
    contextSnapshotId: (row.context_snapshot_id as string | null) ?? null,
    summary: (row.summary as string | null) ?? null,
    cancelRequested: Number(row.cancel_requested ?? 0) === 1,
    usage: json<Record<string, unknown> | null>(row.usage_json, null),
  };
}

// ---------- context snapshots ----------

export class ContextSnapshotStore {
  readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  save(input: { taskId: string; executionId?: string | null; budgetTokens: number; usedTokens: number; sections: ContextSection[] }): ContextSnapshot {
    const snapshot: ContextSnapshot = {
      id: newId("ctx"),
      taskId: input.taskId,
      executionId: input.executionId ?? null,
      budgetTokens: input.budgetTokens,
      usedTokens: input.usedTokens,
      sections: input.sections,
      createdAt: now(),
    };
    this.db.run(
      "INSERT INTO context_snapshots (id, task_id, execution_id, budget_tokens, used_tokens, sections_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      snapshot.id,
      snapshot.taskId,
      snapshot.executionId,
      snapshot.budgetTokens,
      snapshot.usedTokens,
      JSON.stringify(snapshot.sections),
      snapshot.createdAt,
    );
    return snapshot;
  }

  get(id: string): ContextSnapshot | undefined {
    const row = this.db.get("SELECT * FROM context_snapshots WHERE id = ?", id);
    return row ? rowToSnapshot(row) : undefined;
  }

  forTask(taskId: string): ContextSnapshot[] {
    return this.db.all("SELECT * FROM context_snapshots WHERE task_id = ? ORDER BY created_at DESC", taskId).map(rowToSnapshot);
  }
}

function rowToSnapshot(row: Row): ContextSnapshot {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    executionId: (row.execution_id as string | null) ?? null,
    budgetTokens: Number(row.budget_tokens),
    usedTokens: Number(row.used_tokens),
    sections: json<ContextSection[]>(row.sections_json, []),
    createdAt: String(row.created_at),
  };
}

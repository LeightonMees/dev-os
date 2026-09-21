import type { Db } from "../persistence/db.ts";
import { json } from "../persistence/db.ts";
import type { DevEvent } from "../schemas.ts";

export const EVENT_TYPES = [
  "PROJECT_ADDED",
  "PROJECT_UPDATED",
  "PROJECT_REMOVED",
  "TASK_CREATED",
  "TASK_UPDATED",
  "TASK_DELETED",
  "TASK_STATUS_CHANGED",
  "TASK_READY",
  "TASK_STARTED",
  "TASK_BLOCKED",
  "TASK_COMPLETED",
  "TASK_CANCELLED",
  "WORKER_SELECTED",
  "WORKER_HEALTH",
  "CONTEXT_ASSEMBLED",
  "COMMAND_STARTED",
  "COMMAND_OUTPUT",
  "COMMAND_FINISHED",
  "FILE_CHANGED",
  "VERIFICATION_STARTED",
  "VERIFICATION_PASSED",
  "VERIFICATION_FAILED",
  "ARTIFACT_CREATED",
  "EVIDENCE_RECORDED",
  "REVIEW_REQUESTED",
  "APPROVAL_REQUESTED",
  "APPROVAL_RESOLVED",
  "DECISION_RECORDED",
  "PLAN_PROPOSED",
  "PLAN_APPLIED",
  "GIT_COMMIT",
  /** A run was given its own git worktree and branch instead of the user's checkout. */
  "WORKTREE_CREATED",
  /** The run's changes were committed on its branch; the worktree itself is gone. */
  "WORKTREE_COMMITTED",
  "CHAT_MESSAGE",
  /** One chat model handed the turn to another (rate limit, overload or upstream fault). */
  "CHAT_BRAIN_SWITCHED",
  "FLOW_SAVED",
  "FLOW_DELETED",
  "FLOW_RUN_STARTED",
  "FLOW_RUN_FINISHED",
  "AUTO_RUN_STARTED",
  "AUTO_RUN_FINISHED",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface EmitInput {
  projectId?: string | null;
  taskId?: string | null;
  executionId?: string | null;
  data?: Record<string, unknown>;
}

export type EventListener = (event: DevEvent) => void;

/**
 * Structured events. Durable events go to the `events` table and to in-process
 * listeners. Transient events (COMMAND_OUTPUT) reach listeners only, so the
 * database never fills with raw worker output; the log artifact holds that.
 */
export class EventBus {
  readonly #db: Db;
  readonly #listeners = new Set<EventListener>();

  constructor(db: Db) {
    this.#db = db;
  }

  emit(type: EventType, input: EmitInput = {}): DevEvent {
    const ts = new Date().toISOString();
    const data = input.data ?? {};
    const result = this.#db.run(
      "INSERT INTO events (ts, type, project_id, task_id, execution_id, data_json) VALUES (?, ?, ?, ?, ?, ?)",
      ts,
      type,
      input.projectId ?? null,
      input.taskId ?? null,
      input.executionId ?? null,
      JSON.stringify(data),
    );
    const event: DevEvent = {
      id: Number(result.lastInsertRowid),
      ts,
      type,
      projectId: input.projectId ?? null,
      taskId: input.taskId ?? null,
      executionId: input.executionId ?? null,
      data,
    };
    this.#notify(event);
    return event;
  }

  emitTransient(type: EventType, input: EmitInput = {}): void {
    this.#notify({
      id: 0,
      ts: new Date().toISOString(),
      type,
      projectId: input.projectId ?? null,
      taskId: input.taskId ?? null,
      executionId: input.executionId ?? null,
      data: input.data ?? {},
    });
  }

  on(listener: EventListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  list(
    filter: {
      projectId?: string;
      taskId?: string;
      executionId?: string;
      sinceId?: number;
      limit?: number;
      types?: string[];
    } = {},
  ): DevEvent[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.projectId) {
      where.push("project_id = ?");
      params.push(filter.projectId);
    }
    if (filter.taskId) {
      where.push("task_id = ?");
      params.push(filter.taskId);
    }
    if (filter.executionId) {
      where.push("execution_id = ?");
      params.push(filter.executionId);
    }
    if (filter.sinceId !== undefined) {
      where.push("id > ?");
      params.push(filter.sinceId);
    }
    if (filter.types && filter.types.length > 0) {
      where.push(`type IN (${filter.types.map(() => "?").join(",")})`);
      params.push(...filter.types);
    }
    const limit = Math.max(1, Math.min(filter.limit ?? 100, 2000));
    const order = filter.sinceId !== undefined ? "ASC" : "DESC";
    const sql = `SELECT * FROM events ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id ${order} LIMIT ?`;
    const rows = this.#db.all(sql, ...params, limit).map(rowToEvent);
    return order === "DESC" ? rows.reverse() : rows;
  }

  latestId(): number {
    return Number(this.#db.get("SELECT MAX(id) AS id FROM events")?.id ?? 0);
  }

  #notify(event: DevEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // a broken listener must not break the emitter
      }
    }
  }
}

export function rowToEvent(row: Record<string, unknown>): DevEvent {
  return {
    id: Number(row.id),
    ts: String(row.ts),
    type: String(row.type),
    projectId: (row.project_id as string | null) ?? null,
    taskId: (row.task_id as string | null) ?? null,
    executionId: (row.execution_id as string | null) ?? null,
    data: json(row.data_json, {}),
  };
}

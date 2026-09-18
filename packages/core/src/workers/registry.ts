import type { DevConfig } from "../config.ts";
import type { EventBus } from "../events/bus.ts";
import type { Db } from "../persistence/db.ts";
import type { ExecutionStore } from "../records.ts";
import type { WorkerHealth, WorkerInfo } from "../schemas.ts";
import { join } from "node:path";

import { ApiWorker } from "./api.ts";
import { suggestRouting } from "./benchmarks.ts";
import { ClaudeCodeWorker } from "./claude-code.ts";
import { GrokWorker, OpenCodeWorker } from "./cli-agents.ts";
import { CodexWorker } from "./codex.ts";
import { OllamaWorker } from "./ollama.ts";
import { ShellWorker } from "./shell.ts";
import type { Worker, WorkerCapability } from "./types.ts";

/** Workers that can genuinely run on this machine, built from config. */
export function buildWorkers(config: DevConfig, home: string): Worker[] {
  const briefDir = join(home, "logs");
  return [
    new ClaudeCodeWorker(config.workers.claudeCode),
    new CodexWorker(config.workers.codex),
    new GrokWorker({ ...config.workers.grok, briefDir }),
    new OpenCodeWorker({ ...config.workers.opencode, briefDir }),
    new OllamaWorker(config.workers.ollama),
    ...config.workers.api.providers.map((p) => new ApiWorker(p)),
    new ShellWorker(config.terminal.shell),
  ];
}

export interface Selection {
  worker: Worker;
  reason: string;
}

/**
 * The part of a piece of work routing actually looks at. A `Task` satisfies it, and so does a flow
 * step, which is why it is stated separately rather than routing pretending everything is a task.
 */
export interface RoutableWork {
  command: string | null;
  workerId: string | null;
}

export class WorkerRegistry {
  readonly #workers: Map<string, Worker>;
  readonly #db: Db;
  readonly #events: EventBus;
  readonly #executions: ExecutionStore;
  readonly #config: DevConfig;

  constructor(workers: Worker[], db: Db, events: EventBus, executions: ExecutionStore, config: DevConfig) {
    this.#workers = new Map(workers.map((w) => [w.id, w]));
    this.#db = db;
    this.#events = events;
    this.#executions = executions;
    this.#config = config;
  }

  get(id: string): Worker | undefined {
    return this.#workers.get(id);
  }

  all(): Worker[] {
    return Array.from(this.#workers.values());
  }

  /** Metadata with the last recorded health and execution stats; no probing. */
  info(id: string): WorkerInfo | undefined {
    const worker = this.get(id);
    if (!worker) return undefined;
    const running = this.#db.get("SELECT task_id FROM executions WHERE worker_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1", id);
    return {
      id: worker.id,
      name: worker.name,
      type: worker.type,
      capabilities: [...worker.capabilities],
      configRef: worker.configRef,
      health: this.lastHealth(id),
      currentTaskId: running ? String(running.task_id) : null,
      stats: this.#executions.workerStats(id),
    };
  }

  list(): WorkerInfo[] {
    return this.all().map((w) => this.info(w.id) as WorkerInfo);
  }

  lastHealth(id: string): WorkerHealth | null {
    const row = this.#db.get("SELECT * FROM worker_health WHERE worker_id = ?", id);
    if (!row) return null;
    return { ok: Number(row.ok) === 1, checkedAt: String(row.checked_at), detail: String(row.detail), version: (row.version as string | undefined) ?? undefined };
  }

  async check(id: string): Promise<WorkerHealth> {
    const worker = this.get(id);
    if (!worker) throw new Error(`Unknown worker ${id}`);
    let health: WorkerHealth;
    try {
      health = await worker.probe();
    } catch (error) {
      health = { ok: false, checkedAt: new Date().toISOString(), detail: (error as Error).message };
    }
    this.#db.run(
      "INSERT INTO worker_health (worker_id, ok, checked_at, detail, version) VALUES (?, ?, ?, ?, ?) ON CONFLICT(worker_id) DO UPDATE SET ok = excluded.ok, checked_at = excluded.checked_at, detail = excluded.detail, version = excluded.version",
      id,
      health.ok ? 1 : 0,
      health.checkedAt,
      health.detail,
      health.version ?? null,
    );
    this.#events.emit("WORKER_HEALTH", { data: { workerId: id, ok: health.ok, detail: health.detail } });
    return health;
  }

  /**
   * Workers that recently told us they were out of quota, and when they are worth trying again.
   * Only ever set from a real rate-limit response, never guessed.
   */
  readonly #rateLimited = new Map<string, { until: number; detail: string }>();

  /**
   * Record that a worker refused work because it was out of capacity. `retryAfterMs` comes from the
   * provider when it says so; otherwise a conservative default. Routing skips the worker until then,
   * which is how a task moves to a model that still has headroom instead of failing.
   */
  rateLimited(id: string, detail: string, retryAfterMs = 5 * 60 * 1000): void {
    this.#rateLimited.set(id, { until: Date.now() + retryAfterMs, detail });
    this.#events.emit("WORKER_HEALTH", { data: { workerId: id, ok: false, detail: `rate limited: ${detail}`, until: new Date(Date.now() + retryAfterMs).toISOString() } });
  }

  /**
   * Read a worker's own words for "I am out of capacity" and sideline it if so. Providers usually
   * say how long to wait; that number is used when present rather than a guess.
   * Returns true when the text was a rate limit, so callers can report it as such.
   */
  noteIfRateLimited(id: string, text: string): boolean {
    if (!text) return false;
    const limited = /429|rate.?limit|quota (?:exceeded|reached)|too many requests|out of (?:credit|capacity)|usage limit/i.test(text);
    if (!limited) return false;
    // "try again in 7.85s", "retry-after: 30", "Please try again in 2m30s"
    const seconds = Number(text.match(/(?:try again in|retry[- ]after:?)\s*([\d.]+)\s*s/i)?.[1] ?? 0);
    const minutes = Number(text.match(/(?:try again in|retry[- ]after:?)\s*([\d.]+)\s*m/i)?.[1] ?? 0);
    const waitMs = Math.round((seconds + minutes * 60) * 1000);
    this.rateLimited(id, text.replace(/\s+/g, " ").trim().slice(0, 160), waitMs > 0 ? waitMs + 1000 : undefined);
    return true;
  }

  /** How long a worker is still sidelined for, or null when it is available. */
  rateLimitedFor(id: string): { msLeft: number; detail: string } | null {
    const hit = this.#rateLimited.get(id);
    if (!hit) return null;
    if (hit.until <= Date.now()) {
      this.#rateLimited.delete(id);
      return null;
    }
    return { msLeft: hit.until - Date.now(), detail: hit.detail };
  }

  async checkAll(): Promise<Record<string, WorkerHealth>> {
    const out: Record<string, WorkerHealth> = {};
    for (const worker of this.all()) out[worker.id] = await this.check(worker.id);
    return out;
  }

  /**
   * Deterministic routing:
   *  1. a task with a shell command runs on the shell worker
   *  2. an explicit task worker wins, if it is healthy
   *  3. the project default, then config preference order, then the benchmark-suggested order when
   *     no preference is set, then any remaining worker offering the capability — first healthy wins
   * Health is probed on demand when it was never recorded or is older than 10 minutes.
   */
  async select(task: RoutableWork, options: { capability?: WorkerCapability; projectDefault?: string | null; requested?: string | null } = {}): Promise<Selection> {
    if (task.command) {
      const shell = this.get("shell");
      if (!shell) throw new Error("Shell worker is not registered");
      return { worker: shell, reason: "task has a deterministic command" };
    }
    const capability = options.capability ?? "code";
    const explicit = options.requested ?? task.workerId;
    if (explicit) {
      const worker = this.get(explicit);
      if (!worker) throw new Error(`Unknown worker "${explicit}". Known: ${this.all().map((w) => w.id).join(", ")}`);
      const limited = this.rateLimitedFor(worker.id);
      if (limited) throw new WorkerUnavailableError(worker.id, `out of quota for another ${Math.ceil(limited.msLeft / 1000)}s: ${limited.detail}. Clear the worker on the task to let DEV pick one with headroom.`);
      const health = await this.#freshHealth(worker.id);
      if (!health.ok) throw new WorkerUnavailableError(worker.id, health.detail);
      return { worker, reason: options.requested ? "requested on the command line" : "assigned on the task" };
    }
    // The capability's own order when one is set, then the general order, then — when the user has
    // stated no preference at all — the order the benchmark evidence suggests for this kind of work,
    // and finally every remaining worker that offers the capability. Duplicates drop out, so a
    // worker listed for this capability is tried first and never tried twice.
    //
    // The evidence step is what keeps "auto" from meaning "whoever is hardcoded first". It is only
    // consulted where the user has expressed no opinion, and an opinion always wins over it.
    const perCapability = this.#config.workers.preferencesByCapability?.[capability] ?? [];
    const stated = [options.projectDefault, ...perCapability, ...this.#config.workers.preferences].filter((x): x is string => !!x);
    const evidenceOrder = stated.length > 0 ? [] : this.#evidenceOrder(capability);
    const order = [...new Set([...stated, ...evidenceOrder, ...this.all().filter((w) => w.capabilities.includes(capability)).map((w) => w.id)])];
    const tried: string[] = [];
    for (const id of order) {
      const worker = this.get(id);
      if (!worker || !worker.capabilities.includes(capability)) continue;
      const limited = this.rateLimitedFor(id);
      if (limited) {
        tried.push(`${id}: out of quota for another ${Math.ceil(limited.msLeft / 1000)}s (${limited.detail})`);
        continue;
      }
      const health = await this.#freshHealth(id);
      if (health.ok) {
        const reason =
          id === options.projectDefault
            ? "project default worker"
            : perCapability.includes(id)
              ? `your preferred worker for "${capability}"`
              : stated.includes(id)
                ? `first healthy worker with "${capability}" in your preference order`
                : evidenceOrder.includes(id)
                  ? `no preference set; public benchmarks rank it first for "${capability}"`
                  : `the only healthy worker left offering "${capability}"`;
        return { worker, reason };
      }
      tried.push(`${id}: ${health.detail}`);
    }
    throw new WorkerUnavailableError("any", tried.length ? tried.join("; ") : `no registered worker offers "${capability}"`);
  }

  /**
   * Worker ids for a capability, best first, from the public benchmark table. Health is not known
   * here without probing, so every candidate is offered as healthy and `select` does the real
   * health check as it walks the order.
   */
  #evidenceOrder(capability: WorkerCapability): string[] {
    const suggestion = suggestRouting({
      workers: this.all().map((w) => ({ id: w.id, capabilities: w.capabilities, model: this.configuredModel(w.id), healthy: true })),
    }).find((s) => s.capability === capability);
    return suggestion?.order ?? [];
  }

  /** The model a worker is configured with, so benchmark rows can be matched to the actual model. */
  configuredModel(id: string): string | null {
    const workers = this.#config.workers as unknown as Record<string, { model?: string | null } | undefined>;
    if (id === "claude-code") return workers.claudeCode?.model ?? null;
    const direct = workers[id];
    if (direct && typeof direct === "object" && "model" in direct) return direct.model ?? null;
    const provider = this.#config.workers.api.providers.find((p) => p.id === id);
    return provider?.model ?? null;
  }

  async #freshHealth(id: string): Promise<WorkerHealth> {
    const last = this.lastHealth(id);
    if (last && Date.now() - Date.parse(last.checkedAt) < 10 * 60 * 1000) return last;
    return this.check(id);
  }
}

export class WorkerUnavailableError extends Error {
  readonly workerId: string;
  constructor(workerId: string, detail: string) {
    super(`Worker ${workerId} unavailable: ${detail}`);
    this.workerId = workerId;
  }
}

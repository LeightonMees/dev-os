import type { Dev } from "../dev.ts";
import type { Execution, Task } from "../schemas.ts";
import { resolveConfigFor } from "../config.ts";
import { runTask } from "./runner.ts";

export interface AutoRunOptions {
  projectId: string;
  /** Stop after this many task executions (default: until nothing is runnable). */
  maxTasks?: number;
  workerId?: string | null;
  signal?: AbortSignal;
  /** Keep going past a blocked task when other tasks are still runnable (default true). */
  continueOnFailure?: boolean;
  /**
   * Autopilot: when nothing is READY, promote the next BACKLOG task whose dependencies are all
   * satisfied and keep going. Off by default, because it takes tasks the user has not queued.
   * Tasks carrying `needsHuman` are never promoted; they wait for an answer.
   */
  promoteBacklog?: boolean;
  /**
   * How many tasks may run at once. Above 1 needs `git.isolation=worktree` on the project, because
   * two workers editing one checkout would each claim the other's changes; in place, this is
   * clamped to 1 and the report says so. Defaults to `workers.concurrency`.
   */
  concurrency?: number;
  onTaskStart?: (task: Task) => void;
  onTaskEnd?: (task: Task, execution: Execution | null) => void;
  onPromote?: (task: Task) => void;
}

export interface AutoRunReport {
  ran: { taskId: string; title: string; status: string; executionId: string }[];
  stoppedBecause: "no-runnable-tasks" | "max-tasks" | "cancelled" | "blocked";
  /** Set when the run did no useful work, so the UI can say why instead of "started". */
  detail: string | null;
}

export function emptyAutoRunDetail(promoteBacklog: boolean): string {
  return promoteBacklog
    ? "Nothing Ready, and no Backlog task with satisfied dependencies that does not need you."
    : "Nothing Ready. Move a task to Ready, or start Autopilot to promote from Backlog.";
}

/**
 * The automation layer: execute every runnable task in dependency order.
 * When a task finishes, its dependents are promoted to READY and picked up on
 * the next pass with the upstream result summaries in their context, so the
 * workers hand work to one another through DEV rather than through chat.
 * Sequential by design in V1: one worker at a time on one repository.
 */
export async function autoRun(dev: Dev, options: AutoRunOptions): Promise<AutoRunReport> {
  const report: AutoRunReport = { ran: [], stoppedBecause: "no-runnable-tasks", detail: null };
  const max = options.maxTasks ?? Number.POSITIVE_INFINITY;
  const attempted = new Set<string>();
  const project = dev.projects.get(options.projectId);
  const isolation = project?.path ? resolveConfigFor({ home: dev.home, projectDir: project.path }).config.git.isolation : "in-place";
  const wanted = Math.max(1, Math.floor(options.concurrency ?? dev.config.workers.concurrency ?? 1));
  const concurrency = isolation === "worktree" ? wanted : 1;
  if (wanted > 1 && concurrency === 1) report.detail = `ran one at a time: ${wanted} in parallel needs git.isolation=worktree on this project`;
  dev.events.emit("AUTO_RUN_STARTED", {
    projectId: options.projectId,
    data: { promoteBacklog: options.promoteBacklog === true, maxTasks: Number.isFinite(max) ? max : null, concurrency },
  });
  // In flight: one entry per running task, resolving to what happened to it.
  const inFlight = new Map<string, Promise<{ task: Task; execution: Execution | null }>>();
  const launch = (task: Task) => {
    attempted.add(task.id);
    options.onTaskStart?.(task);
    inFlight.set(
      task.id,
      runTask(dev, task.id, { workerId: options.workerId ?? null, signal: options.signal })
        .then((execution) => ({ task, execution }))
        .catch(() => ({ task, execution: null })),
    );
  };
  try {
    for (;;) {
      if (options.signal?.aborted) {
        report.stoppedBecause = "cancelled";
        break;
      }
      // Fill the slots. Runnable tasks are independent of each other by definition (their
      // dependencies are done), so they may run side by side.
      while (inFlight.size < concurrency && report.ran.length + inFlight.size < max) {
        let next = dev.tasks.runnable(options.projectId).find((t) => !attempted.has(t.id));
        if (!next && options.promoteBacklog && inFlight.size === 0) next = promoteNext(dev, options, attempted);
        if (!next) break;
        launch(next);
      }
      if (inFlight.size === 0) {
        if (report.ran.length >= max) report.stoppedBecause = "max-tasks";
        break;
      }
      const finished = await Promise.race(inFlight.values());
      inFlight.delete(finished.task.id);
      const live = dev.tasks.get(finished.task.id) as Task;
      report.ran.push({ taskId: finished.task.id, title: finished.task.title, status: live.status, executionId: finished.execution?.id ?? "" });
      options.onTaskEnd?.(live, finished.execution);
      if (live.status === "BLOCKED" && options.continueOnFailure === false) {
        report.stoppedBecause = "blocked";
        break;
      }
    }
    // A stop with work still running: let it finish and record it, so nothing is lost.
    for (const settled of await Promise.all(inFlight.values())) {
      const live = dev.tasks.get(settled.task.id) as Task;
      report.ran.push({ taskId: settled.task.id, title: settled.task.title, status: live.status, executionId: settled.execution?.id ?? "" });
      options.onTaskEnd?.(live, settled.execution);
    }
    inFlight.clear();
    // A run that did nothing must say why, so the UI can show a reason instead of "started".
    if (report.ran.length === 0 && report.stoppedBecause === "no-runnable-tasks") report.detail = emptyAutoRunDetail(options.promoteBacklog === true);
  } finally {
    dev.events.emit("AUTO_RUN_FINISHED", {
      projectId: options.projectId,
      data: { ran: report.ran.length, blocked: report.ran.filter((r) => r.status === "BLOCKED").length, stoppedBecause: report.stoppedBecause, detail: report.detail },
    });
  }
  return report;
}

function promoteNext(dev: Dev, options: AutoRunOptions, attempted: Set<string>): Task | undefined {
  const candidate = dev.tasks
    .list({ projectId: options.projectId, status: "BACKLOG", limit: null })
    .find((t) => !attempted.has(t.id) && !t.needsHuman && dev.tasks.unmetDependencies(t.id).length === 0);
  if (!candidate) return undefined;
  const promoted = dev.tasks.setStatus(candidate.id, "READY", { reason: "autopilot: dependencies satisfied" });
  options.onPromote?.(promoted);
  return promoted;
}

import type { Dev } from "../dev.ts";
import type { Execution, Task } from "../schemas.ts";
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
  onTaskStart?: (task: Task) => void;
  onTaskEnd?: (task: Task, execution: Execution) => void;
  onPromote?: (task: Task) => void;
}

export interface AutoRunReport {
  ran: { taskId: string; title: string; status: string; executionId: string }[];
  stoppedBecause: "no-runnable-tasks" | "max-tasks" | "cancelled" | "blocked";
}

/**
 * The automation layer: execute every runnable task in dependency order.
 * When a task finishes, its dependents are promoted to READY and picked up on
 * the next pass with the upstream result summaries in their context, so the
 * workers hand work to one another through DEV rather than through chat.
 * Sequential by design in V1: one worker at a time on one repository.
 */
export async function autoRun(dev: Dev, options: AutoRunOptions): Promise<AutoRunReport> {
  const report: AutoRunReport = { ran: [], stoppedBecause: "no-runnable-tasks" };
  const max = options.maxTasks ?? Number.POSITIVE_INFINITY;
  const attempted = new Set<string>();
  while (report.ran.length < max) {
    if (options.signal?.aborted) {
      report.stoppedBecause = "cancelled";
      break;
    }
    let next = dev.tasks.runnable(options.projectId).find((t) => !attempted.has(t.id));
    if (!next && options.promoteBacklog) next = promoteNext(dev, options, attempted);
    if (!next) break;
    attempted.add(next.id);
    options.onTaskStart?.(next);
    let execution: Execution;
    try {
      execution = await runTask(dev, next.id, { workerId: options.workerId ?? null, signal: options.signal });
    } catch (error) {
      const live = dev.tasks.get(next.id) as Task;
      report.ran.push({ taskId: next.id, title: next.title, status: live.status, executionId: "" });
      if (options.continueOnFailure === false) {
        report.stoppedBecause = "blocked";
        break;
      }
      void error;
      continue;
    }
    const live = dev.tasks.get(next.id) as Task;
    report.ran.push({ taskId: next.id, title: next.title, status: live.status, executionId: execution.id });
    options.onTaskEnd?.(live, execution);
    if (live.status === "BLOCKED" && options.continueOnFailure === false) {
      report.stoppedBecause = "blocked";
      break;
    }
  }
  if (report.ran.length >= max && report.stoppedBecause === "no-runnable-tasks") report.stoppedBecause = "max-tasks";
  return report;
}

/**
 * Autopilot promotion: the first BACKLOG task, in board order, whose dependencies are all
 * satisfied and which does not need the user. Returns it as READY, or undefined when the
 * backlog has nothing that can legitimately start.
 */
function promoteNext(dev: Dev, options: AutoRunOptions, attempted: Set<string>): Task | undefined {
  const candidate = dev.tasks
    .list({ projectId: options.projectId, status: "BACKLOG" })
    .find((t) => !attempted.has(t.id) && !t.needsHuman && dev.tasks.unmetDependencies(t.id).length === 0);
  if (!candidate) return undefined;
  const promoted = dev.tasks.setStatus(candidate.id, "READY", { reason: "autopilot: dependencies satisfied" });
  options.onPromote?.(promoted);
  return promoted;
}

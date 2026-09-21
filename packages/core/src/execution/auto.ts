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
  dev.events.emit("AUTO_RUN_STARTED", {
    projectId: options.projectId,
    data: { promoteBacklog: options.promoteBacklog === true, maxTasks: Number.isFinite(max) ? max : null },
  });
  try {
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
      let execution: Execution | null = null;
      try {
        execution = await runTask(dev, next.id, { workerId: options.workerId ?? null, signal: options.signal });
      } catch (error) {
        const live = dev.tasks.get(next.id) as Task;
        report.ran.push({ taskId: next.id, title: next.title, status: live.status, executionId: "" });
        options.onTaskEnd?.(live, null);
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
    report.detail = finishDetail(report, options.promoteBacklog === true);
    return report;
  } finally {
    const blocked = report.ran.filter((r) => r.status === "BLOCKED").length;
    dev.events.emit("AUTO_RUN_FINISHED", {
      projectId: options.projectId,
      data: {
        promoteBacklog: options.promoteBacklog === true,
        ran: report.ran.length,
        blocked,
        stoppedBecause: report.stoppedBecause,
        detail: report.detail,
        titles: report.ran.filter((r) => r.status === "BLOCKED").map((r) => r.title).slice(0, 8),
      },
    });
  }
}

function finishDetail(report: AutoRunReport, promoteBacklog: boolean): string | null {
  if (report.ran.length === 0) return emptyAutoRunDetail(promoteBacklog);
  const blocked = report.ran.filter((r) => r.status === "BLOCKED");
  if (blocked.length === report.ran.length) {
    const names = blocked.map((r) => r.title).slice(0, 3).join("; ");
    return `Every task in this run blocked or timed out${names ? `: ${names}` : ""}.`;
  }
  return null;
}

/**
 * Autopilot promotion: the first BACKLOG task, in board order, whose dependencies are all
 * satisfied and which does not need the user. Returns it as READY, or undefined when the
 * backlog has nothing that can legitimately start.
 */
function promoteNext(dev: Dev, options: AutoRunOptions, attempted: Set<string>): Task | undefined {
  const candidate = dev.tasks
    .list({ projectId: options.projectId, status: "BACKLOG", limit: null })
    .find((t) => !attempted.has(t.id) && !t.needsHuman && dev.tasks.unmetDependencies(t.id).length === 0);
  if (!candidate) return undefined;
  const promoted = dev.tasks.setStatus(candidate.id, "READY", { reason: "autopilot: dependencies satisfied" });
  options.onPromote?.(promoted);
  return promoted;
}

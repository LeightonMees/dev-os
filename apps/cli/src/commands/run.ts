import { autoRun, runTask, type DevEvent, type Task } from "@dev/core";

import { ControlPlaneClient } from "../api.ts";
import { flagBool, flagNumber, flagString, UsageError } from "../args.ts";
import { controlPlane, currentProject, type CliContext } from "../context.ts";
import { c, duration, eprintln, printJson, println, statusColor, truncate } from "../output.ts";
import { resolveTask } from "./task.ts";

/**
 * `dev task run`: when the control plane is up, the run happens there so the
 * desktop app shows the same live execution; otherwise it runs in this process.
 */
export async function runCommand(ctx: CliContext, ref: string | undefined): Promise<number> {
  const task = resolveTask(ctx, ref);
  const workerId = flagString(ctx.flags, "worker") ?? null;
  const force = flagBool(ctx.flags, "force");
  const timeoutMs = flagNumber(ctx.flags, "timeout") ? (flagNumber(ctx.flags, "timeout") as number) * 1000 : undefined;
  const quiet = ctx.json || flagBool(ctx.flags, "quiet");
  const cp = await controlPlane(ctx.home);
  if (cp) {
    const client = new ControlPlaneClient(cp.url);
    if (!quiet) eprintln(c.dim(`▶ ${task.id} ${truncate(task.title, 60)}  via control plane ${cp.url}`));
    const controller = new AbortController();
    const streaming = client.stream({ taskId: task.id, since: String(ctx.dev.events.latestId()) }, (e) => (quiet ? undefined : printEvent(e)), (e) => e.type === "TASK_STATUS_CHANGED" && e.taskId === task.id && ["DONE", "BLOCKED", "REVIEW", "CANCELLED"].includes(String(e.data.to)), controller.signal);
    let result: { executionId: string; task: Task };
    try {
      result = await client.call<{ executionId: string; task: Task }>("POST", `/api/tasks/${task.id}/run`, { workerId, force, timeoutMs });
    } catch (error) {
      controller.abort();
      throw error;
    }
    await streaming.catch(() => undefined);
    const final = await client.call<Task>("GET", `/api/tasks/${task.id}`);
    return report(ctx, final, result.executionId);
  }
  if (!quiet) eprintln(c.dim(`▶ ${task.id} ${truncate(task.title, 60)}`));
  const off = quiet ? () => {} : ctx.dev.events.on((e) => printEvent(e));
  const controller = new AbortController();
  const onSigint = () => {
    eprintln(c.yellow("\n! cancelling…"));
    controller.abort();
  };
  process.on("SIGINT", onSigint);
  try {
    const execution = await runTask(ctx.dev, task.id, { workerId, force, timeoutMs, signal: controller.signal });
    return report(ctx, ctx.dev.tasks.get(task.id) as Task, execution.id);
  } finally {
    off();
    process.off("SIGINT", onSigint);
  }
}

function report(ctx: CliContext, task: Task, executionId: string): number {
  const execution = ctx.dev.executions.get(executionId);
  if (ctx.json) {
    printJson({ task, execution });
    return task.status === "DONE" || task.status === "REVIEW" ? 0 : 2;
  }
  println("");
  if (task.status === "DONE") println(`${c.green("✓")} ${task.id} ${statusColor("DONE")} ${c.dim(duration(execution?.durationMs))}${execution?.changedFiles.length ? c.dim(`  ${execution.changedFiles.length} file(s) changed`) : ""}`);
  else if (task.status === "REVIEW") println(`${c.yellow("◆")} ${task.id} ${statusColor("REVIEW")} — approve with: dev task approve ${task.id}`);
  else if (task.status === "CANCELLED") println(`${c.dim("×")} ${task.id} ${statusColor("CANCELLED")}`);
  else println(`${c.red("✗")} ${task.id} ${statusColor(task.status)}: ${task.failure?.reason ?? ""}\n  ${c.dim("Next:")} ${task.failure?.nextAction ?? ""}`);
  if (task.resultSummary) println(c.dim(task.resultSummary.split("\n").slice(0, 8).map((l) => "  " + l).join("\n")));
  return task.status === "DONE" || task.status === "REVIEW" ? 0 : 2;
}

export function printEvent(e: DevEvent): void {
  switch (e.type) {
    case "COMMAND_OUTPUT": {
      const chunk = String(e.data.chunk ?? "");
      if (e.data.stream === "stderr") process.stderr.write(c.dim(chunk));
      else process.stdout.write(chunk);
      return;
    }
    case "WORKER_SELECTED":
      eprintln(c.dim(`  worker ${e.data.workerId}: ${e.data.reason}`));
      return;
    case "CONTEXT_ASSEMBLED":
      eprintln(c.dim(`  context ~${e.data.usedTokens}/${e.data.budgetTokens} tokens (${(e.data.sections as string[]).join(", ")})`));
      return;
    case "COMMAND_STARTED":
      eprintln(c.dim(`  running ${truncate(String(e.data.command), 80)}`));
      return;
    case "COMMAND_FINISHED":
      eprintln(c.dim(`  finished exit=${e.data.exitCode} ${duration(Number(e.data.durationMs))}`));
      return;
    case "FILE_CHANGED":
      if (e.data.path) eprintln(c.dim(`  changed ${e.data.path}`));
      return;
    case "VERIFICATION_STARTED":
      eprintln(c.dim(`  verify ${e.data.label ?? e.data.kind}`));
      return;
    case "VERIFICATION_PASSED":
      eprintln(`  ${c.green("✓")} ${e.data.summary}`);
      return;
    case "VERIFICATION_FAILED":
      eprintln(`  ${c.red("✗")} ${e.data.summary}`);
      return;
    case "TASK_STATUS_CHANGED":
      eprintln(c.dim(`  ${e.data.from} → ${e.data.to}${e.data.reason ? ` (${e.data.reason})` : ""}`));
      return;
    default:
      return;
  }
}

export async function retryCommand(ctx: CliContext, ref: string | undefined): Promise<number> {
  const task = resolveTask(ctx, ref);
  if (task.status !== "BLOCKED" && task.status !== "REVIEW") throw new UsageError(`Task is ${task.status}; only BLOCKED or REVIEW tasks can be retried`);
  if (flagBool(ctx.flags, "no-run")) {
    const updated = ctx.dev.tasks.retry(task.id);
    if (ctx.json) printJson(updated);
    else println(`${c.green("✓")} ${task.id} → ${statusColor("READY")} (retry ${updated.retryCount})`);
    return 0;
  }
  return runCommand(ctx, task.id);
}

export async function cancelCommand(ctx: CliContext, ref: string | undefined): Promise<number> {
  const task = resolveTask(ctx, ref);
  const running = ctx.dev.executions.list({ taskId: task.id, status: "running" });
  for (const execution of running) ctx.dev.executions.requestCancel(execution.id);
  if (running.length === 0) {
    if (task.status === "DONE" || task.status === "CANCELLED") throw new UsageError(`Task is already ${task.status}`);
    ctx.dev.tasks.setStatus(task.id, "CANCELLED", { reason: flagString(ctx.flags, "reason") ?? "cancelled by user" });
  }
  if (ctx.json) printJson({ cancelled: running.map((e) => e.id), task: ctx.dev.tasks.get(task.id) });
  else println(running.length ? `${c.yellow("!")} Cancellation requested for ${running.length} running execution(s) of ${task.id}` : `${c.green("✓")} ${task.id} → ${statusColor("CANCELLED")}`);
  return 0;
}

/** `dev auto`: run every runnable task in dependency order until none remain. */
export async function autoCommand(ctx: CliContext): Promise<number> {
  const project = currentProject(ctx);
  if (!project) throw new UsageError("No project");
  const maxTasks = flagNumber(ctx.flags, "max");
  const workerId = flagString(ctx.flags, "worker") ?? null;
  const promoteBacklog = flagBool(ctx.flags, "promote-backlog") || flagBool(ctx.flags, "autopilot");
  const runnable = ctx.dev.tasks.runnable(project.id);
  if (runnable.length === 0 && !promoteBacklog) {
    if (ctx.json) printJson({ ran: [], stoppedBecause: "no-runnable-tasks" });
    else println(c.dim(`Nothing runnable in ${project.name}. Tasks must be READY with all dependencies DONE. Use --promote-backlog to let Autopilot pull from Backlog.`));
    return 0;
  }
  const cp = await controlPlane(ctx.home);
  if (cp) {
    const client = new ControlPlaneClient(cp.url);
    if (!ctx.json) eprintln(c.dim(`▶ ${promoteBacklog ? "autopilot" : "auto-run"} ${project.name}: ${runnable.length} runnable now  via control plane`));
    await client.call("POST", `/api/projects/${project.id}/auto`, { maxTasks, workerId, continueOnFailure: !flagBool(ctx.flags, "stop-on-failure"), promoteBacklog });
    if (flagBool(ctx.flags, "detach")) {
      println(ctx.json ? JSON.stringify({ started: true }) : `${c.green("✓")} auto-run started in the control plane (dev status shows progress)`);
      return 0;
    }
    const ran: { taskId: string; status: string }[] = [];
    await client.stream({ projectId: project.id, since: String(ctx.dev.events.latestId()) }, (e) => {
      if (!ctx.json) printEvent(e);
      if (e.type === "TASK_STATUS_CHANGED" && ["DONE", "BLOCKED", "REVIEW", "CANCELLED"].includes(String(e.data.to)) && e.taskId) ran.push({ taskId: e.taskId, status: String(e.data.to) });
    }, () => false, autoStopSignal(client, project.id));
    if (ctx.json) printJson({ ran });
    return ran.some((r) => r.status === "BLOCKED") ? 2 : 0;
  }
  if (!ctx.json) eprintln(c.dim(`▶ auto-run ${project.name}: ${runnable.length} runnable now`));
  const off = ctx.json ? () => {} : ctx.dev.events.on(printEvent);
  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort());
  try {
    const report = await autoRun(ctx.dev, {
      projectId: project.id,
      maxTasks,
      workerId,
      signal: controller.signal,
      continueOnFailure: !flagBool(ctx.flags, "stop-on-failure"),
      promoteBacklog,
      onTaskStart: (t) => (ctx.json ? undefined : eprintln(`\n${c.cyan("▶")} ${t.id} ${t.title}`)),
    });
    if (ctx.json) printJson(report);
    else {
      println("");
      for (const r of report.ran) println(`  ${r.status === "DONE" ? c.green("✓") : r.status === "BLOCKED" ? c.red("✗") : c.yellow("◆")} ${r.taskId} ${statusColor(r.status as Task["status"])} ${truncate(r.title, 50)}`);
      println(c.dim(`  stopped: ${report.stoppedBecause}`));
    }
    return report.ran.some((r) => r.status === "BLOCKED") ? 2 : 0;
  } finally {
    off();
  }
}

/** Resolves (aborts the stream) once the control plane reports auto-run finished for the project. */
function autoStopSignal(client: ControlPlaneClient, projectId: string): AbortSignal {
  const controller = new AbortController();
  const poll = async () => {
    while (!controller.signal.aborted) {
      await new Promise((r) => setTimeout(r, 1500));
      try {
        const status = await client.call<{ auto: { projectId: string }[] }>("GET", "/api/status");
        if (!status.auto.some((a) => a.projectId === projectId)) {
          await new Promise((r) => setTimeout(r, 300));
          controller.abort();
        }
      } catch {
        controller.abort();
      }
    }
  };
  void poll();
  return controller.signal;
}

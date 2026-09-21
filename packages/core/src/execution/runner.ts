import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { assembleContext, estimateTokens } from "../context/assemble.ts";
import type { Dev } from "../dev.ts";
import { effortForTaskSize } from "../workers/efforts.ts";
import * as gitOps from "../git.ts";
import type { Execution, Task, TaskFailure, WorkerType } from "../schemas.ts";
import { runVerification } from "../verification.ts";
import { resolveConfigFor } from "../config.ts";
import { WorkerUnavailableError } from "../workers/registry.ts";
import type { WorkerCapability } from "../workers/types.ts";

const MAX_RETRY_TIMEOUT_MS = 4 * 60 * 60 * 1000;

/** How long a run may take: shell uses timeoutMs, agents use agentTimeoutMs. A retry after timeout doubles once. */
export function timeoutFor(workerType: WorkerType, config: { timeoutMs: number; agentTimeoutMs: number }, previous?: TaskFailure | null): number {
  const base = workerType === "shell" ? config.timeoutMs : config.agentTimeoutMs;
  if (previous?.kind !== "timeout") return base;
  const last = Number(previous.data?.timeoutMs);
  const from = Number.isFinite(last) && last > 0 ? last : base;
  return Math.min(from * 2, MAX_RETRY_TIMEOUT_MS);
}

/** "30 minutes", "2 hours" — what the board should show, not 1800s. */
export function formatTimeout(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) {
    const seconds = Math.max(1, Math.round(ms / 1000));
    return seconds === 1 ? "1 second" : `${seconds} seconds`;
  }
  if (minutes < 90) return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? "1 hour" : `${hours} hours`;
}

export interface RunOptions {
  workerId?: string | null;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Skip the dependency check (the task graph is advisory for a forced run). */
  force?: boolean;
}

/**
 * The execution lifecycle for one task:
 *   preflight → select worker → WORKING → context → run → changed files →
 *   verification → artifacts + evidence → DONE | REVIEW | BLOCKED
 * Every step leaves a structured event; raw output goes to the log artifact.
 */
export async function runTask(dev: Dev, taskId: string, options: RunOptions = {}): Promise<Execution> {
  const task = dev.tasks.get(taskId);
  if (!task) throw new Error(`Unknown task ${taskId}`);
  const project = dev.projects.get(task.projectId);
  if (!project) throw new Error(`Task ${taskId} belongs to a missing project`);
  if (!project.path) {
    dev.tasks.block(task.id, { kind: "dependency-missing", reason: `${project.name} has no repository yet`, nextAction: "Create or register a directory for the project (dev project new / dev project set path), then retry" });
    throw new Error(`Project ${project.name} has no repository yet; nothing can run`);
  }
  const projectPath = project.path;
  const previousFailure = task.failure;

  // ----- preflight -----
  if (task.status === "BLOCKED" || task.status === "REVIEW") dev.tasks.retry(task.id);
  else if (task.status === "BACKLOG") dev.tasks.setStatus(task.id, "READY", { force: !!options.force, reason: "run requested" });
  const current = dev.tasks.get(task.id) as Task;
  if (current.status !== "READY") throw new Error(`Task ${task.id} is ${current.status}; only READY (or BLOCKED/REVIEW for a retry) tasks can run`);
  const unmet = dev.tasks.unmetDependencies(task.id);
  if (unmet.length > 0 && !options.force) {
    dev.tasks.block(task.id, {
      kind: "dependency-missing",
      reason: `Waiting on ${unmet.map((t) => `${t.title} (${t.status})`).join(", ")}`,
      nextAction: "Finish the upstream tasks, or run with --force to ignore the graph",
    });
    throw new Error(`Task ${task.id} has unmet dependencies: ${unmet.map((t) => t.id).join(", ")}`);
  }

  // ----- worker -----
  let selection;
  try {
    selection = await dev.workers.select(current, { requested: options.workerId ?? null, projectDefault: project.config.defaultWorker ?? null, capability: capabilityFor(current) });
  } catch (error) {
    const detail = error instanceof WorkerUnavailableError ? error.message : (error as Error).message;
    dev.tasks.block(task.id, { kind: "worker-unavailable", reason: detail, nextAction: "Run `dev worker doctor`, fix the worker, then `dev task retry`" });
    throw error;
  }
  const { worker } = selection;
  dev.events.emit("WORKER_SELECTED", { projectId: project.id, taskId: task.id, data: { workerId: worker.id, reason: selection.reason } });

  // ----- start -----
  const logsDir = join(dev.home, "logs");
  mkdirSync(logsDir, { recursive: true });
  dev.tasks.setStatus(task.id, "WORKING", { reason: `worker ${worker.id}` });
  const execution = dev.executions.create({ taskId: task.id, projectId: project.id, workerId: worker.id, cwd: projectPath });
  const logPath = join(logsDir, `${execution.id}.log`);
  dev.db.run("UPDATE executions SET log_path = ? WHERE id = ?", logPath, execution.id);
  writeFileSync(logPath, `# DEV execution ${execution.id}\n# task ${task.id}: ${task.title}\n# worker ${worker.id}\n# started ${execution.startedAt}\n\n`);
  dev.events.emit("TASK_STARTED", { projectId: project.id, taskId: task.id, executionId: execution.id, data: { workerId: worker.id, title: task.title } });

  // ----- where the run happens -----
  // In-place is the default: the worker edits the user's checkout. With
  // isolation=worktree each run gets its own git worktree on a fresh branch, so a
  // worker can never leave the checkout half-changed; what it did is committed on
  // that branch for the user to merge or discard. Only a repository can be
  // isolated; anything else falls back to in-place and says so in the log.
  const isolation = resolveConfigFor({ home: dev.home, projectDir: projectPath }).config.git.isolation;
  let runCwd = projectPath;
  let worktree: { path: string; branch: string } | null = null;
  if (isolation === "worktree") {
    if (await gitOps.isRepo(projectPath)) {
      const branch = `dev/${task.id}`;
      const path = join(dev.home, "worktrees", `${task.id}-${execution.id}`);
      mkdirSync(join(dev.home, "worktrees"), { recursive: true });
      await gitOps.worktreeAdd(projectPath, path, branch);
      worktree = { path, branch };
      runCwd = path;
      dev.db.run("UPDATE executions SET cwd = ? WHERE id = ?", runCwd, execution.id);
      dev.events.emit("WORKTREE_CREATED", { projectId: project.id, taskId: task.id, executionId: execution.id, data: { path, branch } });
      appendFileSync(logPath, `# isolation: worktree ${path} on branch ${branch}

`);
    } else {
      appendFileSync(logPath, `# isolation: worktree requested but ${projectPath} is not a git repository; running in place

`);
    }
  }

  const controller = new AbortController();
  options.signal?.addEventListener("abort", () => controller.abort(), { once: true });
  const cancelPoll = setInterval(() => {
    if (dev.executions.cancelRequested(execution.id)) controller.abort();
  }, 1000);

  const append = (chunk: string) => {
    try {
      appendFileSync(logPath, chunk);
    } catch {
      // log path unavailable; keep running
    }
  };
  const onOutput = (chunk: string, stream: "stdout" | "stderr") => {
    append(chunk);
    dev.events.emitTransient("COMMAND_OUTPUT", { projectId: project.id, taskId: task.id, executionId: execution.id, data: { stream, chunk } });
  };

  try {
    // ----- git snapshot before -----
    const before = await gitOps.snapshot(runCwd);

    // ----- context -----
    let prompt = "";
    if (worker.type !== "shell") {
      const assembled = assembleContext({ task: current, project, tasks: dev.tasks, decisions: dev.decisions, config: dev.config.context });
      // A human-edited brief wins. The snapshot below still records the assembled sections, because
      // knowing what DEV *would* have sent is what makes an override reviewable rather than a
      // black box, but the text that reaches the worker is exactly what the person wrote.
      const override = current.promptOverride;
      prompt = override ?? assembled.prompt;
      if (override !== null && override !== undefined) {
        append(`# context: human-edited brief, ~${estimateTokens(override)} tokens (assembly bypassed)

`);
      }
      const snapshot = dev.contextSnapshots.save({ taskId: task.id, executionId: execution.id, budgetTokens: assembled.budgetTokens, usedTokens: assembled.usedTokens, sections: assembled.sections });
      dev.executions.setContextSnapshot(execution.id, snapshot.id);
      dev.events.emit("CONTEXT_ASSEMBLED", { projectId: project.id, taskId: task.id, executionId: execution.id, data: { snapshotId: snapshot.id, usedTokens: assembled.usedTokens, budgetTokens: assembled.budgetTokens, sections: assembled.sections.filter((s) => s.included).map((s) => s.name) } });
      append(`# context: ${assembled.usedTokens}/${assembled.budgetTokens} tokens, sections: ${assembled.sections.filter((s) => s.included).map((s) => s.name).join(", ")}\n\n`);
    }

    // ----- run -----
    const timeoutMs = options.timeoutMs ?? timeoutFor(worker.type, dev.config.workers, previousFailure);
    dev.events.emit("COMMAND_STARTED", { projectId: project.id, taskId: task.id, executionId: execution.id, data: { workerId: worker.id, command: current.command ?? worker.id, timeoutMs } });
    const result = await worker.run({
      taskId: task.id,
      cwd: runCwd,
      prompt,
      command: current.command,
      effort: current.effort,
      // Two different axes: `effort` is how big the task is, `reasoningEffort` is how hard the model
      // thinks. A level set on the task wins; otherwise it is derived from the size estimate, and
      // the worker's own configured level overrides both inside the worker.
      reasoningEffort: current.reasoningEffort ?? effortForTaskSize(current.effort),
      timeoutMs,
      signal: controller.signal,
      onOutput,
    });
    dev.events.emit("COMMAND_FINISHED", { projectId: project.id, taskId: task.id, executionId: execution.id, data: { ok: result.ok, exitCode: result.exitCode, timedOut: result.timedOut, cancelled: result.cancelled, durationMs: result.durationMs } });
    append(`\n# worker finished: ok=${result.ok} exit=${result.exitCode} timedOut=${result.timedOut} cancelled=${result.cancelled}\n`);

    // ----- changed files -----
    let changedFiles: string[] = [];
    if (before.isRepo) {
      changedFiles = await gitOps.changedFilesSince(runCwd, before.files);
      for (const file of changedFiles.slice(0, 50)) dev.events.emit("FILE_CHANGED", { projectId: project.id, taskId: task.id, executionId: execution.id, data: { path: file } });
      if (changedFiles.length > 50) dev.events.emit("FILE_CHANGED", { projectId: project.id, taskId: task.id, executionId: execution.id, data: { count: changedFiles.length, note: "only the first 50 listed individually" } });
    }

    // ----- artifacts: log, diff, report -----
    const logArtifact = dev.artifacts.add({ projectId: project.id, taskId: task.id, executionId: execution.id, kind: "log", name: `${execution.id}.log`, path: logPath, meta: { workerId: worker.id } });
    if (changedFiles.length > 0 && before.isRepo) {
      const diffText = await gitOps.diff(runCwd);
      if (diffText.trim()) {
        const diffPath = join(logsDir, `${execution.id}.diff`);
        writeFileSync(diffPath, diffText);
        dev.artifacts.add({ projectId: project.id, taskId: task.id, executionId: execution.id, kind: "diff", name: `${execution.id}.diff`, path: diffPath, meta: { files: changedFiles.length } });
      }
    }
    if (result.summary.trim()) {
      const reportPath = join(logsDir, `${execution.id}.summary.md`);
      writeFileSync(reportPath, result.summary);
      dev.artifacts.add({ projectId: project.id, taskId: task.id, executionId: execution.id, kind: "report", name: "worker summary", path: reportPath });
    }

    // ----- outcome of the run itself -----
    if (result.cancelled) {
      return finish(dev, task, execution, { status: "cancelled", exitCode: result.exitCode, error: "cancelled", changedFiles, summary: result.summary, commandLine: result.commandLine, usage: result.usage }, {
        kind: "cancelled",
        reason: "Execution was cancelled",
        nextAction: "Retry when ready: dev task retry " + task.id,
      });
    }
    if (result.timedOut) {
      const lasted = formatTimeout(timeoutMs);
      const setting = worker.type === "shell" ? "workers.timeoutMs" : "workers.agentTimeoutMs";
      return finish(dev, task, execution, { status: "timeout", exitCode: result.exitCode, error: `timed out after ${lasted}`, changedFiles, summary: result.summary, commandLine: result.commandLine, usage: result.usage }, {
        kind: "timeout",
        reason: `Worker ${worker.id} exceeded ${lasted}`,
        nextAction: `Retry gets a longer cap (up to 4 hours). Or split the task, or raise ${setting}.`,
        data: { timeoutMs, workerId: worker.id },
      });
    }
    if (result.launchError) {
      return finish(dev, task, execution, { status: "failed", exitCode: null, error: result.launchError, changedFiles, summary: result.summary, commandLine: result.commandLine, usage: result.usage }, {
        kind: "launch-failed",
        reason: result.launchError,
        nextAction: "Check the worker is installed and on PATH (dev worker doctor)",
      });
    }
    dev.evidence.record({ taskId: task.id, executionId: execution.id, kind: "command-exit", passed: result.ok, summary: result.ok ? `${worker.name} finished with exit ${result.exitCode}` : `${worker.name} failed with exit ${result.exitCode}`, data: { exitCode: result.exitCode, workerId: worker.id }, artifactId: logArtifact.id });
    if (!result.ok) {
      // A worker that ran out of quota is not broken; sideline it so the next run picks one with
      // headroom instead of hammering the same limit.
      if (dev.workers.noteIfRateLimited(worker.id, result.summary)) {
        return finish(dev, task, execution, { status: "failed", exitCode: result.exitCode, error: "rate limited", changedFiles, summary: result.summary, commandLine: result.commandLine, usage: result.usage }, {
          kind: "worker-unavailable",
          reason: `${worker.name} is out of quota: ${firstLine(result.summary)}`,
          nextAction: `Retry and DEV routes to a worker with headroom, or wait for ${worker.name} to reset: dev task retry ${task.id}`,
        });
      }
      return finish(dev, task, execution, { status: "failed", exitCode: result.exitCode, error: `worker exited ${result.exitCode}`, changedFiles, summary: result.summary, commandLine: result.commandLine, usage: result.usage }, {
        kind: "process-failed",
        reason: `${worker.name} exited with code ${result.exitCode}: ${firstLine(result.summary)}`,
        nextAction: `Read the log (dev task log ${task.id}), fix the cause, then dev task retry ${task.id}`,
      });
    }

    // A worker that was refused permission to run commands cannot have verified anything it built.
    // Say so plainly instead of letting the run look clean: the summary reads like success.
    if (wasPermissionBlocked(result.summary)) {
      dev.evidence.record({ taskId: task.id, executionId: execution.id, kind: "other", passed: false, summary: `${worker.name} was refused permission to run commands, so nothing it built was tested`, data: { workerId: worker.id, permissionBlocked: true } });
      return finish(dev, task, execution, { status: "failed", exitCode: result.exitCode, error: "permission-blocked: the worker could not run commands", changedFiles, summary: result.summary, commandLine: result.commandLine, usage: result.usage }, {
        kind: "worker-unavailable",
        reason: `${worker.name} could edit files but was refused permission to run commands, so it could not run tests, builds or any check. Its own summary says the work is unverified.`,
        nextAction: `Set the worker's permission mode to one that allows commands (Settings → Workers → permission mode: bypassPermissions), then retry: dev task retry ${task.id}`,
      });
    }

    // ----- verification -----
    const specs = [...(project.config.verification ?? []), ...current.verification];
    let needsReview = project.config.reviewRequired === true;
    let verificationFailed: string | null = null;
    for (const spec of specs) {
      dev.events.emit("VERIFICATION_STARTED", { projectId: project.id, taskId: task.id, executionId: execution.id, data: { kind: spec.kind, label: spec.label ?? spec.command ?? spec.path ?? null } });
      const outcome = await runVerification(spec, runCwd, { signal: controller.signal, onOutput: (chunk) => onOutput(chunk, "stdout") });
      if (outcome.manual) {
        needsReview = true;
        dev.events.emit("REVIEW_REQUESTED", { projectId: project.id, taskId: task.id, executionId: execution.id, data: { reason: outcome.label } });
        continue;
      }
      let artifactId: string | null = null;
      if (outcome.output.trim()) {
        const outPath = join(logsDir, `${execution.id}.verify-${specs.indexOf(spec) + 1}.log`);
        writeFileSync(outPath, outcome.output);
        artifactId = dev.artifacts.add({ projectId: project.id, taskId: task.id, executionId: execution.id, kind: "test-result", name: outcome.label, path: outPath, meta: { passed: outcome.passed } }).id;
      }
      dev.evidence.record({ taskId: task.id, executionId: execution.id, kind: spec.kind === "file-exists" ? "file-exists" : "verification", passed: outcome.passed, summary: outcome.summary, data: outcome.data, artifactId });
      dev.events.emit(outcome.passed ? "VERIFICATION_PASSED" : "VERIFICATION_FAILED", { projectId: project.id, taskId: task.id, executionId: execution.id, data: { label: outcome.label, summary: outcome.summary, durationMs: outcome.durationMs } });
      if (!outcome.passed) {
        verificationFailed = outcome.summary;
        break;
      }
    }
    if (verificationFailed) {
      return finish(dev, task, execution, { status: "failed", exitCode: result.exitCode, error: `verification failed: ${verificationFailed}`, changedFiles, summary: result.summary, commandLine: result.commandLine, usage: result.usage }, {
        kind: "verification-failed",
        reason: verificationFailed,
        nextAction: `Fix the failure (see dev task show ${task.id}), then dev task retry ${task.id}`,
      });
    }

    // ----- success -----
    let summary = await concise(dev, result.summary, changedFiles);
    if (worktree) {
      // The checkout never saw this work; the branch is where it lives now.
      if (changedFiles.length > 0) {
        const message = `${current.title}

DEV task ${task.id}, execution ${execution.id}.`;
        const made = await gitOps.commit(worktree.path, message, { all: true });
        dev.events.emit("WORKTREE_COMMITTED", { projectId: project.id, taskId: task.id, executionId: execution.id, data: { branch: worktree.branch, hash: made.hash, files: changedFiles.length } });
        dev.events.emit("GIT_COMMIT", { projectId: project.id, taskId: task.id, executionId: execution.id, data: { hash: made.hash, subject: made.subject, branch: worktree.branch } });
        summary = `${summary}

Committed on branch ${worktree.branch} (${made.hash.slice(0, 7)}); your checkout is unchanged.`;
      }
      await gitOps.worktreeRemove(projectPath, worktree.path, true).catch(() => undefined);
    }
    const finished = dev.executions.finish(execution.id, { status: "succeeded", exitCode: result.exitCode, changedFiles, summary, command: result.commandLine, usage: result.usage });
    if (needsReview) {
      dev.tasks.setStatus(task.id, "REVIEW", { reason: "review required", resultSummary: summary });
      dev.events.emit("REVIEW_REQUESTED", { projectId: project.id, taskId: task.id, executionId: execution.id, data: { reason: "project or task requires human review" } });
    } else {
      dev.tasks.setStatus(task.id, "DONE", { reason: "verified", resultSummary: summary });
    }
    return finished;
  } catch (error) {
    const message = (error as Error).message;
    append(`\n# runner error: ${message}\n`);
    return finish(dev, task, execution, { status: "failed", exitCode: null, error: message, changedFiles: [], summary: message, commandLine: null, usage: null }, {
      kind: "process-failed",
      reason: message,
      nextAction: worktree ? `Inspect the log (dev task log ${task.id}) and the worktree at ${worktree.path}, then retry` : `Inspect the log (dev task log ${task.id}) and retry`,
    });
  } finally {
    clearInterval(cancelPoll);
  }
}

function finish(
  dev: Dev,
  task: Task,
  execution: Execution,
  patch: { status: Execution["status"]; exitCode: number | null; error: string | null; changedFiles: string[]; summary: string; commandLine: string | null; usage: Record<string, unknown> | null },
  failure: Omit<TaskFailure, "at" | "executionId">,
): Execution {
  const finished = dev.executions.finish(execution.id, { status: patch.status, exitCode: patch.exitCode, error: patch.error, changedFiles: patch.changedFiles, summary: patch.summary, command: patch.commandLine, usage: patch.usage });
  const live = dev.tasks.get(task.id);
  if (live && live.status === "WORKING") {
    // Cancelling a run stops the work; it does not throw the task away. Put it back in the queue
    // so it stays on the board and can be run again. CANCELLED is reserved for an explicit discard.
    if (failure.kind === "cancelled") dev.tasks.setStatus(task.id, "READY", { reason: "run cancelled; returned to the queue", force: true });
    else dev.tasks.block(task.id, { ...failure, executionId: execution.id });
  }
  return finished;
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).find((l) => l.trim())?.trim().slice(0, 200) ?? "";
}

/**
 * Keep the persisted result summary short. The worker's closing message is
 * already brief for agents; shell output is trimmed. When a local model is
 * healthy and the text is long, it condenses it, so the next task's context
 * stays small. Failure of the summariser is never fatal.
 */
async function concise(dev: Dev, summary: string, changedFiles: string[]): Promise<string> {
  const changed = changedFiles.length ? `Changed ${changedFiles.length} file(s): ${changedFiles.slice(0, 8).join(", ")}${changedFiles.length > 8 ? ", …" : ""}` : "";
  let text = summary.trim();
  if (text.length > 1200) {
    const shorter = await dev.summarize(text, "Condense this worker report to at most 8 short lines: what changed, where, how it was verified, open issues.");
    if (shorter) text = shorter;
    else text = text.slice(0, 1200) + "…";
  }
  return [text, changed].filter(Boolean).join("\n");
}

/**
 * Did the worker report that it was refused permission to run commands? Claude Code says so in
 * plain words when a non-interactive session cannot get approval. Matching its own wording is
 * deliberate: DEV never infers this from an exit code, only from the worker saying it.
 */
export function wasPermissionBlocked(summary: string): boolean {
  if (!summary) return false;
  return /permission[- ](?:blocked|prompt was declined)|blocked by permission rules|requires approval and the permission prompt|could not (?:get|obtain) approval|non-interactive, so I can'?t get approval/i.test(summary);
}

/**
 * What kind of thinking this task actually needs, so routing can send it to the worker the user
 * rates for that. A decision or an epic is planning; a prep task is research; everything else is
 * code. Workers differ in what they are good at, and DEV should not pretend otherwise.
 */
export function capabilityFor(task: Task): WorkerCapability {
  if (task.kind === "decision" || task.kind === "epic") return "plan";
  if (task.kind === "prep") return "research";
  return "code";
}

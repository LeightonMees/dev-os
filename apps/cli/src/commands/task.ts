import { existsSync, readFileSync } from "node:fs";

import { assembleContext, isTaskStatus, isReasoningEffort, REASONING_EFFORTS, type Task, type VerificationSpec } from "@dev/core";

import { flagBool, flagList, flagString, UsageError } from "../args.ts";
import { currentProject, type CliContext } from "../context.ts";
import { ago, c, duration, kv, printJson, println, statusColor, statusSymbol, table, truncate } from "../output.ts";
import { runCommand, cancelCommand, retryCommand } from "./run.ts";

export async function taskCommand(ctx: CliContext, sub: string | undefined, rest: string[]): Promise<number> {
  switch (sub) {
    case undefined:
    case "list":
    case "ls":
      return list(ctx);
    case "add":
    case "create":
      return add(ctx, rest.join(" "));
    case "show":
      return show(ctx, rest[0]);
    case "run":
      return runCommand(ctx, rest[0]);
    case "retry":
      return retryCommand(ctx, rest[0]);
    case "cancel":
      return cancelCommand(ctx, rest[0]);
    case "move":
      return move(ctx, rest[0], rest[1]);
    case "dep":
    case "depends":
      return dep(ctx, rest[0], rest[1]);
    case "undep":
      return undep(ctx, rest[0], rest[1]);
    case "approve":
      return approve(ctx, rest[0]);
    case "reject":
      return reject(ctx, rest[0]);
    case "context":
      return context(ctx, rest[0]);
    case "log":
      return log(ctx, rest[0]);
    case "edit":
    case "set":
      return edit(ctx, rest[0]);
    case "rm":
    case "remove":
      return remove(ctx, rest[0]);
    default:
      throw new UsageError(`Unknown task command "${sub}". Try: dev task --help`);
  }
}

export function resolveTask(ctx: CliContext, ref: string | undefined): Task {
  if (!ref) throw new UsageError("A task id is required (see: dev task list)");
  const project = currentProject(ctx, { required: false });
  const task = ctx.dev.tasks.resolve(ref, project?.id);
  if (!task) throw new UsageError(`No task matches "${ref}"${project ? ` in ${project.name}` : ""}`);
  return task;
}

function list(ctx: CliContext): number {
  const project = currentProject(ctx, { required: false });
  const statusFilter = flagList(ctx.flags, "status").map((s) => s.toUpperCase()).filter(isTaskStatus);
  let tasks = ctx.dev.tasks.list({ projectId: project?.id, status: statusFilter.length ? statusFilter : undefined, milestone: flagString(ctx.flags, "milestone"), epic: flagString(ctx.flags, "epic") });
  if (!flagBool(ctx.flags, "all") && statusFilter.length === 0) tasks = tasks.filter((t) => t.status !== "CANCELLED");
  if (ctx.json) {
    printJson(tasks);
    return 0;
  }
  if (tasks.length === 0) {
    println(c.dim("No tasks.") + (project ? `  Create one: ${c.bold(`dev task add "<title>"`)}  or plan a goal: ${c.bold(`dev plan "<goal>"`)}` : ""));
    return 0;
  }
  const rows = tasks.map((t) => [
    statusSymbol(t.status),
    t.id,
    String(t.ordinal),
    truncate(t.title, 56),
    statusColor(t.status),
    t.kind === "ticket" ? (t.epic ? c.dim(truncate(t.epic, 22)) : "") : c.magenta(t.kind) + (t.epic ? c.dim(` ${truncate(t.epic, 18)}`) : ""),
    t.risk === "high" ? c.red("high") : t.needsHuman ? c.yellow("human") : "",
    t.dependsOn.length ? c.dim(`⇠ ${t.dependsOn.map((d) => ctx.dev.tasks.get(d)?.ordinal ?? "?").join(",")}`) : "",
    t.workerId ?? "",
    t.status === "BLOCKED" ? c.red(truncate(t.failure?.reason ?? "", 40)) : c.dim(ago(t.updatedAt)),
  ]);
  println(table(rows, { header: ["", "ID", "#", "TITLE", "STATUS", "EPIC", "RISK", "DEPS", "WORKER", ""] }));
  return 0;
}

function add(ctx: CliContext, title: string): number {
  const project = currentProject(ctx);
  if (!project) throw new UsageError("No project");
  if (!title.trim()) throw new UsageError('Usage: dev task add "<title>" [--outcome ..] [--req ..] [--accept ..] [--command ..] [--verify "<cmd>"] [--depends <id,id>] [--file <path>] [--worker <id>] [--effort low|medium|high] [--reasoning <level>] [--ready]');
  const verification: VerificationSpec[] = flagList(ctx.flags, "verify").map((command) => ({ kind: "command", command }));
  for (const path of flagList(ctx.flags, "verify-file")) verification.push({ kind: "file-exists", path });
  if (flagBool(ctx.flags, "manual-review")) verification.push({ kind: "manual" });
  const effortRaw = flagString(ctx.flags, "effort");
  const effort = effortRaw === "low" || effortRaw === "high" ? effortRaw : "medium";
  // --effort is how big the job is; --reasoning is how hard the model thinks about it.
  const reasoningRaw = flagString(ctx.flags, "reasoning");
  if (reasoningRaw !== undefined && !isReasoningEffort(reasoningRaw)) {
    throw new UsageError(`--reasoning must be one of ${REASONING_EFFORTS.join(", ")}; got "${reasoningRaw}"`);
  }
  const dependsOn = flagList(ctx.flags, "depends").concat(flagList(ctx.flags, "after")).map((ref) => {
    const dep = ctx.dev.tasks.resolve(ref, project.id);
    if (!dep) throw new UsageError(`Dependency "${ref}" does not match a task`);
    return dep.id;
  });
  const task = ctx.dev.tasks.create({
    projectId: project.id,
    title: title.trim(),
    outcome: flagString(ctx.flags, "outcome"),
    requirements: flagList(ctx.flags, "req").concat(flagList(ctx.flags, "requirement")),
    acceptance: flagList(ctx.flags, "accept").concat(flagList(ctx.flags, "acceptance")),
    command: flagString(ctx.flags, "command") ?? null,
    workerId: flagString(ctx.flags, "worker") ?? null,
    files: flagList(ctx.flags, "file"),
    verification,
    effort,
    reasoningEffort: reasoningRaw ?? null,
    dependsOn,
    milestone: flagString(ctx.flags, "milestone") ?? null,
    epic: flagString(ctx.flags, "epic") ?? null,
    kind: (flagString(ctx.flags, "kind") as "epic" | "ticket" | "subtask" | "prep" | "decision" | undefined) ?? "ticket",
    risk: (flagString(ctx.flags, "risk") as "low" | "normal" | "high" | undefined) ?? "normal",
    needsHuman: flagString(ctx.flags, "needs-human") ?? null,
    status: "BACKLOG",
  });
  if (flagBool(ctx.flags, "ready") || (dependsOn.length === 0 && !flagBool(ctx.flags, "backlog"))) {
    if (ctx.dev.tasks.unmetDependencies(task.id).length === 0) ctx.dev.tasks.setStatus(task.id, "READY", { reason: "created ready" });
  }
  const created = ctx.dev.tasks.get(task.id) as Task;
  if (ctx.json) {
    printJson(created);
    return 0;
  }
  println(`${c.green("✓")} Task ${c.bold(created.id)} #${created.ordinal} ${statusColor(created.status)}: ${created.title}`);
  if (created.status === "READY") println(c.dim(`  Run it: dev task run ${created.id}`));
  return 0;
}

function show(ctx: CliContext, ref: string | undefined): number {
  const task = resolveTask(ctx, ref);
  const executions = ctx.dev.executions.list({ taskId: task.id, limit: 10 });
  const evidence = ctx.dev.evidence.list(task.id);
  const artifacts = ctx.dev.artifacts.list({ taskId: task.id });
  const events = ctx.dev.events.list({ taskId: task.id, limit: 200 });
  if (ctx.json) {
    printJson({ ...task, executions, evidence, artifacts, events, dependents: ctx.dev.tasks.dependents(task.id) });
    return 0;
  }
  const deps = task.dependsOn.map((d) => ctx.dev.tasks.get(d)).filter((d): d is Task => !!d);
  println(`${statusSymbol(task.status)} ${c.bold(task.title)}  ${c.dim(task.id)}  ${statusColor(task.status)}`);
  println(
    kv(
      [
        ["project", ctx.dev.projects.get(task.projectId)?.name ?? task.projectId],
        ["outcome", task.outcome || null],
        ["size (effort)", task.effort],
        ["reasoning", task.reasoningEffort ?? `from size (${task.effort})`],
        ["worker", task.workerId ?? c.dim("auto")],
        ["command", task.command],
        ["depends on", deps.length ? deps.map((d) => `${d.id} ${statusColor(d.status)} ${truncate(d.title, 40)}`).join("\n" + " ".repeat(14)) : null],
        ["files", task.files.length ? task.files.join(", ") : null],
        ["verification", task.verification.length ? task.verification.map((v) => v.command ?? v.path ?? v.kind).join("; ") : c.dim("none on task")],
        ["capabilities", task.capabilities.length ? task.capabilities.map((x) => `${x.kind}:${x.name}`).join(", ") : null],
        ["retries", task.retryCount || null],
        ["updated", ago(task.updatedAt)],
      ],
      2,
    ),
  );
  if (task.requirements.length) println("\n  " + c.dim("Requirements") + "\n" + task.requirements.map((r) => `    - ${r}`).join("\n"));
  if (task.acceptance.length) println("\n  " + c.dim("Acceptance") + "\n" + task.acceptance.map((a) => `    - ${a}`).join("\n"));
  if (task.failure) {
    println("\n  " + c.red(`Blocked: ${task.failure.kind}`));
    println(`    ${task.failure.reason}`);
    println(c.dim(`    Next: ${task.failure.nextAction}`));
  }
  if (task.resultSummary) println("\n  " + c.green("Result") + "\n" + task.resultSummary.split("\n").map((l) => `    ${l}`).join("\n"));
  if (executions.length) {
    println("\n  " + c.dim("Executions"));
    println(table(executions.map((e) => [e.id, e.workerId, e.status === "succeeded" ? c.green(e.status) : e.status === "running" ? c.cyan(e.status) : c.red(e.status), duration(e.durationMs), `${e.changedFiles.length} files`, ago(e.startedAt)]), { indent: 4 }));
  }
  if (evidence.length) {
    println("\n  " + c.dim("Evidence"));
    println(table(evidence.map((e) => [e.passed ? c.green("✓") : c.red("✗"), e.kind, truncate(e.summary, 70)]), { indent: 4 }));
  }
  if (artifacts.length) {
    println("\n  " + c.dim("Artifacts"));
    println(table(artifacts.map((a) => [a.id, a.kind, a.name, c.dim(a.path)]), { indent: 4 }));
  }
  if (events.length) {
    println("\n  " + c.dim(`Events (${events.length})`));
    println(table(events.slice(-12).map((e) => [c.dim(e.ts.slice(11, 19)), e.type, c.dim(truncate(JSON.stringify(e.data), 60))]), { indent: 4 }));
  }
  return 0;
}

function move(ctx: CliContext, ref: string | undefined, to: string | undefined): number {
  const task = resolveTask(ctx, ref);
  const target = (to ?? "").toUpperCase();
  if (!isTaskStatus(target)) throw new UsageError("Usage: dev task move <id> <backlog|ready|working|blocked|review|done|cancelled>");
  const updated = ctx.dev.tasks.setStatus(task.id, target, { force: flagBool(ctx.flags, "force"), reason: flagString(ctx.flags, "reason") ?? "moved by user" });
  if (ctx.json) printJson(updated);
  else println(`${c.green("✓")} ${task.id} ${statusColor(task.status)} → ${statusColor(updated.status)}`);
  return 0;
}

function dep(ctx: CliContext, ref: string | undefined, onRef: string | undefined): number {
  const task = resolveTask(ctx, ref);
  const on = resolveTask(ctx, onRef);
  ctx.dev.tasks.addDependency(task.id, on.id);
  if (ctx.json) printJson(ctx.dev.tasks.get(task.id));
  else println(`${c.green("✓")} ${task.id} now depends on ${on.id} (${truncate(on.title, 40)})`);
  return 0;
}

function undep(ctx: CliContext, ref: string | undefined, onRef: string | undefined): number {
  const task = resolveTask(ctx, ref);
  const on = resolveTask(ctx, onRef);
  ctx.dev.tasks.removeDependency(task.id, on.id);
  if (ctx.json) printJson(ctx.dev.tasks.get(task.id));
  else println(`${c.green("✓")} ${task.id} no longer depends on ${on.id}`);
  return 0;
}

function approve(ctx: CliContext, ref: string | undefined): number {
  const task = resolveTask(ctx, ref);
  const reason = flagString(ctx.flags, "reason") || "Approved by user";
  if (task.status !== "REVIEW" && !flagBool(ctx.flags, "force")) throw new UsageError(`Task is ${task.status}; approve is for REVIEW tasks (use --force to record human approval on a ${task.status} task)`);
  ctx.dev.evidence.record({ taskId: task.id, kind: "human-approval", passed: true, summary: reason });
  const updated = ctx.dev.tasks.setStatus(task.id, "DONE", { reason: "approved", force: true });
  if (ctx.json) printJson(updated);
  else println(`${c.green("✓")} ${task.id} approved → ${statusColor("DONE")}`);
  return 0;
}

function reject(ctx: CliContext, ref: string | undefined): number {
  const task = resolveTask(ctx, ref);
  const reason = flagString(ctx.flags, "reason") || "Rejected in review";
  ctx.dev.evidence.record({ taskId: task.id, kind: "human-approval", passed: false, summary: reason });
  const updated = ctx.dev.tasks.block(task.id, { kind: "review-rejected", reason, nextAction: `Address the feedback, then dev task retry ${task.id}` });
  if (ctx.json) printJson(updated);
  else println(`${c.yellow("!")} ${task.id} rejected → ${statusColor("BLOCKED")}: ${reason}`);
  return 0;
}

function context(ctx: CliContext, ref: string | undefined): number {
  const task = resolveTask(ctx, ref);
  const project = ctx.dev.projects.get(task.projectId);
  if (!project) throw new UsageError("Project missing");
  const budgetRaw = flagString(ctx.flags, "budget");
  const assembled = assembleContext({ task, project, tasks: ctx.dev.tasks, decisions: ctx.dev.decisions, config: ctx.dev.config.context, budgetTokens: budgetRaw ? Number(budgetRaw) : undefined });
  if (ctx.json) {
    printJson({ taskId: task.id, ...assembled });
    return 0;
  }
  println(c.bold(`Context preview for ${task.id}`) + c.dim(`  ~${assembled.usedTokens} of ${assembled.budgetTokens} tokens`));
  println(table(assembled.sections.map((s) => [s.included ? (s.truncated ? c.yellow("cut") : c.green("in")) : c.dim("out"), s.name, `~${s.tokens} tok`, c.dim(s.source ?? "")]), { indent: 2 }));
  if (flagBool(ctx.flags, "full") || flagBool(ctx.flags, "verbose")) {
    println("\n" + c.dim("─".repeat(60)));
    println(assembled.prompt);
  } else {
    println(c.dim("\n  --full prints the exact prompt the worker receives"));
  }
  return 0;
}

function log(ctx: CliContext, ref: string | undefined): number {
  const task = resolveTask(ctx, ref);
  const executionRef = flagString(ctx.flags, "execution");
  const execution = executionRef ? ctx.dev.executions.get(executionRef) : ctx.dev.executions.list({ taskId: task.id, limit: 1 })[0];
  if (!execution) throw new UsageError(`No executions for ${task.id} yet`);
  if (!execution.logPath || !existsSync(execution.logPath)) throw new UsageError(`Log file missing for ${execution.id}`);
  const text = readFileSync(execution.logPath, "utf8");
  const tailRaw = flagString(ctx.flags, "tail");
  const lines = text.split(/\r?\n/);
  const shown = tailRaw ? lines.slice(-Number(tailRaw)) : lines;
  if (ctx.json) printJson({ execution, log: shown.join("\n") });
  else {
    println(c.dim(`# ${execution.id} ${execution.workerId} ${execution.status} ${execution.logPath}`));
    println(shown.join("\n"));
  }
  return 0;
}

function edit(ctx: CliContext, ref: string | undefined): number {
  const task = resolveTask(ctx, ref);
  const patch: Record<string, unknown> = {};
  const title = flagString(ctx.flags, "title");
  if (title) patch.title = title;
  const outcome = flagString(ctx.flags, "outcome");
  if (outcome !== undefined) patch.outcome = outcome;
  const worker = flagString(ctx.flags, "worker");
  if (worker !== undefined) patch.workerId = worker === "auto" || worker === "" ? null : worker;
  const command = flagString(ctx.flags, "command");
  if (command !== undefined) patch.command = command || null;
  const effort = flagString(ctx.flags, "effort");
  if (effort === "low" || effort === "medium" || effort === "high") patch.effort = effort;
  const reasoning = flagString(ctx.flags, "reasoning");
  if (reasoning !== undefined) {
    if (reasoning === "" || reasoning === "null") patch.reasoningEffort = null;
    else if (isReasoningEffort(reasoning)) patch.reasoningEffort = reasoning;
    else throw new UsageError(`--reasoning must be one of ${REASONING_EFFORTS.join(", ")} (or "null"); got "${reasoning}"`);
  }
  const req = flagList(ctx.flags, "req");
  if (req.length) patch.requirements = req;
  const accept = flagList(ctx.flags, "accept");
  if (accept.length) patch.acceptance = accept;
  const files = flagList(ctx.flags, "file");
  if (files.length) patch.files = files;
  const verify = flagList(ctx.flags, "verify");
  if (verify.length) patch.verification = verify.map((command) => ({ kind: "command", command }));
  if (flagString(ctx.flags, "verify") === "none") patch.verification = [];
  if (Object.keys(patch).length === 0) throw new UsageError("Nothing to change. Flags: --title --outcome --worker --command --effort --req --accept --file --verify");
  const updated = ctx.dev.tasks.update(task.id, patch);
  if (ctx.json) printJson(updated);
  else println(`${c.green("✓")} ${task.id} updated: ${Object.keys(patch).join(", ")}`);
  return 0;
}

function remove(ctx: CliContext, ref: string | undefined): number {
  const task = resolveTask(ctx, ref);
  if (!flagBool(ctx.flags, "yes") && !flagBool(ctx.flags, "y")) throw new UsageError(`This deletes task ${task.id} and its evidence/executions from DEV. Re-run with --yes to confirm.`);
  ctx.dev.tasks.remove(task.id);
  if (ctx.json) printJson({ removed: task.id });
  else println(`${c.green("✓")} Removed ${task.id}`);
  return 0;
}

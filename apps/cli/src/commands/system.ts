import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { doctor, git, setConfigValue, type DoctorCheck, seedGettingStarted } from "@dev/core";

import { ControlPlaneClient } from "../api.ts";
import { flagBool, flagNumber, flagString, UsageError } from "../args.ts";
import { controlPlane, controlPlaneInfoPath, currentProject, REPO_ROOT, type CliContext } from "../context.ts";
import { ago, c, duration, kv, printJson, println, eprintln, statusColor, SYMBOL, table, truncate } from "../output.ts";
import { printEvent } from "./run.ts";

export async function doctorCommand(ctx: CliContext): Promise<number> {
  const checks = await doctor(ctx.dev, { desktop: flagBool(ctx.flags, "desktop") || true });
  const cp = await controlPlane(ctx.home);
  checks.push({ name: "control-plane", status: cp ? "ok" : "warning", detail: cp ? `${cp.url} (pid ${cp.pid})` : "not running", remediation: cp ? undefined : "dev control-plane start   (dev ui starts it automatically)" });
  if (ctx.json) {
    printJson(checks);
    return checks.some((x) => x.status === "failed") ? 2 : 0;
  }
  println(c.bold("dev doctor") + c.dim(`  home ${ctx.home}`));
  for (const check of checks) println(formatCheck(check));
  const failed = checks.filter((x) => x.status === "failed").length;
  const warned = checks.filter((x) => x.status === "warning").length;
  println("");
  println(failed ? c.red(`${failed} failed, ${warned} warning(s)`) : warned ? c.yellow(`${warned} warning(s), nothing failed`) : c.green("Everything OK"));
  return failed ? 2 : 0;
}

/**
 * Put the guide in front of a new user. Idempotent, so running it twice says so
 * rather than creating a second copy.
 */
export async function welcomeCommand(ctx: CliContext): Promise<number> {
  const result = seedGettingStarted(ctx.dev);
  if (ctx.json) {
    printJson(result);
    return 0;
  }
  if (result.existed) {
    println(c.dim(`"${result.project.name}" is already here with ${result.tasks.length} step(s).`));
  } else {
    println(c.green(`Created "${result.project.name}" with ${result.tasks.length} steps.`));
  }
  println("");
  for (const task of result.tasks) {
    const mark = task.status === "DONE" ? c.green("✓") : task.status === "READY" ? c.bold("→") : c.dim("·");
    println(`  ${mark} ${task.ordinal}. ${task.title}`);
  }
  println("");
  println(c.dim("DEV has no default AI. A local model, a CLI agent, a hosted key or none at all are all valid."));
  println(`Start with: ${c.bold("dev task show " + (result.tasks[0]?.id ?? ""))}   or open the app with ${c.bold("dev ui")}`);
  return 0;
}

function formatCheck(check: DoctorCheck): string {
  const symbol = check.status === "ok" ? SYMBOL.ok : check.status === "warning" ? SYMBOL.warn : SYMBOL.fail;
  const line = `  ${symbol} ${check.name.padEnd(22)} ${check.detail}`;
  return check.remediation && check.status !== "ok" ? `${line}\n      ${c.dim("→ " + check.remediation)}` : line;
}

export async function statusCommand(ctx: CliContext): Promise<number> {
  const projects = ctx.dev.projects.list({ status: "active" });
  const running = ctx.dev.executions.list({ status: "running", limit: 20 });
  const blocked = ctx.dev.tasks.list({ status: "BLOCKED", limit: 10 });
  const review = ctx.dev.tasks.list({ status: "REVIEW", limit: 10 });
  const recentDone = ctx.dev.tasks.list({ status: "DONE" }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 5);
  const cp = await controlPlane(ctx.home);
  const workers = ctx.dev.workers.list();
  if (ctx.json) {
    printJson({ home: ctx.home, controlPlane: cp, projects, running, blocked, review, recentDone, workers, counts: ctx.dev.tasks.counts() });
    return 0;
  }
  println(c.bold("DEV") + c.dim(`  ${ctx.home}`) + "  " + (cp ? c.green(`control plane ${cp.url}`) : c.dim("control plane not running")));
  const name = (taskId: string) => ctx.dev.tasks.get(taskId)?.title ?? taskId;
  const projectName = (id: string) => ctx.dev.projects.get(id)?.name ?? id;
  if (projects.length === 0) println(c.dim("\nNo projects. dev project add <path>"));
  else {
    println("\n" + c.dim("Projects"));
    println(table(projects.map((p) => {
      const counts = ctx.dev.tasks.counts(p.id);
      return [p.id, c.bold(p.name), `${counts.READY + counts.WORKING} active`, counts.BLOCKED ? c.red(`${counts.BLOCKED} blocked`) : "", counts.REVIEW ? c.yellow(`${counts.REVIEW} review`) : "", `${counts.DONE} done`, c.dim(ago(p.updatedAt))];
    }), { indent: 2 }));
  }
  if (running.length) {
    println("\n" + c.cyan("Running"));
    println(table(running.map((e) => [e.id, projectName(e.projectId), truncate(name(e.taskId), 40), e.workerId, ago(e.startedAt)]), { indent: 2 }));
  }
  if (blocked.length) {
    println("\n" + c.red("Blocked"));
    println(table(blocked.map((t) => [t.id, projectName(t.projectId), truncate(t.title, 40), c.dim(truncate(t.failure?.reason ?? "", 50))]), { indent: 2 }));
  }
  if (review.length) {
    println("\n" + c.yellow("Awaiting review"));
    println(table(review.map((t) => [t.id, projectName(t.projectId), truncate(t.title, 50)]), { indent: 2 }));
  }
  if (recentDone.length) {
    println("\n" + c.green("Recently done"));
    println(table(recentDone.map((t) => [t.id, projectName(t.projectId), truncate(t.title, 50), c.dim(ago(t.updatedAt))]), { indent: 2 }));
  }
  println("\n" + c.dim("Workers"));
  println(table(workers.map((w) => [w.health ? (w.health.ok ? SYMBOL.ok : SYMBOL.fail) : SYMBOL.dot, w.id, w.type, c.dim(w.health ? truncate(w.health.detail, 60) : "not checked (dev worker doctor)")]), { indent: 2 }));
  return 0;
}

export async function workersCommand(ctx: CliContext, sub: string | undefined, rest: string[]): Promise<number> {
  if (sub === "doctor" || sub === "check") {
    const only = rest[0];
    const ids = only ? [only] : ctx.dev.workers.all().map((w) => w.id);
    const results: Record<string, unknown> = {};
    for (const id of ids) {
      if (!ctx.dev.workers.get(id)) throw new UsageError(`Unknown worker ${id}`);
      results[id] = await ctx.dev.workers.check(id);
    }
    if (ctx.json) {
      printJson(results);
      return 0;
    }
    for (const [id, h] of Object.entries(results) as [string, { ok: boolean; detail: string }][]) println(`  ${h.ok ? SYMBOL.ok : SYMBOL.fail} ${id.padEnd(12)} ${h.detail}`);
    return 0;
  }
  if (sub && sub !== "list") throw new UsageError(`Unknown workers command "${sub}". Try: dev workers | dev worker doctor [id]`);
  const workers = ctx.dev.workers.list();
  if (ctx.json) {
    printJson(workers);
    return 0;
  }
  println(table(workers.map((w) => [w.health ? (w.health.ok ? SYMBOL.ok : SYMBOL.fail) : SYMBOL.dot, c.bold(w.id), w.type, w.capabilities.join(","), w.currentTaskId ? c.cyan(`busy: ${w.currentTaskId}`) : c.dim("idle"), `${w.stats.succeeded}/${w.stats.executions} ok`, w.stats.avgDurationMs ? c.dim(`avg ${duration(w.stats.avgDurationMs)}`) : "", c.dim(w.health ? truncate(w.health.detail, 50) : "unchecked")]), { header: ["", "WORKER", "TYPE", "CAPABILITIES", "STATE", "RUNS", "", "HEALTH"] }));
  println(c.dim("\n  dev worker doctor   probes every worker now"));
  return 0;
}

export async function chatCommand(ctx: CliContext, text: string): Promise<number> {
  const { chatTurn } = await import("@dev/core");
  if (!text.trim()) throw new UsageError("Usage: dev chat <message> [--conversation <id>] [--project <ref>]");
  const project = currentProject(ctx, { required: false });
  const existing = flagString(ctx.flags, "conversation");
  const conversation = existing ? ctx.dev.chat.get(existing) : ctx.dev.chat.create({ projectId: project?.id ?? null });
  if (!conversation) throw new UsageError(`Unknown conversation ${existing}`);
  if (!ctx.json) eprintln(c.dim(`conversation ${conversation.id}${project ? ` (project ${project.name})` : ""}`));
  const turn = await chatTurn(ctx.dev, conversation.id, text);
  if (ctx.json) {
    printJson(turn);
    return 0;
  }
  for (const m of turn.messages) {
    if (m.role === "assistant" && m.toolCalls?.length) for (const call of m.toolCalls) eprintln(c.dim(`  -> ${call.function.name} ${truncate(call.function.arguments, 80)}`));
    if (m.role === "tool") eprintln(c.dim(`  <- ${truncate(m.content ?? "", 100)}`));
    if (m.role === "assistant" && m.content?.trim()) println(m.content.trim());
  }
  eprintln(c.dim(`  (${turn.brain.id} ${turn.brain.model}; continue with: dev chat <message> --conversation ${conversation.id})`));
  return 0;
}

export function keysCommand(ctx: CliContext): number {
  const rows = ctx.dev.config.workers.api.providers.map((p) => ({ provider: p.id, env: p.keyEnv || "(none needed)", set: !!p.keyEnv && !!process.env[p.keyEnv], enabled: p.enabled, model: p.model }));
  if (ctx.json) {
    printJson({ files: ctx.dev.secrets.files, loaded: ctx.dev.secrets.loaded, providers: rows });
    return 0;
  }
  println(c.dim(`secret files: ${ctx.dev.secrets.files.join(", ") || "none found"}`));
  println(table(rows.map((r) => [r.set ? SYMBOL.ok : SYMBOL.dot, r.provider, r.env, r.set ? "set" : c.dim("missing"), r.enabled ? "" : c.dim("disabled"), c.dim(r.model)]), { header: ["", "PROVIDER", "ENV VAR", "KEY", "", "MODEL"] }));
  println(c.dim("  Keys are read from Nexus secrets.env (nexus secret set <NAME> <value>) and ~/.dev/keys.env."));
  return 0;
}

export async function resourcesCommand(ctx: CliContext, sub: string | undefined, rest: string[]): Promise<number> {
  if (sub === "workflows") {
    const workflows = await ctx.dev.nexus.listWorkflows();
    if (ctx.json) printJson(workflows);
    else if (workflows.length === 0) println(c.dim("Nexus lists no workflows."));
    else println(table(workflows.map((w) => [c.bold(w.name), truncate(w.description, 70), w.hasRunner ? c.dim("runner") : ""]), { header: ["WORKFLOW", "DESCRIPTION", ""] }));
    return 0;
  }
  if (sub === "status") {
    const status = await ctx.dev.nexus.status();
    if (ctx.json) printJson(status);
    else println(kv([["root", status.root], ["skills", status.skills], ["mcps", status.mcps], ["apis", status.apis], ["workflows", status.workflows], ["tools", status.tools.join(", ")]]));
    return 0;
  }
  const query = sub === "search" ? rest.join(" ") : [sub, ...rest].filter(Boolean).join(" ");
  if (!query.trim()) throw new UsageError('Usage: dev resources search "<what you need>"   |   dev resources status');
  const matches = await ctx.dev.nexus.findCapability(query, flagNumber(ctx.flags, "limit") ?? 8);
  if (ctx.json) {
    printJson(matches);
    return 0;
  }
  if (matches.length === 0) {
    println(c.dim("Nexus found nothing for that. Try different words."));
    return 0;
  }
  println(table(matches.map((m) => [m.ready ? SYMBOL.ok : SYMBOL.warn, m.kind, c.bold(m.name), String(m.score), truncate(m.what, 70), m.blockers.length ? c.yellow(truncate(m.blockers.join("; "), 40)) : ""]), { header: ["", "KIND", "NAME", "SCORE", "WHAT", "BLOCKERS"] }));
  return 0;
}

export async function eventsCommand(ctx: CliContext): Promise<number> {
  const project = currentProject(ctx, { required: false });
  const limit = flagNumber(ctx.flags, "limit") ?? 40;
  const taskId = flagString(ctx.flags, "task");
  const types = flagString(ctx.flags, "type")?.split(",");
  const events = ctx.dev.events.list({ projectId: project?.id, taskId, limit, types });
  const render = (events: typeof ctx.dev.events extends { list: (...a: never[]) => infer R } ? R : never) => {
    for (const e of events) println(`${c.dim(e.ts.replace("T", " ").slice(0, 19))}  ${e.type.padEnd(22)} ${c.dim(e.taskId ?? e.projectId ?? "")}  ${truncate(JSON.stringify(e.data), 90)}`);
  };
  if (ctx.json && !flagBool(ctx.flags, "follow")) {
    printJson(events);
    return 0;
  }
  render(events);
  if (!flagBool(ctx.flags, "follow")) return 0;
  let last = events.length ? (events[events.length - 1] as { id: number }).id : ctx.dev.events.latestId();
  eprintln(c.dim("… following (Ctrl+C to stop)"));
  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => resolve());
    const timer = setInterval(() => {
      const fresh = ctx.dev.events.list({ projectId: project?.id, taskId, sinceId: last, limit: 200, types });
      if (fresh.length) {
        if (ctx.json) for (const e of fresh) println(JSON.stringify(e));
        else render(fresh);
        last = (fresh[fresh.length - 1] as { id: number }).id;
      }
    }, 500);
    process.on("SIGINT", () => clearInterval(timer));
  });
  return 0;
}

export async function configCommand(ctx: CliContext, sub: string | undefined, rest: string[]): Promise<number> {
  const file = join(ctx.home, "config.json");
  if (sub === "path") {
    println(file);
    return 0;
  }
  if (sub === "set") {
    const [key, ...valueParts] = rest;
    if (!key || valueParts.length === 0) throw new UsageError("Usage: dev config set <dotted.key> <value>");
    const config = setConfigValue(ctx.home, key, valueParts.join(" "));
    if (ctx.json) printJson(config);
    else println(`${c.green("✓")} ${key} = ${JSON.stringify(valueParts.join(" "))}  ${c.dim(`(${file}; restart the control plane to apply worker/nexus changes)`)}`);
    return 0;
  }
  if (sub === "init") {
    if (existsSync(file) && !flagBool(ctx.flags, "force")) throw new UsageError(`${file} already exists (use --force to overwrite with defaults)`);
    writeFileSync(file, JSON.stringify(ctx.dev.config, null, 2) + "\n");
    println(`${c.green("✓")} wrote ${file}`);
    return 0;
  }
  if (sub && sub !== "get" && sub !== "show") throw new UsageError("Usage: dev config [get [key]] | set <key> <value> | path | init");
  const key = rest[0];
  let value: unknown = ctx.dev.config;
  if (key) for (const part of key.split(".")) value = value && typeof value === "object" ? (value as Record<string, unknown>)[part] : undefined;
  if (ctx.json || typeof value === "object") printJson(value);
  else println(String(value));
  return 0;
}

export async function gitCommand(ctx: CliContext, sub: string | undefined, rest: string[]): Promise<number> {
  const project = currentProject(ctx);
  if (!project) throw new UsageError("No project");
  if (!project.path) throw new UsageError(`${project.name} has no repository yet (dev project set path <dir> --project ${project.id})`);
  switch (sub) {
    case undefined:
    case "status": {
      const status = await git.status(project.path);
      if (ctx.json) printJson(status);
      else if (!status.isRepo) println(c.dim(`${project.path} is not a git repository (git init to start one)`));
      else {
        println(kv([["branch", status.branch ?? (status.detached ? "detached HEAD" : "?")], ["remote", status.remote], ["ahead/behind", `${status.ahead}/${status.behind}`], ["last commit", status.lastCommit ? `${status.lastCommit.short} ${status.lastCommit.subject} ${c.dim(ago(status.lastCommit.date))}` : null], ["state", status.dirty ? c.yellow(`${status.changes.length} changed file(s)`) : c.green("clean")]]));
        if (status.changes.length) println(table(status.changes.slice(0, 50).map((ch) => [c.yellow(ch.status), ch.path]), { indent: 2 }));
      }
      return 0;
    }
    case "diff": {
      const text = await git.diff(project.path, { stat: flagBool(ctx.flags, "stat"), staged: flagBool(ctx.flags, "staged"), paths: rest });
      if (ctx.json) printJson({ diff: text });
      else println(text || c.dim("no differences"));
      return 0;
    }
    case "log": {
      const entries = await git.log(project.path, flagNumber(ctx.flags, "limit") ?? 15);
      if (ctx.json) printJson(entries);
      else println(table(entries.map((e) => [c.yellow(e.short), truncate(e.subject, 60), c.dim(e.author), c.dim(ago(e.date))])));
      return 0;
    }
    case "branch": {
      const name = rest[0];
      if (!name) {
        const b = await git.branches(project.path);
        if (ctx.json) printJson(b);
        else println(b.all.map((x) => (x === b.current ? c.green(`* ${x}`) : `  ${x}`)).join("\n"));
        return 0;
      }
      await git.createBranch(project.path, name, !flagBool(ctx.flags, "no-checkout"));
      println(`${c.green("✓")} branch ${name}`);
      return 0;
    }
    case "commit": {
      const message = rest.join(" ") || flagString(ctx.flags, "m") || flagString(ctx.flags, "message");
      if (!message) throw new UsageError('Usage: dev git commit "<message>" [--task <id>]');
      const commit = await git.commit(project.path, message, { all: true });
      const taskRef = flagString(ctx.flags, "task");
      const task = taskRef ? ctx.dev.tasks.resolve(taskRef, project.id) : undefined;
      ctx.dev.events.emit("GIT_COMMIT", { projectId: project.id, taskId: task?.id ?? null, data: { hash: commit.hash, subject: commit.subject } });
      if (task) ctx.dev.evidence.record({ taskId: task.id, kind: "other", passed: true, summary: `Committed ${commit.short}: ${commit.subject}`, data: { hash: commit.hash } });
      if (ctx.json) printJson(commit);
      else println(`${c.green("✓")} ${commit.short} ${commit.subject}`);
      return 0;
    }
    default:
      throw new UsageError(`Unknown git command "${sub}". Try: dev git status|diff|log|branch|commit`);
  }
}

export function decisionCommand(ctx: CliContext, sub: string | undefined, rest: string[]): number {
  const project = currentProject(ctx);
  if (!project) throw new UsageError("No project");
  if (sub === "add" || sub === "record") {
    const title = rest.join(" ") || flagString(ctx.flags, "title");
    const decision = flagString(ctx.flags, "decision") ?? title;
    if (!title) throw new UsageError('Usage: dev decision add "<title>" [--decision ..] [--reason ..] [--alt a,b] [--tags x,y] [--revisit ..]');
    const record = ctx.dev.decisions.record({ projectId: project.id, title, decision: decision ?? title, reason: flagString(ctx.flags, "reason"), alternatives: rest.length ? undefined : undefined, tags: flagString(ctx.flags, "tags")?.split(","), revisit: flagString(ctx.flags, "revisit") ?? null });
    if (ctx.json) printJson(record);
    else println(`${c.green("✓")} decision ${record.id}: ${record.title}`);
    return 0;
  }
  if (sub === "rm" || sub === "remove") {
    if (!rest[0]) throw new UsageError("Usage: dev decision rm <id>");
    ctx.dev.decisions.remove(rest[0]);
    println(`${c.green("✓")} removed ${rest[0]}`);
    return 0;
  }
  const decisions = ctx.dev.decisions.list(project.id);
  if (ctx.json) printJson(decisions);
  else if (decisions.length === 0) println(c.dim('No decisions recorded. dev decision add "Use SQLite" --reason "local first"'));
  else println(table(decisions.map((d) => [d.id, c.bold(truncate(d.title, 40)), truncate(d.decision, 50), c.dim(d.tags.join(",")), c.dim(ago(d.createdAt))])));
  return 0;
}

export function approvalsCommand(ctx: CliContext, sub: string | undefined, rest: string[]): number {
  if (sub === "approve" || sub === "deny") {
    const id = rest[0];
    if (!id) throw new UsageError(`Usage: dev approvals ${sub} <id>`);
    const resolved = ctx.dev.approvals.resolve(id, sub === "approve" ? "approved" : "denied");
    if (ctx.json) printJson(resolved);
    else println(`${c.green("✓")} ${id} ${resolved.status}`);
    return 0;
  }
  const list = ctx.dev.approvals.list({ status: flagBool(ctx.flags, "all") ? undefined : "pending" });
  if (ctx.json) printJson(list);
  else if (list.length === 0) println(c.dim("No pending approvals."));
  else println(table(list.map((a) => [a.id, a.status === "pending" ? c.yellow(a.status) : a.status, a.action, truncate(a.reason, 50), c.dim(ago(a.requestedAt))])));
  return 0;
}

// ----- control plane / ui -----

export async function controlPlaneCommand(ctx: CliContext, sub: string | undefined): Promise<number> {
  const cp = await controlPlane(ctx.home);
  switch (sub) {
    case undefined:
    case "status":
      if (ctx.json) printJson(cp);
      else println(cp ? `${SYMBOL.ok} control plane ${cp.url} pid ${cp.pid} since ${ago(cp.startedAt)}` : `${SYMBOL.dot} control plane not running`);
      return 0;
    case "start": {
      if (cp) {
        println(`${SYMBOL.ok} already running at ${cp.url}`);
        return 0;
      }
      const info = await startControlPlane(ctx.home, { foreground: flagBool(ctx.flags, "foreground") });
      if (info) println(`${SYMBOL.ok} control plane started at ${info.url} (pid ${info.pid})`);
      return 0;
    }
    case "stop": {
      if (!cp) {
        println(`${SYMBOL.dot} not running`);
        return 0;
      }
      try {
        process.kill(cp.pid);
      } catch (error) {
        throw new UsageError(`Could not stop pid ${cp.pid}: ${(error as Error).message}`);
      }
      const file = controlPlaneInfoPath(ctx.home);
      if (existsSync(file)) {
        try {
          const current = JSON.parse(readFileSync(file, "utf8")) as { pid?: number };
          if (current.pid === cp.pid) writeFileSync(file, "");
        } catch {
          // ignore
        }
      }
      println(`${SYMBOL.ok} stopped pid ${cp.pid}`);
      return 0;
    }
    default:
      throw new UsageError("Usage: dev control-plane [status|start|stop]");
  }
}

export async function startControlPlane(home: string, options: { foreground?: boolean } = {}): Promise<{ url: string; pid: number } | null> {
  const script = join(REPO_ROOT, "apps", "control-plane", "src", "main.ts");
  if (options.foreground) {
    const child = spawn(process.execPath, [script, "--home", home], { stdio: "inherit" });
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));
    return null;
  }
  const child = spawn(process.execPath, [script, "--home", home], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const info = await controlPlane(home);
    if (info) return { url: info.url, pid: info.pid };
  }
  throw new UsageError("Control plane did not come up within 10s. Run `dev control-plane start --foreground` to see the error.");
}

export async function uiCommand(ctx: CliContext): Promise<number> {
  let cp = await controlPlane(ctx.home);
  if (!cp) {
    eprintln(c.dim("starting control plane…"));
    const started = await startControlPlane(ctx.home);
    cp = await controlPlane(ctx.home);
    if (!cp || !started) throw new UsageError("Control plane failed to start");
  }
  eprintln(`${SYMBOL.ok} control plane ${cp.url}`);
  const desktopDir = join(REPO_ROOT, "apps", "desktop");
  const builtCandidates = [
    join(process.env.CARGO_TARGET_DIR ?? join(desktopDir, "src-tauri", "target"), "release", "dev-desktop.exe"),
    join(desktopDir, "src-tauri", "target", "release", "dev-desktop.exe"),
  ];
  const built = flagBool(ctx.flags, "dev") ? undefined : builtCandidates.find((p) => existsSync(p));
  if (built) {
    eprintln(c.dim(`launching ${built}`));
    const child = spawn(built, [], { detached: true, stdio: "ignore", env: { ...process.env, DEV_HOME: ctx.home, DEV_CONTROL_PLANE_URL: cp.url } });
    child.unref();
    return 0;
  }
  if (!existsSync(join(desktopDir, "node_modules"))) throw new UsageError("Desktop dependencies are not installed. Run: npm install  (then dev ui again)");
  eprintln(c.dim("no release build found; starting the desktop app in development mode (first compile takes a few minutes)"));
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const child = spawn(npm, ["run", "tauri", "dev"], { cwd: desktopDir, stdio: "inherit", shell: process.platform === "win32", env: { ...process.env, DEV_HOME: ctx.home, DEV_CONTROL_PLANE_URL: cp.url } });
  const code = await new Promise<number>((resolve) => child.on("exit", (c) => resolve(c ?? 0)));
  return code;
}

export function versionCommand(): number {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { version: string };
  println(`dev ${pkg.version}`);
  return 0;
}

export function statusLine(status: string): string {
  return statusColor(status as never);
}

export { printEvent, ControlPlaneClient };

import { resolve } from "node:path";

import { git } from "@dev/core";

import { flagBool, flagList, flagString, UsageError } from "../args.ts";
import { currentProject, type CliContext } from "../context.ts";
import { ago, c, kv, printJson, println, statusColor, table, truncate } from "../output.ts";

export async function projectCommand(ctx: CliContext, sub: string | undefined, rest: string[]): Promise<number> {
  switch (sub) {
    case undefined:
    case "list":
    case "ls":
      return list(ctx);
    case "add":
      return add(ctx, rest[0]);
    case "new":
    case "create":
      return create(ctx, rest[0]);
    case "status":
    case "show":
    case "open":
      return status(ctx, rest[0]);
    case "set":
      return set(ctx, rest[0], rest[1]);
    case "remove":
    case "rm":
      return remove(ctx, rest[0]);
    default:
      throw new UsageError(`Unknown project command "${sub}". Try: dev project --help`);
  }
}

function list(ctx: CliContext): number {
  const all = flagBool(ctx.flags, "all");
  const lifecycleFilter = flagList(ctx.flags, "lifecycle").map((l) => l.toUpperCase());
  const tree = ctx.dev.projects.tree().filter(({ project }) => (lifecycleFilter.length ? lifecycleFilter.includes(project.lifecycle) : all || project.lifecycle === "ACTIVE" || project.lifecycle === "NEXT" || project.lifecycle === "MAINTENANCE"));
  if (ctx.json) {
    printJson(tree.map(({ project, depth }) => ({ ...project, depth, tasks: ctx.dev.tasks.counts(project.id) })));
    return 0;
  }
  if (tree.length === 0) {
    const total = ctx.dev.projects.list().length;
    if (total === 0) println(c.dim("No projects yet.") + "  Add one: " + c.bold("dev project add <path>"));
    else println(c.dim("No active projects.") + "  " + c.bold("dev project list --all") + c.dim(` shows the ${total} planned, incubator, parked and archived ones.`));
    return 0;
  }
  const lifecycleColor = (l: string) => (l === "ACTIVE" ? c.green(l) : l === "NEXT" ? c.blue(l) : l === "ARCHIVED" || l === "CLOSED" ? c.dim(l) : c.yellow(l));
  const rows = tree.map(({ project: p, depth }) => {
    const counts = ctx.dev.tasks.counts(p.id);
    const open = counts.BACKLOG + counts.READY + counts.WORKING + counts.BLOCKED + counts.REVIEW;
    return [p.id, `${"  ".repeat(depth)}${depth ? "└ " : ""}${c.bold(p.name)}`, lifecycleColor(p.lifecycle), p.kind === "project" ? "" : c.dim(p.kind), p.priority === "high" || p.priority === "critical" ? c.red(p.priority) : "", `${open} open`, counts.BLOCKED ? c.red(`${counts.BLOCKED} blocked`) : "", `${counts.DONE} done`, c.dim(p.path ?? "no repository yet")];
  });
  println(table(rows, { header: ["ID", "NAME", "LIFECYCLE", "KIND", "PRI", "OPEN", "", "DONE", "PATH"] }));
  if (!all && !lifecycleFilter.length) println(c.dim(`\n  ${ctx.dev.projects.list().length - tree.length} more in planned/incubator/parked/archived: dev project list --all`));
  return 0;
}

function add(ctx: CliContext, pathArg: string | undefined): number {
  const path = resolve(pathArg ?? ".");
  const project = ctx.dev.projects.add({ path, name: flagString(ctx.flags, "name"), goal: flagString(ctx.flags, "goal") ?? null });
  if (ctx.json) {
    printJson(project);
    return 0;
  }
  println(`${c.green("✓")} Added project ${c.bold(project.name)} ${c.dim(project.id)}`);
  println(c.dim(`  ${project.path}`));
  println(c.dim(`  Next: dev task add "<title>" --project ${project.id}   or   dev plan "<goal>" --project ${project.id}`));
  return 0;
}

function create(ctx: CliContext, name: string | undefined): number {
  if (!name) throw new UsageError("Usage: dev project new <name> [--dir <parent>] [--template empty|node|python] [--goal <text>] [--no-git]");
  const templateRaw = flagString(ctx.flags, "template") ?? "empty";
  if (templateRaw !== "empty" && templateRaw !== "node" && templateRaw !== "python") throw new UsageError("--template must be empty, node or python");
  const project = ctx.dev.projects.create({ name, dir: flagString(ctx.flags, "dir") ?? ctx.dev.config.projects.defaultDir, template: templateRaw, git: ctx.flags.git !== false, goal: flagString(ctx.flags, "goal") ?? null });
  if (ctx.json) {
    printJson(project);
    return 0;
  }
  println(`${c.green("✓")} Created project ${c.bold(project.name)} ${c.dim(project.id)} from the ${templateRaw} template`);
  println(c.dim(`  ${project.path}`));
  println(c.dim(`  Next: dev plan "<goal>" --project ${project.id}   or   dev chat "build me ..."`));
  return 0;
}

async function status(ctx: CliContext, ref: string | undefined): Promise<number> {
  const project = ref ? ctx.dev.projects.resolve(ref) : currentProject(ctx);
  if (!project) throw new UsageError(`No project matches "${ref}"`);
  const counts = ctx.dev.tasks.counts(project.id);
  const gitStatus = project.path ? await git.status(project.path) : { isRepo: false, root: null, branch: null, detached: false, dirty: false, changes: [], ahead: 0, behind: 0, lastCommit: null, remote: null };
  const running = ctx.dev.executions.list({ projectId: project.id, status: "running" });
  const blocked = ctx.dev.tasks.list({ projectId: project.id, status: "BLOCKED" });
  const review = ctx.dev.tasks.list({ projectId: project.id, status: "REVIEW" });
  const runnable = ctx.dev.tasks.runnable(project.id);
  if (ctx.json) {
    printJson({ ...project, tasks: counts, git: gitStatus, running, blocked, review, runnable });
    return 0;
  }
  println(c.bold(project.name) + "  " + c.dim(project.id));
  println(
    kv([
      ["path", project.path ?? c.dim("no repository yet")],
      ["lifecycle", `${project.lifecycle}${project.kind !== "project" ? ` · ${project.kind}` : ""}${project.priority !== "normal" ? ` · ${project.priority} priority` : ""}`],
      ["parent", project.parentId ? (ctx.dev.projects.get(project.parentId)?.name ?? project.parentId) : null],
      ["aliases", project.aliases.length ? project.aliases.join(", ") : null],
      ["goal", project.goal],
      ["milestone", project.milestone],
      ["git", gitStatus.isRepo ? `${gitStatus.branch ?? (gitStatus.detached ? "detached" : "?")}${gitStatus.dirty ? c.yellow(` (${gitStatus.changes.length} changed)`) : c.green(" clean")}${gitStatus.lastCommit ? c.dim(`  ${gitStatus.lastCommit.short} ${truncate(gitStatus.lastCommit.subject, 50)}`) : ""}` : c.dim("not a git repository")],
      ["tasks", `${c.dim("backlog")} ${counts.BACKLOG}  ${c.blue("ready")} ${counts.READY}  ${c.cyan("working")} ${counts.WORKING}  ${c.red("blocked")} ${counts.BLOCKED}  ${c.yellow("review")} ${counts.REVIEW}  ${c.green("done")} ${counts.DONE}`],
      ["updated", ago(project.updatedAt)],
    ]),
  );
  if (project.summary) println("\n" + c.dim(truncate(project.summary, 400)));
  const children = ctx.dev.projects.children(project.id);
  if (children.length) {
    println("\n" + c.dim("Subprojects"));
    println(table(children.map((ch) => [ch.id, ch.name, ch.lifecycle, c.dim(ch.kind), c.dim(ch.path ?? "no repository yet")]), { indent: 2 }));
  }
  if (project.meta.planned?.length) {
    println("\n" + c.dim("Planned"));
    for (const item of project.meta.planned.slice(0, 12)) println(`  - ${item}`);
  }
  if (running.length) {
    println("\n" + c.cyan("Running"));
    println(table(running.map((e) => [e.id, ctx.dev.tasks.get(e.taskId)?.title ?? e.taskId, e.workerId, ago(e.startedAt)]), { indent: 2 }));
  }
  if (blocked.length) {
    println("\n" + c.red("Blocked"));
    println(table(blocked.map((t) => [t.id, t.title, c.dim(truncate(t.failure?.reason ?? "", 60))]), { indent: 2 }));
  }
  if (review.length) {
    println("\n" + c.yellow("Awaiting review"));
    println(table(review.map((t) => [t.id, t.title]), { indent: 2 }));
  }
  if (runnable.length) {
    println("\n" + c.blue("Runnable now"));
    println(table(runnable.map((t) => [t.id, t.title, statusColor(t.status)]), { indent: 2 }));
    println(c.dim(`  dev task run ${runnable[0]?.id}   or   dev auto --project ${project.id}`));
  }
  return 0;
}

function set(ctx: CliContext, key: string | undefined, value: string | undefined): number {
  const project = currentProject(ctx);
  if (!project) throw new UsageError("No project");
  if (!key || value === undefined) throw new UsageError("Usage: dev project set <goal|summary|milestone|name|path|lifecycle|kind|priority|parent|aliases|defaultWorker|reviewRequired|verification|status> <value>");
  let updated;
  switch (key) {
    case "goal":
    case "summary":
    case "milestone":
    case "name":
    case "path":
      updated = ctx.dev.projects.update(project.id, { [key]: value });
      break;
    case "lifecycle": {
      const l = value.toUpperCase();
      if (!["ACTIVE", "NEXT", "PLANNED", "INCUBATOR", "PARKED", "MAINTENANCE", "ARCHIVED", "CLOSED"].includes(l)) throw new UsageError("lifecycle must be ACTIVE|NEXT|PLANNED|INCUBATOR|PARKED|MAINTENANCE|ARCHIVED|CLOSED");
      updated = ctx.dev.projects.update(project.id, { lifecycle: l as never });
      break;
    }
    case "kind":
      updated = ctx.dev.projects.update(project.id, { kind: value as never });
      break;
    case "priority":
      updated = ctx.dev.projects.update(project.id, { priority: value as never });
      break;
    case "parent": {
      const parent = value === "none" ? null : ctx.dev.projects.resolve(value);
      if (value !== "none" && !parent) throw new UsageError(`No project matches "${value}"`);
      updated = ctx.dev.projects.update(project.id, { parentId: parent ? parent.id : null });
      break;
    }
    case "aliases":
      updated = ctx.dev.projects.update(project.id, { aliases: value.split(",").map((a) => a.trim()).filter(Boolean) });
      break;
    case "status":
      if (value !== "active" && value !== "archived") throw new UsageError("status must be active or archived");
      updated = ctx.dev.projects.update(project.id, { status: value });
      break;
    case "defaultWorker":
      updated = ctx.dev.projects.update(project.id, { config: { defaultWorker: value === "null" ? undefined : value } });
      break;
    case "reviewRequired":
      updated = ctx.dev.projects.update(project.id, { config: { reviewRequired: value === "true" } });
      break;
    case "verification":
      updated = ctx.dev.projects.update(project.id, { config: { verification: value === "none" ? [] : [{ kind: "command", command: value }] } });
      break;
    default:
      throw new UsageError(`Unknown project field "${key}"`);
  }
  if (ctx.json) printJson(updated);
  else println(`${c.green("✓")} ${project.name}: ${key} updated`);
  return 0;
}

function remove(ctx: CliContext, ref: string | undefined): number {
  if (!ref) throw new UsageError("Usage: dev project remove <id|name>");
  const project = ctx.dev.projects.resolve(ref);
  if (!project) throw new UsageError(`No project matches "${ref}"`);
  if (ctx.flags.yes !== true && ctx.flags.y !== true) {
    throw new UsageError(`This removes ${project.name} and its ${ctx.dev.tasks.list({ projectId: project.id }).length} task(s) from DEV (files on disk are untouched). Re-run with --yes to confirm.`);
  }
  ctx.dev.projects.remove(project.id);
  if (ctx.json) printJson({ removed: project.id });
  else println(`${c.green("✓")} Removed ${project.name} from DEV. The directory ${project.path} was not touched.`);
  return 0;
}

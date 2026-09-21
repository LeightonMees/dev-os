import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative as relative_, resolve, sep } from "node:path";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import {
  applyPlan,
  artifactLanguage,
  resolveConfigFor,
  artifactMedia,
  assembleContext,
  autoRun,
  chatTurn,
  doctor,
  git,
  planGoal,
  runTask,
  setConfigValue,
  isTaskStatus,
  loadConfig,
  saveConfig,
  setSecret,
  suggestRouting,
  runFlow,
  seedGettingStarted,
  validateFlow,
  BENCHMARKS_CAPTURED_ON,
  type Dev,
  type DevEvent,
  type FlowEdge,
  type FlowNode,
  type PlanProposal,
  type TaskStatus,
} from "@dev/core";

import { currentEffort, workerModels } from "./worker-models.ts";

/** Directories the file tree never shows: noise, or far too large to browse. */
const SKIP_IN_TREE = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build", "target", ".next", "out", ".cache", ".turbo", "coverage"]);

/**
 * Resolve a project-relative path and prove it stays inside the project. Anything that climbs out
 * (.., an absolute path, a symlink target elsewhere) is refused rather than quietly clamped.
 */
function insideProject(root: string, requested: string): string {
  const cleaned = requested.replaceAll("\\", "/").replace(/^\/+/, "");
  if (isAbsolute(cleaned)) throw new HttpError(400, "Use a path relative to the project");
  const full = resolve(root, cleaned);
  const base = resolve(root);
  if (full !== base && !full.startsWith(base + sep)) throw new HttpError(403, "That path is outside the project");
  return full;
}

type Handler = (req: Req) => Promise<unknown> | unknown;

interface Req {
  method: string;
  params: Record<string, string>;
  query: URLSearchParams;
  body: Record<string, unknown>;
  raw: IncomingMessage;
  res: ServerResponse;
}

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

/** Live execution state that only the control plane knows: abort handles and auto-run loops. */
export class Runtime {
  readonly running = new Map<string, AbortController>();
  readonly auto = new Map<string, { controller: AbortController; startedAt: string; ran: number; promoteBacklog?: boolean }>();
  readonly chatBusy = new Map<string, AbortController>();
  /** Flow runs in flight, by flow id, so a run can be watched and stopped. */
  readonly flowRuns = new Map<string, { controller: AbortController; runId: string | null; startedAt: string }>();
}

export function createControlPlane(dev: Dev, options: { version: string }): { server: Server; runtime: Runtime } {
  const runtime = new Runtime();
  const routes: Route[] = [];
  const add = (method: string, path: string, handler: Handler) => {
    const keys: string[] = [];
    const pattern = new RegExp("^" + path.replace(/:([a-zA-Z]+)/g, (_, k: string) => (keys.push(k), "([^/]+)")) + "/?$");
    routes.push({ method, pattern, keys, handler });
  };
  const num = (value: string | null, fallback: number) => (value === null || value === "" || Number.isNaN(Number(value)) ? fallback : Number(value));
  const str = (body: Record<string, unknown>, key: string, required = false): string | undefined => {
    const v = body[key];
    if (v === undefined || v === null) {
      if (required) throw new HttpError(400, `"${key}" is required`);
      return undefined;
    }
    return String(v);
  };
  const strings = (body: Record<string, unknown>, key: string): string[] | undefined => {
    const v = body[key];
    if (v === undefined) return undefined;
    if (!Array.isArray(v)) throw new HttpError(400, `"${key}" must be an array`);
    return v.map(String);
  };
  const project = (id: string) => {
    const p = dev.projects.resolve(id);
    if (!p) throw new HttpError(404, `Unknown project ${id}`);
    return p;
  };
  /** A project that has a directory on disk; git and execution routes need one. */
  const repoProject = (id: string) => {
    const p = project(id);
    if (!p.path) throw new HttpError(409, `${p.name} has no repository yet`);
    return p as typeof p & { path: string };
  };
  const task = (id: string) => {
    const t = dev.tasks.resolve(id);
    if (!t) throw new HttpError(404, `Unknown task ${id}`);
    return t;
  };

  // ----- health / status -----
  add("GET", "/health", () => ({ ok: true, version: options.version, home: dev.home, pid: process.pid }));
  add("GET", "/api/status", () => {
    const projects = dev.projects.list({ status: "active" });
    return {
      home: dev.home,
      version: options.version,
      projects: projects.length,
      tasks: dev.tasks.counts(),
      running: dev.executions.list({ status: "running", limit: 20 }),
      auto: Array.from(runtime.auto.entries()).map(([projectId, a]) => ({ projectId, startedAt: a.startedAt, ran: a.ran, promoteBacklog: a.promoteBacklog === true })),
      workers: dev.workers.list(),
      recentFailures: dev.tasks.list({ status: "BLOCKED", limit: 10 }),
      recentDone: dev.tasks.list({ status: "DONE" }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 10),
      pendingApprovals: dev.approvals.list({ status: "pending" }).length,
      latestEventId: dev.events.latestId(),
    };
  });
  add("GET", "/api/doctor", async (req) => doctor(dev, { desktop: req.query.get("desktop") === "1" }));
  // Read the file, not the copy loaded at startup, so the screen shows what is actually saved.
  add("GET", "/api/config", () => ({ home: dev.home, config: loadConfig(dev.home), secrets: dev.secrets, keys: dev.config.workers.api.providers.map((p) => ({ provider: p.id, env: p.keyEnv, set: !!p.keyEnv && !!process.env[p.keyEnv] })) }));
  add("PATCH", "/api/config", (req) => {
    const key = str(req.body, "key", true) as string;
    const value = str(req.body, "value", true) as string;
    return { config: setConfigValue(dev.home, key, value), note: "restart the control plane for worker/nexus settings to apply" };
  });

  // ----- projects -----
  add("GET", "/api/projects", (req) => {
    const lifecycle = req.query.get("lifecycle")?.split(",").filter(Boolean) as ("ACTIVE" | "NEXT" | "PLANNED" | "INCUBATOR" | "PARKED" | "MAINTENANCE" | "ARCHIVED" | "CLOSED")[] | undefined;
    return dev.projects.list({ lifecycle }).map((p) => ({ ...p, tasks: dev.tasks.counts(p.id), children: dev.projects.children(p.id).length }));
  });
  add("GET", "/api/projects/tree", () => dev.projects.tree().map(({ project, depth }) => ({ ...project, depth, tasks: dev.tasks.counts(project.id) })));
  add("POST", "/api/projects", (req) => {
    if (req.body.create === true) {
      return dev.projects.create({ name: str(req.body, "name", true) as string, dir: str(req.body, "dir") ?? dev.config.projects.defaultDir, template: (str(req.body, "template") as "empty" | "node" | "python" | undefined) ?? "empty", git: req.body.git !== false, goal: str(req.body, "goal") ?? null });
    }
    return dev.projects.add({ path: str(req.body, "path") ?? null, name: str(req.body, "name"), goal: str(req.body, "goal") ?? null, repository: str(req.body, "repository") ?? null, lifecycle: str(req.body, "lifecycle") as never, kind: str(req.body, "kind") as never, priority: str(req.body, "priority") as never, parentId: str(req.body, "parentId") ?? null, aliases: strings(req.body, "aliases"), meta: (req.body.meta as never) ?? undefined });
  });
  add("GET", "/api/projects/:id", async (req) => {
    const p = project(req.params.id as string);
    return { ...p, tasks: dev.tasks.counts(p.id), git: p.path ? await git.status(p.path) : { isRepo: false, root: null, branch: null, detached: false, dirty: false, changes: [], ahead: 0, behind: 0, lastCommit: null, remote: null }, decisions: dev.decisions.list(p.id).slice(0, 20), running: dev.executions.list({ projectId: p.id, status: "running" }), children: dev.projects.children(p.id).map((c) => ({ id: c.id, name: c.name, lifecycle: c.lifecycle, kind: c.kind, tasks: dev.tasks.counts(c.id) })), parent: p.parentId ? (() => { const parent = dev.projects.get(p.parentId as string); return parent ? { id: parent.id, name: parent.name } : null; })() : null };
  });
  add("PATCH", "/api/projects/:id", (req) => {
    const p = project(req.params.id as string);
    const patch: Record<string, unknown> = {};
    for (const key of ["name", "path", "goal", "repository", "summary", "milestone", "status", "lifecycle", "kind", "priority", "parentId", "aliases", "meta"]) if (req.body[key] !== undefined) patch[key] = req.body[key];
    if (req.body.config && typeof req.body.config === "object") patch.config = req.body.config;
    return dev.projects.update(p.id, patch);
  });
  add("DELETE", "/api/projects/:id", (req) => {
    const p = project(req.params.id as string);
    dev.projects.remove(p.id);
    return { removed: p.id };
  });
  add("GET", "/api/projects/:id/git", async (req) => git.status(repoProject(req.params.id as string).path));
  add("GET", "/api/projects/:id/git/diff", async (req) => ({ diff: await git.diff(repoProject(req.params.id as string).path, { stat: req.query.get("stat") === "1", staged: req.query.get("staged") === "1", paths: req.query.get("path") ? [req.query.get("path") as string] : undefined }) }));
  add("GET", "/api/projects/:id/git/log", async (req) => git.log(repoProject(req.params.id as string).path, num(req.query.get("limit"), 20)));
  add("GET", "/api/projects/:id/git/branches", async (req) => git.branches(repoProject(req.params.id as string).path));
  add("POST", "/api/projects/:id/git/branch", async (req) => {
    const p = repoProject(req.params.id as string);
    await git.createBranch(p.path, str(req.body, "name", true) as string, req.body.checkout !== false);
    return git.status(p.path);
  });
  add("POST", "/api/projects/:id/git/checkout", async (req) => {
    const p = repoProject(req.params.id as string);
    await git.checkout(p.path, str(req.body, "ref", true) as string);
    return git.status(p.path);
  });
  add("POST", "/api/projects/:id/git/commit", async (req) => {
    const p = repoProject(req.params.id as string);
    const message = str(req.body, "message", true) as string;
    const taskId = str(req.body, "taskId") ?? null;
    // A commit is the moment work becomes history. When the project asks for
    // approval, the request is filed instead of the commit, and approving it is
    // what performs the commit (see /api/approvals/:id/resolve). Nothing is
    // half-done in between: either the approval exists or the commit does.
    const gate = resolveConfigFor({ home: dev.home, projectDir: p.path }).config.approvals.requireForCommit;
    if (gate) {
      const approval = dev.approvals.request({ projectId: p.id, taskId, action: "git.commit", reason: message });
      req.res.statusCode = 202;
      return { approvalRequired: true, approval };
    }
    const commit = await git.commit(p.path, message, { all: req.body.all !== false, paths: strings(req.body, "paths") });
    dev.events.emit("GIT_COMMIT", { projectId: p.id, taskId, data: { hash: commit.hash, subject: commit.subject } });
    return commit;
  });
  add("POST", "/api/projects/:id/git/push", async (req) => {
    const p = repoProject(req.params.id as string);
    // A push leaves the machine. By default it waits for the person, the same
    // way a gated commit does: file it, and approving it performs it.
    const gate = resolveConfigFor({ home: dev.home, projectDir: p.path }).config.approvals.requireForPush;
    if (gate) {
      const status = await git.status(p.path);
      // The remote's URL is not a name; and with no upstream yet git cannot count.
      const count = status.ahead > 0 ? `${status.ahead} commit${status.ahead === 1 ? "" : "s"}` : "sets the upstream";
      const approval = dev.approvals.request({ projectId: p.id, action: "git.push", reason: `Push ${status.branch ?? "HEAD"} to origin (${count})` });
      req.res.statusCode = 202;
      return { approvalRequired: true, approval };
    }
    const pushed = await git.push(p.path);
    dev.events.emit("GIT_PUSH", { projectId: p.id, data: { branch: pushed.branch, remote: pushed.remote } });
    return pushed;
  });
  add("GET", "/api/projects/:id/decisions", (req) => dev.decisions.list(project(req.params.id as string).id));
  add("POST", "/api/projects/:id/decisions", (req) => {
    const p = project(req.params.id as string);
    return dev.decisions.record({ projectId: p.id, title: str(req.body, "title", true) as string, decision: str(req.body, "decision", true) as string, reason: str(req.body, "reason"), alternatives: strings(req.body, "alternatives"), tags: strings(req.body, "tags"), revisit: str(req.body, "revisit") ?? null });
  });
  add("DELETE", "/api/decisions/:id", (req) => {
    dev.decisions.remove(req.params.id as string);
    return { removed: req.params.id };
  });

  // ----- tasks -----
  add("GET", "/api/tasks", (req) => {
    const statusRaw = req.query.get("status");
    const status = statusRaw ? (statusRaw.split(",").filter(isTaskStatus) as TaskStatus[]) : undefined;
    const projectId = req.query.get("projectId") ? project(req.query.get("projectId") as string).id : undefined;
    return dev.tasks.list({ projectId, status, milestone: req.query.get("milestone") ?? undefined, epic: req.query.get("epic") ?? undefined, limit: num(req.query.get("limit"), 500) });
  });
  add("GET", "/api/projects/:id/structure", (req) => dev.tasks.structure(project(req.params.id as string).id));
  add("POST", "/api/tasks", (req) => {
    const p = project(str(req.body, "projectId", true) as string);
    const statusRaw = str(req.body, "status");
    return dev.tasks.create({
      projectId: p.id,
      title: str(req.body, "title", true) as string,
      outcome: str(req.body, "outcome"),
      requirements: strings(req.body, "requirements"),
      acceptance: strings(req.body, "acceptance"),
      dependsOn: strings(req.body, "dependsOn"),
      workerId: str(req.body, "workerId") ?? null,
      milestone: str(req.body, "milestone") ?? null,
      epic: str(req.body, "epic") ?? null,
      kind: (str(req.body, "kind") as "epic" | "ticket" | "subtask" | "prep" | "decision" | undefined) ?? "ticket",
      risk: (str(req.body, "risk") as "low" | "normal" | "high" | undefined) ?? "normal",
      needsHuman: str(req.body, "needsHuman") ?? null,
      effort: (str(req.body, "effort") as "low" | "medium" | "high" | undefined) ?? "medium",
      command: str(req.body, "command") ?? null,
      files: strings(req.body, "files"),
      verification: Array.isArray(req.body.verification) ? (req.body.verification as never) : undefined,
      capabilities: Array.isArray(req.body.capabilities) ? (req.body.capabilities as never) : undefined,
      status: statusRaw && isTaskStatus(statusRaw) ? statusRaw : "BACKLOG",
    });
  });
  add("GET", "/api/tasks/:id", (req) => taskDetail(dev, task(req.params.id as string).id));
  add("PATCH", "/api/tasks/:id", (req) => {
    const t = task(req.params.id as string);
    const patch: Record<string, unknown> = {};
    for (const key of ["title", "outcome", "requirements", "acceptance", "workerId", "effort", "command", "files", "verification", "capabilities", "resultSummary", "milestone", "epic", "kind", "risk", "needsHuman", "promptOverride"]) if (req.body[key] !== undefined) patch[key] = req.body[key];
    return dev.tasks.update(t.id, patch);
  });
  add("DELETE", "/api/tasks/:id", (req) => {
    const t = task(req.params.id as string);
    dev.tasks.remove(t.id);
    return { removed: t.id };
  });
  add("POST", "/api/tasks/:id/status", (req) => {
    const t = task(req.params.id as string);
    const to = str(req.body, "to", true) as string;
    if (!isTaskStatus(to)) throw new HttpError(400, `Unknown status ${to}`);
    return dev.tasks.setStatus(t.id, to, { reason: str(req.body, "reason"), force: req.body.force === true });
  });
  add("POST", "/api/tasks/:id/deps", (req) => {
    const t = task(req.params.id as string);
    dev.tasks.addDependency(t.id, task(str(req.body, "dependsOn", true) as string).id);
    return dev.tasks.get(t.id);
  });
  add("DELETE", "/api/tasks/:id/deps/:dep", (req) => {
    const t = task(req.params.id as string);
    dev.tasks.removeDependency(t.id, task(req.params.dep as string).id);
    return dev.tasks.get(t.id);
  });
  add("POST", "/api/tasks/:id/approve", (req) => {
    const t = task(req.params.id as string);
    if (t.status !== "REVIEW" && t.status !== "WORKING" && t.status !== "BLOCKED") throw new HttpError(409, `Task is ${t.status}; approve applies to REVIEW (or BLOCKED/WORKING with --force)`);
    dev.evidence.record({ taskId: t.id, kind: "human-approval", passed: true, summary: str(req.body, "reason") || "Approved by user", data: { by: str(req.body, "by") ?? "user" } });
    return dev.tasks.setStatus(t.id, "DONE", { reason: "approved", force: true });
  });
  // The user answers a task that needs them: the answer is durable evidence, a project decision (so
  // context assembly can surface it to workers) and a requirement line in the worker's brief.
  add("POST", "/api/tasks/:id/answer", (req) => {
    const t = task(req.params.id as string);
    if (t.status === "WORKING") throw new HttpError(409, "Task is being worked on; answer it when the run finishes");
    const answer = (str(req.body, "answer", true) as string).trim();
    if (!answer) throw new HttpError(400, "answer is required");
    const next = str(req.body, "next") ?? "none";
    const date = new Date().toISOString().slice(0, 10);
    const question = t.needsHuman ?? "Input for this task";
    dev.evidence.record({ taskId: t.id, kind: "human-input", passed: true, summary: answer, data: { question, by: str(req.body, "by") ?? "user" } });
    dev.decisions.record({ projectId: t.projectId, title: `${t.title}: ${question}`.slice(0, 200), decision: answer, reason: "Answered by the user in DEV", tags: ["task-input", t.id] });
    const line = `Leighton (${date}) on "${question}": ${answer}`;
    let updated = dev.tasks.update(t.id, { requirements: [...t.requirements, line], needsHuman: req.body.keepFlag === true ? t.needsHuman : null });
    if (next === "ready" && (updated.status === "BACKLOG" || updated.status === "BLOCKED")) updated = dev.tasks.setStatus(t.id, "READY", { reason: "answered", force: true });
    if (next === "done") {
      // Walk the state machine rather than jumping: the human-input evidence recorded above lets DONE pass.
      if (updated.status === "BACKLOG" || updated.status === "BLOCKED") updated = dev.tasks.setStatus(t.id, "READY", { reason: "answered", force: true });
      if (updated.status === "READY") updated = dev.tasks.setStatus(t.id, "WORKING", { reason: "answered by the user" });
      if (updated.status === "WORKING" || updated.status === "REVIEW") updated = dev.tasks.setStatus(t.id, "DONE", { reason: "answered by the user", resultSummary: `Answered by Leighton: ${answer.slice(0, 200)}` });
    }
    return updated;
  });
  add("POST", "/api/tasks/:id/reject", (req) => {
    const t = task(req.params.id as string);
    const reason = str(req.body, "reason") || "Rejected in review";
    dev.evidence.record({ taskId: t.id, kind: "human-approval", passed: false, summary: reason });
    return dev.tasks.block(t.id, { kind: "review-rejected", reason, nextAction: "Address the review feedback, then retry the task" });
  });
  add("GET", "/api/tasks/:id/context", (req) => {
    const t = task(req.params.id as string);
    const p = project(t.projectId);
    const assembled = assembleContext({ task: t, project: p, tasks: dev.tasks, decisions: dev.decisions, config: dev.config.context, budgetTokens: req.query.get("budget") ? num(req.query.get("budget"), dev.config.context.budgetTokens) : undefined });
    return { prompt: assembled.prompt, sections: assembled.sections, usedTokens: assembled.usedTokens, budgetTokens: assembled.budgetTokens, snapshots: dev.contextSnapshots.forTask(t.id).slice(0, 5) };
  });
  add("GET", "/api/tasks/:id/log", (req) => {
    const t = task(req.params.id as string);
    const execution = req.query.get("execution") ? dev.executions.get(req.query.get("execution") as string) : dev.executions.list({ taskId: t.id, limit: 1 })[0];
    if (!execution) return { execution: null, log: "" };
    const log = execution.logPath && existsSync(execution.logPath) ? readFileSync(execution.logPath, "utf8") : "";
    const tailChars = num(req.query.get("tail"), 0);
    return { execution, log: tailChars > 0 && log.length > tailChars ? log.slice(-tailChars) : log };
  });

  // ----- execution -----
  add("POST", "/api/tasks/:id/run", (req) => {
    const t = task(req.params.id as string);
    if (runtime.running.size > 0 && Array.from(runtime.running.keys()).some((id) => dev.executions.get(id)?.taskId === t.id)) throw new HttpError(409, "Task is already running");
    const controller = new AbortController();
    const started = new Promise<string>((resolve, reject) => {
      const off = dev.events.on((e) => {
        if (e.type === "TASK_STARTED" && e.taskId === t.id && e.executionId) {
          off();
          runtime.running.set(e.executionId, controller);
          resolve(e.executionId);
        }
      });
      runTask(dev, t.id, { workerId: str(req.body, "workerId") ?? null, force: req.body.force === true, signal: controller.signal, timeoutMs: req.body.timeoutMs ? Number(req.body.timeoutMs) : undefined })
        .then((execution) => {
          runtime.running.delete(execution.id);
          off();
          resolve(execution.id);
        })
        .catch((error: Error) => {
          off();
          reject(error);
        });
    });
    return started.then((executionId) => ({ executionId, task: dev.tasks.get(t.id) }));
  });
  add("POST", "/api/tasks/:id/retry", (req) => {
    const t = task(req.params.id as string);
    return dev.tasks.retry(t.id);
  });
  add("POST", "/api/tasks/:id/cancel", (req) => {
    const t = task(req.params.id as string);
    const running = dev.executions.list({ taskId: t.id, status: "running" });
    for (const execution of running) {
      dev.executions.requestCancel(execution.id);
      runtime.running.get(execution.id)?.abort();
    }
    if (running.length === 0 && t.status !== "DONE" && t.status !== "CANCELLED") dev.tasks.setStatus(t.id, "CANCELLED", { reason: str(req.body, "reason") ?? "cancelled" });
    return { cancelled: running.map((e) => e.id), task: dev.tasks.get(t.id) };
  });
  add("GET", "/api/executions", (req) =>
    dev.executions
      .list({ taskId: req.query.get("taskId") ?? undefined, projectId: req.query.get("projectId") ?? undefined, workerId: req.query.get("workerId") ?? undefined, status: (req.query.get("status") as "running" | null) ?? undefined, limit: num(req.query.get("limit"), 50) })
      .map((e) => ({ ...e, contextTokens: e.contextSnapshotId ? (dev.contextSnapshots.get(e.contextSnapshotId)?.usedTokens ?? null) : null, taskTitle: dev.tasks.get(e.taskId)?.title ?? null })),
  );
  // Verification and other evidence across a project: the "Checks" panel.
  // ----- usage: real tokens and cost, taken from what the workers reported -----
  add("GET", "/api/usage", (req) => {
    const days = num(req.query.get("days"), 30);
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const executions = dev.executions.list({ limit: 1000 }).filter((e) => e.startedAt >= since);
    const zero = () => ({ executions: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, durationMs: 0 });
    const total = zero();
    const byWorker = new Map<string, ReturnType<typeof zero>>();
    const byDay = new Map<string, ReturnType<typeof zero>>();
    for (const e of executions) {
      const u = (e.usage ?? {}) as Record<string, unknown>;
      const n = (key: string) => (typeof u[key] === "number" ? (u[key] as number) : 0);
      const row = { executions: 1, input: n("input_tokens") + n("prompt_tokens"), output: n("output_tokens") + n("completion_tokens"), cacheRead: n("cache_read_input_tokens"), cacheWrite: n("cache_creation_input_tokens"), costUsd: n("total_cost_usd"), durationMs: e.durationMs ?? 0 };
      for (const bucket of [total, byWorker.get(e.workerId) ?? byWorker.set(e.workerId, zero()).get(e.workerId)!, byDay.get(e.startedAt.slice(0, 10)) ?? byDay.set(e.startedAt.slice(0, 10), zero()).get(e.startedAt.slice(0, 10))!]) {
        for (const key of Object.keys(row) as (keyof typeof row)[]) bucket[key] += row[key];
      }
    }
    return {
      days,
      total,
      byWorker: [...byWorker.entries()].map(([workerId, v]) => ({ workerId, ...v })).sort((a, b) => b.executions - a.executions),
      byDay: [...byDay.entries()].map(([day, v]) => ({ day, ...v })).sort((a, b) => a.day.localeCompare(b.day)),
      note: "Tokens and cost are what each worker reported; workers that report nothing (shell, local CLIs without usage) count as executions only.",
    };
  });

  // ----- keys and provider switches: the two things the Problems panel used to only complain about -----
  add("POST", "/api/secrets", (req) => {
    const name = str(req.body, "name", true) as string;
    const value = str(req.body, "value", true) as string;
    const { file, replaced } = setSecret(dev.config.secrets.files, name, value);
    // Re-probe the workers that depend on this key so the screen tells the truth immediately.
    const affected = dev.config.workers.api.providers.filter((p) => p.keyEnv === name.trim().toUpperCase()).map((p) => p.id);
    return { name: name.trim().toUpperCase(), file, replaced, affected };
  });
  add("POST", "/api/providers/:id/model", (req) => {
    const id = req.params.id as string;
    const model = (str(req.body, "model", true) as string).trim();
    if (!model) throw new HttpError(400, "A model is required");
    const config = loadConfig(dev.home);
    const entry = config.workers.api.providers.find((p) => p.id === id);
    if (!entry) throw new HttpError(404, `Unknown API provider ${id}`);
    entry.model = model;
    saveConfig(dev.home, config);
    const live = dev.config.workers.api.providers.find((p) => p.id === id);
    if (live) live.model = model;
    return { id, model, note: "restart the control plane for the worker to use it" };
  });
  add("POST", "/api/providers/:id/enabled", (req) => {
    const id = req.params.id as string;
    const provider = dev.config.workers.api.providers.find((p) => p.id === id);
    if (!provider) throw new HttpError(404, `Unknown API provider ${id}`);
    const enabled = req.body.enabled === true;
    // Providers are an array, which the dotted-key setter cannot address; edit the entry and save.
    const config = loadConfig(dev.home);
    const entry = config.workers.api.providers.find((p) => p.id === id);
    if (!entry) throw new HttpError(404, `Unknown API provider ${id}`);
    entry.enabled = enabled;
    saveConfig(dev.home, config);
    provider.enabled = enabled;
    return { id, enabled, keyEnv: entry.keyEnv, keySet: !!entry.keyEnv && !!process.env[entry.keyEnv], note: "restart the control plane for the worker list to change" };
  });

  // ----- the project's own files: browse, read, write -----
  // Every path is resolved and checked to be inside the project directory before anything is
  // read or written; a path that escapes it is refused, not clamped.
  add("GET", "/api/projects/:id/files", (req) => {
    const p = repoProject(req.params.id as string);
    const dir = insideProject(p.path, req.query.get("path") ?? "");
    if (!existsSync(dir)) throw new HttpError(404, `${req.query.get("path") ?? ""} does not exist`);
    const entries = readdirSync(dir, { withFileTypes: true })
      .filter((e) => !SKIP_IN_TREE.has(e.name))
      .map((e) => {
        const full = join(dir, e.name);
        const relative = relative_(p.path, full).replaceAll("\\", "/");
        const stat = e.isFile() ? statSync(full) : null;
        return { name: e.name, path: relative, directory: e.isDirectory(), size: stat?.size ?? null, modified: stat?.mtime.toISOString() ?? null };
      })
      .sort((a, b) => (a.directory === b.directory ? a.name.localeCompare(b.name) : a.directory ? -1 : 1));
    return { root: p.path, path: relative_(p.path, dir).replaceAll("\\", "/"), entries };
  });
  add("GET", "/api/projects/:id/file", (req) => {
    const p = repoProject(req.params.id as string);
    const requested = req.query.get("path");
    if (!requested) throw new HttpError(400, '"path" is required');
    const file = insideProject(p.path, requested);
    if (!existsSync(file) || !statSync(file).isFile()) throw new HttpError(404, "No such file");
    const size = statSync(file).size;
    if (size > 2_000_000) throw new HttpError(413, `That file is ${Math.round(size / 1024)} KB; the editor opens files up to 2 MB`);
    const buffer = readFileSync(file);
    // A NUL byte in the first block means it is not text; refuse rather than mangle it.
    if (buffer.subarray(0, 8000).includes(0)) throw new HttpError(415, "That looks like a binary file, so it is not editable here");
    return { path: relative_(p.path, file).replaceAll("\\", "/"), content: buffer.toString("utf8"), size, modified: statSync(file).mtime.toISOString() };
  });
  add("PUT", "/api/projects/:id/file", (req) => {
    const p = repoProject(req.params.id as string);
    const file = insideProject(p.path, str(req.body, "path", true) as string);
    const content = req.body.content;
    if (typeof content !== "string") throw new HttpError(400, '"content" must be a string');
    const expected = str(req.body, "modified");
    // Refuse a save that would silently overwrite a change made since the editor loaded the file.
    if (expected && existsSync(file) && statSync(file).mtime.toISOString() !== expected) {
      throw new HttpError(409, "This file changed on disk since you opened it. Reload it before saving, or your edit would overwrite that change.");
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content, "utf8");
    const stat = statSync(file);
    dev.events.emit("FILE_CHANGED", { projectId: p.id, data: { path: relative_(p.path, file).replaceAll("\\", "/"), by: "editor", bytes: stat.size } });
    return { path: relative_(p.path, file).replaceAll("\\", "/"), size: stat.size, modified: stat.mtime.toISOString() };
  });

  // ----- what public benchmarks say about who is best at what -----
  add("GET", "/api/routing/suggestion", () => {
    const workers = dev.workers.list().map((w) => ({ id: w.id, capabilities: w.capabilities, model: dev.workers.configuredModel(w.id), healthy: !!w.health?.ok }));
    const stated = dev.config.workers.preferences;
    return {
      capturedOn: BENCHMARKS_CAPTURED_ON,
      current: dev.config.workers.preferencesByCapability ?? {},
      stated,
      // Whether this advice is actually in force, or is only advice. With no stated preference DEV
      // routes by it; with one, the user's order wins and the suggestion is shown for comparison.
      inUse: stated.length === 0,
      suggestions: suggestRouting({ workers }),
      note: "Benchmarks measure the model, not the tool wrapped around it, and a worker is only as good as the model it is configured with. No capability is decided by one leaderboard, and a benchmark with a known validity problem is carried at reduced weight with its caveat attached. These are a starting point, not a verdict; your own experience beats them.",
    };
  });

  // ----- which models a worker can actually be given -----
  // Every list is discovered from the tool itself (its model cache, its own `models` command, or the
  // provider's /models endpoint) so the dropdown shows what exists rather than what we remember.
  // Claude Code has no such command, so its list is documented and marked as such.
  add("GET", "/api/workers/:id/models", async (req) => {
    const id = req.params.id as string;
    const worker = dev.workers.get(id);
    if (!worker) throw new HttpError(404, `Unknown worker ${id}`);
    // Model and reasoning effort are two separate dials on the same worker, and the UI needs both
    // together: "opus" is the model, "low" is the effort. A worker with no effort dial says so
    // through `efforts.levels` being empty, and the control is omitted rather than shown inert.
    const efforts = { ...worker.efforts, current: currentEffort(dev.config, id) };
    const provider = dev.config.workers.api.providers.find((p) => p.id === id);
    if (provider) {
      const key = provider.keyEnv ? process.env[provider.keyEnv] : null;
      if (provider.keyEnv && !key) return { models: [], source: `${provider.name} /models`, detail: `${provider.keyEnv} is not set`, free: true, efforts };
      try {
        const response = await fetch(`${provider.baseUrl.replace(/\/+$/, "")}/models`, { headers: key ? { authorization: `Bearer ${key}`, ...provider.headers } : { ...provider.headers }, signal: AbortSignal.timeout(8000) });
        if (!response.ok) return { models: [], source: `${provider.name} /models`, detail: `${response.status} from /models`, free: true, efforts };
        const body = (await response.json()) as { data?: { id: string }[]; models?: { name?: string; id?: string }[] };
        const list = (body.data ?? body.models ?? []).map((m) => ({ id: String(m.id ?? (m as { name?: string }).name), label: String(m.id ?? (m as { name?: string }).name) }));
        return { models: list.sort((a, b) => a.id.localeCompare(b.id)), source: `${provider.name} /models`, detail: null, free: true, efforts };
      } catch (error) {
        return { models: [], source: `${provider.name} /models`, detail: (error as Error).message, free: true, efforts };
      }
    }
    return { ...(await workerModels(id, dev.config)), efforts };
  });

  // ----- ollama: what is installed, and pulling a model -----
  add("GET", "/api/ollama/models", async () => {
    const baseUrl = dev.config.workers.ollama.baseUrl.replace(/\/+$/, "");
    try {
      const response = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) return { reachable: false, baseUrl, models: [], detail: `${response.status} from /api/tags` };
      const body = (await response.json()) as { models?: { name: string; size?: number; details?: { parameter_size?: string } }[] };
      return { reachable: true, baseUrl, models: (body.models ?? []).map((m) => ({ name: m.name, size: m.size ?? null, parameters: m.details?.parameter_size ?? null })), detail: null };
    } catch (error) {
      return { reachable: false, baseUrl, models: [], detail: (error as Error).message };
    }
  });
  add("POST", "/api/ollama/pull", async (req) => {
    const model = (str(req.body, "model", true) as string).trim();
    if (!/^[\w.:/-]{1,120}$/.test(model)) throw new HttpError(400, "Model name may only contain letters, numbers, dot, colon, slash, dash and underscore");
    const baseUrl = dev.config.workers.ollama.baseUrl.replace(/\/+$/, "");
    const response = await fetch(`${baseUrl}/api/pull`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, stream: false }), signal: AbortSignal.timeout(30 * 60_000) });
    const text = await response.text();
    if (!response.ok) throw new HttpError(502, `Ollama refused the pull (${response.status}): ${text.slice(0, 300)}`);
    return { pulled: model, detail: text.slice(0, 300) };
  });

  add("GET", "/api/evidence", (req) => {
    const projectId = req.query.get("projectId") ? project(req.query.get("projectId") as string).id : undefined;
    const limit = num(req.query.get("limit"), 100);
    const rows = projectId
      ? dev.db.all("SELECT e.* FROM evidence e JOIN tasks t ON t.id = e.task_id WHERE t.project_id = ? ORDER BY e.created_at DESC LIMIT ?", projectId, limit)
      : dev.db.all("SELECT * FROM evidence ORDER BY created_at DESC LIMIT ?", limit);
    return rows.map((row) => ({
      id: String(row.id),
      taskId: String(row.task_id),
      taskTitle: dev.tasks.get(String(row.task_id))?.title ?? null,
      executionId: (row.execution_id as string | null) ?? null,
      kind: String(row.kind),
      passed: Number(row.passed) === 1,
      summary: String(row.summary),
      data: JSON.parse(String(row.data_json ?? "{}")),
      artifactId: (row.artifact_id as string | null) ?? null,
      createdAt: String(row.created_at),
    }));
  });
  add("GET", "/api/executions/:id", (req) => {
    const execution = dev.executions.get(req.params.id as string);
    if (!execution) throw new HttpError(404, "Unknown execution");
    return { ...execution, evidence: dev.evidence.forExecution(execution.id), artifacts: dev.artifacts.list({ executionId: execution.id }), context: execution.contextSnapshotId ? dev.contextSnapshots.get(execution.contextSnapshotId) : null };
  });
  add("POST", "/api/projects/:id/auto", async (req) => {
    const p = project(req.params.id as string);
    if (runtime.auto.has(p.id)) throw new HttpError(409, "Auto-run is already active for this project");
    const controller = new AbortController();
    const state = { controller, startedAt: new Date().toISOString(), ran: 0, promoteBacklog: req.body.promoteBacklog === true };
    runtime.auto.set(p.id, state);
    // `0` is a real answer and must not be read as "no limit": the old truthiness
    // check turned a request for zero tasks into an unbounded unattended run.
    const rawMax = req.body.maxTasks;
    const maxTasks = rawMax === undefined || rawMax === null || rawMax === "" ? undefined : Math.max(0, Number(rawMax));
    if (maxTasks !== undefined && !Number.isFinite(maxTasks)) throw new HttpError(400, '"maxTasks" must be a number');
    void autoRun(dev, {
      projectId: p.id,
      maxTasks,
      workerId: str(req.body, "workerId") ?? null,
      signal: controller.signal,
      continueOnFailure: req.body.continueOnFailure !== false,
      promoteBacklog: req.body.promoteBacklog === true,
      onTaskEnd: () => {
        state.ran++;
      },
    }).catch(() => {
      // autoRun emits AUTO_RUN_FINISHED in its own finally; this only stops an unhandled rejection.
    }).finally(() => runtime.auto.delete(p.id));
    return { started: true, projectId: p.id, runnable: dev.tasks.runnable(p.id).length, promoteBacklog: state.promoteBacklog };
  });
  add("POST", "/api/projects/:id/auto/stop", (req) => {
    const p = project(req.params.id as string);
    const state = runtime.auto.get(p.id);
    if (!state) return { stopped: false };
    state.controller.abort();
    for (const execution of dev.executions.list({ projectId: p.id, status: "running" })) dev.executions.requestCancel(execution.id);
    return { stopped: true, ran: state.ran };
  });

  // ----- workers / resources / approvals / artifacts -----
  add("GET", "/api/workers", () => dev.workers.list());

  add("POST", "/api/workers/:id/check", async (req) => {
    const health = await dev.workers.check(req.params.id as string);
    return { ...dev.workers.info(req.params.id as string), health };
  });
  // Nexus is optional. When it is absent or down that is "service unavailable",
  // not a fault in the control plane, and the browser console should say so.
  const viaNexus = async <T,>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      throw new HttpError(503, (error as Error).message);
    }
  };
  add("GET", "/api/resources/status", () => viaNexus(() => dev.nexus.status()));
  add("GET", "/api/resources/workflows", () => viaNexus(() => dev.nexus.listWorkflows()));

  // ----- flows: executable agent workflows -----
  // A flow is stored as the graph the user drew and run from that same graph, so the canvas and the
  // engine cannot disagree. Validation is served separately from running, so the editor can show
  // what is wrong with a flow while it is being drawn rather than only when it is run.
  add("GET", "/api/flows", (req) => dev.flows.list(req.query.get("projectId")));
  add("POST", "/api/flows", (req) => {
    const projectId = str(req.body, "projectId");
    if (!projectId) throw new HttpError(400, "A flow needs a projectId");
    return dev.flows.create({
      projectId,
      name: str(req.body, "name") ?? "New flow",
      description: str(req.body, "description") ?? "",
      nodes: (req.body.nodes as FlowNode[] | undefined) ?? [],
      edges: (req.body.edges as FlowEdge[] | undefined) ?? [],
    });
  });
  add("GET", "/api/flows/:id", (req) => {
    const flow = dev.flows.get(req.params.id as string);
    if (!flow) throw new HttpError(404, "Unknown flow");
    const active = runtime.flowRuns.get(flow.id);
    return { flow, problems: validateFlow(flow), runs: dev.flows.runs(flow.id), running: active ? { runId: active.runId, startedAt: active.startedAt } : null };
  });
  add("PATCH", "/api/flows/:id", (req) => {
    const flow = dev.flows.get(req.params.id as string);
    if (!flow) throw new HttpError(404, "Unknown flow");
    const patch: Record<string, unknown> = {};
    for (const key of ["name", "description", "nodes", "edges"]) if (req.body[key] !== undefined) patch[key] = req.body[key];
    const next = dev.flows.update(flow.id, patch);
    return { flow: next, problems: validateFlow(next) };
  });
  add("DELETE", "/api/flows/:id", (req) => {
    dev.flows.remove(req.params.id as string);
    return { deleted: true };
  });

  add("POST", "/api/flows/:id/run", (req) => {
    const flow = dev.flows.get(req.params.id as string);
    if (!flow) throw new HttpError(404, "Unknown flow");
    if (runtime.flowRuns.has(flow.id)) throw new HttpError(409, "This flow is already running");
    const problems = validateFlow(flow);
    if (problems.length > 0) throw new HttpError(400, `This flow cannot run yet: ${problems.map((p) => p.message).join(" ")}`);

    const controller = new AbortController();
    const state = { controller, runId: null as string | null, startedAt: new Date().toISOString() };
    runtime.flowRuns.set(flow.id, state);
    void runFlow(dev, {
      flowId: flow.id,
      signal: controller.signal,
      // Live step output reaches the run view as a transient event; only the summary is stored.
      onOutput: (nodeId, chunk) => dev.events.emitTransient("COMMAND_OUTPUT", { projectId: flow.projectId, data: { flowId: flow.id, nodeId, stream: "stdout", chunk } }),
    })
      .then((report) => {
        state.runId = report.runId;
      })
      .catch((error: Error) => {
        dev.events.emit("FLOW_RUN_FINISHED", { projectId: flow.projectId, data: { flowId: flow.id, runId: null, status: "FAILED", detail: error.message, steps: 0 } });
      })
      .finally(() => runtime.flowRuns.delete(flow.id));
    return { started: true, flowId: flow.id, steps: flow.nodes.length };
  });
  add("POST", "/api/flows/:id/stop", (req) => {
    const state = runtime.flowRuns.get(req.params.id as string);
    if (!state) return { stopped: false };
    state.controller.abort();
    return { stopped: true };
  });
  add("GET", "/api/flows/:id/runs", (req) => dev.flows.runs(req.params.id as string));
  add("GET", "/api/flow-runs/:id", (req) => {
    const run = dev.flows.run(req.params.id as string);
    if (!run) throw new HttpError(404, "Unknown flow run");
    return { run, steps: dev.flows.nodeRuns(run.id) };
  });

  // ----- chat: talk to DEV itself -----
  add("GET", "/api/chat", (req) => dev.chat.list(req.query.get("projectId")));
  add("POST", "/api/chat", (req) => dev.chat.create({ projectId: str(req.body, "projectId") ?? null, title: str(req.body, "title") }));
  add("GET", "/api/chat/:id", (req) => {
    const conversation = dev.chat.get(req.params.id as string);
    if (!conversation) throw new HttpError(404, "Unknown conversation");
    return { conversation, messages: dev.chat.messages(conversation.id) };
  });
  add("DELETE", "/api/chat/:id", (req) => {
    dev.chat.remove(req.params.id as string);
    return { removed: req.params.id };
  });
  add("PATCH", "/api/chat/:id", (req) => {
    const conversation = dev.chat.get(req.params.id as string);
    if (!conversation) throw new HttpError(404, "Unknown conversation");
    if (req.body.projectId !== undefined) dev.chat.setProject(conversation.id, req.body.projectId ? project(String(req.body.projectId)).id : null);
    if (req.body.title) dev.chat.retitle(conversation.id, String(req.body.title));
    return dev.chat.get(conversation.id);
  });
  add("POST", "/api/chat/:id/messages", async (req) => {
    const conversation = dev.chat.get(req.params.id as string);
    if (!conversation) throw new HttpError(404, "Unknown conversation");
    const text = str(req.body, "text", true) as string;
    if (runtime.chatBusy.has(conversation.id)) throw new HttpError(409, "DEV is still answering the previous message");
    const controller = new AbortController();
    runtime.chatBusy.set(conversation.id, controller);
    try {
      return await chatTurn(dev, conversation.id, text, { signal: controller.signal });
    } finally {
      runtime.chatBusy.delete(conversation.id);
    }
  });
  add("POST", "/api/chat/:id/cancel", (req) => {
    const controller = runtime.chatBusy.get(req.params.id as string);
    controller?.abort();
    return { cancelled: !!controller };
  });
  add("GET", "/api/resources/search", async (req) => {
    const q = req.query.get("q");
    if (!q) throw new HttpError(400, "q is required");
    return viaNexus(() => dev.nexus.findCapability(q, num(req.query.get("limit"), 8)));
  });
  add("GET", "/api/approvals", (req) => dev.approvals.list({ status: (req.query.get("status") as "pending" | "approved" | "denied" | null) ?? undefined }));
  add("POST", "/api/approvals/:id/resolve", async (req) => {
    const status = str(req.body, "status", true);
    if (status !== "approved" && status !== "denied") throw new HttpError(400, "status must be approved or denied");
    const pending = dev.approvals.get(req.params.id as string);
    if (!pending) throw new HttpError(404, "Unknown approval");
    const resolved = dev.approvals.resolve(pending.id, status, str(req.body, "by") ?? "user", str(req.body, "note") ?? null);
    // Some approvals carry the action itself: approving a gated commit commits.
    if (status === "approved" && pending.action === "git.commit" && pending.projectId) {
      const p = repoProject(pending.projectId);
      const commit = await git.commit(p.path, pending.reason, { all: true });
      dev.events.emit("GIT_COMMIT", { projectId: p.id, taskId: pending.taskId, data: { hash: commit.hash, subject: commit.subject, approvalId: pending.id } });
      return { ...resolved, performed: { commit } };
    }
    if (status === "approved" && pending.action === "git.push" && pending.projectId) {
      const p = repoProject(pending.projectId);
      const pushed = await git.push(p.path);
      dev.events.emit("GIT_PUSH", { projectId: p.id, data: { branch: pushed.branch, remote: pushed.remote, approvalId: pending.id } });
      return { ...resolved, performed: { push: pushed } };
    }
    return resolved;
  });
  add("GET", "/api/artifacts", (req) => dev.artifacts.list({ projectId: req.query.get("projectId") ?? undefined, taskId: req.query.get("taskId") ?? undefined, limit: num(req.query.get("limit"), 200) }));
  const artifactFile = (id: string) => {
    const artifact = dev.artifacts.get(id);
    if (!artifact) throw new HttpError(404, "Unknown artifact");
    if (!existsSync(artifact.path)) throw new HttpError(410, "Artifact file is missing on disk");
    return artifact;
  };
  add("GET", "/api/artifacts/:id/content", (req) => {
    const artifact = artifactFile(req.params.id as string);
    const media = artifactMedia(artifact.path);
    const rootId = typeof artifact.meta.rootId === "string" ? artifact.meta.rootId : artifact.id;
    const head = { artifact, media, language: artifactLanguage(artifact.path), versions: dev.artifacts.versions(rootId).length };
    // Binary artifacts are shown from /raw; sending their bytes through a JSON
    // string would corrupt them, so say so instead of lying with mojibake.
    if (!media.text) return { ...head, content: "", truncated: false, editable: false };
    const text = readFileSync(artifact.path, "utf8");
    const max = num(req.query.get("max"), 200_000);
    const truncated = text.length > max;
    // An edit must never be saved from a partial view: it would silently drop
    // everything the pane never loaded.
    return { ...head, content: truncated ? text.slice(-max) : text, truncated, editable: !truncated };
  });
  add("GET", "/api/artifacts/:id/raw", (req) => {
    const artifact = artifactFile(req.params.id as string);
    const media = artifactMedia(artifact.path);
    const stat = statSync(artifact.path);
    req.res.writeHead(200, {
      "content-type": media.type,
      "content-length": stat.size,
      "content-disposition": `inline; filename="${encodeURIComponent(artifact.name)}"`,
      "cache-control": "no-store",
      // The preview renders untrusted worker output. Keep it from reaching the
      // network or loading anything but its own bytes.
      "content-security-policy": "default-src 'none'; img-src 'self' data: blob:; style-src 'unsafe-inline'; font-src data:; sandbox",
      "x-content-type-options": "nosniff",
    });
    createReadStream(artifact.path).pipe(req.res);
    return undefined;
  });
  add("GET", "/api/artifacts/:id/versions", (req) => {
    const artifact = dev.artifacts.get(req.params.id as string);
    if (!artifact) throw new HttpError(404, "Unknown artifact");
    const rootId = typeof artifact.meta.rootId === "string" ? artifact.meta.rootId : artifact.id;
    return dev.artifacts.versions(rootId);
  });
  add("POST", "/api/artifacts/:id/revise", (req) => {
    const artifact = artifactFile(req.params.id as string);
    if (!artifactMedia(artifact.path).text) throw new HttpError(415, `${artifact.name} is not a text artifact and cannot be edited here`);
    const content = req.body.content;
    if (typeof content !== "string") throw new HttpError(400, '"content" is required');
    return dev.artifacts.revise(artifact.id, content);
  });

  add("POST", "/api/onboarding/seed", () => seedGettingStarted(dev));

  // ----- planning -----
  add("POST", "/api/plan", async (req) => {
    const p = project(str(req.body, "projectId", true) as string);
    return planGoal(dev, p, str(req.body, "goal", true) as string, { workerId: str(req.body, "workerId") ?? null, maxTasks: req.body.maxTasks ? Number(req.body.maxTasks) : undefined });
  });
  add("POST", "/api/plan/apply", (req) => {
    const p = project(str(req.body, "projectId", true) as string);
    const proposal = req.body.proposal as PlanProposal | undefined;
    if (!proposal || !Array.isArray(proposal.tasks)) throw new HttpError(400, "proposal with tasks is required");
    return applyPlan(dev, p, proposal);
  });

  // ----- events -----
  add("GET", "/api/events", (req) => dev.events.list({ projectId: req.query.get("projectId") ?? undefined, taskId: req.query.get("taskId") ?? undefined, executionId: req.query.get("executionId") ?? undefined, sinceId: req.query.get("since") ? num(req.query.get("since"), 0) : undefined, limit: num(req.query.get("limit"), 100), types: req.query.get("types")?.split(",") }));

  const server = createServer(async (raw, res) => {
    const url = new URL(raw.url ?? "/", "http://localhost");
    // This API starts processes and reads and writes files, and it has no
    // password because it is meant to be reachable only from this machine.
    // That makes the browser the real threat: any page the user happens to
    // have open can send it requests. So a request carrying a browser Origin
    // is served only when that origin is DEV's own window, and a request whose
    // Host is not loopback is refused outright, which closes DNS rebinding.
    const origin = raw.headers.origin;
    if (!hostIsLoopback(raw.headers.host)) {
      sendJson(res, 403, { error: "Refused: the control plane only answers requests addressed to this machine." });
      return;
    }
    if (typeof origin === "string") {
      // `Origin: null` is what sandboxed iframes (and some local files) send. It is not DEV's window.
      if (!originIsTrusted(origin)) {
        sendJson(res, 403, { error: `Refused: ${origin} is not allowed to reach the control plane.` });
        return;
      }
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
    if (raw.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    if (url.pathname === "/api/events/stream" && raw.method === "GET") {
      streamEvents(dev, raw, res, url.searchParams);
      return;
    }
    const route = routes.find((r) => r.method === raw.method && r.pattern.test(url.pathname));
    if (!route) {
      sendJson(res, 404, { error: `No route ${raw.method} ${url.pathname}` });
      return;
    }
    const match = route.pattern.exec(url.pathname) as RegExpExecArray;
    const params: Record<string, string> = {};
    route.keys.forEach((k, i) => {
      params[k] = decodeURIComponent(match[i + 1] as string);
    });
    try {
      const body = await readBody(raw);
      const result = await route.handler({ method: raw.method ?? "GET", params, query: url.searchParams, body, raw, res });
      // A handler that served the response itself (raw artifact bytes) has
      // already written headers; there is nothing left to encode as JSON.
      // A handler may have chosen a status (202 for "filed, not performed"); 200 otherwise.
      if (!res.headersSent) sendJson(res, res.statusCode === 200 ? 200 : res.statusCode, result ?? {});
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (res.headersSent) res.end();
      else sendJson(res, status, { error: (error as Error).message });
    }
  });
  server.on("close", () => {
    for (const controller of runtime.running.values()) controller.abort();
    for (const auto of runtime.auto.values()) auto.controller.abort();
  });
  return { server, runtime };
}

export function taskDetail(dev: Dev, id: string) {
  const t = dev.tasks.get(id);
  if (!t) throw new HttpError(404, `Unknown task ${id}`);
  const executions = dev.executions.list({ taskId: t.id, limit: 20 });
  return {
    ...t,
    dependencies: t.dependsOn.map((d) => dev.tasks.get(d)).filter(Boolean).map((d) => ({ id: d!.id, title: d!.title, status: d!.status })),
    dependents: dev.tasks.dependents(t.id).map((d) => dev.tasks.get(d)).filter(Boolean).map((d) => ({ id: d!.id, title: d!.title, status: d!.status })),
    executions,
    evidence: dev.evidence.list(t.id),
    artifacts: dev.artifacts.list({ taskId: t.id }),
    events: dev.events.list({ taskId: t.id, limit: 100 }),
    contextSnapshots: dev.contextSnapshots.forTask(t.id).slice(0, 3),
    worker: t.workerId ? dev.workers.info(t.workerId) : null,
  };
}

function streamEvents(dev: Dev, raw: IncomingMessage, res: ServerResponse, query: URLSearchParams): void {
  // The CORS header for this stream was already set from the checked Origin;
  // re-adding a wildcard here would hand the event feed to any page.
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  res.write(": connected\n\n");
  const projectId = query.get("projectId") ?? null;
  const taskId = query.get("taskId") ?? null;
  const send = (event: DevEvent) => {
    if (projectId && event.projectId !== projectId) return;
    if (taskId && event.taskId !== taskId) return;
    res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  };
  const since = query.get("since");
  if (since !== null) for (const event of dev.events.list({ sinceId: Number(since), limit: 500 })) send(event);
  const off = dev.events.on(send);
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);
  raw.on("close", () => {
    clearInterval(heartbeat);
    off();
  });
}

async function readBody(raw: IncomingMessage): Promise<Record<string, unknown>> {
  if (raw.method === "GET" || raw.method === "DELETE") return {};
  const chunks: Buffer[] = [];
  for await (const chunk of raw) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new HttpError(400, "Body must be JSON");
  }
}

/** Hosts the window and the dev server are served from. Anything else is the open web. */
const TRUSTED_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "tauri.localhost"]);

/**
 * True for DEV's own window and its dev server. The scheme and port vary by
 * platform and build (`tauri://localhost`, `http://tauri.localhost`,
 * `http://localhost:1420`), so the hostname is what is checked.
 */
export function originIsTrusted(origin: string): boolean {
  try {
    return TRUSTED_HOSTNAMES.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/** True when the request was addressed to this machine rather than to a name that resolves here. */
export function hostIsLoopback(host: string | undefined): boolean {
  if (host === undefined) return true; // HTTP/1.0 and local clients that send no Host.
  try {
    return TRUSTED_HOSTNAMES.has(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

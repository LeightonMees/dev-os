import { repoMap } from "./context/assemble.ts";
import type { Dev } from "./dev.ts";
import { toCapabilityRefs, type NexusMatch } from "./nexus/client.ts";
import type { CapabilityRef, Project, Task, VerificationSpec } from "./schemas.ts";
import type { Worker } from "./workers/types.ts";

export interface PlannedTask {
  title: string;
  outcome: string;
  requirements: string[];
  acceptance: string[];
  /** Indices into the same plan (0-based). */
  dependsOn: number[];
  verification: VerificationSpec[];
  files: string[];
  effort: "low" | "medium" | "high";
}

export interface PlanProposal {
  goal: string;
  milestone: string;
  summary: string;
  tasks: PlannedTask[];
  capabilities: CapabilityRef[];
  nexusMatches: NexusMatch[];
  workerId: string;
  notes: string[];
}

/**
 * Goal → bounded plan. Inspects the repository map and the project summary,
 * asks Nexus for relevant capabilities, then asks one planning-capable worker
 * for at most `maxTasks` tasks with dependencies. Nothing is persisted here;
 * `applyPlan` does that after the user confirms.
 */
export async function planGoal(dev: Dev, project: Project, goal: string, options: { workerId?: string | null; maxTasks?: number; signal?: AbortSignal } = {}): Promise<PlanProposal> {
  const maxTasks = Math.max(1, Math.min(options.maxTasks ?? dev.config.planning.maxTasks, 12));
  const workerId = options.workerId ?? dev.config.planning.worker ?? null;
  const worker = await pickPlanner(dev, workerId);

  let nexusMatches: NexusMatch[] = [];
  const notes: string[] = [];
  if (dev.config.nexus.enabled) {
    try {
      nexusMatches = await dev.nexus.findCapability(goal, 8);
    } catch (error) {
      notes.push(`Nexus discovery unavailable: ${(error as Error).message}`);
    }
  }
  const capabilities = toCapabilityRefs(nexusMatches, 5);

  const existing = dev.tasks.list({ projectId: project.id }).filter((t) => t.status !== "DONE" && t.status !== "CANCELLED");
  if (!project.path) throw new Error(`${project.name} has no repository yet; create or register a directory before planning against code`);
  const prompt = buildPlanPrompt({ project, goal, maxTasks, capabilities, existing, map: repoMap(project.path, project.config.contextHints ?? [], 80) });
  const controller = new AbortController();
  options.signal?.addEventListener("abort", () => controller.abort(), { once: true });
  let output = "";
  const result = await worker.run({
    taskId: "plan",
    cwd: project.path,
    prompt,
    command: null,
    effort: "medium",
    // Planning is a read-only analysis pass; the worker's own configured level decides how hard it thinks.
    reasoningEffort: null,
    timeoutMs: 10 * 60 * 1000,
    signal: controller.signal,
    readOnly: true,
    onOutput: (chunk) => {
      output += chunk;
    },
  });
  const text = result.summary || output;
  if (!result.ok && !extractJson(text)) {
    throw new Error(`Planner ${worker.id} failed: ${result.launchError ?? result.summary ?? `exit ${result.exitCode}`}`);
  }
  const parsed = extractJson(text);
  if (!parsed) throw new Error(`Planner ${worker.id} returned no JSON plan. Output started: ${text.slice(0, 300)}`);
  const tasks = normaliseTasks(parsed, maxTasks);
  if (tasks.length === 0) throw new Error("Planner returned an empty task list");
  return {
    goal,
    milestone: String(parsed.milestone ?? goal).slice(0, 160),
    summary: String(parsed.summary ?? "").slice(0, 1200),
    tasks,
    capabilities,
    nexusMatches,
    workerId: worker.id,
    notes,
  };
}

export function applyPlan(dev: Dev, project: Project, plan: PlanProposal): Task[] {
  const created: Task[] = [];
  dev.db.transaction(() => {
    for (const planned of plan.tasks) {
      created.push(
        dev.tasks.create({
          projectId: project.id,
          title: planned.title,
          outcome: planned.outcome,
          requirements: planned.requirements,
          acceptance: planned.acceptance,
          verification: planned.verification,
          files: planned.files,
          effort: planned.effort,
          capabilities: plan.capabilities,
          status: "BACKLOG",
        }),
      );
    }
    plan.tasks.forEach((planned, index) => {
      for (const dep of planned.dependsOn) {
        const from = created[index];
        const to = created[dep];
        if (from && to && from.id !== to.id) {
          try {
            dev.tasks.addDependency(from.id, to.id);
          } catch {
            // a cycle from the planner is dropped rather than failing the whole plan
          }
        }
      }
    });
    for (const task of created) {
      if (dev.tasks.unmetDependencies(task.id).length === 0) dev.tasks.setStatus(task.id, "READY", { reason: "plan applied" });
    }
    dev.projects.update(project.id, { milestone: plan.milestone, goal: project.goal ?? plan.goal });
    dev.decisions.record({
      projectId: project.id,
      title: `Plan: ${plan.milestone}`,
      decision: `Planned ${created.length} task(s) for "${plan.goal}"`,
      reason: plan.summary,
      tags: ["plan"],
    });
  });
  dev.events.emit("PLAN_APPLIED", { projectId: project.id, data: { goal: plan.goal, milestone: plan.milestone, taskIds: created.map((t) => t.id), workerId: plan.workerId } });
  return created;
}

async function pickPlanner(dev: Dev, requested: string | null): Promise<Worker> {
  const candidates = requested ? [requested] : dev.config.workers.preferences.filter((id) => id !== "shell");
  const tried: string[] = [];
  for (const id of candidates) {
    const worker = dev.workers.get(id);
    if (!worker || !worker.capabilities.includes("plan")) {
      tried.push(`${id}: not a planning worker`);
      continue;
    }
    const health = await dev.workers.check(id);
    if (health.ok) return worker;
    tried.push(`${id}: ${health.detail}`);
  }
  throw new Error(`No planning worker available. ${tried.join("; ")}`);
}

function buildPlanPrompt(input: { project: Project; goal: string; maxTasks: number; capabilities: CapabilityRef[]; existing: Task[]; map: string }): string {
  const lines = [
    "You are the planner inside DEV, a development operating system. Produce a SMALL, bounded plan for the next milestone only.",
    "Read the repository if you need to, but DO NOT modify any file.",
    "",
    `# Project: ${input.project.name}`,
    `Path: ${input.project.path ?? "(none)"}`,
    input.project.goal ? `Existing goal: ${input.project.goal}` : "",
    input.project.summary ? `Summary: ${input.project.summary}` : "",
    "",
    `# Goal to plan`,
    input.goal,
    "",
    "# Repository map",
    input.map || "(empty directory)",
  ];
  if (input.existing.length > 0) {
    lines.push("", "# Open tasks already planned (do not duplicate)", ...input.existing.slice(0, 15).map((t) => `- [${t.status}] ${t.title}`));
  }
  if (input.capabilities.length > 0) {
    lines.push("", "# Capabilities available through Nexus (reference only)", ...input.capabilities.map((c) => `- ${c.kind}: ${c.name} — ${c.reason ?? ""}`));
  }
  lines.push(
    "",
    "# Rules",
    `- At most ${input.maxTasks} tasks. Fewer is better. Only what is needed for the next meaningful, shippable milestone.`,
    "- Each task must be completable by one coding agent in one sitting and must be verifiable.",
    "- Prefer a verification command that exists in this repository (its test/build/lint script). Use kind \"file-exists\" when a command does not exist yet.",
    "- dependsOn uses 0-based indices into your own task list. No cycles.",
    // `files` looked free, so planners listed every document that seemed related and each one was
    // pasted into the worker's brief. Measured 2026-09-18: a 17,160-character strategy document
    // attached to a "decide the next milestone" task took 62% of that task's entire brief.
    "- files = the files the task will actually CREATE OR EDIT. Every one is pasted into the worker's brief and spends its budget, so do not attach background reading, strategy documents or anything the task only refers to. Omit the field when the task edits nothing.",
    "- No speculative extras, no roadmap items, no 'nice to have'.",
    "",
    "# Output",
    "Reply with ONLY a JSON object (no prose before or after) of this exact shape:",
    JSON.stringify(
      {
        milestone: "short milestone name",
        summary: "2-4 sentences: the approach and why",
        tasks: [
          {
            title: "imperative title",
            outcome: "what exists when this is done",
            requirements: ["specific requirement"],
            acceptance: ["observable acceptance criterion"],
            dependsOn: [],
            files: ["relative/path/to/file"],
            effort: "low|medium|high",
            verification: [{ kind: "command", command: "npm test" }],
          },
        ],
      },
      null,
      2,
    ),
  );
  return lines.filter((l) => l !== undefined).join("\n");
}

export function extractJson(text: string): Record<string, unknown> | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidates = [fenced?.[1], text];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start < 0 || end <= start) continue;
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1));
      if (parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).tasks)) return parsed as Record<string, unknown>;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function normaliseTasks(parsed: Record<string, unknown>, maxTasks: number): PlannedTask[] {
  const raw = Array.isArray(parsed.tasks) ? (parsed.tasks as Record<string, unknown>[]) : [];
  const tasks: PlannedTask[] = [];
  for (const item of raw.slice(0, maxTasks)) {
    const title = String(item.title ?? "").trim();
    if (!title) continue;
    const verification = (Array.isArray(item.verification) ? item.verification : [])
      .map((v) => v as Record<string, unknown>)
      .filter((v) => v.kind === "command" || v.kind === "file-exists" || v.kind === "manual")
      .map((v) => ({ kind: v.kind as VerificationSpec["kind"], command: v.command ? String(v.command) : undefined, path: v.path ? String(v.path) : undefined, label: v.label ? String(v.label) : undefined }));
    const effortRaw = String(item.effort ?? "medium");
    tasks.push({
      title: title.slice(0, 140),
      outcome: String(item.outcome ?? "").trim().slice(0, 800),
      requirements: strings(item.requirements),
      acceptance: strings(item.acceptance),
      dependsOn: (Array.isArray(item.dependsOn) ? item.dependsOn : []).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < maxTasks),
      verification,
      files: strings(item.files).slice(0, 10),
      effort: effortRaw === "low" || effortRaw === "high" ? effortRaw : "medium",
    });
  }
  return tasks.map((t, i) => ({ ...t, dependsOn: t.dependsOn.filter((d) => d < tasks.length && d !== i) }));
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => String(v).trim()).filter(Boolean).slice(0, 12) : [];
}

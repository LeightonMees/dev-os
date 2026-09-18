// The first thing a new user sees.
//
// An empty board teaches nothing, so DEV's own setup is seeded as real tasks in
// a real project: the same board, graph, dependencies and inspector they will
// use for their own work, with the setup steps as the content. Working through
// the guide *is* the tutorial.
//
// Two rules hold this together. Nothing here is fake — these are ordinary task
// rows in the ordinary database, and the user can edit, reorder or delete them
// like any other. And nothing here names a provider: which AI runs the work is
// the user's choice, and the guide must never read as though one of them is
// required.

import type { Dev } from "./dev.ts";
import type { Project, Task } from "./schemas.ts";

export const GUIDE_PROJECT_NAME = "Getting started with DEV";

interface Step {
  title: string;
  outcome: string;
  requirements: string[];
  /** Index into the step list, 1-based, this step depends on. */
  after?: number;
}

/**
 * The setup path, in the order it has to happen. Each step states an outcome
 * the user can check for themselves, because a task whose completion nobody can
 * judge is not a task.
 */
const STEPS: Step[] = [
  {
    title: "Check what DEV can see on this machine",
    outcome: "`dev doctor` runs and you have read what it reports as healthy, missing or misconfigured.",
    requirements: [
      "Run `dev doctor` in a terminal, or open the Workers section in the app.",
      "It lists what is actually installed. Nothing is assumed to be present.",
      "Missing things are fine at this stage — the next step is choosing one.",
    ],
  },
  {
    title: "Choose the AI you want DEV to use",
    outcome: "At least one worker reports healthy, and you know which one your tasks will go to.",
    after: 1,
    requirements: [
      "DEV has no default provider and no favourite model. Any of these is a complete setup on its own:",
      "A CLI agent you already use, if one is installed.",
      "A local model through Ollama, which keeps every byte on this machine and needs no account.",
      "A hosted API key in your .env — several providers have a free tier, and any OpenAI-compatible endpoint works.",
      "Shell tasks alone, with no AI at all, if you only want the orchestration.",
      "You can enable several and let routing pick a healthy one per task; if one is rate-limited, another takes the work.",
    ],
  },
  {
    title: "Register your first project",
    outcome: "A repository of yours appears in the project switcher.",
    after: 2,
    requirements: [
      "`dev project add <path>`, or use the app's project switcher.",
      "Use a repository with a clean git status and a branch you do not mind DEV working on.",
      "DEV never writes outside the project directory you name.",
    ],
  },
  {
    title: "Write a task with an outcome and a check",
    outcome: "A task exists whose outcome is specific enough that a stranger could tell whether it was met.",
    after: 3,
    requirements: [
      "`dev task add \"<title>\" --outcome \"<what is true when this is done>\" --verify \"<command>\"`",
      "The outcome is the important half. \"Improve the API\" cannot be verified; \"GET /health returns 200 JSON\" can.",
      "The check is what lets the task reach DONE without you inspecting it by hand.",
    ],
  },
  {
    title: "Run it and read the evidence",
    outcome: "The task reached DONE or BLOCKED, and you have looked at why.",
    after: 4,
    requirements: [
      "`dev task run <id>`, or press Run in the app.",
      "DONE always has evidence behind it: an exit code, a file that exists, a passing check, or your approval.",
      "BLOCKED always has a reason and a next action. A failed run is information, not a dead end.",
      "Open the task in the inspector to see its execution, artifacts and events.",
    ],
  },
  {
    title: "Let DEV plan a goal for you",
    outcome: "You have seen a plan proposed from a one-line goal, and either kept it or thrown it away.",
    after: 5,
    requirements: [
      "`dev plan \"<goal>\"` proposes a small, bounded task list and asks before saving anything.",
      "`dev auto` then runs everything runnable in dependency order.",
      "Delete this guide project whenever you like — it is an ordinary project.",
    ],
  },
];

export interface SeedResult {
  project: Project;
  tasks: Task[];
  /** True when the guide already existed and nothing was created. */
  existed: boolean;
}

/**
 * Create the guide project and its tasks. Idempotent: if a guide is already
 * present it is returned untouched, so this can be called on every start
 * without ever duplicating or resetting the user's progress through it.
 */
export function seedGettingStarted(dev: Dev): SeedResult {
  const existing = dev.projects.list().find((p) => p.name === GUIDE_PROJECT_NAME);
  if (existing) {
    return { project: existing, tasks: dev.tasks.list({ projectId: existing.id }), existed: true };
  }
  // No path: the guide is about setting DEV up, so it must not need a
  // repository to exist before it can be read.
  const project = dev.projects.add({
    path: null,
    name: GUIDE_PROJECT_NAME,
    goal: "Get DEV running with the AI of your choice, then run a real task end to end.",
    summary: "Created by DEV on first run. An ordinary project: edit or delete it freely.",
    meta: { sources: ["DEV onboarding"] },
  });

  const created: Task[] = [];
  for (const [index, step] of STEPS.entries()) {
    const dependsOn = step.after ? [created[step.after - 1]!.id] : [];
    created.push(
      dev.tasks.create({
        projectId: project.id,
        title: step.title,
        outcome: step.outcome,
        requirements: step.requirements,
        // Every step is finished by a person doing something outside DEV, so
        // the honest verification is their own approval, not an invented check.
        verification: [{ kind: "manual", label: "Mark this done once the outcome above is true for you." }],
        dependsOn,
        // The first step is actionable immediately; the rest unlock in order,
        // which also demonstrates how dependencies gate work.
        status: index === 0 ? "READY" : "BACKLOG",
      }),
    );
  }
  return { project, tasks: created, existed: false };
}

/** Seed the guide only when this installation has no projects at all. */
export function seedIfFirstRun(dev: Dev): SeedResult | null {
  if (dev.projects.list().length > 0) return null;
  return seedGettingStarted(dev);
}

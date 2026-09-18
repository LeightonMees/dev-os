import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

import type { DevConfig } from "../config.ts";
import type { DecisionStore } from "../records.ts";
import type { ContextSection, Decision, Project, Task, VerificationSpec } from "../schemas.ts";
import type { TaskStore } from "../tasks.ts";

/** Rough but stable: 4 characters per token. Recorded, never billed. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Words too common to say anything about relevance. */
const STOP = new Set(
  (
    "the a an and or but if then else for of to in on at by with from as is are was were be been it its this that these those not no do does did done " +
    "task work use used using make made set get put add new next current project file files code run"
  ).split(" "),
);

function terms(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );
}

/**
 * The part of a document worth sending, rather than its first N characters.
 *
 * Head truncation assumes relevance lives at the top of a file. For a source file that is roughly
 * true; for the reference documents planners actually attach it is not. Measured 2026-09-18: a
 * 17,160-character strategy document entered a "decide the next milestone" brief as its first 8,000
 * characters, which spent the budget on a weekly study timetable while the priority order the task
 * explicitly asked about sat further down.
 *
 * So: split on markdown headings, score each section by how many of the task's own words it uses,
 * and keep the best in document order until the budget is gone. The opening section is always kept
 * — it is the title and summary, and a document that starts mid-sentence reads as corrupt. Every
 * gap is marked, so a worker knows it is holding an excerpt rather than a whole file.
 */
export function excerptForTask(
  raw: string,
  task: { title: string; outcome?: string; requirements?: string[]; acceptance?: string[] },
  maxChars: number,
): string {
  if (raw.length <= maxChars) return raw;

  const wanted = terms([task.title, task.outcome ?? "", ...(task.requirements ?? []), ...(task.acceptance ?? [])].join(" "));

  // Split before every markdown heading, keeping each heading with its body.
  const parts: string[] = [];
  let current: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (/^#{1,6}\s/.test(line) && current.length > 0) {
      parts.push(current.join("\n"));
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) parts.push(current.join("\n"));

  // No headings means no sections to choose between; the head is all we can honestly offer.
  if (parts.length < 2) return raw.slice(0, maxChars) + `\n… (truncated, ${raw.length - maxChars} more characters)`;

  const scored = parts.map((text, index) => {
    const own = terms(text);
    let hits = 0;
    for (const w of wanted) if (own.has(w)) hits++;
    // Per-root-character, so a short on-topic section beats a long rambling one.
    return { index, text, score: hits / Math.max(1, Math.sqrt(text.length)) };
  });

  const keep = new Set<number>([0]); // the opening section always goes
  let used = (parts[0] ?? "").length;
  for (const section of [...scored].sort((a, b) => b.score - a.score)) {
    if (keep.has(section.index) || section.score <= 0) continue;
    if (used + section.text.length + 24 > maxChars) continue;
    keep.add(section.index);
    used += section.text.length + 24;
  }

  const out: string[] = [];
  let skipped = 0;
  const flush = () => {
    if (skipped > 0) out.push(`… (${skipped} section${skipped === 1 ? "" : "s"} not relevant to this task omitted)`);
    skipped = 0;
  };
  for (const [i, part] of parts.entries()) {
    if (keep.has(i)) {
      flush();
      out.push(part);
    } else skipped++;
  }
  flush();
  const joined = out.join("\n");
  return joined.length > maxChars ? joined.slice(0, maxChars) + "\n… (cut to fit the per-file budget)" : joined;
}

export interface AssembledContext {
  prompt: string;
  sections: ContextSection[];
  budgetTokens: number;
  usedTokens: number;
}

interface Piece {
  name: string;
  source?: string;
  text: string;
  /** Lower runs first and is cut last. */
  priority: number;
  /** Pieces that may be shortened to fit; others are all-or-nothing. */
  truncatable: boolean;
}

const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "build", "target", ".dev-home", ".cache", "coverage", "__pycache__", ".venv", "venv", ".next", "out"]);

/**
 * Build the worker brief for a task. Only what the task needs, in priority
 * order, cut to the budget:
 *   task > dependency outcomes > project summary > decisions > files > repo map > recent outcomes
 * Never the backlog, never transcripts, never every skill.
 */
export function assembleContext(
  input: {
    task: Task;
    project: Project;
    tasks: TaskStore;
    decisions: DecisionStore;
    config: DevConfig["context"];
    budgetTokens?: number;
    instructions?: string;
  },
): AssembledContext {
  const { task, project } = input;
  const budget = input.budgetTokens ?? input.config.budgetTokens;
  const pieces: Piece[] = [];

  pieces.push({ name: "task", priority: 0, truncatable: false, text: renderTask(task) });

  const deps = task.dependsOn.map((id) => input.tasks.get(id)).filter((t): t is Task => !!t);
  if (deps.length > 0) {
    pieces.push({
      name: "dependencies",
      priority: 1,
      truncatable: true,
      text: ["## Upstream tasks (already done)", ...deps.map((d) => `- ${d.title} [${d.status}]${d.resultSummary ? `: ${oneLine(d.resultSummary, 400)}` : ""}`)].join("\n"),
    });
  }

  const projectLines = [`## Project: ${project.name}`, `Path: ${project.path ?? "(no repository yet)"}`];
  if (project.lifecycle !== "ACTIVE") projectLines.push(`Lifecycle: ${project.lifecycle}`);
  if (project.goal) projectLines.push(`Goal: ${project.goal}`);
  if (project.milestone) projectLines.push(`Current milestone: ${project.milestone}`);
  if (project.summary) projectLines.push("", project.summary);
  pieces.push({ name: "project", priority: 2, truncatable: true, text: projectLines.join("\n") });

  const relevant = input.decisions.relevant(project.id, `${task.title} ${task.outcome} ${task.requirements.join(" ")}`, 5);
  if (relevant.length > 0) {
    pieces.push({ name: "decisions", source: `${relevant.length} relevant of ${input.decisions.list(project.id).length}`, priority: 3, truncatable: true, text: renderDecisions(relevant) });
  }

  const files = task.files.slice(0, input.config.maxFiles);
  for (const file of files) {
    if (!project.path && !isAbsolute(file)) continue;
    const abs = isAbsolute(file) ? file : join(project.path as string, file);
    if (!existsSync(abs) || statSync(abs).isDirectory()) continue;
    const raw = readFileSync(abs, "utf8");
    const body = excerptForTask(raw, task, input.config.maxFileTokens * 4);
    pieces.push({ name: `file:${file}`, source: abs, priority: 4, truncatable: true, text: `## File: ${file}\n\`\`\`\n${body}\n\`\`\`` });
  }

  const map = project.path ? repoMap(project.path, project.config.contextHints ?? []) : "";
  if (map) pieces.push({ name: "repo-map", priority: 5, truncatable: true, text: `## Repository map\n${map}` });

  const recent = input.tasks
    .list({ projectId: project.id, status: "DONE" })
    .filter((t) => t.id !== task.id && !task.dependsOn.includes(t.id) && t.resultSummary)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 3);
  if (recent.length > 0) {
    pieces.push({ name: "recent-outcomes", priority: 6, truncatable: true, text: ["## Recent completed work", ...recent.map((t) => `- ${t.title}: ${oneLine(t.resultSummary ?? "", 240)}`)].join("\n") });
  }

  if (task.capabilities.length > 0) {
    pieces.push({ name: "capabilities", priority: 7, truncatable: true, text: ["## Capabilities selected for this task (via Nexus)", ...task.capabilities.map((c) => `- ${c.kind}: ${c.name}${c.reason ? ` — ${c.reason}` : ""}`)].join("\n") });
  }

  const instructions = input.instructions ?? defaultInstructions(task, project.config.verification ?? []);
  pieces.push({ name: "instructions", priority: 0, truncatable: false, text: instructions });

  // Fit to budget: fixed pieces first, then by priority; truncate the piece that overflows.
  const ordered = [...pieces].sort((a, b) => a.priority - b.priority);
  const sections: ContextSection[] = [];
  const kept = new Map<string, string>();
  let used = 0;
  for (const piece of ordered) {
    const tokens = estimateTokens(piece.text);
    if (used + tokens <= budget) {
      kept.set(piece.name, piece.text);
      used += tokens;
      sections.push({ name: piece.name, tokens, included: true, truncated: false, source: piece.source });
      continue;
    }
    const remaining = budget - used;
    if (piece.truncatable && remaining > 80) {
      const cut = piece.text.slice(0, remaining * 4 - 40) + "\n… (cut to fit context budget)";
      kept.set(piece.name, cut);
      const cutTokens = estimateTokens(cut);
      used += cutTokens;
      sections.push({ name: piece.name, tokens: cutTokens, included: true, truncated: true, source: piece.source });
    } else if (!piece.truncatable) {
      // Required pieces are always sent even when they blow the budget; record it honestly.
      kept.set(piece.name, piece.text);
      used += tokens;
      sections.push({ name: piece.name, tokens, included: true, truncated: false, source: piece.source });
    } else {
      sections.push({ name: piece.name, tokens, included: false, truncated: false, source: piece.source });
    }
  }
  const prompt = pieces
    .filter((p) => kept.has(p.name))
    .map((p) => kept.get(p.name) as string)
    .join("\n\n");
  return { prompt, sections, budgetTokens: budget, usedTokens: estimateTokens(prompt) };
}

export function defaultInstructions(task: Task, projectVerification: VerificationSpec[] = []): string {
  const lines = [
    "## Instructions",
    "You are a worker inside DEV, a development operating system. Do exactly this task in the current working directory and nothing beyond it.",
    "Work in small, verifiable steps. Do not create speculative extras or refactor unrelated code.",
    "When finished, reply with a concise summary (max 12 lines): what changed, which files, how it was verified, and anything the next task must know.",
    "Do not paste large logs or full file contents in the summary.",
  ];
  const checks = [...projectVerification, ...task.verification].map((v) => v.command ?? v.path ?? v.kind);
  if (checks.length > 0) lines.push(`DEV will run this verification after you finish: ${checks.join("; ")}. Make it pass.`);
  return lines.join("\n");
}

function renderTask(task: Task): string {
  const lines = [`# Task: ${task.title}`];
  if (task.outcome) lines.push("", `## Desired outcome`, task.outcome);
  if (task.requirements.length) lines.push("", "## Requirements", ...task.requirements.map((r) => `- ${r}`));
  if (task.acceptance.length) lines.push("", "## Acceptance criteria", ...task.acceptance.map((a) => `- ${a}`));
  return lines.join("\n");
}

function renderDecisions(decisions: Decision[]): string {
  return ["## Relevant decisions", ...decisions.map((d) => `- ${d.title}: ${oneLine(d.decision, 200)}${d.reason ? ` (why: ${oneLine(d.reason, 120)})` : ""}`)].join("\n");
}

export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

/** Two levels of the tree, capped, with directories first. Hints are listed explicitly. */
export function repoMap(root: string, hints: string[], maxEntries = 60): string {
  if (!existsSync(root)) return "";
  const lines: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (lines.length >= maxEntries || depth > 1) return;
    let entries: string[];
    try {
      entries = readdirSync(dir).filter((e) => !IGNORED_DIRS.has(e) && !e.startsWith(".")).sort();
    } catch {
      return;
    }
    const dirs = entries.filter((e) => safeIsDir(join(dir, e)));
    const files = entries.filter((e) => !dirs.includes(e));
    for (const d of dirs) {
      if (lines.length >= maxEntries) break;
      lines.push(`${"  ".repeat(depth)}${relative(root, join(dir, d)) || d}/`);
      walk(join(dir, d), depth + 1);
    }
    for (const f of files) {
      if (lines.length >= maxEntries) break;
      lines.push(`${"  ".repeat(depth)}${relative(root, join(dir, f)) || f}`);
    }
  };
  walk(root, 0);
  if (lines.length >= maxEntries) lines.push("… (more entries not shown)");
  for (const hint of hints) lines.push(`hint: ${hint}`);
  return lines.join("\n");
}

function safeIsDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

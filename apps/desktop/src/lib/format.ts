import type { TaskStatus } from "./api.ts";

export function ago(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s - m * 60)}s`;
}

export function clock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString([], { hour12: false });
}

export function truncate(text: string | null | undefined, max: number): string {
  if (!text) return "";
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export const STATUS_ORDER: TaskStatus[] = ["BACKLOG", "READY", "WORKING", "BLOCKED", "REVIEW", "DONE"];

export const STATUS_SYMBOL: Record<TaskStatus, string> = {
  BACKLOG: "○",
  READY: "◔",
  WORKING: "▶",
  BLOCKED: "■",
  REVIEW: "◆",
  DONE: "●",
  CANCELLED: "×",
};

export const STATUS_LABEL: Record<TaskStatus, string> = {
  BACKLOG: "Backlog",
  READY: "Ready",
  WORKING: "Working",
  BLOCKED: "Blocked",
  REVIEW: "Review",
  DONE: "Done",
  CANCELLED: "Cancelled",
};

/** Legal manual moves from the board (mirrors core TRANSITIONS minus the runner-only ones). */
export const MANUAL_MOVES: Record<TaskStatus, TaskStatus[]> = {
  BACKLOG: ["READY", "CANCELLED"],
  READY: ["BACKLOG", "CANCELLED"],
  WORKING: ["CANCELLED"],
  BLOCKED: ["READY", "CANCELLED"],
  REVIEW: ["READY", "CANCELLED"],
  DONE: ["READY"],
  CANCELLED: ["BACKLOG"],
};

export function elapsed(iso: string): string {
  return duration(Math.max(0, Date.now() - Date.parse(iso)));
}

export function describeEvent(type: string, data: Record<string, unknown>): string {
  switch (type) {
    case "TASK_STATUS_CHANGED":
      return `${data.from} → ${data.to}${data.reason ? ` (${data.reason})` : ""}`;
    case "WORKER_SELECTED":
      return `${data.workerId}: ${data.reason}`;
    case "CONTEXT_ASSEMBLED":
      return `~${data.usedTokens}/${data.budgetTokens} tokens`;
    case "COMMAND_STARTED":
      return truncate(String(data.command ?? ""), 80);
    case "COMMAND_FINISHED":
      return `exit ${data.exitCode} in ${duration(Number(data.durationMs))}`;
    case "FILE_CHANGED":
      return String(data.path ?? `${data.count} files`);
    case "VERIFICATION_STARTED":
      return String(data.label ?? data.kind ?? "");
    case "VERIFICATION_PASSED":
    case "VERIFICATION_FAILED":
      return String(data.summary ?? "");
    case "EVIDENCE_RECORDED":
      return `${data.passed ? "✓" : "✗"} ${data.kind}: ${truncate(String(data.summary ?? ""), 70)}`;
    case "ARTIFACT_CREATED":
      return `${data.kind}: ${data.name}`;
    case "TASK_CREATED":
    case "TASK_COMPLETED":
    case "TASK_STARTED":
      return String(data.title ?? "");
    case "TASK_BLOCKED": {
      const failure = data.failure as { kind?: string; reason?: string } | undefined;
      return failure ? `${failure.kind}: ${truncate(failure.reason, 80)}` : "";
    }
    case "GIT_COMMIT":
      return `${String(data.hash ?? "").slice(0, 7)} ${data.subject ?? ""}`;
    case "PLAN_APPLIED":
      return `${(data.taskIds as string[] | undefined)?.length ?? 0} tasks · ${data.milestone ?? ""}`;
    case "WORKER_HEALTH":
      return `${data.workerId}: ${data.ok ? "ok" : "down"}`;
    case "PROJECT_ADDED":
      return String(data.name ?? "");
    case "REVIEW_REQUESTED":
      return String(data.reason ?? "");
    default:
      return truncate(JSON.stringify(data), 80);
  }
}

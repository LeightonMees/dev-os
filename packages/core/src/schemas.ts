// Typed records shared by the core, the CLI, the control plane and the desktop.
// Everything persisted in SQLite has a shape here. Keep prose out of records:
// large text (logs, transcripts, diffs) lives in artifacts on disk.

export const TASK_STATUSES = ["BACKLOG", "READY", "WORKING", "BLOCKED", "REVIEW", "DONE", "CANCELLED"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** How big a job is: a planning estimate carried on the task. */
export const EFFORTS = ["low", "medium", "high"] as const;
export type Effort = (typeof EFFORTS)[number];

/**
 * How hard a model is told to think. A different axis from EFFORTS above, and a wider ladder:
 * Claude Code alone accepts low through max. Which levels a given worker actually takes, and
 * where that list was read from, lives in `workers/efforts.ts`.
 */
export const REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export type ProjectStatus = "active" | "archived";

/** Where a project is in its life. ACTIVE and NEXT are today's work; the rest stay searchable. */
export const LIFECYCLES = ["ACTIVE", "NEXT", "PLANNED", "INCUBATOR", "PARKED", "MAINTENANCE", "ARCHIVED", "CLOSED"] as const;
export type Lifecycle = (typeof LIFECYCLES)[number];
export type ProjectKind = "project" | "subproject" | "module" | "capability" | "workflow" | "idea" | "program" | "infrastructure";
export type Priority = "critical" | "high" | "normal" | "low";

export interface ProjectMeta {
  /** Where this record's facts came from (paths, docs, the canonical inventory). */
  sources?: string[];
  stack?: string[];
  remote?: string | null;
  related?: string[];
  /** Working features observed on disk or in docs. Never assumed. */
  working?: string[];
  planned?: string[];
  risks?: string[];
  decisions?: string[];
  legacyPaths?: string[];
  category?: string;
  notes?: string;
}

export interface VerificationSpec {
  /** command: exit code 0 passes. file-exists: the path exists. manual: a human approves in REVIEW. */
  kind: "command" | "file-exists" | "manual";
  label?: string;
  command?: string;
  path?: string;
  timeoutMs?: number;
}

export interface ProjectConfig {
  defaultWorker?: string;
  /** Verification every task in this project runs after execution (e.g. the test suite). */
  verification?: VerificationSpec[];
  /** When true a successful task waits in REVIEW for a human instead of going straight to DONE. */
  reviewRequired?: boolean;
  /** Extra paths that context assembly should treat as important. */
  contextHints?: string[];
}

export interface Project {
  id: string;
  name: string;
  /** Null for planned projects with no repository yet. */
  path: string | null;
  repository: string | null;
  lifecycle: Lifecycle;
  kind: ProjectKind;
  priority: Priority;
  parentId: string | null;
  aliases: string[];
  meta: ProjectMeta;
  goal: string | null;
  summary: string | null;
  milestone: string | null;
  status: ProjectStatus;
  config: ProjectConfig;
  createdAt: string;
  updatedAt: string;
}

export interface CapabilityRef {
  kind: "skill" | "mcp" | "api" | "workflow" | "tool";
  name: string;
  reason?: string;
  ready?: boolean;
}

export type FailureKind =
  | "process-failed"
  | "timeout"
  | "verification-failed"
  | "worker-unavailable"
  | "dependency-missing"
  | "approval-denied"
  | "launch-failed"
  | "cancelled"
  /** The process running it went away (control plane restarted, machine rebooted, crash). */
  | "abandoned"
  | "review-rejected";

export interface TaskFailure {
  kind: FailureKind;
  reason: string;
  nextAction: string;
  executionId?: string;
  at: string;
  /** Facts about the failure (last timeout, etc.). Never prose. */
  data?: Record<string, unknown>;
}

export type TaskKind = "epic" | "ticket" | "subtask" | "prep" | "decision";
export type TaskRisk = "low" | "normal" | "high";

export interface Task {
  id: string;
  projectId: string;
  title: string;
  /** Grouping for planning: which milestone and epic this work belongs to. Free text, matched by name. */
  milestone: string | null;
  epic: string | null;
  kind: TaskKind;
  risk: TaskRisk;
  /** When set, a person must do or decide something before this task can proceed. */
  needsHuman: string | null;
  outcome: string;
  requirements: string[];
  acceptance: string[];
  status: TaskStatus;
  dependsOn: string[];
  workerId: string | null;
  capabilities: CapabilityRef[];
  /** How big the job is. A planning estimate, not a dial on the model. */
  effort: Effort;
  /**
   * How hard the model should think on this task, when it differs from what the size estimate
   * implies. null = derive it from `effort`. The worker's own configured level overrides both.
   */
  reasoningEffort: ReasoningEffort | null;
  /** A deterministic shell command. When set, the shell worker runs it instead of an agent. */
  command: string | null;
  /** Files the task is expected to touch; context assembly includes them. */
  files: string[];
  /**
   * A human-edited brief. null = assemble the brief from context, which is the normal path. When
   * set, this exact text is sent to the worker and assembly is skipped, so what you read in the
   * composer is literally what runs.
   */
  promptOverride: string | null;
  verification: VerificationSpec[];
  resultSummary: string | null;
  failure: TaskFailure | null;
  retryCount: number;
  ordinal: number;
  createdAt: string;
  updatedAt: string;
}

export interface DevEvent {
  id: number;
  ts: string;
  type: string;
  projectId: string | null;
  taskId: string | null;
  executionId: string | null;
  data: Record<string, unknown>;
}

export type ExecutionStatus = "running" | "succeeded" | "failed" | "cancelled" | "timeout";

export interface Execution {
  id: string;
  taskId: string;
  projectId: string;
  workerId: string;
  status: ExecutionStatus;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  command: string | null;
  cwd: string;
  logPath: string | null;
  changedFiles: string[];
  error: string | null;
  durationMs: number | null;
  contextSnapshotId: string | null;
  summary: string | null;
  cancelRequested: boolean;
  usage: Record<string, unknown> | null;
}

export type ArtifactKind =
  | "log"
  | "report"
  | "diff"
  | "file"
  | "build"
  | "screenshot"
  | "test-result"
  | "dataset"
  | "document"
  | "design"
  | "other";

export interface Artifact {
  id: string;
  projectId: string;
  taskId: string | null;
  executionId: string | null;
  kind: ArtifactKind;
  name: string;
  path: string;
  size: number;
  createdAt: string;
  meta: Record<string, unknown>;
}

export type EvidenceKind =
  | "command-exit"
  | "verification"
  | "file-exists"
  | "tests-passed"
  | "build-completed"
  | "human-approval"
  /** An answer, decision or piece of information the user typed for a task that needed them. */
  | "human-input"
  | "diff-review"
  | "other";

export interface Evidence {
  id: string;
  taskId: string;
  executionId: string | null;
  kind: EvidenceKind;
  passed: boolean;
  summary: string;
  data: Record<string, unknown>;
  artifactId: string | null;
  createdAt: string;
}

export interface Decision {
  id: string;
  projectId: string;
  title: string;
  decision: string;
  reason: string;
  alternatives: string[];
  tags: string[];
  revisit: string | null;
  createdAt: string;
}

export type ApprovalStatus = "pending" | "approved" | "denied";

export interface Approval {
  id: string;
  projectId: string | null;
  taskId: string | null;
  executionId: string | null;
  action: string;
  reason: string;
  status: ApprovalStatus;
  requestedAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  /** The human's answer or reason, when they gave one. */
  note: string | null;
}

export interface ContextSection {
  name: string;
  tokens: number;
  included: boolean;
  truncated: boolean;
  source?: string;
}

export interface ContextSnapshot {
  id: string;
  taskId: string;
  executionId: string | null;
  budgetTokens: number;
  usedTokens: number;
  sections: ContextSection[];
  createdAt: string;
}

export type WorkerType = "cli-agent" | "shell" | "local-model" | "remote-model";

export interface WorkerHealth {
  ok: boolean;
  checkedAt: string;
  detail: string;
  version?: string;
}

export interface WorkerStats {
  executions: number;
  succeeded: number;
  failed: number;
  avgDurationMs: number | null;
  lastRunAt: string | null;
}

export interface WorkerInfo {
  id: string;
  name: string;
  type: WorkerType;
  capabilities: string[];
  configRef: string;
  health: WorkerHealth | null;
  currentTaskId: string | null;
  stats: WorkerStats;
}

export interface DoctorCheck {
  name: string;
  status: "ok" | "warning" | "failed";
  detail: string;
  remediation?: string;
}

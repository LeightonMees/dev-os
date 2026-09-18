import type { Effort, WorkerHealth, WorkerType } from "../schemas.ts";
import type { EffortSupport, ReasoningEffort } from "./efforts.ts";

export type WorkerCapability = "code" | "plan" | "review" | "shell" | "research" | "summarize";

export interface WorkerRunRequest {
  taskId: string;
  cwd: string;
  /** Full assembled prompt for agent workers; ignored by the shell worker. */
  prompt: string;
  /** Shell command for the shell worker; ignored by agent workers. */
  command: string | null;
  /** The task's size estimate. Kept for the record and as the fallback for `reasoningEffort`. */
  effort: Effort;
  /** How hard to tell the model to think. null = let the worker's own configured level decide. */
  reasoningEffort: ReasoningEffort | null;
  timeoutMs: number;
  signal: AbortSignal;
  /** Agent workers in plan mode must not modify files. */
  readOnly?: boolean;
  onOutput: (chunk: string, stream: "stdout" | "stderr") => void;
  /** Structured progress from agents that emit it (tool use, assistant text). */
  onEvent?: (event: WorkerEvent) => void;
}

export interface WorkerEvent {
  kind: "assistant" | "tool" | "result" | "system";
  text: string;
  raw?: unknown;
}

export interface WorkerRunResult {
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  launchError: string | null;
  /** The worker's own closing summary: the final assistant message, or the last output lines. */
  summary: string;
  /** Command line actually run (for the execution record). */
  commandLine: string;
  usage: Record<string, unknown> | null;
  durationMs: number;
}

export interface Worker {
  readonly id: string;
  readonly name: string;
  readonly type: WorkerType;
  readonly capabilities: readonly WorkerCapability[];
  readonly configRef: string;
  /** Which reasoning levels this worker accepts, and where that list came from. */
  readonly efforts: EffortSupport;
  probe(): Promise<WorkerHealth>;
  run(request: WorkerRunRequest): Promise<WorkerRunResult>;
}

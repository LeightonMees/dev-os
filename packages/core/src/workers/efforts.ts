// How hard a worker is told to think, as distinct from how big the job is.
//
// DEV has two things that were both called "effort":
//   * `Task.effort`  — a size estimate from planning (low/medium/high). A property of the work.
//   * reasoning effort — the dial on the model. A property of the worker run.
// They are not the same axis: a small task can want a strong model and a large one can want a
// cheap pass. This module owns the second, and every ladder here records where it came from.
//
// Nothing is invented. A worker whose CLI publishes its levels gets those levels and is marked
// verified; a worker whose CLI takes a free-form string says so, and a worker with no such dial
// says that too, so the UI can omit the control rather than show one that does nothing.

import { REASONING_EFFORTS, type ReasoningEffort } from "../schemas.ts";

export { REASONING_EFFORTS };
export type { ReasoningEffort };

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && (REASONING_EFFORTS as readonly string[]).includes(value);
}

export interface EffortSupport {
  /** Levels this worker accepts, weakest first. Empty = the worker has no reasoning dial. */
  levels: readonly ReasoningEffort[];
  /** The flag or config key the level is passed as, for the execution record. null = not passed. */
  flag: string | null;
  /** Where `levels` came from. Shown to the user so a documented list is never mistaken for a probed one. */
  source: string;
  /**
   * True when the CLI accepts a level outside `levels` without complaint. Then `levels` is a
   * suggestion, not a constraint, and a value DEV does not know is passed through rather than dropped.
   */
  free: boolean;
}

/** A worker with no reasoning dial. Its runs ignore the setting entirely. */
export const NO_EFFORT: EffortSupport = { levels: [], flag: null, source: "this worker has no reasoning-effort setting", free: false };

/**
 * `claude --help` prints the levels: "Effort level for the current session (low, medium, high,
 * xhigh, max)". Read from the installed CLI, so it is as current as the CLI is.
 */
export const CLAUDE_CODE_EFFORTS: EffortSupport = {
  levels: ["low", "medium", "high", "xhigh", "max"],
  flag: "--effort",
  source: "claude --help (read 2026-09-18)",
  free: false,
};

/**
 * Codex takes the level through config rather than a flag (`--config model_reasoning_effort=".."`).
 * The CLI does not reject an unknown value — a deliberately bogus one was accepted and the run
 * proceeded — so this ladder is documented, not enforced, and `free` says so.
 */
export const CODEX_EFFORTS: EffortSupport = {
  levels: ["minimal", "low", "medium", "high", "xhigh"],
  flag: "--config model_reasoning_effort",
  source: "documented; the Codex CLI accepts any value without validating it",
  free: true,
};

/** `grok --help`: "--reasoning-effort <EFFORT>  Reasoning effort for reasoning models". No enum given. */
export const GROK_EFFORTS: EffortSupport = {
  levels: ["low", "medium", "high"],
  flag: "--reasoning-effort",
  source: "grok --help (read 2026-09-18); the CLI states no enum, so the list is a suggestion",
  free: true,
};

/**
 * OpenCode calls it a model variant, not an effort, and the level is provider-specific:
 * "--variant  model variant (provider-specific reasoning effort, e.g., high, max, minimal)".
 * Note this is `--variant`, not `--reasoning-effort`: OpenCode has no such flag.
 */
export const OPENCODE_EFFORTS: EffortSupport = {
  levels: ["minimal", "low", "medium", "high", "max"],
  flag: "--variant",
  source: "opencode run --help (read 2026-09-18); levels are provider-specific, so the list is a suggestion",
  free: true,
};

/**
 * OpenAI-compatible endpoints take `reasoning_effort` in the request body. Only endpoints flagged
 * `supportsEffort` are offered this: sending the field to a gateway that does not know it fails the
 * whole request, so the default is to send nothing.
 */
export const API_EFFORTS: EffortSupport = {
  levels: ["minimal", "low", "medium", "high"],
  flag: "reasoning_effort",
  source: "OpenAI-compatible chat-completions field; support varies by gateway",
  free: true,
};

/**
 * Narrow a requested level to something this worker will accept. The input is a plain string
 * because it comes from config, where the user may type anything.
 *
 *  * no dial on this worker      -> null, and the caller passes no flag at all
 *  * the worker takes free-form  -> the value unchanged, even one DEV does not recognise
 *  * a level the worker has      -> that level
 *  * "max" on a worker capped at "high" -> "high": the strongest level it does have
 *  * an unrecognised value on a fixed ladder -> null, rather than guessing at what was meant
 */
export function clampEffort(support: EffortSupport, requested: string | null | undefined): string | null {
  if (!requested) return null;
  if (support.levels.length === 0) return null;
  if (support.free) return requested;
  if ((support.levels as readonly string[]).includes(requested)) return requested;
  if (!isReasoningEffort(requested)) return null;
  const wanted = REASONING_EFFORTS.indexOf(requested);
  let best: ReasoningEffort | null = null;
  for (const level of support.levels) {
    if (REASONING_EFFORTS.indexOf(level) <= wanted) best = level;
  }
  return best ?? (support.levels[0] as ReasoningEffort);
}

/**
 * The reasoning level to use when neither the worker config nor the task names one. Derived from
 * the task's size estimate, which is the only signal available — stated here in one place so the
 * fallback is visible and overridable rather than buried in each worker.
 */
export function effortForTaskSize(size: "low" | "medium" | "high"): ReasoningEffort {
  return size;
}

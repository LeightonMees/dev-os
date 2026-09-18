import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { runProcess } from "./execution/process.ts";
import type { VerificationSpec } from "./schemas.ts";

export interface VerificationResult {
  spec: VerificationSpec;
  label: string;
  passed: boolean;
  /** "manual" specs cannot pass automatically; they hand the task to REVIEW. */
  manual: boolean;
  summary: string;
  data: Record<string, unknown>;
  output: string;
  durationMs: number;
}

export function labelOf(spec: VerificationSpec): string {
  if (spec.label) return spec.label;
  if (spec.kind === "command") return spec.command ?? "command";
  if (spec.kind === "file-exists") return `exists: ${spec.path ?? "?"}`;
  return "manual approval";
}

export async function runVerification(
  spec: VerificationSpec,
  cwd: string,
  options: { timeoutMs?: number; signal?: AbortSignal; onOutput?: (chunk: string) => void } = {},
): Promise<VerificationResult> {
  const label = labelOf(spec);
  const started = Date.now();
  if (spec.kind === "manual") {
    return { spec, label, passed: false, manual: true, summary: "Waiting for human review", data: {}, output: "", durationMs: 0 };
  }
  if (spec.kind === "file-exists") {
    const target = spec.path ? (isAbsolute(spec.path) ? spec.path : join(cwd, spec.path)) : "";
    const exists = !!spec.path && existsSync(target);
    return {
      spec,
      label,
      passed: exists,
      manual: false,
      summary: exists ? `File exists: ${spec.path}` : `Missing file: ${spec.path ?? "(no path given)"}`,
      data: { path: target, exists },
      output: "",
      durationMs: Date.now() - started,
    };
  }
  if (!spec.command?.trim()) {
    return { spec, label, passed: false, manual: false, summary: "Verification command is empty", data: {}, output: "", durationMs: 0 };
  }
  const result = await runProcess({
    command: spec.command,
    cwd,
    shell: true,
    timeoutMs: spec.timeoutMs ?? options.timeoutMs ?? 10 * 60 * 1000,
    signal: options.signal,
    onOutput: options.onOutput ? (chunk) => options.onOutput?.(chunk) : undefined,
  });
  const output = `${result.stdout}${result.stderr}`;
  const passed = result.exitCode === 0 && !result.timedOut && !result.cancelled;
  let summary: string;
  if (result.launchError) summary = `Could not start: ${result.launchError}`;
  else if (result.timedOut) summary = `Timed out after ${Math.round(result.durationMs / 1000)}s: ${spec.command}`;
  else if (result.cancelled) summary = `Cancelled: ${spec.command}`;
  else summary = `${passed ? "Passed" : `Failed (exit ${result.exitCode})`}: ${spec.command}`;
  return {
    spec,
    label,
    passed,
    manual: false,
    summary,
    data: { exitCode: result.exitCode, timedOut: result.timedOut, cancelled: result.cancelled, tail: tail(output, 1500) },
    output,
    durationMs: result.durationMs,
  };
}

export function tail(text: string, chars: number): string {
  return text.length <= chars ? text : `…${text.slice(-chars)}`;
}

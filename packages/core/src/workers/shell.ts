import { runProcess } from "../execution/process.ts";
import type { WorkerHealth } from "../schemas.ts";
import { tail } from "../verification.ts";
import { NO_EFFORT } from "./efforts.ts";
import type { Worker, WorkerCapability, WorkerRunRequest, WorkerRunResult } from "./types.ts";

/** Deterministic worker: runs the task's command through the platform shell. */
export class ShellWorker implements Worker {
  readonly id = "shell";
  readonly name = "Shell";
  readonly type = "shell" as const;
  readonly capabilities: readonly WorkerCapability[] = ["shell"];
  readonly configRef = "terminal.shell";
  readonly efforts = NO_EFFORT;
  readonly #shell: string | null;

  constructor(shell: string | null) {
    this.#shell = shell;
  }

  async probe(): Promise<WorkerHealth> {
    const command = this.#shell ?? (process.platform === "win32" ? "cmd.exe" : "/bin/sh");
    const result = await runProcess({ command: process.platform === "win32" ? "cmd.exe" : "/bin/sh", args: process.platform === "win32" ? ["/d", "/c", "echo ok"] : ["-c", "echo ok"], cwd: process.cwd(), timeoutMs: 10_000 });
    return {
      ok: result.exitCode === 0,
      checkedAt: new Date().toISOString(),
      detail: result.exitCode === 0 ? `${command} responds` : `${command} failed: ${result.launchError ?? result.stderr}`,
    };
  }

  async run(request: WorkerRunRequest): Promise<WorkerRunResult> {
    if (!request.command?.trim()) {
      return { ok: false, exitCode: null, timedOut: false, cancelled: false, launchError: "The shell worker needs a task command", summary: "No command to run", commandLine: "", usage: null, durationMs: 0 };
    }
    const result = await runProcess({
      command: request.command,
      cwd: request.cwd,
      shell: true,
      timeoutMs: request.timeoutMs,
      signal: request.signal,
      onOutput: request.onOutput,
    });
    const combined = `${result.stdout}${result.stderr}`.trim();
    return {
      ok: result.exitCode === 0 && !result.timedOut && !result.cancelled && !result.launchError,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      cancelled: result.cancelled,
      launchError: result.launchError,
      summary: tail(combined, 600) || `Command exited ${result.exitCode} with no output`,
      commandLine: request.command,
      usage: null,
      durationMs: result.durationMs,
    };
  }
}

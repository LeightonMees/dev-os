import { launchSpec, probeCommand, runProcess, which } from "../execution/process.ts";
import type { WorkerHealth } from "../schemas.ts";
import { tail } from "../verification.ts";
import { CODEX_EFFORTS, clampEffort } from "./efforts.ts";
import type { Worker, WorkerCapability, WorkerRunRequest, WorkerRunResult } from "./types.ts";

export interface CodexOptions {
  command: string;
  model: string | null;
  /** Reasoning level for every run. null = whatever the run asks for. */
  effort: string | null;
}

/** Headless OpenAI Codex CLI (`codex exec`), prompt on stdin. */
export class CodexWorker implements Worker {
  readonly id = "codex";
  readonly name = "Codex CLI";
  readonly type = "cli-agent" as const;
  readonly capabilities: readonly WorkerCapability[] = ["code", "plan", "review"];
  readonly configRef = "workers.codex";
  readonly efforts = CODEX_EFFORTS;
  readonly #options: CodexOptions;

  constructor(options: CodexOptions) {
    this.#options = options;
  }

  async probe(): Promise<WorkerHealth> {
    const path = which(this.#options.command);
    if (!path) return { ok: false, checkedAt: new Date().toISOString(), detail: `"${this.#options.command}" is not on PATH` };
    const probe = probeCommand(this.#options.command, ["--version"]);
    const version = probe.output.split(/\r?\n/)[0] ?? "";
    return { ok: probe.ok, checkedAt: new Date().toISOString(), detail: probe.ok ? `${version} at ${path}` : `--version failed: ${probe.output}`, version };
  }

  buildArgs(request: Pick<WorkerRunRequest, "reasoningEffort" | "readOnly">): string[] {
    const args = ["exec", "--skip-git-repo-check", "--sandbox", request.readOnly ? "read-only" : "workspace-write"];
    if (this.#options.model) args.push("--model", this.#options.model);
    // Codex takes the level through config, not a flag. No level set means no --config at all, so
    // the user's own ~/.codex/config.toml keeps whatever it says rather than being silently overridden.
    const effort = clampEffort(this.efforts, this.#options.effort ?? request.reasoningEffort);
    if (effort) args.push("--config", `model_reasoning_effort="${effort}"`);
    args.push("-");
    return args;
  }

  async run(request: WorkerRunRequest): Promise<WorkerRunResult> {
    const args = this.buildArgs(request);
    let lastAssistant = "";
    const spec = launchSpec(this.#options.command, args);
    const result = await runProcess({
      command: spec.command,
      args: spec.args,
      cwd: request.cwd,
      stdin: request.prompt,
      timeoutMs: request.timeoutMs,
      signal: request.signal,
      shell: spec.shell,
      onOutput: (chunk, stream) => {
        request.onOutput(chunk, stream);
        if (stream === "stdout") lastAssistant = tail(lastAssistant + chunk, 4000);
      },
    });
    const ok = result.exitCode === 0 && !result.timedOut && !result.cancelled && !result.launchError;
    return {
      ok,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      cancelled: result.cancelled,
      launchError: result.launchError,
      summary: tail(lastAssistant.trim() || result.stderr.trim() || `exit ${result.exitCode}`, 2000),
      commandLine: `${this.#options.command} ${args.join(" ")}`,
      usage: null,
      durationMs: result.durationMs,
    };
  }
}

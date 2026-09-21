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
    // --json: one event per line, so the final message, errors and token usage
    // are read from what Codex says rather than guessed from a text tail.
    const args = ["exec", "--skip-git-repo-check", "--json", "--sandbox", request.readOnly ? "read-only" : "workspace-write"];
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
    const parser = new CodexEventParser(request);
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
        if (stream === "stdout") parser.feed(chunk);
        else request.onOutput(chunk, stream);
      },
    });
    parser.flush();
    // A turn Codex itself reports as failed is a failure whatever the exit code says.
    const ok = result.exitCode === 0 && !result.timedOut && !result.cancelled && !result.launchError && !parser.failed;
    const summary = parser.failed && parser.error ? parser.error : parser.finalText.trim() || result.stderr.trim() || `exit ${result.exitCode}`;
    return {
      ok,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      cancelled: result.cancelled,
      launchError: result.launchError,
      summary: tail(summary, 2000),
      commandLine: `${this.#options.command} ${args.join(" ")}`,
      usage: parser.usage,
      durationMs: result.durationMs,
    };
  }
}

/**
 * Parses `codex exec --json` events: the agent's messages become readable
 * output and the final text; commands it ran are shown as such; an error item
 * or a failed turn marks the run failed with Codex's own message; usage comes
 * from the completed turn. Anything that is not JSON is passed through as is.
 */
export class CodexEventParser {
  finalText = "";
  error: string | null = null;
  failed = false;
  usage: Record<string, unknown> | null = null;
  #buffer = "";
  readonly #request: Pick<WorkerRunRequest, "onOutput" | "onEvent">;

  constructor(request: Pick<WorkerRunRequest, "onOutput" | "onEvent">) {
    this.#request = request;
  }

  feed(chunk: string): void {
    this.#buffer += chunk;
    let index: number;
    while ((index = this.#buffer.indexOf("\n")) >= 0) {
      const line = this.#buffer.slice(0, index).trim();
      this.#buffer = this.#buffer.slice(index + 1);
      if (line) this.#line(line);
    }
  }

  flush(): void {
    const line = this.#buffer.trim();
    this.#buffer = "";
    if (line) this.#line(line);
  }

  #line(line: string): void {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.#request.onOutput(line + "\n", "stdout");
      return;
    }
    const type = String(parsed.type ?? "");
    if (type === "item.completed" || type === "item.started") {
      const item = (parsed.item ?? {}) as Record<string, unknown>;
      const kind = String(item.type ?? "");
      if (type === "item.completed" && kind === "agent_message" && typeof item.text === "string") {
        this.finalText = item.text;
        this.#request.onOutput(item.text + "\n", "stdout");
        this.#request.onEvent?.({ kind: "assistant", text: item.text });
      } else if (kind === "command_execution" && typeof item.command === "string") {
        if (type === "item.started") {
          this.#request.onOutput(`→ ${item.command}\n`, "stdout");
          this.#request.onEvent?.({ kind: "tool", text: item.command, raw: item });
        } else if (typeof item.aggregated_output === "string" && item.aggregated_output.trim()) {
          this.#request.onOutput(tail(item.aggregated_output, 4000), "stdout");
        }
      } else if (type === "item.completed" && kind === "error" && typeof item.message === "string") {
        // Codex reports configuration and account problems as error items; the
        // turn may still fail afterwards, and that message is the one to keep.
        this.error = item.message;
        this.#request.onOutput(`! ${item.message}\n`, "stderr");
      } else if (type === "item.completed" && kind === "reasoning" && typeof item.text === "string") {
        this.#request.onOutput(`… ${tail(item.text, 400)}\n`, "stdout");
      }
    } else if (type === "turn.completed") {
      const usage = parsed.usage as Record<string, unknown> | undefined;
      if (usage) this.usage = usage;
    } else if (type === "turn.failed" || type === "error") {
      this.failed = true;
      const error = (parsed.error as Record<string, unknown> | undefined)?.message ?? parsed.message;
      const message = typeof error === "string" ? unwrapApiError(error) : "Codex reported a failed turn";
      this.error = message;
      this.#request.onOutput(`! ${message}\n`, "stderr");
    }
  }
}

/** Codex wraps API errors as JSON text inside the message; say the message, not the envelope. */
function unwrapApiError(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string }; message?: string };
    return parsed.error?.message ?? parsed.message ?? text;
  } catch {
    return text;
  }
}

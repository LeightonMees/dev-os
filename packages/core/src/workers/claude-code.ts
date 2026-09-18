import { launchSpec, probeCommand, runProcess, which } from "../execution/process.ts";
import type { WorkerHealth } from "../schemas.ts";
import { tail } from "../verification.ts";
import { CLAUDE_CODE_EFFORTS, clampEffort } from "./efforts.ts";
import type { Worker, WorkerCapability, WorkerRunRequest, WorkerRunResult } from "./types.ts";

export interface ClaudeCodeOptions {
  command: string;
  model: string | null;
  effort: string | null;
  permissionMode: string;
}

/**
 * Headless Claude Code. The prompt goes in on stdin; `stream-json` comes out,
 * one JSON object per line, which gives us live tool activity, the final
 * assistant text and token usage without scraping terminal output.
 */
export class ClaudeCodeWorker implements Worker {
  readonly id = "claude-code";
  readonly name = "Claude Code";
  readonly type = "cli-agent" as const;
  readonly capabilities: readonly WorkerCapability[] = ["code", "plan", "review", "research"];
  readonly configRef = "workers.claudeCode";
  readonly efforts = CLAUDE_CODE_EFFORTS;
  readonly #options: ClaudeCodeOptions;

  constructor(options: ClaudeCodeOptions) {
    this.#options = options;
  }

  async probe(): Promise<WorkerHealth> {
    const path = which(this.#options.command);
    if (!path) {
      return { ok: false, checkedAt: new Date().toISOString(), detail: `"${this.#options.command}" is not on PATH` };
    }
    const probe = probeCommand(this.#options.command, ["--version"]);
    const version = probe.output.split(/\r?\n/)[0] ?? "";
    return { ok: probe.ok, checkedAt: new Date().toISOString(), detail: probe.ok ? `${version} at ${path}` : `--version failed: ${probe.output}`, version };
  }

  buildArgs(request: Pick<WorkerRunRequest, "reasoningEffort" | "readOnly">): string[] {
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--no-chrome"];
    if (request.readOnly) args.push("--allowedTools", "Read", "Glob", "Grep");
    else args.push("--permission-mode", this.#options.permissionMode);
    if (this.#options.model) args.push("--model", this.#options.model);
    // The worker's own configured level wins; otherwise whatever the run asked for. Either way it
    // is narrowed to a level this CLI actually accepts rather than passed through blind.
    const effort = clampEffort(this.efforts, this.#options.effort ?? request.reasoningEffort);
    if (effort) args.push("--effort", effort);
    return args;
  }

  async run(request: WorkerRunRequest): Promise<WorkerRunResult> {
    const args = this.buildArgs(request);
    const parser = new StreamJsonParser(request);
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
        else request.onOutput(chunk, "stderr");
      },
    });
    parser.flush();
    const ok = result.exitCode === 0 && !result.timedOut && !result.cancelled && !result.launchError && !parser.isError;
    const summary = parser.finalText || tail(`${result.stderr}`.trim(), 600) || `exit ${result.exitCode}`;
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

/** Parses Claude Code stream-json lines into readable output and structured events. */
export class StreamJsonParser {
  finalText = "";
  usage: Record<string, unknown> | null = null;
  isError = false;
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
    if (type === "assistant") {
      const message = parsed.message as { content?: unknown[] } | undefined;
      for (const block of message?.content ?? []) {
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") {
          this.#request.onOutput(b.text + "\n", "stdout");
          this.#request.onEvent?.({ kind: "assistant", text: b.text });
        } else if (b.type === "tool_use") {
          const input = b.input as Record<string, unknown> | undefined;
          const hint = summariseToolInput(String(b.name ?? "tool"), input);
          this.#request.onOutput(`→ ${b.name} ${hint}\n`, "stdout");
          this.#request.onEvent?.({ kind: "tool", text: `${b.name} ${hint}`, raw: input });
        }
      }
    } else if (type === "result") {
      if (typeof parsed.result === "string") this.finalText = parsed.result;
      this.isError = parsed.is_error === true || String(parsed.subtype ?? "").startsWith("error");
      const usage: Record<string, unknown> = {};
      if (parsed.usage && typeof parsed.usage === "object") Object.assign(usage, parsed.usage as Record<string, unknown>);
      if (typeof parsed.total_cost_usd === "number") usage.total_cost_usd = parsed.total_cost_usd;
      if (typeof parsed.duration_ms === "number") usage.duration_ms = parsed.duration_ms;
      if (typeof parsed.num_turns === "number") usage.num_turns = parsed.num_turns;
      this.usage = Object.keys(usage).length ? usage : null;
      this.#request.onEvent?.({ kind: "result", text: this.finalText, raw: parsed });
      if (this.isError && this.finalText) this.#request.onOutput(this.finalText + "\n", "stderr");
    } else if (type === "system") {
      const model = parsed.model ? ` model=${String(parsed.model)}` : "";
      this.#request.onEvent?.({ kind: "system", text: `session${model}`, raw: parsed });
    }
  }
}

function summariseToolInput(name: string, input: Record<string, unknown> | undefined): string {
  if (!input) return "";
  const candidate = input.file_path ?? input.path ?? input.command ?? input.pattern ?? input.query ?? input.description ?? "";
  const text = String(candidate);
  return text.length > 120 ? text.slice(0, 117) + "…" : text;
}

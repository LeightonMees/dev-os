import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { launchSpec, probeCommand, runProcess, which } from "../execution/process.ts";
import type { WorkerHealth } from "../schemas.ts";
import { tail } from "../verification.ts";
import { GROK_EFFORTS, OPENCODE_EFFORTS, clampEffort } from "./efforts.ts";
import type { Worker, WorkerCapability, WorkerRunRequest, WorkerRunResult } from "./types.ts";

function versionProbe(command: string): WorkerHealth {
  const path = which(command);
  if (!path) return { ok: false, checkedAt: new Date().toISOString(), detail: `"${command}" is not on PATH` };
  const probe = probeCommand(command, ["--version"]);
  const version = probe.output.split(/\r?\n/)[0] ?? "";
  return { ok: probe.ok, checkedAt: new Date().toISOString(), detail: probe.ok ? `${version} at ${path}` : `--version failed: ${probe.output}`, version };
}

/** Write the brief to a file the agent can read; long prompts do not fit in Windows argv. */
function briefFile(dir: string, taskId: string, prompt: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `brief-${taskId}-${Date.now()}.md`);
  writeFileSync(path, prompt);
  return path;
}

export interface GrokOptions {
  command: string;
  model: string | null;
  /** Reasoning level for every run. null = whatever the run asks for. */
  effort: string | null;
  permissionMode: string;
  /** Where brief files are written (DEV home logs directory). */
  briefDir: string;
}

/**
 * xAI's Grok Build CLI in headless single-turn mode. Streams NDJSON
 * (`--output-format streaming-json`); the brief goes through `--prompt-file`.
 */
export class GrokWorker implements Worker {
  readonly id = "grok";
  readonly name = "Grok";
  readonly type = "cli-agent" as const;
  readonly capabilities: readonly WorkerCapability[] = ["code", "plan", "review", "research"];
  readonly configRef = "workers.grok";
  readonly efforts = GROK_EFFORTS;
  readonly #options: GrokOptions;

  constructor(options: GrokOptions) {
    this.#options = options;
  }

  async probe(): Promise<WorkerHealth> {
    return versionProbe(this.#options.command);
  }

  buildArgs(promptFile: string, request: Pick<WorkerRunRequest, "reasoningEffort" | "readOnly" | "cwd">): string[] {
    const args = ["--prompt-file", promptFile, "--output-format", "streaming-json", "--cwd", request.cwd, "--no-subagents"];
    args.push("--permission-mode", request.readOnly ? "plan" : this.#options.permissionMode);
    if (this.#options.model) args.push("--model", this.#options.model);
    const effort = clampEffort(this.efforts, this.#options.effort ?? request.reasoningEffort);
    if (effort) args.push("--reasoning-effort", effort);
    return args;
  }

  async run(request: WorkerRunRequest): Promise<WorkerRunResult> {
    const file = briefFile(this.#options.briefDir, request.taskId, request.prompt);
    const args = this.buildArgs(file, request);
    const spec = launchSpec(this.#options.command, args);
    let finalText = "";
    let buffer = "";
    const line = (raw: string) => {
      const text = raw.trim();
      if (!text) return;
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        const update = (parsed.update ?? parsed) as Record<string, unknown>;
        const kind = String(update.sessionUpdate ?? parsed.type ?? "");
        const content = update.content as { type?: string; text?: string } | undefined;
        if (kind === "agent_message_chunk" && content?.text) {
          finalText += content.text;
          request.onOutput(content.text, "stdout");
        } else if (kind === "tool_call" || kind === "tool_call_update") {
          const title = String(update.title ?? update.kind ?? "tool");
          if (kind === "tool_call") {
            request.onOutput(`→ ${title}\n`, "stdout");
            request.onEvent?.({ kind: "tool", text: title, raw: update });
          }
        } else if (typeof parsed.result === "string") {
          finalText = parsed.result;
        } else {
          request.onOutput(text + "\n", "stdout");
        }
      } catch {
        request.onOutput(raw + "\n", "stdout");
      }
    };
    const result = await runProcess({
      command: spec.command,
      args: spec.args,
      cwd: request.cwd,
      timeoutMs: request.timeoutMs,
      signal: request.signal,
      shell: spec.shell,
      onOutput: (chunk, stream) => {
        if (stream === "stderr") {
          request.onOutput(chunk, "stderr");
          return;
        }
        buffer += chunk;
        let i: number;
        while ((i = buffer.indexOf("\n")) >= 0) {
          line(buffer.slice(0, i));
          buffer = buffer.slice(i + 1);
        }
      },
    });
    if (buffer.trim()) line(buffer);
    const ok = result.exitCode === 0 && !result.timedOut && !result.cancelled && !result.launchError;
    return { ok, exitCode: result.exitCode, timedOut: result.timedOut, cancelled: result.cancelled, launchError: result.launchError, summary: tail(finalText.trim() || result.stderr.trim() || `exit ${result.exitCode}`, 2000), commandLine: `${this.#options.command} ${args.join(" ")}`, usage: null, durationMs: result.durationMs };
  }
}

export interface OpenCodeOptions {
  command: string;
  model: string | null;
  /**
   * OpenCode's name for the reasoning dial is a model variant, and it is provider-specific.
   * null = whatever the run asks for.
   */
  effort: string | null;
  briefDir: string;
}

/** OpenCode (`opencode run`), pointed at a brief file because its message is a positional argument. */
export class OpenCodeWorker implements Worker {
  readonly id = "opencode";
  readonly name = "OpenCode";
  readonly type = "cli-agent" as const;
  readonly capabilities: readonly WorkerCapability[] = ["code", "plan", "review"];
  readonly configRef = "workers.opencode";
  readonly efforts = OPENCODE_EFFORTS;
  readonly #options: OpenCodeOptions;

  constructor(options: OpenCodeOptions) {
    this.#options = options;
  }

  async probe(): Promise<WorkerHealth> {
    return versionProbe(this.#options.command);
  }

  buildArgs(promptFile: string, request: Pick<WorkerRunRequest, "cwd" | "readOnly" | "reasoningEffort">): string[] {
    const args = ["run", "--format", "json", "--dir", request.cwd];
    if (this.#options.model) args.push("--model", this.#options.model);
    // OpenCode spells this `--variant`; it has no --reasoning-effort flag, and passing one is an error.
    const effort = clampEffort(this.efforts, this.#options.effort ?? request.reasoningEffort);
    if (effort) args.push("--variant", effort);
    if (!request.readOnly) args.push("--auto");
    args.push(`Read the task brief at ${promptFile} and carry it out completely in this directory. ${request.readOnly ? "Do not modify any file." : ""} Finish with a concise summary.`);
    return args;
  }

  async run(request: WorkerRunRequest): Promise<WorkerRunResult> {
    const file = briefFile(this.#options.briefDir, request.taskId, request.prompt);
    const args = this.buildArgs(file, request);
    const spec = launchSpec(this.#options.command, args);
    let text = "";
    const result = await runProcess({
      command: spec.command,
      args: spec.args,
      cwd: request.cwd,
      timeoutMs: request.timeoutMs,
      signal: request.signal,
      shell: spec.shell,
      onOutput: (chunk, stream) => {
        if (stream === "stdout") {
          for (const raw of chunk.split(/\r?\n/)) {
            const line = raw.trim();
            if (!line) continue;
            try {
              const parsed = JSON.parse(line) as { type?: string; part?: { type?: string; text?: string; tool?: string } };
              const part = parsed.part;
              if (part?.type === "text" && part.text) {
                text += part.text;
                request.onOutput(part.text, "stdout");
              } else if (part?.type === "tool" && part.tool) {
                request.onOutput(`→ ${part.tool}\n`, "stdout");
                request.onEvent?.({ kind: "tool", text: part.tool, raw: part });
              }
            } catch {
              request.onOutput(line + "\n", "stdout");
              text += line + "\n";
            }
          }
        } else request.onOutput(chunk, "stderr");
      },
    });
    const ok = result.exitCode === 0 && !result.timedOut && !result.cancelled && !result.launchError;
    return { ok, exitCode: result.exitCode, timedOut: result.timedOut, cancelled: result.cancelled, launchError: result.launchError, summary: tail(text.trim() || result.stderr.trim() || `exit ${result.exitCode}`, 2000), commandLine: `${this.#options.command} ${args.join(" ")}`, usage: null, durationMs: result.durationMs };
  }
}

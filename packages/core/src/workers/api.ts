import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { runProcess } from "../execution/process.ts";
import { chatCompletion, parseToolArguments, probeModels, type ChatMessage, type ToolDefinition } from "../llm/openai.ts";
import type { WorkerHealth } from "../schemas.ts";
import { hasSecret } from "../secrets.ts";
import { tail } from "../verification.ts";
import { API_EFFORTS, NO_EFFORT, clampEffort } from "./efforts.ts";
import type { Worker, WorkerCapability, WorkerRunRequest, WorkerRunResult } from "./types.ts";

export interface ApiProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  /** Environment variable holding the key (loaded from Nexus secrets.env). Empty = no key needed. */
  keyEnv: string;
  enabled: boolean;
  /** Human note shown in the Workers view (free tier limits, etc). */
  note?: string;
  /** Extra headers some gateways want (OpenRouter's referer, for example). */
  headers?: Record<string, string>;
  /**
   * OpenAI-compatible `reasoning_effort`. null = do not send the field, which is the safe default:
   * a gateway that does not support it rejects the request outright.
   */
  effort?: string | null;
  /** True when this endpoint is known to accept `reasoning_effort`. Off means no effort control is offered. */
  supportsEffort?: boolean;
}

const TOOLS: ToolDefinition[] = [
  { type: "function", function: { name: "list_files", description: "List files and directories under a path relative to the project root (default: root). Skips node_modules, .git and build output.", parameters: { type: "object", properties: { path: { type: "string" } } } } },
  { type: "function", function: { name: "read_file", description: "Read a text file relative to the project root.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: { name: "write_file", description: "Create or overwrite a text file relative to the project root with the given content.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } } },
  { type: "function", function: { name: "run_command", description: "Run a shell command in the project root (tests, build, git status). Returns exit code and the tail of the output. 2 minute limit.", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } },
  { type: "function", function: { name: "done", description: "Call exactly once when the task is complete, with a concise summary (max 12 lines): what changed, which files, how it was verified.", parameters: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] } } },
];

const IGNORED = new Set(["node_modules", ".git", "dist", "build", "target", ".dev-home", "coverage", "__pycache__", ".venv"]);

/**
 * An OpenAI-compatible API model turned into a coding worker: a bounded tool
 * loop over the project directory (list, read, write, run) until it calls
 * `done`. Free-tier gateways (Groq, Cerebras, OpenRouter, GitHub Models,
 * Gemini) and any paid endpoint use the same code; which ones exist is config.
 */
export class ApiWorker implements Worker {
  readonly id: string;
  readonly name: string;
  readonly type = "remote-model" as const;
  readonly capabilities: readonly WorkerCapability[] = ["code", "plan", "review", "summarize", "research"];
  readonly configRef: string;
  readonly efforts: typeof API_EFFORTS | typeof NO_EFFORT;
  readonly provider: ApiProviderConfig;

  constructor(provider: ApiProviderConfig) {
    this.provider = provider;
    this.id = provider.id;
    this.name = provider.name;
    this.configRef = `workers.api.providers[${provider.id}]`;
    // Only endpoints flagged as supporting the field get a dial; the rest show none, rather than a
    // control whose value would break every request.
    this.efforts = provider.supportsEffort ? API_EFFORTS : NO_EFFORT;
  }

  get apiKey(): string | null {
    return this.provider.keyEnv ? (process.env[this.provider.keyEnv] ?? null) : null;
  }

  async probe(): Promise<WorkerHealth> {
    const checkedAt = new Date().toISOString();
    if (!this.provider.enabled) return { ok: false, checkedAt, detail: "disabled in config" };
    if (this.provider.keyEnv && !hasSecret(this.provider.keyEnv)) {
      return { ok: false, checkedAt, detail: `${this.provider.keyEnv} is not set (add it to Nexus secrets.env)` };
    }
    const probe = await probeModels(this.provider.baseUrl, this.apiKey);
    return { ok: probe.ok, checkedAt, detail: `${probe.detail}; model ${this.provider.model}${this.provider.note ? `; ${this.provider.note}` : ""}`, version: this.provider.model };
  }

  /** Plain completion for planning and summaries. */
  async generate(prompt: string, options: { system?: string; timeoutMs?: number; signal?: AbortSignal; maxTokens?: number } = {}): Promise<string> {
    const messages: ChatMessage[] = [];
    if (options.system) messages.push({ role: "system", content: options.system });
    messages.push({ role: "user", content: prompt });
    const result = await chatCompletion({ baseUrl: this.provider.baseUrl, apiKey: this.apiKey, model: this.provider.model, messages, timeoutMs: options.timeoutMs, signal: options.signal, maxTokens: options.maxTokens, extraHeaders: this.provider.headers });
    return (result.message.content ?? "").trim();
  }

  async run(request: WorkerRunRequest): Promise<WorkerRunResult> {
    const started = Date.now();
    const root = resolve(request.cwd);
    const usage = { prompt_tokens: 0, completion_tokens: 0, turns: 0, tool_calls: 0 };
    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: request.readOnly ? `${request.prompt}\n\n(Read-only: do not call write_file or run commands that modify files.)` : request.prompt },
    ];
    const say = (line: string) => request.onOutput(line + "\n", "stdout");
    let summary = "";
    let finished = false;
    try {
      for (let turn = 0; turn < 40 && !finished; turn++) {
        if (request.signal.aborted) return this.result(false, null, started, "cancelled", usage, { cancelled: true });
        usage.turns++;
        const result = await chatCompletion({ baseUrl: this.provider.baseUrl, apiKey: this.apiKey, model: this.provider.model, messages, tools: TOOLS, timeoutMs: 180_000, signal: request.signal, extraHeaders: this.provider.headers, reasoningEffort: clampEffort(this.efforts, this.provider.effort ?? request.reasoningEffort) });
        usage.prompt_tokens += result.usage?.prompt_tokens ?? 0;
        usage.completion_tokens += result.usage?.completion_tokens ?? 0;
        const message = result.message;
        messages.push({ role: "assistant", content: message.content ?? null, tool_calls: message.tool_calls });
        if (message.content?.trim()) {
          say(message.content.trim());
          request.onEvent?.({ kind: "assistant", text: message.content });
        }
        const calls = message.tool_calls ?? [];
        if (calls.length === 0) {
          summary = message.content?.trim() ?? "";
          finished = true;
          break;
        }
        for (const call of calls) {
          usage.tool_calls++;
          const args = parseToolArguments(call);
          const name = call.function.name;
          let output: string;
          if (name === "done") {
            summary = String(args.summary ?? "").trim() || "done";
            finished = true;
            output = "ok";
          } else if (request.readOnly && (name === "write_file" || name === "run_command")) {
            output = "refused: read-only run";
          } else {
            output = await this.tool(name, args, root, request);
          }
          const hint = String(args.path ?? args.command ?? "").slice(0, 100);
          say(`→ ${name} ${hint}`);
          request.onEvent?.({ kind: "tool", text: `${name} ${hint}`, raw: args });
          messages.push({ role: "tool", tool_call_id: call.id, name, content: tail(output, 12_000) });
        }
      }
      if (!finished) summary = tail(summary || "Stopped after 40 turns without calling done.", 2000);
      return this.result(finished, 0, started, summary, usage, {});
    } catch (error) {
      const cancelled = request.signal.aborted;
      return this.result(false, null, started, (error as Error).message, usage, { cancelled, launchError: cancelled ? null : (error as Error).message });
    }
  }

  private result(ok: boolean, exitCode: number | null, started: number, summary: string, usage: Record<string, number>, flags: { cancelled?: boolean; launchError?: string | null }): WorkerRunResult {
    return { ok, exitCode: ok ? 0 : exitCode, timedOut: false, cancelled: flags.cancelled ?? false, launchError: flags.launchError ?? null, summary: tail(summary, 2000), commandLine: `${this.provider.baseUrl} ${this.provider.model}`, usage, durationMs: Date.now() - started };
  }

  private async tool(name: string, args: Record<string, unknown>, root: string, request: WorkerRunRequest): Promise<string> {
    const safePath = (p: unknown): string => {
      const rel = String(p ?? "").trim() || ".";
      const full = resolve(root, rel);
      if (isAbsolute(rel) || relative(root, full).startsWith("..")) throw new Error(`path ${rel} is outside the project`);
      return full;
    };
    try {
      switch (name) {
        case "list_files": {
          const dir = safePath(args.path);
          if (!existsSync(dir)) return `not found: ${args.path}`;
          const out: string[] = [];
          const walk = (d: string, depth: number) => {
            if (out.length > 300 || depth > 3) return;
            for (const entry of readdirSync(d).sort()) {
              if (IGNORED.has(entry) || entry.startsWith(".")) continue;
              const full = join(d, entry);
              const isDir = statSync(full).isDirectory();
              out.push(relative(root, full).replace(/\\/g, "/") + (isDir ? "/" : ""));
              if (isDir) walk(full, depth + 1);
            }
          };
          walk(dir, 0);
          return out.join("\n") || "(empty)";
        }
        case "read_file": {
          const file = safePath(args.path);
          if (!existsSync(file)) return `not found: ${args.path}`;
          return tail(readFileSync(file, "utf8"), 40_000);
        }
        case "write_file": {
          const file = safePath(args.path);
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, String(args.content ?? ""));
          return `wrote ${relative(root, file)} (${String(args.content ?? "").length} chars)`;
        }
        case "run_command": {
          const command = String(args.command ?? "").trim();
          if (!command) return "no command";
          const result = await runProcess({ command, cwd: root, shell: true, timeoutMs: 120_000, signal: request.signal, onOutput: (chunk) => request.onOutput(chunk, "stdout") });
          return `exit ${result.exitCode}${result.timedOut ? " (timed out)" : ""}\n${tail(`${result.stdout}${result.stderr}`, 8000)}`;
        }
        default:
          return `unknown tool ${name}`;
      }
    } catch (error) {
      return `error: ${(error as Error).message}`;
    }
  }
}

const SYSTEM_PROMPT = [
  "You are a coding worker inside DEV, a development operating system. You work in one project directory through tools:",
  "list_files, read_file, write_file, run_command, done.",
  "Read before you write. Make the smallest change that satisfies the task. Run the verification you are given.",
  "When finished call done(summary) with a concise summary: what changed, which files, how it was verified, anything the next task must know.",
  "Never call done before the change exists on disk.",
].join("\n");

/** Providers DEV knows how to reach. Keys come from Nexus secrets.env; nothing runs without one. */
export const DEFAULT_API_PROVIDERS: ApiProviderConfig[] = [
  { id: "groq", name: "Groq", baseUrl: "https://api.groq.com/openai/v1", model: "openai/gpt-oss-120b", keyEnv: "GROQ_API_KEY", enabled: true, note: "free tier" },
  { id: "cerebras", name: "Cerebras", baseUrl: "https://api.cerebras.ai/v1", model: "gpt-oss-120b", keyEnv: "CEREBRAS_API_KEY", enabled: true, note: "free tier, 1M tokens/day" },
  { id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-oss-20b:free", keyEnv: "OPENROUTER_API_KEY", enabled: true, note: "free models only (:free)", headers: { "HTTP-Referer": "https://github.com/dev-local", "X-Title": "DEV" } },
  { id: "github-models", name: "GitHub Models", baseUrl: "https://models.github.ai/inference", model: "openai/gpt-4o-mini", keyEnv: "GITHUB_TOKEN", enabled: true, note: "free with a GitHub token that has models:read" },
  { id: "gemini", name: "Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-2.5-flash", keyEnv: "GEMINI_API_KEY", enabled: true, note: "AI Studio free tier" },
  { id: "nvidia", name: "NVIDIA NIM", baseUrl: "https://integrate.api.nvidia.com/v1", model: "openai/gpt-oss-20b", keyEnv: "NVIDIA_API_KEY", enabled: true, note: "free developer tier" },
  { id: "mistral", name: "Mistral", baseUrl: "https://api.mistral.ai/v1", model: "codestral-latest", keyEnv: "MISTRAL_API_KEY", enabled: true, note: "free tier: Codestral and small models" },
  { id: "zai", name: "Z.ai", baseUrl: "https://api.z.ai/api/paas/v4", model: "glm-4.5-flash", keyEnv: "ZAI_API_KEY", enabled: true, note: "free flash model" },
  { id: "anthropic", name: "Anthropic", baseUrl: "https://api.anthropic.com/v1", model: "claude-opus-5", keyEnv: "ANTHROPIC_API_KEY", enabled: false, note: "paid; Claude over Anthropic's OpenAI-compatible endpoint" },
  { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini", keyEnv: "OPENAI_API_KEY", enabled: false, note: "paid; enable deliberately" },
];

import type { WorkerHealth } from "../schemas.ts";
import { tail } from "../verification.ts";
import { NO_EFFORT } from "./efforts.ts";
import type { Worker, WorkerCapability, WorkerRunRequest, WorkerRunResult } from "./types.ts";

export interface OllamaOptions {
  baseUrl: string;
  model: string;
}

/**
 * Local model over the Ollama HTTP API. It cannot edit files, so it is a text
 * worker: summaries, plan drafts, reviews. Small jobs stay local and free.
 */
export class OllamaWorker implements Worker {
  readonly id = "ollama";
  readonly name = "Ollama (local)";
  readonly type = "local-model" as const;
  readonly capabilities: readonly WorkerCapability[] = ["summarize", "plan", "review"];
  readonly configRef = "workers.ollama";
  readonly efforts = NO_EFFORT;
  readonly #options: OllamaOptions;

  constructor(options: OllamaOptions) {
    this.#options = options;
  }

  get model(): string {
    return this.#options.model;
  }

  async probe(): Promise<WorkerHealth> {
    const checkedAt = new Date().toISOString();
    try {
      const response = await fetch(`${this.#options.baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) return { ok: false, checkedAt, detail: `Ollama responded ${response.status}` };
      const body = (await response.json()) as { models?: { name: string }[] };
      const names = (body.models ?? []).map((m) => m.name);
      const has = names.includes(this.#options.model);
      return {
        ok: has,
        checkedAt,
        detail: has ? `${this.#options.model} available (${names.length} models installed)` : `model ${this.#options.model} is not installed; have: ${names.slice(0, 6).join(", ")}`,
        version: this.#options.model,
      };
    } catch (error) {
      return { ok: false, checkedAt, detail: `Ollama not reachable at ${this.#options.baseUrl}: ${(error as Error).message}` };
    }
  }

  /** Plain completion helper used by the summariser and the planner. */
  async generate(prompt: string, options: { system?: string; timeoutMs?: number; signal?: AbortSignal; maxTokens?: number } = {}): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 120_000);
    options.signal?.addEventListener("abort", () => controller.abort(), { once: true });
    try {
      const response = await fetch(`${this.#options.baseUrl}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: this.#options.model, prompt, system: options.system, stream: false, options: { num_predict: options.maxTokens ?? 800, temperature: 0.2 } }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Ollama responded ${response.status}: ${await response.text()}`);
      const body = (await response.json()) as { response?: string };
      return (body.response ?? "").trim();
    } finally {
      clearTimeout(timer);
    }
  }

  async run(request: WorkerRunRequest): Promise<WorkerRunResult> {
    const started = Date.now();
    try {
      const text = await this.generate(request.prompt, { timeoutMs: request.timeoutMs, signal: request.signal, maxTokens: 1500 });
      request.onOutput(text + "\n", "stdout");
      return { ok: true, exitCode: 0, timedOut: false, cancelled: false, launchError: null, summary: tail(text, 2000), commandLine: `ollama:${this.#options.model}`, usage: null, durationMs: Date.now() - started };
    } catch (error) {
      const cancelled = request.signal.aborted;
      return { ok: false, exitCode: null, timedOut: !cancelled && (error as Error).name === "AbortError", cancelled, launchError: (error as Error).message, summary: (error as Error).message, commandLine: `ollama:${this.#options.model}`, usage: null, durationMs: Date.now() - started };
    }
  }
}

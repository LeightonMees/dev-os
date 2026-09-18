// What models each CLI worker can be given. Discovered from the tool itself wherever the tool can
// say: Codex keeps a model cache, Grok and OpenCode each have a `models` command, Ollama lists what
// is pulled. Claude Code has no such command, so its list is documented and labelled that way.
// Nothing here guesses: every entry carries the source it came from.
import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { DevConfig } from "@dev/core";

const run = promisify(execFile);

export interface ModelOption {
  id: string;
  label: string;
  note?: string;
}

export interface WorkerModels {
  models: ModelOption[];
  /** Where this list came from, shown to the user so a stale or documented list is obvious. */
  source: string;
  detail: string | null;
  /** True when a model outside the list is still accepted (every CLI here takes a free-form id). */
  free: boolean;
}

/**
 * Claude Code takes an alias for the latest model in a family or a full model id (`claude --help`).
 * There is no command that lists them, so this is a documented list, current as of 2026-06.
 */
const CLAUDE_CODE: ModelOption[] = [
  { id: "fable", label: "fable", note: "alias · latest Fable" },
  { id: "opus", label: "opus", note: "alias · latest Opus" },
  { id: "sonnet", label: "sonnet", note: "alias · latest Sonnet" },
  { id: "haiku", label: "haiku", note: "alias · latest Haiku" },
  { id: "claude-fable-5-1", label: "claude-fable-5-1", note: "most capable" },
  { id: "claude-fable-5", label: "claude-fable-5" },
  { id: "claude-opus-5", label: "claude-opus-5" },
  { id: "claude-opus-4-8", label: "claude-opus-4-8" },
  { id: "claude-opus-4-7", label: "claude-opus-4-7" },
  { id: "claude-opus-4-6", label: "claude-opus-4-6" },
  { id: "claude-sonnet-5", label: "claude-sonnet-5" },
  { id: "claude-sonnet-4-6", label: "claude-sonnet-4-6" },
  { id: "claude-haiku-4-5", label: "claude-haiku-4-5", note: "cheapest" },
];

async function cli(command: string, args: string[], timeoutMs = 20_000): Promise<string> {
  const { stdout } = await run(command, args, { timeout: timeoutMs, windowsHide: true, shell: process.platform === "win32" });
  return stdout;
}

/**
 * The reasoning level a worker is currently configured with, so the UI can show the dial's real
 * position rather than an empty control. null means "not set": the level is decided per task.
 */
export function currentEffort(config: DevConfig, id: string): string | null {
  const workers = config.workers as unknown as Record<string, { effort?: string | null } | undefined>;
  if (id === "claude-code") return workers.claudeCode?.effort ?? null;
  const direct = workers[id];
  if (direct && typeof direct === "object" && "effort" in direct) return direct.effort ?? null;
  return config.workers.api.providers.find((p) => p.id === id)?.effort ?? null;
}

export async function workerModels(id: string, config: DevConfig): Promise<WorkerModels> {
  if (id === "claude-code") {
    return { models: CLAUDE_CODE, source: "documented (Claude Code has no list command; `claude --model` takes an alias or a full id)", detail: null, free: true };
  }

  if (id === "codex") {
    // Codex caches the model list it was served; read it rather than asking the network.
    const cache = join(homedir(), ".codex", "models_cache.json");
    if (!existsSync(cache)) return { models: [], source: "Codex model cache", detail: `${cache} not found; run codex once to populate it`, free: true };
    try {
      const body = JSON.parse(readFileSync(cache, "utf8")) as { models?: { id?: string; slug?: string; display_name?: string; description?: string }[]; fetched_at?: string };
      const models = (body.models ?? [])
        .map((m) => ({ id: String(m.id ?? m.slug ?? ""), label: String(m.display_name ?? m.id ?? m.slug ?? ""), note: m.description ?? undefined }))
        .filter((m) => m.id && !/auto-review/i.test(m.id));
      const when = body.fetched_at ? new Date(body.fetched_at).toISOString().slice(0, 10) : new Date(statSync(cache).mtime).toISOString().slice(0, 10);
      return { models, source: `Codex model cache (fetched ${when})`, detail: null, free: true };
    } catch (error) {
      return { models: [], source: "Codex model cache", detail: (error as Error).message, free: true };
    }
  }

  if (id === "grok") {
    try {
      const out = await cli(config.workers.grok?.command ?? "grok", ["models"]);
      const models: ModelOption[] = [];
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(/^\s*[*-]\s+(\S+)\s*(\(default\))?/);
        if (m?.[1]) models.push({ id: m[1], label: m[1], note: m[2] ? "default" : undefined });
      }
      return { models, source: "grok models", detail: models.length ? null : "grok models returned no list", free: true };
    } catch (error) {
      return { models: [], source: "grok models", detail: (error as Error).message.split("\n")[0] ?? "failed", free: true };
    }
  }

  if (id === "opencode") {
    try {
      const out = await cli(config.workers.opencode?.command ?? "opencode", ["models"]);
      const models = out
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => /^[\w.-]+\/[\w.:-]+$/.test(l))
        .map((l) => ({ id: l, label: l }));
      return { models, source: "opencode models", detail: models.length ? null : "opencode models returned no list", free: true };
    } catch (error) {
      return { models: [], source: "opencode models", detail: (error as Error).message.split("\n")[0] ?? "failed", free: true };
    }
  }

  if (id === "ollama") {
    const baseUrl = config.workers.ollama.baseUrl.replace(/\/+$/, "");
    try {
      const response = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) return { models: [], source: "ollama /api/tags", detail: `${response.status} from /api/tags`, free: true };
      const body = (await response.json()) as { models?: { name: string; details?: { parameter_size?: string } }[] };
      return { models: (body.models ?? []).map((m) => ({ id: m.name, label: m.name, note: m.details?.parameter_size })), source: "installed in Ollama", detail: null, free: false };
    } catch (error) {
      return { models: [], source: "ollama /api/tags", detail: (error as Error).message, free: false };
    }
  }

  return { models: [], source: "none", detail: `${id} has no model setting`, free: false };
}

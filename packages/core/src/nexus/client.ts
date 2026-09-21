import { spawn, type ChildProcess } from "node:child_process";

import type { CapabilityRef } from "../schemas.ts";

export interface NexusMatch {
  kind: CapabilityRef["kind"];
  name: string;
  what: string;
  capabilities: string[];
  score: number;
  ready: boolean;
  blockers: string[];
  activate: string;
}

export interface NexusStatus {
  mcps: number;
  apis: number;
  skills: number;
  workflows: number;
  root: string;
  tools: string[];
}

export interface NexusClientOptions {
  command: string;
  args: string[];
  timeoutMs: number;
}

/**
 * Minimal MCP client over stdio JSON-RPC for the Nexus hub. One process per
 * call batch; nothing stays resident. Nexus is the capability front door, so
 * DEV never keeps its own copy of the catalogue.
 */
export class NexusClient {
  readonly #options: NexusClientOptions;

  constructor(options: NexusClientOptions) {
    this.#options = options;
  }

  async status(): Promise<NexusStatus> {
    return this.#withSession(async (session) => {
      const text = await session.callTool("nexus_status", {});
      const parsed = JSON.parse(text) as Partial<NexusStatus>;
      return {
        mcps: Number(parsed.mcps ?? 0),
        apis: Number(parsed.apis ?? 0),
        skills: Number(parsed.skills ?? 0),
        workflows: Number(parsed.workflows ?? 0),
        root: String(parsed.root ?? ""),
        tools: Array.isArray(parsed.tools) ? parsed.tools.map(String) : [],
      };
    });
  }

  async findCapability(need: string, limit = 8): Promise<NexusMatch[]> {
    return this.#withSession(async (session) => {
      const text = await session.callTool("find_capability", { need, limit });
      const parsed = JSON.parse(text) as { matches?: Partial<NexusMatch>[] };
      return (parsed.matches ?? []).map((m) => ({
        kind: (m.kind as NexusMatch["kind"]) ?? "tool",
        name: String(m.name ?? ""),
        what: String(m.what ?? ""),
        capabilities: Array.isArray(m.capabilities) ? m.capabilities.map(String) : [],
        score: Number(m.score ?? 0),
        ready: m.ready !== false,
        blockers: Array.isArray(m.blockers) ? m.blockers.map(String) : [],
        activate: String(m.activate ?? ""),
      }));
    });
  }

  async search(query: string): Promise<unknown> {
    return this.#withSession(async (session) => {
      const text = await session.callTool("search", { query });
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    });
  }

  async listWorkflows(): Promise<{ name: string; description: string; hasRunner: boolean }[]> {
    return this.#withSession(async (session) => {
      const text = await session.callTool("list_workflows", {});
      try {
        const parsed = JSON.parse(text) as unknown;
        const rows = Array.isArray(parsed) ? parsed : ((parsed as { workflows?: unknown[] }).workflows ?? []);
        return (rows as Record<string, unknown>[]).map((w) => ({ name: String(w.name ?? ""), description: String(w.description ?? ""), hasRunner: Boolean(w.hasRunner ?? w.runner ?? false) }));
      } catch {
        return [];
      }
    });
  }

  async getSkill(name: string): Promise<string> {
    return this.#withSession((session) => session.callTool("get_skill", { name }));
  }

  /** True when something points at a Nexus server, so there is something to start. */
  get configured(): boolean {
    return this.#options.args.length > 0 || (this.#options.command !== "node" && this.#options.command !== "");
  }

  async #withSession<T>(fn: (session: McpSession) => Promise<T>): Promise<T> {
    // Spawning bare `node` with no script would sit waiting on stdin, or exit with
    // nothing said; neither tells the user what to do.
    if (!this.configured) throw new Error("Nexus is not set up on this machine: set nexus.args to the path of Nexus's mcp-server (dev config set nexus.args <path>), or set nexus.enabled false");
    const session = new McpSession(this.#options);
    try {
      await session.initialize();
      return await fn(session);
    } finally {
      session.close();
    }
  }
}

class McpSession {
  readonly #child: ChildProcess;
  readonly #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  readonly #timeoutMs: number;
  #nextId = 1;
  #buffer = "";
  #stderr = "";
  #closed = false;

  constructor(options: NexusClientOptions) {
    this.#timeoutMs = options.timeoutMs;
    this.#child = spawn(options.command, options.args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: process.platform === "win32" && !options.command.includes("\\") && !options.command.endsWith(".exe") && options.command !== "node" });
    this.#child.stdout?.setEncoding("utf8");
    this.#child.stderr?.setEncoding("utf8");
    this.#child.stdout?.on("data", (chunk: string) => this.#onData(chunk));
    this.#child.stderr?.on("data", (chunk: string) => {
      this.#stderr = (this.#stderr + chunk).slice(-4000);
    });
    this.#child.on("error", (error) => this.#failAll(new Error(`Nexus could not start: ${error.message}`)));
    this.#child.on("close", (code) => {
      this.#closed = true;
      this.#failAll(new Error(`Nexus exited (${code ?? "signal"})${this.#stderr ? `: ${this.#stderr.trim()}` : ""}`));
    });
  }

  async initialize(): Promise<void> {
    await this.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "dev", version: "1.0.0" } });
    this.notify("notifications/initialized", {});
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const result = (await this.request("tools/call", { name, arguments: args })) as { content?: { type: string; text?: string }[]; isError?: boolean };
    const text = (result.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
    if (result.isError) throw new Error(`Nexus tool ${name} failed: ${text}`);
    return text;
  }

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error("Nexus session is closed"));
    const id = this.#nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Nexus ${method} timed out after ${this.#timeoutMs}ms`));
      }, this.#timeoutMs);
      this.#pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.#child.stdin?.write(payload + "\n");
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.#child.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#child.stdin?.end();
      this.#child.kill();
    } catch {
      // already gone
    }
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    let index: number;
    while ((index = this.#buffer.indexOf("\n")) >= 0) {
      const line = this.#buffer.slice(0, index).trim();
      this.#buffer = this.#buffer.slice(index + 1);
      if (!line) continue;
      let message: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof message.id !== "number") continue;
      const pending = this.#pending.get(message.id);
      if (!pending) continue;
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? "Nexus error"));
      else pending.resolve(message.result);
    }
  }

  #failAll(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

export function toCapabilityRefs(matches: NexusMatch[], limit = 5): CapabilityRef[] {
  return matches
    .filter((m) => m.ready)
    .slice(0, limit)
    .map((m) => ({ kind: m.kind, name: m.name, reason: m.what.slice(0, 140), ready: m.ready }));
}

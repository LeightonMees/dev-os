import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { loadConfigWithWarnings, type ConfigWarning, type DevConfig } from "./config.ts";
import { loadSecretFiles } from "./secrets.ts";
import { EventBus } from "./events/bus.ts";
import { NexusClient } from "./nexus/client.ts";
import { Db } from "./persistence/db.ts";
import { ProjectStore } from "./projects.ts";
import { ApprovalStore, ArtifactStore, ContextSnapshotStore, DecisionStore, EvidenceStore, ExecutionStore } from "./records.ts";
import { TaskStore } from "./tasks.ts";
import { OllamaWorker } from "./workers/ollama.ts";
import { buildWorkers, WorkerRegistry } from "./workers/registry.ts";
import { ChatStore } from "./chat.ts";
import { FlowStore } from "./flows/store.ts";

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends (infer U)[] ? U[] : T[K] extends object ? DeepPartial<T[K]> : T[K] };

export interface OpenOptions {
  /** Directory holding config.json, dev.sqlite, logs/ and artifacts/. */
  home: string;
  /** Override the database path (tests use ":memory:"). */
  dbPath?: string;
  config?: DeepPartial<DevConfig>;
}

/**
 * The one object every interface (CLI, control plane, desktop) opens.
 * It owns the database connection and composes the stores.
 */
export class Dev {
  readonly home: string;
  readonly config: DevConfig;
  readonly db: Db;
  readonly events: EventBus;
  readonly projects: ProjectStore;
  readonly tasks: TaskStore;
  readonly decisions: DecisionStore;
  readonly artifacts: ArtifactStore;
  readonly evidence: EvidenceStore;
  readonly approvals: ApprovalStore;
  readonly executions: ExecutionStore;
  readonly contextSnapshots: ContextSnapshotStore;
  readonly workers: WorkerRegistry;
  readonly nexus: NexusClient;
  readonly chat: ChatStore;
  readonly flows: FlowStore;
  /** Which secret names were loaded from which files. Values are never kept here. */
  readonly secrets: { loaded: string[]; files: string[] };
  /** Problems found in config.json at load time. Bad values fell back to defaults. */
  readonly configWarnings: ConfigWarning[];

  constructor(options: OpenOptions) {
    this.home = options.home;
    mkdirSync(this.home, { recursive: true });
    const loaded = loadConfigWithWarnings(this.home);
    this.configWarnings = loaded.warnings;
    this.config = options.config ? mergeConfig(loaded.config, options.config) : loaded.config;
    this.secrets = loadSecretFiles(this.config.secrets.files);
    this.db = new Db(options.dbPath ?? join(this.home, "dev.sqlite"));
    this.events = new EventBus(this.db);
    this.projects = new ProjectStore(this.db, this.events);
    this.tasks = new TaskStore(this.db, this.events);
    this.decisions = new DecisionStore(this.db, this.events);
    this.artifacts = new ArtifactStore(this.db, this.events);
    this.evidence = new EvidenceStore(this.db, this.events);
    this.approvals = new ApprovalStore(this.db, this.events);
    this.executions = new ExecutionStore(this.db);
    this.contextSnapshots = new ContextSnapshotStore(this.db);
    this.workers = new WorkerRegistry(buildWorkers(this.config, this.home), this.db, this.events, this.executions, this.config);
    this.nexus = new NexusClient(this.config.nexus);
    this.chat = new ChatStore(this.db);
    this.flows = new FlowStore(this.db, this.events);
  }

  /**
   * Local, free condensation of long text through Ollama when it is healthy.
   * Returns null when no local model is available so callers fall back to trimming.
   */
  async summarize(text: string, instruction: string): Promise<string | null> {
    const worker = this.workers.get("ollama");
    if (!(worker instanceof OllamaWorker)) return null;
    const health = this.workers.lastHealth("ollama") ?? (await this.workers.check("ollama"));
    if (!health.ok) return null;
    try {
      const out = await worker.generate(`${instruction}\n\n---\n${text.slice(0, 24_000)}\n---`, { system: "You write terse engineering summaries. No preamble, no markdown headings.", timeoutMs: 90_000, maxTokens: 400 });
      return out || null;
    } catch {
      return null;
    }
  }

  close(): void {
    this.db.close();
  }
}

export function openDev(options: OpenOptions): Dev {
  return new Dev(options);
}

function mergeConfig(base: DevConfig, patch: DeepPartial<DevConfig>): DevConfig {
  const merge = (current: unknown, value: unknown): unknown => {
    if (current && typeof current === "object" && !Array.isArray(current) && value && typeof value === "object" && !Array.isArray(value)) {
      const out: Record<string, unknown> = { ...(current as Record<string, unknown>) };
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (v !== undefined) out[k] = merge(out[k], v);
      return out;
    }
    return value;
  };
  return merge(structuredClone(base), patch) as DevConfig;
}

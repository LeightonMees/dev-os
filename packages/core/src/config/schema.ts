/**
 * The configuration schema: one declaration of every setting DEV has or expects
 * to have, with its type, default, description and scope.
 *
 * `DevConfig` and `DEFAULT_CONFIG` in `../config.ts` are both derived from
 * `CONFIG_SCHEMA`, so the type, the defaults, the validator and the Settings UI
 * cannot drift from one another.
 *
 * Fields carry `active`. A field with `active: false` is declared here for a
 * later milestone and nothing in DEV reads it yet; the Settings UI must hide it
 * or disable it with that reason rather than show a control that does nothing.
 *
 * No dependencies: the validator is `checkConfigValue` below, fifty lines of it.
 */
import { homedir } from "node:os";
import { join } from "node:path";

import { DEFAULT_API_PROVIDERS, type ApiProviderConfig } from "../workers/api.ts";
import type { WorkerCapability } from "../workers/types.ts";

/** Schema version of a persisted config file. A missing version means 1. */
export const CONFIG_SCHEMA_VERSION = 1;

/** The scopes a value may be written at, lowest precedence first (ADR 0001). */
export const CONFIG_WRITE_SCOPES = ["global", "project", "session", "task"] as const;
export type ConfigWriteScope = (typeof CONFIG_WRITE_SCOPES)[number];

/**
 * How a value is edited and checked. "path" is a string the Settings UI may
 * offer a file picker for; it is validated as a string. "record" is an object
 * with keys the schema cannot know in advance, each holding a `valueType`.
 */
export type ConfigValueType =
  | "string"
  | "path"
  | "number"
  | "boolean"
  | "enum"
  | "string[]"
  | "path[]"
  | "object[]"
  | "record";

export interface ConfigField<T = unknown> {
  readonly kind: "field";
  /** Short name for the Settings UI. */
  readonly label: string;
  readonly type: ConfigValueType;
  readonly default: T;
  /** One sentence for the Settings UI. Every field has one. */
  readonly description: string;
  /** The most specific scope that may set this key. "global" means global only. */
  readonly scope: ConfigWriteScope;
  /** Changing it only takes effect after the control plane or app restarts. */
  readonly restartRequired: boolean;
  /** False when nothing reads this key yet: declared for a later milestone. */
  readonly active: boolean;
  /** The value may also be null. */
  readonly nullable: boolean;
  /** Allowed values for type "enum". */
  readonly values?: readonly string[];
  /** What each entry holds, for type "record". */
  readonly valueType?: ConfigValueType;
  readonly min?: number;
  readonly max?: number;
  /**
   * The key may be tightened by a lower-precedence scope but never loosened
   * (ADR 0001). The text is the rule; `../config.ts` enforces it.
   */
  readonly restricted?: string;
}

export interface ConfigSection {
  readonly [key: string]: ConfigNode;
}

export type ConfigNode = ConfigField<unknown> | ConfigSection;

interface FieldSpec<T> {
  label: string;
  type: ConfigValueType;
  default: T;
  description: string;
  scope?: ConfigWriteScope;
  restartRequired?: boolean;
  active?: boolean;
  nullable?: boolean;
  values?: readonly string[];
  valueType?: ConfigValueType;
  min?: number;
  max?: number;
  restricted?: string;
}

function field<T>(spec: FieldSpec<T>): ConfigField<T> {
  return {
    kind: "field",
    label: spec.label,
    type: spec.type,
    default: spec.default,
    description: spec.description,
    scope: spec.scope ?? "task",
    restartRequired: spec.restartRequired ?? false,
    active: spec.active ?? false,
    nullable: spec.nullable ?? false,
    values: spec.values,
    valueType: spec.valueType,
    min: spec.min ?? (spec.type === "number" ? 0 : undefined),
    max: spec.max,
    restricted: spec.restricted,
  };
}

export function isConfigField(node: unknown): node is ConfigField<unknown> {
  return !!node && typeof node === "object" && (node as ConfigField).kind === "field";
}

export function isConfigSection(node: unknown): node is ConfigSection {
  return !!node && typeof node === "object" && !Array.isArray(node) && !isConfigField(node);
}

// ---------------------------------------------------------------------------
// Enumerations. Declared once, used by the schema, the validator and the UI.
// ---------------------------------------------------------------------------

export const UI_THEMES = ["system", "dark", "light"] as const;

/** Ordered tightest first. A lower-precedence scope may only move toward the front. */
export const PRIVACY_MODES = ["LOCAL_ONLY", "LOCAL_FIRST", "OPEN"] as const;
export type PrivacyMode = (typeof PRIVACY_MODES)[number];

/** How `select()` chooses a worker when the task does not name one. */
export const ROUTING_MODES = ["MANUAL", "RULE_BASED", "COST_FIRST", "QUALITY_FIRST", "LOCAL_FIRST"] as const;

/** What a worker may do without being asked. */
export const WORKING_MODES = ["LEARN", "PAIR", "BUILD", "AUTOPILOT"] as const;

/** What happens when a run fails. */
export const FAILURE_POLICIES = [
  "RETRY_SAME",
  "RETRY_WITH_CONTEXT",
  "DIFFERENT_WORKER",
  "ESCALATE",
  "REQUEST_HUMAN",
  "BLOCK",
] as const;

/** Approval policy values (spec §13). */
export const APPROVAL_POLICIES = ["ALWAYS_ALLOW", "ALLOW_WITHIN_TICKET", "ASK", "ALWAYS_ASK", "DENY"] as const;

const EXPERIENCE_LEVELS = ["beginner", "intermediate", "advanced"] as const;
const EXPLANATION_DEPTHS = ["brief", "normal", "deep"] as const;
const COMMIT_STYLES = ["conventional", "plain"] as const;
export const ISOLATION_MODES = ["in-place", "worktree"] as const;
const SANDBOX_MODES = ["none", "directory", "container"] as const;
const UI_DENSITIES = ["comfortable", "compact"] as const;

// ---------------------------------------------------------------------------
// The schema.
// ---------------------------------------------------------------------------

export const CONFIG_SCHEMA = {
  user: {
    name: field<string>({
      label: "Name",
      type: "string",
      default: "",
      description: "Your name, used in commit messages and handover documents. Empty leaves git's own setting alone.",
      scope: "global",
    }),
    experience: field<(typeof EXPERIENCE_LEVELS)[number]>({
      label: "Experience",
      type: "enum",
      values: EXPERIENCE_LEVELS,
      default: "intermediate",
      description: "How much explanation you want by default. Sets the starting point for Learn mode.",
      scope: "global",
    }),
  },

  machine: {
    name: field<string>({
      label: "Machine name",
      type: "string",
      default: "",
      description: "Name for this machine in records. Empty uses the hostname.",
      scope: "global",
    }),
    cacheDir: field<string>({
      label: "Cache directory",
      type: "path",
      default: "F:\\devcache",
      description: "Where DEV and its workers put caches and downloaded models. Keep it off the OS disk.",
      scope: "global",
      restartRequired: true,
    }),
    tempDir: field<string>({
      label: "Temp directory",
      type: "path",
      default: "F:\\tmp",
      description: "Where DEV puts scratch files that can be deleted at any time.",
      scope: "global",
      restartRequired: true,
    }),
    ramGb: field<number | null>({
      label: "RAM (GB)",
      type: "number",
      default: null,
      nullable: true,
      description: "Memory available for local models. null = detect at startup.",
      scope: "global",
    }),
    gpuVramGb: field<number | null>({
      label: "GPU memory (GB)",
      type: "number",
      default: null,
      nullable: true,
      description: "Video memory available for local models. null = detect at startup, 0 = no usable GPU.",
      scope: "global",
    }),
  },

  projects: {
    defaultDir: field<string>({
      label: "Default project directory",
      type: "path",
      // A folder in the user's home: exists everywhere, belongs to them, and is
      // never a cloud-synced or system directory.
      default: join(homedir(), "Projects"),
      description: "Where `dev project new` and the New project dialog create directories.",
      scope: "global",
      active: true,
      restricted: "projects.defaultDir is a global setting: it governs where DEV writes on disk",
    }),
  },

  workers: {
    preferences: field<string[]>({
      label: "Preference order",
      type: "string[]",
      default: [],
      description:
        'Who "auto" picks, best first. Empty = no standing opinion: DEV orders the healthy workers by what the benchmark evidence says for the kind of work in hand. Set this to overrule that. A worker set on a task always wins over both.',
      active: true,
    }),
    preferencesByCapability: field<Partial<Record<WorkerCapability, string[]>>>({
      label: "Who is best at what",
      type: "record",
      valueType: "string[]",
      default: {},
      description:
        "Preference order per kind of work, best first. A capability with no entry falls back to the general order; empty states no opinion.",
      active: true,
    }),
    timeoutMs: field<number>({
      label: "Shell timeout",
      type: "number",
      default: 30 * 60 * 1000,
      description: "How long a shell command may run before it is cancelled. Stored in milliseconds (default 30 minutes). Agent workers use agentTimeoutMs.",
      active: true,
      restricted: "workers.timeoutMs may only be lowered by a project, session or task",
    }),
    agentTimeoutMs: field<number>({
      label: "Agent timeout",
      type: "number",
      default: 2 * 60 * 60 * 1000,
      description: "How long a coding agent (Claude Code, Codex, Grok, OpenCode, API, Ollama) may run before it is cancelled. Stored in milliseconds (default 2 hours). A retry after a timeout doubles this once, up to 4 hours.",
      active: true,
      restricted: "workers.agentTimeoutMs may only be lowered by a project, session or task",
    }),
    concurrency: field<number>({
      label: "Concurrent runs",
      type: "number",
      default: 1,
      min: 1,
      description: "How many independent tasks may run at once. Never two on the same repository.",
    }),
    claudeCode: {
      command: field<string>({
        label: "Claude Code command",
        type: "string",
        default: "claude",
        description: "The executable DEV runs for the claude-code worker.",
        active: true,
      }),
      model: field<string | null>({
        label: "Claude Code model",
        type: "string",
        default: null,
        nullable: true,
        description: "null = whatever the CLI defaults to.",
        active: true,
      }),
      effort: field<string | null>({
        label: "Claude Code reasoning effort",
        type: "string",
        default: null,
        nullable: true,
        description: "How hard the model thinks (low, medium, high, xhigh, max). null = decided per task.",
        active: true,
      }),
      permissionMode: field<string>({
        label: "Claude Code permission mode",
        type: "string",
        default: "acceptEdits",
        description:
          "acceptEdits lets a worker edit files but not run commands, so tests and builds are refused in a non-interactive run; bypassPermissions lets it run commands in the project directory.",
        active: true,
      }),
    },
    codex: {
      command: field<string>({
        label: "Codex command",
        type: "string",
        default: "codex",
        description: "The executable DEV runs for the codex worker.",
        active: true,
      }),
      model: field<string | null>({
        label: "Codex model",
        type: "string",
        default: null,
        nullable: true,
        description: "null = whatever the CLI defaults to.",
        active: true,
      }),
      effort: field<string | null>({
        label: "Codex reasoning effort",
        type: "string",
        default: null,
        nullable: true,
        description: "How hard the model thinks, passed as model_reasoning_effort. null = leave your own Codex config alone.",
        active: true,
      }),
    },
    ollama: {
      baseUrl: field<string>({
        label: "Ollama URL",
        type: "string",
        default: "http://127.0.0.1:11434",
        description: "Where the local Ollama server listens.",
        active: true,
      }),
      model: field<string>({
        label: "Ollama model",
        type: "string",
        default: "qwen2.5-coder:7b",
        description: "Used for summaries and as a planning fallback.",
        active: true,
      }),
    },
    grok: {
      command: field<string>({
        label: "Grok command",
        type: "string",
        default: "grok",
        description: "The executable DEV runs for the grok worker.",
        active: true,
      }),
      model: field<string | null>({
        label: "Grok model",
        type: "string",
        default: null,
        nullable: true,
        description: "null = whatever the CLI defaults to.",
        active: true,
      }),
      effort: field<string | null>({
        label: "Grok reasoning effort",
        type: "string",
        default: null,
        nullable: true,
        description: "How hard the model thinks (--reasoning-effort). null = decided per task.",
        active: true,
      }),
      permissionMode: field<string>({
        label: "Grok permission mode",
        type: "string",
        default: "acceptEdits",
        description: "What the Grok CLI may do without asking.",
        active: true,
      }),
    },
    opencode: {
      command: field<string>({
        label: "OpenCode command",
        type: "string",
        default: "opencode",
        description: "The executable DEV runs for the opencode worker.",
        active: true,
      }),
      model: field<string | null>({
        label: "OpenCode model",
        type: "string",
        default: null,
        nullable: true,
        description: "null = whatever the CLI defaults to.",
        active: true,
      }),
      effort: field<string | null>({
        label: "OpenCode model variant",
        type: "string",
        default: null,
        nullable: true,
        description: "Provider-specific reasoning level, passed as --variant. null = decided per task.",
        active: true,
      }),
    },
    api: {
      providers: field<ApiProviderConfig[]>({
        label: "API providers",
        type: "object[]",
        default: DEFAULT_API_PROVIDERS,
        description: "OpenAI-compatible endpoints turned into workers. Keys are read from the secret files, never stored here.",
        active: true,
        restartRequired: true,
      }),
    },
  },

  routing: {
    mode: field<(typeof ROUTING_MODES)[number]>({
      label: "Routing mode",
      type: "enum",
      values: ROUTING_MODES,
      default: "RULE_BASED",
      description: "How a worker is chosen when the task does not name one. RULE_BASED follows the preference order.",
    }),
    allowFallback: field<boolean>({
      label: "Allow fallback",
      type: "boolean",
      default: true,
      description: "Try the next healthy worker when the chosen one is unavailable.",
    }),
    maxAttempts: field<number>({
      label: "Max workers per task",
      type: "number",
      default: 3,
      min: 1,
      description: "How many workers a single task may be tried on before it blocks.",
    }),
  },

  autonomy: {
    mode: field<(typeof WORKING_MODES)[number]>({
      label: "Working mode",
      type: "enum",
      values: WORKING_MODES,
      default: "BUILD",
      description:
        "LEARN: workers explain and never edit. PAIR: contained edits with an explanation. BUILD: normal work. AUTOPILOT: DEV may work a queue unattended.",
      scope: "project",
    }),
    autoRun: field<boolean>({
      label: "Run the queue automatically",
      type: "boolean",
      default: false,
      description: "Start the next runnable task without being asked. Only AUTOPILOT may do this.",
      scope: "project",
    }),
    maxTasksPerRun: field<number>({
      label: "Max tasks per unattended run",
      type: "number",
      default: 5,
      min: 1,
      description: "An unattended run stops after this many tasks even if more are runnable.",
    }),
    stopOnFailure: field<boolean>({
      label: "Stop on failure",
      type: "boolean",
      default: true,
      description: "End an unattended run at the first blocked task instead of moving on.",
    }),
    failurePolicy: field<(typeof FAILURE_POLICIES)[number]>({
      label: "Failure policy",
      type: "enum",
      values: FAILURE_POLICIES,
      default: "RETRY_WITH_CONTEXT",
      description: "What DEV does with a failed run before giving the task back to you.",
    }),
    maxRetries: field<number>({
      label: "Max retries per task",
      type: "number",
      default: 2,
      description: "How many times the failure policy may retry one task.",
    }),
  },

  approvals: {
    requireForCommit: field<boolean>({
      label: "Require approval for commits",
      type: "boolean",
      default: false,
      description: "A commit waits for you instead of happening at the end of a run.",
      active: true,
      restricted: "approvals.requireForCommit may only be turned on by a project, session or task",
    }),
    requireForPush: field<boolean>({
      label: "Require approval for pushes",
      type: "boolean",
      // On by default: a push leaves the machine, and nothing DEV does should
      // reach a remote without a person saying so.
      default: true,
      description: "Push files an approval instead of pushing; approving it performs the push.",
      active: true,
      restricted: "approvals.requireForPush may only be turned on by a project, session or task",
    }),
    defaultPolicy: field<(typeof APPROVAL_POLICIES)[number]>({
      label: "Default policy",
      type: "enum",
      values: APPROVAL_POLICIES,
      default: "ALLOW_WITHIN_TICKET",
      description: "What an action with no policy of its own is allowed to do.",
    }),
    destructiveCommands: field<(typeof APPROVAL_POLICIES)[number]>({
      label: "Destructive commands",
      type: "enum",
      values: APPROVAL_POLICIES,
      default: "ALWAYS_ASK",
      description: "Deleting, resetting or force-pushing: commands that lose work.",
    }),
    systemChanges: field<(typeof APPROVAL_POLICIES)[number]>({
      label: "System changes",
      type: "enum",
      values: APPROVAL_POLICIES,
      default: "ASK",
      description: "Installing software, changing PATH or touching anything outside the project.",
    }),
    dependencyChanges: field<(typeof APPROVAL_POLICIES)[number]>({
      label: "Dependency changes",
      type: "enum",
      values: APPROVAL_POLICIES,
      default: "ALLOW_WITHIN_TICKET",
      description: "Adding or upgrading a package the project depends on.",
    }),
    networkAccess: field<(typeof APPROVAL_POLICIES)[number]>({
      label: "Network access",
      type: "enum",
      values: APPROVAL_POLICIES,
      default: "ALLOW_WITHIN_TICKET",
      description: "A worker fetching something from the internet during a run.",
    }),
    protectedPaths: field<string[]>({
      label: "Protected paths",
      type: "path[]",
      default: [],
      description: "Globs whose changes send a task to REVIEW even when verification passed.",
      scope: "project",
    }),
  },

  testing: {
    command: field<string | null>({
      label: "Test command",
      type: "string",
      default: null,
      nullable: true,
      description: "The project's test command. null = the task's own verification entries decide.",
      scope: "project",
    }),
    runBeforeDone: field<boolean>({
      label: "Test before DONE",
      type: "boolean",
      default: false,
      description: "Run the test command as evidence before a task may reach DONE.",
      scope: "project",
    }),
    requireLint: field<boolean>({
      label: "Require lint evidence",
      type: "boolean",
      default: false,
      description: "DONE also needs a passing lint run.",
      scope: "project",
    }),
    requireTypecheck: field<boolean>({
      label: "Require typecheck evidence",
      type: "boolean",
      default: false,
      description: "DONE also needs a passing typecheck run.",
      scope: "project",
    }),
    timeoutMs: field<number>({
      label: "Verification timeout (ms)",
      type: "number",
      default: 10 * 60 * 1000,
      description: "How long one verification command may take.",
    }),
  },

  git: {
    autoCommit: field<boolean>({
      label: "Commit after a passing run",
      type: "boolean",
      default: false,
      description: "Commit the changed files when verification passes, subject to the approval setting.",
      scope: "project",
    }),
    commitStyle: field<(typeof COMMIT_STYLES)[number]>({
      label: "Commit message style",
      type: "enum",
      values: COMMIT_STYLES,
      default: "conventional",
      description: "conventional writes `feat: …`; plain writes the task title.",
      scope: "project",
    }),
    branchPrefix: field<string>({
      label: "Branch prefix",
      type: "string",
      default: "",
      description: "Prefix for branches DEV creates, e.g. `feature/`. Empty = work on the current branch.",
      scope: "project",
    }),
    pushAfterCommit: field<boolean>({
      label: "Push after commit",
      type: "boolean",
      default: false,
      description: "Push to the tracking remote after a commit.",
      scope: "project",
    }),
    protectedBranches: field<string[]>({
      label: "Protected branches",
      type: "string[]",
      default: ["master", "main"],
      description: "Branches DEV may not commit to without your approval.",
      scope: "project",
    }),
    isolation: field<(typeof ISOLATION_MODES)[number]>({
      label: "Where a task runs",
      type: "enum",
      values: ISOLATION_MODES,
      default: "in-place",
      description: "in-place runs the worker in your checkout. worktree gives each run its own git worktree on a branch named dev/<task>, commits what changed there, and leaves your checkout untouched — the safe setting for autopilot.",
      scope: "project",
      active: true,
    }),
  },

  context: {
    budgetTokens: field<number>({
      label: "Tokens per worker brief",
      type: "number",
      default: 12_000,
      description: "Everything beyond this is cut from the brief, lowest priority first.",
      active: true,
    }),
    maxFileTokens: field<number>({
      label: "Tokens per included file",
      type: "number",
      default: 600,
      // Was 2_000, which let one document own a whole brief. Measured 2026-09-18: a task whose job
      // was "decide the next milestone for Agency" shipped 3,199 tokens, of which ~2,000 were the
      // first 8,000 characters of MASTER PLAN.md (17,160 chars) -- 62% of the brief, to answer a
      // question the one-line decisions section had already answered. At 600 no single file can be
      // more than about a fifth of a brief, and the head of a document is its summary, which is the
      // part worth sending.
      description: "A file longer than this is trimmed before it enters the brief. Keeps one big document from owning the whole brief.",
      active: true,
    }),
    maxFiles: field<number>({
      label: "Max files per task",
      type: "number",
      default: 8,
      description: "How many files the brief may include.",
      active: true,
    }),
  },

  planning: {
    maxTasks: field<number>({
      label: "Max tasks per plan",
      type: "number",
      default: 6,
      min: 1,
      description: "The hard bound on a generated plan. DEV never writes a speculative backlog.",
      active: true,
    }),
    worker: field<string | null>({
      label: "Planning worker",
      type: "string",
      default: null,
      nullable: true,
      description: "null = the first healthy planner in preference order.",
      active: true,
    }),
  },

  chat: {
    worker: field<string | null>({
      label: "Chat worker",
      type: "string",
      default: null,
      nullable: true,
      description: "Which worker answers you in DEV chat and drives DEV's own tools. null = the first healthy one.",
      active: true,
    }),
    maxToolCalls: field<number>({
      label: "Max tool calls per answer",
      type: "number",
      default: 12,
      description: "How many tools the chat brain may use before it must answer.",
      active: true,
      restricted: "chat.maxToolCalls may only be lowered by a project, session or task",
    }),
  },

  learning: {
    explanationDepth: field<(typeof EXPLANATION_DEPTHS)[number]>({
      label: "Explanation depth",
      type: "enum",
      values: EXPLANATION_DEPTHS,
      default: "normal",
      description: "How much DEV explains what it did and why.",
      scope: "project",
    }),
    hintLadder: field<boolean>({
      label: "Hint ladder",
      type: "boolean",
      default: true,
      description: "In LEARN mode, start with a question and only give the answer when you ask again.",
      scope: "project",
    }),
    showDiffBeforeApply: field<boolean>({
      label: "Show the diff first",
      type: "boolean",
      default: false,
      description: "Show a proposed change and wait before it is written to disk.",
      scope: "project",
    }),
    captureLessons: field<boolean>({
      label: "Record lessons",
      type: "boolean",
      default: false,
      description: "Write what a failed run taught into the project's decisions.",
      scope: "project",
    }),
  },

  budget: {
    dailyTokenLimit: field<number | null>({
      label: "Daily token limit",
      type: "number",
      default: null,
      nullable: true,
      description: "Tokens per day across all workers that report usage. null = no limit.",
    }),
    dailyCostLimitUsd: field<number | null>({
      label: "Daily cost limit (USD)",
      type: "number",
      default: null,
      nullable: true,
      description: "Spend per day for workers that report a price. null = no limit. DEV never estimates a cost it was not given.",
    }),
    perTaskTokenLimit: field<number | null>({
      label: "Tokens per task",
      type: "number",
      default: null,
      nullable: true,
      description: "Bound on one task's runs. null = no limit.",
    }),
    warnAtPercent: field<number>({
      label: "Warn at (%)",
      type: "number",
      default: 80,
      min: 1,
      max: 100,
      description: "How close to a limit DEV gets before it warns you.",
    }),
    stopAtLimit: field<boolean>({
      label: "Stop at the limit",
      type: "boolean",
      default: true,
      description: "Refuse to start a new run once a limit is reached, instead of only warning.",
    }),
  },

  tools: {
    discovery: field<boolean>({
      label: "Capability discovery",
      type: "boolean",
      default: true,
      description: "Search Nexus for capabilities while planning and attach what it finds to the task.",
    }),
    shell: field<boolean>({
      label: "Shell tool",
      type: "boolean",
      default: true,
      description: "Workers and the chat brain may run commands.",
    }),
    fileEdit: field<boolean>({
      label: "File editing tool",
      type: "boolean",
      default: true,
      description: "Workers may write files in the project directory.",
    }),
    deniedCommands: field<string[]>({
      label: "Denied commands",
      type: "string[]",
      default: [],
      description: "Commands no worker may run, matched on the first word or a glob.",
    }),
  },

  nexus: {
    enabled: field<boolean>({
      label: "Nexus enabled",
      type: "boolean",
      default: true,
      description: "Use the Nexus MCP server for capability search and downstream tools.",
      active: true,
      restartRequired: true,
      restricted: "nexus.enabled may only be turned off by a project, session or task",
    }),
    command: field<string>({
      label: "Nexus command",
      type: "string",
      default: "node",
      description: "The executable that starts the Nexus MCP server.",
      active: true,
      restartRequired: true,
    }),
    args: field<string[]>({
      label: "Nexus arguments",
      type: "string[]",
      // Empty on purpose: Nexus is a separate, optional tool, and its location is
      // this machine's business. Doctor says so plainly until it is pointed at one.
      default: [],
      description: "Arguments passed to the Nexus command, e.g. the path to Nexus's mcp-server. Empty means Nexus is not set up here.",
      active: true,
      restartRequired: true,
    }),
    timeoutMs: field<number>({
      label: "Nexus timeout (ms)",
      type: "number",
      default: 20_000,
      description: "How long one Nexus call may take before DEV gives up on it.",
      active: true,
    }),
  },

  secrets: {
    files: field<string[]>({
      label: "Secret files",
      type: "path[]",
      default: [join(homedir(), ".dev", "keys.env")],
      description: "Dotenv files loaded at startup. Keys stay in these files; DEV never copies them into the repository.",
      active: true,
      restartRequired: true,
      restricted: "secrets.files may only be narrowed to a subset of the inherited list",
    }),
  },

  security: {
    allowNetwork: field<boolean>({
      label: "Allow network access",
      type: "boolean",
      default: true,
      description: "Workers may reach the internet during a run.",
    }),
    redactSecrets: field<boolean>({
      label: "Redact secrets",
      type: "boolean",
      default: true,
      description: "Values that look like keys are replaced before anything is logged or sent to a worker.",
    }),
    secretPatterns: field<string[]>({
      label: "Secret name patterns",
      type: "string[]",
      default: ["*_KEY", "*_TOKEN", "*_SECRET", "*_PASSWORD"],
      description: "Environment variable name globs treated as secrets.",
    }),
    logRetentionDays: field<number | null>({
      label: "Log retention (days)",
      type: "number",
      default: null,
      nullable: true,
      description: "Delete execution logs older than this. null = keep them.",
      scope: "global",
    }),
    sandbox: field<(typeof SANDBOX_MODES)[number]>({
      label: "Sandbox",
      type: "enum",
      values: SANDBOX_MODES,
      default: "none",
      description: "How far a worker process is confined. none is what DEV does today: the project directory as the working directory.",
    }),
  },

  privacy: {
    mode: field<PrivacyMode>({
      label: "Privacy mode",
      type: "enum",
      values: PRIVACY_MODES,
      default: "LOCAL_FIRST",
      description:
        "How far work may travel off this machine. LOCAL_ONLY is the tightest: local workers only, nothing leaves the machine.",
      scope: "project",
      active: true,
      restricted: "privacy.mode may only be tightened toward LOCAL_ONLY by a project, session or task",
    }),
  },

  notifications: {
    enabled: field<boolean>({
      label: "Notifications",
      type: "boolean",
      default: true,
      description: "Tell you when something needs you or a run finished.",
      scope: "global",
    }),
    desktop: field<boolean>({
      label: "Desktop notifications",
      type: "boolean",
      default: true,
      description: "Use the operating system's notifications as well as in-app toasts.",
      scope: "global",
    }),
    sound: field<boolean>({
      label: "Sound",
      type: "boolean",
      default: false,
      description: "Play a sound with a notification.",
      scope: "global",
    }),
    events: field<string[]>({
      label: "Events that notify",
      type: "string[]",
      default: [],
      description: "Event types worth interrupting you for. Empty = the built-in set: blocked tasks, approvals and finished runs.",
      scope: "global",
    }),
    quietHours: field<string | null>({
      label: "Quiet hours",
      type: "string",
      default: null,
      nullable: true,
      description: 'No notifications during this window, as "HH:MM-HH:MM". null = always notify.',
      scope: "global",
    }),
  },

  terminal: {
    shell: field<string | null>({
      label: "Shell",
      type: "string",
      default: null,
      nullable: true,
      description: "The shell the integrated terminal opens. null = pwsh, then powershell.",
      scope: "global",
      active: true,
    }),
  },

  storage: {
    keepLogs: field<boolean>({
      label: "Keep execution logs",
      type: "boolean",
      default: true,
      description: "Write each run's output to an artifact on disk.",
      scope: "global",
      active: true,
    }),
  },

  ui: {
    theme: field<(typeof UI_THEMES)[number]>({
      label: "Theme",
      type: "enum",
      values: UI_THEMES,
      default: "system",
      description: "The desktop app's colour scheme.",
      scope: "global",
      active: true,
    }),
    density: field<(typeof UI_DENSITIES)[number]>({
      label: "Density",
      type: "enum",
      values: UI_DENSITIES,
      default: "comfortable",
      description: "How much space the board and lists use.",
      scope: "global",
    }),
    confirmDestructive: field<boolean>({
      label: "Confirm destructive actions",
      type: "boolean",
      default: true,
      description: "Ask before deleting a project, a task or a record.",
      scope: "global",
    }),
    showAdvanced: field<boolean>({
      label: "Show advanced settings",
      type: "boolean",
      default: false,
      description: "Show the advanced section in Settings.",
      scope: "global",
    }),
  },

  controlPlane: {
    host: field<string>({
      label: "Control plane host",
      type: "string",
      default: "127.0.0.1",
      description: "The address the control plane binds to. Loopback keeps it on this machine.",
      scope: "global",
      active: true,
      restartRequired: true,
    }),
    port: field<number>({
      label: "Control plane port",
      type: "number",
      default: 47831,
      min: 1,
      max: 65_535,
      description: "The port the CLI and the app talk to.",
      scope: "global",
      active: true,
      restartRequired: true,
    }),
  },

  advanced: {
    debugLogging: field<boolean>({
      label: "Debug logging",
      type: "boolean",
      default: false,
      description: "Log every control plane request and worker process line.",
      scope: "global",
      restartRequired: true,
    }),
    experiments: field<string[]>({
      label: "Experiments",
      type: "string[]",
      default: [],
      description: "Names of unfinished features to switch on. Empty in normal use.",
      scope: "global",
    }),
  },
};

/** A section's name and why it exists, for the Settings UI. */
export const CONFIG_SECTION_INFO: Record<string, { title: string; description: string }> = {
  user: { title: "You", description: "Who DEV is working with." },
  machine: { title: "Machine", description: "What this machine can do and where DEV may write." },
  projects: { title: "Projects", description: "Where new projects are created." },
  workers: { title: "Workers", description: "The CLIs, local models and API endpoints that do the work." },
  routing: { title: "Routing", description: "How a worker is chosen for a task." },
  autonomy: { title: "Autonomy", description: "How much DEV may do without being asked." },
  approvals: { title: "Approvals", description: "Which actions wait for you." },
  testing: { title: "Testing", description: "What counts as done." },
  git: { title: "Git", description: "Branches, commits and what DEV may push." },
  context: { title: "Context budget", description: "How much a worker is told about the project." },
  planning: { title: "Planning", description: "How a goal becomes tasks." },
  chat: { title: "Chat", description: "The brain that answers you in DEV chat." },
  learning: { title: "Learning", description: "How much DEV explains and how it teaches." },
  budget: { title: "Budget", description: "Token and cost limits, from real reported usage only." },
  tools: { title: "Tools", description: "What workers may reach for." },
  nexus: { title: "Nexus", description: "The capability and MCP server DEV asks for tools." },
  secrets: { title: "Secrets", description: "Where keys are read from. Never stored in the repository." },
  security: { title: "Security", description: "What leaves the machine and what is kept." },
  privacy: { title: "Privacy", description: "How far work may travel off this machine." },
  notifications: { title: "Notifications", description: "When DEV interrupts you." },
  terminal: { title: "Terminal", description: "The integrated terminal." },
  storage: { title: "Storage", description: "What DEV keeps on disk." },
  ui: { title: "Appearance", description: "How the desktop app looks." },
  controlPlane: { title: "Control plane", description: "The local server the CLI and the app share." },
  advanced: { title: "Advanced", description: "Diagnostics and unfinished features." },
};

// ---------------------------------------------------------------------------
// Derived: the config type, the defaults and the flat field list.
// ---------------------------------------------------------------------------

/** The value a schema node describes: a field's type, or a section of them. */
type ValueOf<N> = N extends ConfigField<infer T> ? T : { -readonly [K in keyof N]: ValueOf<N[K]> };

/** The shape of a complete configuration, derived from the schema. */
export type DevConfigShape = ValueOf<typeof CONFIG_SCHEMA>;

function defaultsOf(node: unknown): unknown {
  if (isConfigField(node)) return structuredClone(node.default);
  const out: Record<string, unknown> = {};
  if (!isConfigSection(node)) return out;
  for (const [key, child] of Object.entries(node)) out[key] = defaultsOf(child);
  return out;
}

/** Build a complete configuration from the schema's defaults. Fresh every call. */
export function buildDefaultConfig(): DevConfigShape {
  return defaultsOf(CONFIG_SCHEMA) as DevConfigShape;
}

/** One row of the flat field list the Settings UI renders from. */
export interface ConfigFieldInfo extends ConfigField<unknown> {
  /** Dotted key, e.g. "workers.timeoutMs". */
  key: string;
  /** Top-level section name, e.g. "workers". */
  section: string;
}

function flatten(node: unknown, prefix: string, section: string, out: ConfigFieldInfo[]): void {
  if (!isConfigSection(node)) return;
  for (const [key, child] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isConfigField(child)) out.push({ ...child, key: path, section: section || key });
    else flatten(child, path, section || key, out);
  }
}

/** Every setting, in schema order: {key, type, description, default, scope, restartRequired, …}. */
export const CONFIG_FIELDS: ConfigFieldInfo[] = (() => {
  const out: ConfigFieldInfo[] = [];
  flatten(CONFIG_SCHEMA, "", "", out);
  return out;
})();

const FIELDS_BY_KEY = new Map(CONFIG_FIELDS.map((f): [string, ConfigFieldInfo] => [f.key, f]));

/** The field for a dotted key, or undefined when DEV does not know the key. */
export function configFieldFor(key: string): ConfigFieldInfo | undefined {
  return FIELDS_BY_KEY.get(key);
}

export interface ConfigSectionInfo {
  name: string;
  title: string;
  description: string;
  fields: ConfigFieldInfo[];
}

/** The settings grouped into the sections the UI shows, in schema order. */
export const CONFIG_SECTIONS: ConfigSectionInfo[] = Object.keys(CONFIG_SCHEMA).map((name) => {
  const info = CONFIG_SECTION_INFO[name];
  return {
    name,
    title: info?.title ?? name,
    description: info?.description ?? "",
    fields: CONFIG_FIELDS.filter((f) => f.section === name),
  };
});

/** Keys a lower-precedence scope may tighten but never loosen (ADR 0001). */
export const RESTRICTED_CONFIG_KEYS: string[] = CONFIG_FIELDS.filter((f) => f.restricted).map((f) => f.key);

// ---------------------------------------------------------------------------
// Validation. Hand-written, no dependencies, and it never edits its input.
// ---------------------------------------------------------------------------

function entryField(field: ConfigField<unknown>): ConfigField<unknown> {
  return { ...field, type: field.valueType === "record" ? "string" : field.valueType ?? "string", nullable: false };
}

/** Why `value` is not allowed for `field`, or null when it is. */
export function checkConfigValue(field: ConfigField<unknown>, value: unknown): string | null {
  const wanted = `expected ${describe(field)}`;
  if (value === null) return field.nullable ? null : wanted;
  switch (field.type) {
    case "enum":
      return typeof value === "string" && (field.values ?? []).includes(value) ? null : wanted;
    case "string":
    case "path":
      return typeof value === "string" ? null : wanted;
    case "boolean":
      return typeof value === "boolean" ? null : wanted;
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) return wanted;
      if (value < (field.min ?? 0)) return wanted;
      if (field.max !== undefined && value > field.max) return wanted;
      return null;
    }
    case "string[]":
    case "path[]":
      return Array.isArray(value) && value.every((item) => typeof item === "string") ? null : wanted;
    case "object[]":
      return Array.isArray(value) && value.every((item) => !!item && typeof item === "object" && !Array.isArray(item))
        ? null
        : wanted;
    case "record": {
      if (typeof value !== "object" || Array.isArray(value)) return wanted;
      const entry = entryField(field);
      for (const [key, item] of Object.entries(value)) {
        if (checkConfigValue(entry, item)) return `every entry must be ${describe(entry)} ("${key}" is not)`;
      }
      return null;
    }
  }
}

/** What a field accepts, as a noun phrase for an error message or a tooltip. */
export function describe(field: ConfigField<unknown>): string {
  const orNull = field.nullable ? ", or null" : "";
  switch (field.type) {
    case "enum":
      return `one of ${(field.values ?? []).join(", ")}${orNull}`;
    case "string":
    case "path":
      return `a string${orNull}`;
    case "boolean":
      return `a boolean${orNull}`;
    case "number": {
      const min = field.min ?? 0;
      const range = field.max === undefined ? `a number of ${min} or more` : `a number between ${min} and ${field.max}`;
      return `${range}${orNull}`;
    }
    case "string[]":
    case "path[]":
      return `an array of strings${orNull}`;
    case "object[]":
      return `an array of objects${orNull}`;
    case "record":
      return `an object whose values are each ${describe(entryField(field))}`;
  }
}

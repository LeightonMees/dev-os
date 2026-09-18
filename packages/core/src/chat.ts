// The DEV chat: talk to DEV itself. The brain is an OpenAI-compatible model
// (Groq / Cerebras / OpenRouter / Ollama…) given DEV's own operations as tools.
// It plans, creates projects and tasks, and launches execution; the coding is
// still done by the workers. Every message and tool call is stored, so a
// conversation is state, not a transcript pasted into the next prompt.

import { runTask } from "./execution/runner.ts";
import { autoRun } from "./execution/auto.ts";
import { newId, now } from "./ids.ts";
import { chatCompletion, parseToolArguments, type ChatMessage, type ToolCall, type ToolDefinition } from "./llm/openai.ts";
import type { Dev } from "./dev.ts";
import type { Db, Row } from "./persistence/db.ts";
import { json } from "./persistence/db.ts";
import { applyPlan, planGoal, type PlanProposal } from "./plan.ts";
import { ApiWorker } from "./workers/api.ts";
import { OllamaWorker } from "./workers/ollama.ts";

export interface Conversation {
  id: string;
  projectId: string | null;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredMessage {
  id: number;
  conversationId: string;
  role: ChatMessage["role"];
  content: string | null;
  toolCalls: ToolCall[] | null;
  toolCallId: string | null;
  name: string | null;
  meta: Record<string, unknown>;
  createdAt: string;
}

export interface ChatTurn {
  conversation: Conversation;
  /** Messages appended by this turn (assistant text, tool calls and results). */
  messages: StoredMessage[];
  brain: { id: string; model: string };
}

export interface Brain {
  id: string;
  model: string;
  baseUrl: string;
  apiKey: string | null;
  headers?: Record<string, string>;
}

/** Chat completion function, injectable so tests never hit a network. */
export type ChatFn = (messages: ChatMessage[], tools: ToolDefinition[], brain: Brain, signal?: AbortSignal) => Promise<ChatMessage>;

export const defaultChatFn: ChatFn = async (messages, tools, brain, signal) =>
  (await chatCompletion({ baseUrl: brain.baseUrl, apiKey: brain.apiKey, model: brain.model, messages, tools, signal, timeoutMs: 120_000, extraHeaders: brain.headers })).message;

export class ChatStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  create(input: { projectId?: string | null; title?: string }): Conversation {
    const ts = now();
    const conversation: Conversation = { id: newId("chat"), projectId: input.projectId ?? null, title: input.title?.trim() || "New conversation", createdAt: ts, updatedAt: ts };
    this.#db.run("INSERT INTO conversations (id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", conversation.id, conversation.projectId, conversation.title, ts, ts);
    return conversation;
  }

  get(id: string): Conversation | undefined {
    const row = this.#db.get("SELECT * FROM conversations WHERE id = ?", id);
    return row ? rowToConversation(row) : undefined;
  }

  list(projectId?: string | null): Conversation[] {
    const rows = projectId ? this.#db.all("SELECT * FROM conversations WHERE project_id = ? OR project_id IS NULL ORDER BY updated_at DESC LIMIT 100", projectId) : this.#db.all("SELECT * FROM conversations ORDER BY updated_at DESC LIMIT 100");
    return rows.map(rowToConversation);
  }

  remove(id: string): void {
    this.#db.run("DELETE FROM conversations WHERE id = ?", id);
  }

  retitle(id: string, title: string): void {
    this.#db.run("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?", title.slice(0, 120), now(), id);
  }

  setProject(id: string, projectId: string | null): void {
    this.#db.run("UPDATE conversations SET project_id = ?, updated_at = ? WHERE id = ?", projectId, now(), id);
  }

  append(conversationId: string, message: ChatMessage, meta: Record<string, unknown> = {}): StoredMessage {
    const ts = now();
    const result = this.#db.run(
      "INSERT INTO chat_messages (conversation_id, role, content, tool_calls_json, tool_call_id, name, meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      conversationId,
      message.role,
      message.content ?? null,
      message.tool_calls ? JSON.stringify(message.tool_calls) : null,
      message.tool_call_id ?? null,
      message.name ?? null,
      JSON.stringify(meta),
      ts,
    );
    this.#db.run("UPDATE conversations SET updated_at = ? WHERE id = ?", ts, conversationId);
    return { id: Number(result.lastInsertRowid), conversationId, role: message.role, content: message.content ?? null, toolCalls: message.tool_calls ?? null, toolCallId: message.tool_call_id ?? null, name: message.name ?? null, meta, createdAt: ts };
  }

  messages(conversationId: string, limit = 400): StoredMessage[] {
    return this.#db.all("SELECT * FROM chat_messages WHERE conversation_id = ? ORDER BY id ASC LIMIT ?", conversationId, limit).map(rowToMessage);
  }
}

function rowToConversation(row: Row): Conversation {
  return { id: String(row.id), projectId: (row.project_id as string | null) ?? null, title: String(row.title), createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
}

function rowToMessage(row: Row): StoredMessage {
  return {
    id: Number(row.id),
    conversationId: String(row.conversation_id),
    role: row.role as ChatMessage["role"],
    content: (row.content as string | null) ?? null,
    toolCalls: json<ToolCall[] | null>(row.tool_calls_json, null),
    toolCallId: (row.tool_call_id as string | null) ?? null,
    name: (row.name as string | null) ?? null,
    meta: json(row.meta_json, {}),
    createdAt: String(row.created_at),
  };
}

/**
 * Every model that could answer, best first. The chat uses the first and hands over to the next
 * when one is rate-limited or erroring, so a spent free tier does not end the conversation.
 */
export async function resolveBrains(dev: Dev): Promise<Brain[]> {
  const wanted = dev.config.chat.worker;
  const candidates = wanted ? [wanted, ...dev.config.workers.api.providers.map((p) => p.id), "ollama"] : [...dev.config.workers.api.providers.map((p) => p.id), "ollama"];
  const brains: Brain[] = [];
  for (const id of new Set(candidates)) {
    const worker = dev.workers.get(id);
    if (!worker) continue;
    const last = dev.workers.lastHealth(id);
    const health = last && Date.now() - Date.parse(last.checkedAt) < 10 * 60 * 1000 ? last : await dev.workers.check(id);
    if (!health.ok) continue;
    if (worker instanceof ApiWorker) brains.push({ id, model: worker.provider.model, baseUrl: worker.provider.baseUrl, apiKey: worker.apiKey, headers: worker.provider.headers });
    else if (worker instanceof OllamaWorker) brains.push({ id, model: worker.model, baseUrl: `${dev.config.workers.ollama.baseUrl.replace(/\/+$/, "")}/v1`, apiKey: null });
  }
  return brains;
}

/** True for errors another provider could survive: rate limits, overload, upstream and network faults. */
export function isHandoverWorthy(error: unknown): boolean {
  const message = (error as Error)?.message ?? "";
  if (/\b(429|500|502|503|504)\b/.test(message)) return true;
  return /rate.?limit|quota|overloaded|capacity|too many requests|timed? out|fetch failed|ECONNRESET|socket hang up/i.test(message);
}

/** Which model answers. Explicit config wins; otherwise the first healthy API provider, then Ollama. */
export async function resolveBrain(dev: Dev): Promise<Brain> {
  const wanted = dev.config.chat.worker;
  const candidates = wanted ? [wanted] : [...dev.config.workers.api.providers.map((p) => p.id), "ollama"];
  const tried: string[] = [];
  for (const id of candidates) {
    const worker = dev.workers.get(id);
    if (!worker) {
      tried.push(`${id}: unknown worker`);
      continue;
    }
    const last = dev.workers.lastHealth(id);
    const health = last && Date.now() - Date.parse(last.checkedAt) < 10 * 60 * 1000 ? last : await dev.workers.check(id);
    if (!health.ok) {
      tried.push(`${id}: ${health.detail}`);
      continue;
    }
    if (worker instanceof ApiWorker) return { id, model: worker.provider.model, baseUrl: worker.provider.baseUrl, apiKey: worker.apiKey, headers: worker.provider.headers };
    if (worker instanceof OllamaWorker) return { id, model: worker.model, baseUrl: `${dev.config.workers.ollama.baseUrl.replace(/\/+$/, "")}/v1`, apiKey: null };
    tried.push(`${id}: not a chat-capable worker`);
  }
  throw new Error(`No chat brain available. ${tried.join("; ")}. Add an API key to Nexus secrets.env or start Ollama.`);
}

const TOOLS: ToolDefinition[] = [
  { type: "function", function: { name: "list_projects", description: "List registered projects with task counts.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "create_project", description: "Create a NEW project directory (README, .gitignore, optional node/python starter), git init it and register it. Use when the user wants to build something new.", parameters: { type: "object", properties: { name: { type: "string", description: "folder name, e.g. recipe-app" }, template: { type: "string", enum: ["empty", "node", "python"] }, goal: { type: "string" }, dir: { type: "string", description: "parent directory; omit for the default" } }, required: ["name"] } } },
  { type: "function", function: { name: "add_project", description: "Register an EXISTING directory as a project.", parameters: { type: "object", properties: { path: { type: "string" }, name: { type: "string" }, goal: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: { name: "project_status", description: "Current project: goal, milestone, task counts, blocked and runnable tasks, git branch.", parameters: { type: "object", properties: { projectId: { type: "string" } } } } },
  { type: "function", function: { name: "list_tasks", description: "Tasks of a project with status, dependencies and result summaries.", parameters: { type: "object", properties: { projectId: { type: "string" }, status: { type: "string" } } } } },
  { type: "function", function: { name: "plan_goal", description: "Turn a goal into a SMALL bounded plan (max ~6 tasks) for the next milestone using DEV's planner (it inspects the repository and asks Nexus for capabilities). Returns the proposal. Nothing is created until apply_plan.", parameters: { type: "object", properties: { projectId: { type: "string" }, goal: { type: "string" }, maxTasks: { type: "number" } }, required: ["goal"] } } },
  { type: "function", function: { name: "apply_plan", description: "Create the tasks from the most recent plan_goal proposal in this conversation.", parameters: { type: "object", properties: { projectId: { type: "string" } } } } },
  { type: "function", function: { name: "create_task", description: "Create one task directly (title, outcome, requirements, acceptance, verification command, dependencies by task id).", parameters: { type: "object", properties: { projectId: { type: "string" }, title: { type: "string" }, outcome: { type: "string" }, requirements: { type: "array", items: { type: "string" } }, acceptance: { type: "array", items: { type: "string" } }, verify: { type: "string", description: "shell command that must exit 0" }, command: { type: "string", description: "deterministic shell command instead of an agent" }, dependsOn: { type: "array", items: { type: "string" } }, ready: { type: "boolean" } }, required: ["title"] } } },
  { type: "function", function: { name: "run_task", description: "Start one READY task now (non-blocking). Returns the execution id.", parameters: { type: "object", properties: { taskId: { type: "string" }, workerId: { type: "string" } }, required: ["taskId"] } } },
  { type: "function", function: { name: "run_all_ready", description: "Start auto-run: every runnable task of the project in dependency order (non-blocking).", parameters: { type: "object", properties: { projectId: { type: "string" } } } } },
  { type: "function", function: { name: "task_detail", description: "One task: status, failure, result summary, evidence, last execution.", parameters: { type: "object", properties: { taskId: { type: "string" } }, required: ["taskId"] } } },
  { type: "function", function: { name: "list_workers", description: "Workers on this machine and their health.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "ask_human", description: "Ask the owner to do or decide something DEV cannot (credentials, accounts, a design choice, physical hardware, an approval). Creates a visible request and a notification; the conversation continues when they answer. Optionally attach it to a task, which then shows as needing a human.", parameters: { type: "object", properties: { question: { type: "string" }, taskId: { type: "string" }, projectId: { type: "string" } }, required: ["question"] } } },
  { type: "function", function: { name: "human_answers", description: "Pending and answered requests to the owner (from ask_human), newest first.", parameters: { type: "object", properties: { projectId: { type: "string" } } } } },
];

const SYSTEM_PROMPT = [
  "You are DEV, a local development operating system, talking to its owner. You are the project manager and dispatcher, not the coder: workers (Claude Code, Codex, Grok, API models, shell) do the coding when tasks run.",
  "You have tools that read and change DEV's real state. Use them; never invent projects, tasks, results or progress.",
  "Working style: understand the intent, then act in small verifiable slices. For a new app: create_project (pick node or python when it fits), then plan_goal with a tight goal, show the plan in one short list, and apply_plan and run_all_ready when the user agrees or when they asked you to just do it.",
  "Keep answers short and concrete: what you did, what is running, what needs the user. No marketing tone, no emoji, no restating the tools.",
  "If something failed, say the failure kind and the next action from DEV's state.",
  "When a step genuinely needs the owner (a key, an account, a decision between real options, hardware, an approval), call ask_human with one precise question instead of guessing, and say what you are waiting for.",
].join("\n");

/**
 * One turn: store the user message, run the tool loop with the brain, store
 * everything it said and did, and return what was appended.
 */
export async function chatTurn(dev: Dev, conversationId: string, userText: string, options: { chatFn?: ChatFn; signal?: AbortSignal; brain?: Brain } = {}): Promise<ChatTurn> {
  const conversation = dev.chat.get(conversationId);
  if (!conversation) throw new Error(`Unknown conversation ${conversationId}`);
  let brain = options.brain ?? (await resolveBrain(dev));
  const chatFn = options.chatFn ?? defaultChatFn;
  const appended: StoredMessage[] = [];
  const record = (message: ChatMessage, meta: Record<string, unknown> = {}) => {
    const stored = dev.chat.append(conversationId, message, meta);
    appended.push(stored);
    dev.events.emit("CHAT_MESSAGE", { projectId: conversation.projectId, data: { conversationId, role: message.role, id: stored.id } });
    return stored;
  };
  record({ role: "user", content: userText });
  if (conversation.title === "New conversation") dev.chat.retitle(conversationId, userText.slice(0, 80));

  const history = dev.chat.messages(conversationId).map(toChatMessage);
  const current = () => dev.projects.get(dev.chat.get(conversationId)?.projectId ?? "") ?? null;
  const context = current();
  const messages: ChatMessage[] = [
    { role: "system", content: `${SYSTEM_PROMPT}\n\nCurrent project: ${context ? `${context.name} (${context.id}) at ${context.path ?? "no repository yet"}${context.goal ? `; goal: ${context.goal}` : ""}` : "none selected; create or add one"}.\nDefault directory for new projects: ${dev.config.projects.defaultDir}.` },
    ...compact(history),
  ];
  let pendingPlan: PlanProposal | null = null;
  const maxCalls = dev.config.chat.maxToolCalls;
  let calls = 0;
  // The bench of models this turn can fall back to, best first, starting with the chosen brain.
  const bench = options.brain ? [options.brain] : [brain, ...(await resolveBrains(dev)).filter((b) => b.id !== brain.id)];
  let active = 0;
  /** Ask the current model; on a rate limit or upstream fault, hand the turn to the next one. */
  const ask = async (): Promise<ChatMessage> => {
    for (let attempt = active; attempt < bench.length; attempt++) {
      const candidate = bench[attempt] as Brain;
      try {
        const reply = await chatFn(messages, TOOLS, candidate, options.signal);
        if (attempt !== active) {
          dev.events.emit("CHAT_BRAIN_SWITCHED", { data: { conversationId, from: (bench[active] as Brain).id, to: candidate.id, model: candidate.model } });
          active = attempt;
        }
        return reply;
      } catch (error) {
        if (options.signal?.aborted) throw error;
        const last = attempt === bench.length - 1;
        if (last || !isHandoverWorthy(error)) throw error;
        dev.events.emit("CHAT_BRAIN_SWITCHED", { data: { conversationId, from: candidate.id, to: (bench[attempt + 1] as Brain).id, reason: (error as Error).message.slice(0, 200) } });
      }
    }
    throw new Error("No chat brain could answer");
  };
  for (let turn = 0; turn < 8; turn++) {
    const reply = await ask();
    brain = bench[active] as Brain;
    const assistant: ChatMessage = { role: "assistant", content: reply.content ?? null, tool_calls: reply.tool_calls };
    messages.push(assistant);
    record(assistant, { brain: brain.id, model: brain.model });
    const toolCalls = reply.tool_calls ?? [];
    if (toolCalls.length === 0) break;
    for (const call of toolCalls) {
      calls++;
      let output: string;
      if (calls > maxCalls) output = "refused: tool-call budget for this turn is spent; summarise and ask the user to continue";
      else {
        const args = parseToolArguments(call);
        try {
          const outcome = await runTool(dev, call.function.name, args, { conversationId, currentProject: current, pendingPlan, setPendingPlan: (p) => (pendingPlan = p) });
          output = outcome;
        } catch (error) {
          output = `error: ${(error as Error).message}`;
        }
      }
      const toolMessage: ChatMessage = { role: "tool", tool_call_id: call.id, name: call.function.name, content: output.slice(0, 12_000) };
      messages.push(toolMessage);
      record(toolMessage, { tool: call.function.name });
    }
  }
  return { conversation: dev.chat.get(conversationId) as Conversation, messages: appended, brain: { id: brain.id, model: brain.model } };
}

function toChatMessage(m: StoredMessage): ChatMessage {
  const out: ChatMessage = { role: m.role, content: m.content };
  if (m.toolCalls) out.tool_calls = m.toolCalls;
  if (m.toolCallId) out.tool_call_id = m.toolCallId;
  if (m.name) out.name = m.name;
  return out;
}

/** Keep the prompt small: the last 30 messages, with older tool outputs trimmed hard. */
function compact(history: ChatMessage[]): ChatMessage[] {
  const recent = history.slice(-30);
  return recent.map((m, i) => (m.role === "tool" && i < recent.length - 6 && m.content && m.content.length > 400 ? { ...m, content: m.content.slice(0, 400) + " …" } : m));
}

async function runTool(dev: Dev, name: string, args: Record<string, unknown>, ctx: { conversationId: string; currentProject: () => ReturnType<Dev["projects"]["get"]> | null; pendingPlan: PlanProposal | null; setPendingPlan: (p: PlanProposal | null) => void }): Promise<string> {
  const projectFrom = (id: unknown) => {
    const project = id ? dev.projects.resolve(String(id)) : ctx.currentProject();
    if (!project) throw new Error("No project selected. Use create_project or add_project first, or pass projectId.");
    return project;
  };
  switch (name) {
    case "list_projects":
      return JSON.stringify(dev.projects.list().map((p) => ({ id: p.id, name: p.name, lifecycle: p.lifecycle, kind: p.kind, parentId: p.parentId, path: p.path, goal: p.goal, milestone: p.milestone, tasks: dev.tasks.counts(p.id) })));
    case "create_project": {
      const project = dev.projects.create({ name: String(args.name ?? ""), dir: args.dir ? String(args.dir) : dev.config.projects.defaultDir, template: (args.template as "empty" | "node" | "python" | undefined) ?? "empty", goal: args.goal ? String(args.goal) : null });
      dev.chat.setProject(ctx.conversationId, project.id);
      return JSON.stringify({ created: true, id: project.id, name: project.name, path: project.path });
    }
    case "add_project": {
      const project = dev.projects.add({ path: String(args.path ?? ""), name: args.name ? String(args.name) : undefined, goal: args.goal ? String(args.goal) : null });
      dev.chat.setProject(ctx.conversationId, project.id);
      return JSON.stringify({ added: true, id: project.id, name: project.name, path: project.path });
    }
    case "project_status": {
      const project = projectFrom(args.projectId);
      const runnable = dev.tasks.runnable(project.id).map((t) => ({ id: t.id, title: t.title }));
      const blocked = dev.tasks.list({ projectId: project.id, status: "BLOCKED" }).map((t) => ({ id: t.id, title: t.title, failure: t.failure?.reason }));
      return JSON.stringify({ id: project.id, name: project.name, path: project.path, goal: project.goal, milestone: project.milestone, tasks: dev.tasks.counts(project.id), runnable, blocked, running: dev.executions.list({ projectId: project.id, status: "running" }).map((e) => ({ taskId: e.taskId, workerId: e.workerId })) });
    }
    case "list_tasks": {
      const project = projectFrom(args.projectId);
      const status = args.status ? String(args.status).toUpperCase() : undefined;
      return JSON.stringify(dev.tasks.list({ projectId: project.id }).filter((t) => !status || t.status === status).map((t) => ({ id: t.id, n: t.ordinal, title: t.title, status: t.status, dependsOn: t.dependsOn, result: t.resultSummary?.slice(0, 200) ?? null, failure: t.failure?.reason ?? null })));
    }
    case "plan_goal": {
      const project = projectFrom(args.projectId);
      const proposal = await planGoal(dev, project, String(args.goal ?? ""), { maxTasks: args.maxTasks ? Number(args.maxTasks) : undefined });
      ctx.setPendingPlan(proposal);
      dev.events.emit("PLAN_PROPOSED", { projectId: project.id, data: { goal: proposal.goal, milestone: proposal.milestone, tasks: proposal.tasks.length, via: "chat" } });
      return JSON.stringify({ milestone: proposal.milestone, summary: proposal.summary, plannedBy: proposal.workerId, tasks: proposal.tasks.map((t, i) => ({ n: i + 1, title: t.title, dependsOn: t.dependsOn.map((d) => d + 1), verification: t.verification.map((v) => v.command ?? v.path ?? v.kind) })), note: "call apply_plan to create these tasks" });
    }
    case "apply_plan": {
      if (!ctx.pendingPlan) return "error: no proposal in this turn; call plan_goal first";
      const project = projectFrom(args.projectId);
      const created = applyPlan(dev, project, ctx.pendingPlan);
      ctx.setPendingPlan(null);
      return JSON.stringify({ created: created.map((t) => ({ id: t.id, n: t.ordinal, title: t.title, status: dev.tasks.get(t.id)?.status })) });
    }
    case "create_task": {
      const project = projectFrom(args.projectId);
      const task = dev.tasks.create({
        projectId: project.id,
        title: String(args.title ?? ""),
        outcome: args.outcome ? String(args.outcome) : "",
        requirements: Array.isArray(args.requirements) ? args.requirements.map(String) : [],
        acceptance: Array.isArray(args.acceptance) ? args.acceptance.map(String) : [],
        verification: args.verify ? [{ kind: "command", command: String(args.verify) }] : [],
        command: args.command ? String(args.command) : null,
        dependsOn: Array.isArray(args.dependsOn) ? args.dependsOn.map(String) : [],
      });
      if (args.ready !== false && dev.tasks.unmetDependencies(task.id).length === 0) dev.tasks.setStatus(task.id, "READY", { reason: "created in chat" });
      return JSON.stringify({ id: task.id, n: task.ordinal, title: task.title, status: dev.tasks.get(task.id)?.status });
    }
    case "run_task": {
      const task = dev.tasks.resolve(String(args.taskId ?? ""), ctx.currentProject()?.id);
      if (!task) return `error: unknown task ${args.taskId}`;
      const started = new Promise<string>((resolve, reject) => {
        const off = dev.events.on((e) => {
          if (e.type === "TASK_STARTED" && e.taskId === task.id && e.executionId) {
            off();
            resolve(e.executionId);
          }
        });
        runTask(dev, task.id, { workerId: args.workerId ? String(args.workerId) : null }).then((execution) => (off(), resolve(execution.id))).catch((error: Error) => (off(), reject(error)));
      });
      const executionId = await started;
      return JSON.stringify({ started: true, taskId: task.id, executionId, note: "running in the background; use task_detail to check" });
    }
    case "run_all_ready": {
      const project = projectFrom(args.projectId);
      const runnable = dev.tasks.runnable(project.id);
      if (runnable.length === 0) return "nothing runnable: tasks must be READY with all dependencies DONE";
      void autoRun(dev, { projectId: project.id });
      return JSON.stringify({ started: true, runnable: runnable.map((t) => t.title) });
    }
    case "task_detail": {
      const task = dev.tasks.resolve(String(args.taskId ?? ""), ctx.currentProject()?.id);
      if (!task) return `error: unknown task ${args.taskId}`;
      const execution = dev.executions.list({ taskId: task.id, limit: 1 })[0];
      return JSON.stringify({ id: task.id, title: task.title, status: task.status, outcome: task.outcome, failure: task.failure, result: task.resultSummary, evidence: dev.evidence.list(task.id).map((e) => `${e.passed ? "✓" : "✗"} ${e.kind}: ${e.summary}`), execution: execution ? { id: execution.id, worker: execution.workerId, status: execution.status, durationMs: execution.durationMs, changedFiles: execution.changedFiles } : null });
    }
    case "list_workers":
      return JSON.stringify(dev.workers.list().map((w) => ({ id: w.id, type: w.type, healthy: w.health?.ok ?? null, detail: w.health?.detail ?? "unchecked", busy: !!w.currentTaskId })));
    case "ask_human": {
      const project = args.projectId || ctx.currentProject() ? projectFrom(args.projectId) : null;
      const task = args.taskId ? dev.tasks.resolve(String(args.taskId), project?.id) : undefined;
      const approval = dev.approvals.request({ projectId: project?.id ?? null, taskId: task?.id ?? null, action: "human-input", reason: String(args.question ?? "").trim() });
      return JSON.stringify({ asked: true, approvalId: approval.id, note: "the owner sees this in Problems and gets a notification; check human_answers later" });
    }
    case "human_answers": {
      const project = args.projectId || ctx.currentProject() ? projectFrom(args.projectId) : null;
      return JSON.stringify(dev.approvals.list({ projectId: project?.id }).filter((a) => a.action === "human-input").slice(0, 20).map((a) => ({ id: a.id, question: a.reason, status: a.status, answer: a.note, taskId: a.taskId, at: a.resolvedAt ?? a.requestedAt })));
    }
    default:
      return `error: unknown tool ${name}`;
  }
}

export { TOOLS as CHAT_TOOLS };

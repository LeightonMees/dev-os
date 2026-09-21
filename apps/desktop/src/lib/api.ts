import type { Approval, Artifact, ContextSection, ContextSnapshot, Decision, DevEvent, DoctorCheck, Evidence, Execution, Flow, FlowEdge, FlowNode, FlowNodeRun, FlowProblem, FlowRun, Project, Task, TaskStatus, WorkerInfo, DevConfig, PlanProposal } from "@dev/core";

export interface ArtifactMedia {
  type: string;
  form: "html" | "svg" | "image" | "markdown" | "pdf" | "model" | "text" | "binary";
  text: boolean;
}

export interface ArtifactContent {
  artifact: Artifact;
  media: ArtifactMedia;
  language: string | null;
  versions: number;
  content: string;
  truncated: boolean;
  /** False when the artifact is binary, or when only its tail was sent. */
  editable: boolean;
}

export type { Approval, Artifact, ContextSection, ContextSnapshot, Decision, DevEvent, DoctorCheck, Evidence, Execution, Flow, FlowEdge, FlowNode, FlowNodeRun, FlowProblem, FlowRun, Project, Task, TaskStatus, WorkerInfo, DevConfig, PlanProposal };

export interface ProjectWithCounts extends Project {
  tasks: Record<TaskStatus, number>;
}

export interface GitStatus {
  isRepo: boolean;
  root: string | null;
  branch: string | null;
  detached: boolean;
  dirty: boolean;
  changes: { status: string; path: string }[];
  ahead: number;
  behind: number;
  lastCommit: { hash: string; short: string; subject: string; author: string; date: string } | null;
  remote: string | null;
}

export interface ProjectDetail extends ProjectWithCounts {
  git: GitStatus;
  decisions: Decision[];
  running: Execution[];
}

export interface TaskDetail extends Task {
  dependencies: { id: string; title: string; status: TaskStatus }[];
  dependents: { id: string; title: string; status: TaskStatus }[];
  executions: Execution[];
  evidence: Evidence[];
  artifacts: Artifact[];
  events: DevEvent[];
  contextSnapshots: ContextSnapshot[];
  worker: WorkerInfo | null;
}

export interface ExecutionRow extends Execution {
  contextTokens: number | null;
  taskTitle: string | null;
}

export interface EvidenceRow extends Evidence {
  taskTitle: string | null;
}

export interface StatusSummary {
  home: string;
  version: string;
  projects: number;
  tasks: Record<TaskStatus, number>;
  running: Execution[];
  auto: { projectId: string; startedAt: string; ran: number; promoteBacklog: boolean }[];
  workers: WorkerInfo[];
  recentFailures: Task[];
  recentDone: Task[];
  pendingApprovals: number;
  latestEventId: number;
}

export interface UsageBucket {
  executions: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  durationMs: number;
}

export interface UsageReport {
  days: number;
  total: UsageBucket;
  byWorker: (UsageBucket & { workerId: string })[];
  byDay: (UsageBucket & { day: string })[];
  note: string;
}

export interface FileEntry {
  name: string;
  path: string;
  directory: boolean;
  size: number | null;
  modified: string | null;
}

export interface RoutingAdvice {
  capturedOn: string;
  current: Record<string, string[]>;
  /** The user's own general preference order. Empty = no opinion, and the advice below is in force. */
  stated: string[];
  /** True when DEV is actually routing by this advice rather than by a stated preference. */
  inUse: boolean;
  note: string;
  suggestions: {
    capability: string;
    order: string[];
    because: string;
    unavailable: string[];
    /** "weak" when the order rests on a single benchmark, or only discounted ones. */
    confidence: "strong" | "weak";
    evidence: { benchmark: string; what: string; source: string; readOn: string; weight: number; caveat?: string; scores: { model: string; score: string }[] }[];
  }[];
}

export interface ContextPreview {
  prompt: string;
  sections: ContextSection[];
  usedTokens: number;
  budgetTokens: number;
  snapshots: ContextSnapshot[];
}

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
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  toolCalls: { id: string; type: "function"; function: { name: string; arguments: string } }[] | null;
  toolCallId: string | null;
  name: string | null;
  meta: Record<string, unknown>;
  createdAt: string;
}

export interface ChatTurn {
  conversation: Conversation;
  messages: StoredMessage[];
  brain: { id: string; model: string };
}

export interface NexusMatch {
  kind: string;
  name: string;
  what: string;
  capabilities: string[];
  score: number;
  ready: boolean;
  blockers: string[];
  activate: string;
}

/**
 * A worker's two dials. `models` is which model it runs; `efforts` is how hard that model is told
 * to think. `efforts.levels` empty means the worker has no such dial and the control is omitted.
 */
export interface WorkerModelsResponse {
  models: { id: string; label: string; note?: string }[];
  source: string;
  detail: string | null;
  free: boolean;
  efforts: { levels: string[]; flag: string | null; source: string; free: boolean; current: string | null };
}

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Typed client for the control plane. Every screen reads through this; nothing caches stale copies of state. */
export class Api {
  baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // plain text
    }
    if (!response.ok) {
      const message = parsed && typeof parsed === "object" && "error" in parsed ? String((parsed as { error: unknown }).error) : text || response.statusText;
      throw new ApiError(response.status, message);
    }
    return parsed as T;
  }

  health() {
    return this.request<{ ok: boolean; version: string; home: string }>("GET", "/health");
  }
  status() {
    return this.request<StatusSummary>("GET", "/api/status");
  }
  doctor() {
    return this.request<DoctorCheck[]>("GET", "/api/doctor?desktop=1");
  }
  config() {
    return this.request<{ home: string; config: DevConfig; secrets: { loaded: string[]; files: string[] }; keys: { provider: string; env: string; set: boolean }[] }>("GET", "/api/config");
  }
  createProject(input: { name: string; dir?: string; template?: "empty" | "node" | "python"; git?: boolean; goal?: string }) {
    return this.request<Project>("POST", "/api/projects", { create: true, ...input });
  }
  workflows() {
    return this.request<{ name: string; description: string; hasRunner: boolean }[]>("GET", "/api/resources/workflows");
  }
  conversations(projectId?: string | null) {
    return this.request<Conversation[]>("GET", `/api/chat${projectId ? `?projectId=${projectId}` : ""}`);
  }
  createConversation(projectId?: string | null) {
    return this.request<Conversation>("POST", "/api/chat", { projectId });
  }
  conversation(id: string) {
    return this.request<{ conversation: Conversation; messages: StoredMessage[] }>("GET", `/api/chat/${id}`);
  }
  deleteConversation(id: string) {
    return this.request<{ removed: string }>("DELETE", `/api/chat/${id}`);
  }
  setConversationProject(id: string, projectId: string | null) {
    return this.request<Conversation>("PATCH", `/api/chat/${id}`, { projectId });
  }
  sendChat(id: string, text: string) {
    return this.request<ChatTurn>("POST", `/api/chat/${id}/messages`, { text });
  }
  cancelChat(id: string) {
    return this.request<{ cancelled: boolean }>("POST", `/api/chat/${id}/cancel`, {});
  }
  setConfig(key: string, value: string) {
    return this.request<{ config: DevConfig; note: string }>("PATCH", "/api/config", { key, value });
  }

  projects() {
    return this.request<ProjectWithCounts[]>("GET", "/api/projects");
  }
  project(id: string) {
    return this.request<ProjectDetail>("GET", `/api/projects/${id}`);
  }
  addProject(input: { path: string; name?: string; goal?: string }) {
    return this.request<Project>("POST", "/api/projects", input);
  }
  updateProject(id: string, patch: Record<string, unknown>) {
    return this.request<Project>("PATCH", `/api/projects/${id}`, patch);
  }
  removeProject(id: string) {
    return this.request<{ removed: string }>("DELETE", `/api/projects/${id}`);
  }
  gitStatus(id: string) {
    return this.request<GitStatus>("GET", `/api/projects/${id}/git`);
  }
  gitDiff(id: string, options: { stat?: boolean; staged?: boolean; path?: string } = {}) {
    const params = new URLSearchParams({ stat: options.stat ? "1" : "0", staged: options.staged ? "1" : "0" });
    if (options.path) params.set("path", options.path);
    return this.request<{ diff: string }>("GET", `/api/projects/${id}/git/diff?${params}`);
  }
  gitLog(id: string, limit = 20) {
    return this.request<{ hash: string; short: string; subject: string; author: string; date: string }[]>("GET", `/api/projects/${id}/git/log?limit=${limit}`);
  }
  gitBranches(id: string) {
    return this.request<{ current: string | null; all: string[] }>("GET", `/api/projects/${id}/git/branches`);
  }
  gitBranch(id: string, name: string) {
    return this.request<GitStatus>("POST", `/api/projects/${id}/git/branch`, { name });
  }
  gitCheckout(id: string, ref: string) {
    return this.request<GitStatus>("POST", `/api/projects/${id}/git/checkout`, { ref });
  }
  /** Either the commit, or — when the project requires approval — the approval that was filed instead. */
  gitCommit(id: string, message: string, taskId?: string) {
    return this.request<{ hash: string; short: string; subject: string } | { approvalRequired: true; approval: Approval }>("POST", `/api/projects/${id}/git/commit`, { message, taskId });
  }
  decisions(projectId: string) {
    return this.request<Decision[]>("GET", `/api/projects/${projectId}/decisions`);
  }
  addDecision(projectId: string, input: { title: string; decision: string; reason?: string; tags?: string[]; revisit?: string }) {
    return this.request<Decision>("POST", `/api/projects/${projectId}/decisions`, input);
  }

  tasks(projectId?: string, status?: TaskStatus[]) {
    const params = new URLSearchParams();
    if (projectId) params.set("projectId", projectId);
    if (status?.length) params.set("status", status.join(","));
    return this.request<Task[]>("GET", `/api/tasks?${params}`);
  }
  task(id: string) {
    return this.request<TaskDetail>("GET", `/api/tasks/${id}`);
  }
  createTask(input: Record<string, unknown>) {
    return this.request<Task>("POST", "/api/tasks", input);
  }
  updateTask(id: string, patch: Record<string, unknown>) {
    return this.request<Task>("PATCH", `/api/tasks/${id}`, patch);
  }
  deleteTask(id: string) {
    return this.request<{ removed: string }>("DELETE", `/api/tasks/${id}`);
  }
  moveTask(id: string, to: TaskStatus, options: { reason?: string; force?: boolean } = {}) {
    return this.request<Task>("POST", `/api/tasks/${id}/status`, { to, ...options });
  }
  runTask(id: string, options: { workerId?: string | null; force?: boolean } = {}) {
    return this.request<{ executionId: string; task: Task }>("POST", `/api/tasks/${id}/run`, options);
  }
  retryTask(id: string) {
    return this.request<Task>("POST", `/api/tasks/${id}/retry`, {});
  }
  cancelTask(id: string) {
    return this.request<{ cancelled: string[]; task: Task }>("POST", `/api/tasks/${id}/cancel`, {});
  }
  approveTask(id: string, reason?: string) {
    return this.request<Task>("POST", `/api/tasks/${id}/approve`, { reason });
  }
  /** Write an API key into the secrets file. The value is never read back from the server. */
  setSecret(name: string, value: string) {
    return this.request<{ name: string; file: string; replaced: boolean; affected: string[] }>("POST", "/api/secrets", { name, value });
  }
  setProviderModel(id: string, model: string) {
    return this.request<{ id: string; model: string; note: string }>("POST", `/api/providers/${id}/model`, { model });
  }
  setProviderEnabled(id: string, enabled: boolean) {
    return this.request<{ id: string; enabled: boolean; keyEnv: string | null; keySet: boolean; note: string }>("POST", `/api/providers/${id}/enabled`, { enabled });
  }
  /** Token and cost totals, taken from what the workers themselves reported. */
  usage(days = 30) {
    return this.request<UsageReport>("GET", `/api/usage?days=${days}`);
  }
  /** The project's own files, for the built-in editor. */
  files(projectId: string, path = "") {
    return this.request<{ root: string; path: string; entries: FileEntry[] }>("GET", `/api/projects/${projectId}/files?path=${encodeURIComponent(path)}`);
  }
  file(projectId: string, path: string) {
    return this.request<{ path: string; content: string; size: number; modified: string }>("GET", `/api/projects/${projectId}/file?path=${encodeURIComponent(path)}`);
  }
  saveFile(projectId: string, path: string, content: string, modified?: string) {
    return this.request<{ path: string; size: number; modified: string }>("PUT", `/api/projects/${projectId}/file`, { path, content, modified });
  }
  /** What public benchmarks say about which worker to use for what, with their sources. */
  routingSuggestion() {
    return this.request<RoutingAdvice>("GET", "/api/routing/suggestion");
  }
  /** The models a worker can actually be given, discovered from the tool itself. */
  workerModels(id: string) {
    return this.request<WorkerModelsResponse>("GET", `/api/workers/${id}/models`);
  }
  // ----- flows -----
  flows(projectId?: string | null) {
    return this.request<Flow[]>("GET", `/api/flows${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`);
  }
  flow(id: string) {
    return this.request<{ flow: Flow; problems: FlowProblem[]; runs: FlowRun[]; running: { runId: string | null; startedAt: string } | null }>("GET", `/api/flows/${id}`);
  }
  createFlow(body: { projectId: string; name: string; description?: string; nodes?: FlowNode[]; edges?: FlowEdge[] }) {
    return this.request<Flow>("POST", "/api/flows", body);
  }
  saveFlow(id: string, patch: { name?: string; description?: string; nodes?: FlowNode[]; edges?: FlowEdge[] }) {
    return this.request<{ flow: Flow; problems: FlowProblem[] }>("PATCH", `/api/flows/${id}`, patch);
  }
  deleteFlow(id: string) {
    return this.request<{ deleted: boolean }>("DELETE", `/api/flows/${id}`);
  }
  runFlow(id: string) {
    return this.request<{ started: boolean; flowId: string; steps: number }>("POST", `/api/flows/${id}/run`, {});
  }
  stopFlow(id: string) {
    return this.request<{ stopped: boolean }>("POST", `/api/flows/${id}/stop`, {});
  }
  flowRun(runId: string) {
    return this.request<{ run: FlowRun; steps: FlowNodeRun[] }>("GET", `/api/flow-runs/${runId}`);
  }

  ollamaModels() {
    return this.request<{ reachable: boolean; baseUrl: string; models: { name: string; size: number | null; parameters: string | null }[]; detail: string | null }>("GET", "/api/ollama/models");
  }
  ollamaPull(model: string) {
    return this.request<{ pulled: string; detail: string }>("POST", "/api/ollama/pull", { model });
  }
  /** Record the user's answer to a task that needs them; optionally mark it ready or done afterwards. */
  answerTask(id: string, answer: string, next: "none" | "ready" | "done" = "none") {
    return this.request<Task>("POST", `/api/tasks/${id}/answer`, { answer, next });
  }
  rejectTask(id: string, reason: string) {
    return this.request<Task>("POST", `/api/tasks/${id}/reject`, { reason });
  }
  addDependency(id: string, dependsOn: string) {
    return this.request<Task>("POST", `/api/tasks/${id}/deps`, { dependsOn });
  }
  removeDependency(id: string, dependsOn: string) {
    return this.request<Task>("DELETE", `/api/tasks/${id}/deps/${dependsOn}`);
  }
  context(id: string, budget?: number) {
    return this.request<ContextPreview>("GET", `/api/tasks/${id}/context${budget ? `?budget=${budget}` : ""}`);
  }
  log(id: string, options: { execution?: string; tail?: number } = {}) {
    const params = new URLSearchParams();
    if (options.execution) params.set("execution", options.execution);
    if (options.tail) params.set("tail", String(options.tail));
    return this.request<{ execution: Execution | null; log: string }>("GET", `/api/tasks/${id}/log?${params}`);
  }
  autoRun(projectId: string, options: { maxTasks?: number; workerId?: string | null; promoteBacklog?: boolean } = {}) {
    return this.request<{ started: boolean; runnable: number; promoteBacklog: boolean }>("POST", `/api/projects/${projectId}/auto`, options);
  }
  autoStop(projectId: string) {
    return this.request<{ stopped: boolean }>("POST", `/api/projects/${projectId}/auto/stop`, {});
  }

  executions(filter: { taskId?: string; projectId?: string; status?: string; limit?: number } = {}) {
    const params = new URLSearchParams();
    if (filter.taskId) params.set("taskId", filter.taskId);
    if (filter.projectId) params.set("projectId", filter.projectId);
    if (filter.status) params.set("status", filter.status);
    if (filter.limit) params.set("limit", String(filter.limit));
    return this.request<ExecutionRow[]>("GET", `/api/executions?${params}`);
  }
  evidence(projectId?: string, limit = 100) {
    const params = new URLSearchParams();
    if (projectId) params.set("projectId", projectId);
    params.set("limit", String(limit));
    return this.request<EvidenceRow[]>("GET", `/api/evidence?${params}`);
  }
  workers() {
    return this.request<WorkerInfo[]>("GET", "/api/workers");
  }
  checkWorker(id: string) {
    return this.request<WorkerInfo>("POST", `/api/workers/${id}/check`, {});
  }
  nexusStatus() {
    return this.request<{ skills: number; mcps: number; apis: number; workflows: number; root: string; tools: string[] }>("GET", "/api/resources/status");
  }
  nexusSearch(q: string, limit = 10) {
    return this.request<NexusMatch[]>("GET", `/api/resources/search?q=${encodeURIComponent(q)}&limit=${limit}`);
  }
  approvals(status?: "pending" | "approved" | "denied") {
    return this.request<Approval[]>("GET", `/api/approvals${status ? `?status=${status}` : ""}`);
  }
  resolveApproval(id: string, status: "approved" | "denied", note?: string) {
    return this.request<Approval>("POST", `/api/approvals/${id}/resolve`, { status, note });
  }
  structure(projectId: string) {
    return this.request<{ milestones: { name: string; counts: Record<TaskStatus, number>; epics: { name: string; counts: Record<TaskStatus, number> }[] }[]; unassigned: number }>("GET", `/api/projects/${projectId}/structure`);
  }
  artifacts(filter: { projectId?: string; taskId?: string } = {}) {
    const params = new URLSearchParams();
    if (filter.projectId) params.set("projectId", filter.projectId);
    if (filter.taskId) params.set("taskId", filter.taskId);
    return this.request<Artifact[]>("GET", `/api/artifacts?${params}`);
  }
  artifactContent(id: string, max = 120_000) {
    return this.request<ArtifactContent>("GET", `/api/artifacts/${id}/content?max=${max}`);
  }
  /** URL the preview loads the artifact's own bytes from. Not a fetch: the img/iframe reads it. */
  artifactRawUrl(id: string) {
    return `${this.baseUrl}/api/artifacts/${id}/raw`;
  }
  artifactVersions(id: string) {
    return this.request<Artifact[]>("GET", `/api/artifacts/${id}/versions`);
  }
  /** Save an edit as the next version. The original file is never overwritten. */
  reviseArtifact(id: string, content: string) {
    return this.request<Artifact>("POST", `/api/artifacts/${id}/revise`, { content });
  }
  events(filter: { projectId?: string; taskId?: string; since?: number; limit?: number } = {}) {
    const params = new URLSearchParams();
    if (filter.projectId) params.set("projectId", filter.projectId);
    if (filter.taskId) params.set("taskId", filter.taskId);
    if (filter.since !== undefined) params.set("since", String(filter.since));
    if (filter.limit) params.set("limit", String(filter.limit));
    return this.request<DevEvent[]>("GET", `/api/events?${params}`);
  }
  plan(projectId: string, goal: string, options: { workerId?: string | null; maxTasks?: number } = {}) {
    return this.request<PlanProposal>("POST", "/api/plan", { projectId, goal, ...options });
  }
  applyPlan(projectId: string, proposal: PlanProposal) {
    return this.request<Task[]>("POST", "/api/plan/apply", { projectId, proposal });
  }

  /** Server-sent events. Returns a closer. */
  subscribe(onEvent: (event: DevEvent) => void, onState?: (connected: boolean) => void): () => void {
    const source = new EventSource(`${this.baseUrl}/api/events/stream`);
    const handler = (message: MessageEvent<string>) => {
      try {
        onEvent(JSON.parse(message.data) as DevEvent);
      } catch {
        // malformed frame
      }
    };
    source.onopen = () => onState?.(true);
    source.onerror = () => onState?.(false);
    // Named events: one listener per known type is noisy; the server also sends the type inside the data,
    // so we listen to the union of types via a catch-all by re-registering for each type the UI cares about.
    for (const type of EVENT_TYPES) source.addEventListener(type, handler as EventListener);
    return () => source.close();
  }
}

export const EVENT_TYPES = [
  "PROJECT_ADDED",
  "PROJECT_UPDATED",
  "PROJECT_REMOVED",
  "TASK_CREATED",
  "TASK_UPDATED",
  "TASK_DELETED",
  "TASK_STATUS_CHANGED",
  "TASK_READY",
  "TASK_STARTED",
  "TASK_BLOCKED",
  "TASK_COMPLETED",
  "TASK_CANCELLED",
  "WORKER_SELECTED",
  "WORKER_HEALTH",
  "CONTEXT_ASSEMBLED",
  "COMMAND_STARTED",
  "COMMAND_OUTPUT",
  "COMMAND_FINISHED",
  "FILE_CHANGED",
  "VERIFICATION_STARTED",
  "VERIFICATION_PASSED",
  "VERIFICATION_FAILED",
  "ARTIFACT_CREATED",
  "EVIDENCE_RECORDED",
  "REVIEW_REQUESTED",
  "APPROVAL_REQUESTED",
  "APPROVAL_RESOLVED",
  "DECISION_RECORDED",
  "PLAN_PROPOSED",
  "PLAN_APPLIED",
  "GIT_COMMIT",
  "CHAT_MESSAGE",
  "AUTO_RUN_STARTED",
  "AUTO_RUN_FINISHED",
] as const;

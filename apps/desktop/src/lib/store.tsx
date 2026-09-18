import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { Api, type Approval, type DevEvent, type EvidenceRow, type ProjectWithCounts, type StatusSummary, type Task, type TaskStatus } from "./api.ts";
import { notify } from "./notify.ts";
import { ensureControlPlane } from "./native.ts";

export type Section = "overview" | "chat" | "work" | "flows" | "editor" | "workers" | "terminal" | "git" | "artifacts" | "resources" | "settings";

export const SECTIONS: { id: Section; label: string; key: string; icon: string }[] = [
  { id: "overview", label: "Overview", key: "1", icon: "overview" },
  { id: "chat", label: "Chat", key: "2", icon: "chat" },
  { id: "work", label: "Work", key: "3", icon: "work" },
  // Flows sits next to Work because it is the other way work gets done. It takes "-" rather than a
  // digit so the existing shortcuts keep the positions the user already has in their fingers.
  { id: "flows", label: "Flows", key: "-", icon: "flows" },
  { id: "editor", label: "Editor", key: "4", icon: "editor" },
  { id: "workers", label: "Workers", key: "5", icon: "workers" },
  { id: "terminal", label: "Terminal", key: "6", icon: "terminal" },
  { id: "git", label: "Git", key: "7", icon: "git" },
  { id: "artifacts", label: "Artifacts", key: "8", icon: "artifacts" },
  { id: "resources", label: "Resources", key: "9", icon: "resources" },
  { id: "settings", label: "Settings", key: "0", icon: "settings" },
];

export type BottomTab = "activity" | "output" | "checks" | "problems";
export type WorkMode = "board" | "list" | "graph";
export type DialogKind = "task" | "plan" | "project" | "newProject" | "editProject" | null;

export interface OutputChunk {
  stream: "stdout" | "stderr";
  chunk: string;
}

export interface Toast {
  id: number;
  kind: "info" | "error" | "success";
  text: string;
}

interface StoreValue {
  api: Api;
  connection: "connecting" | "connected" | "offline";
  connectionError: string | null;
  home: string | null;
  status: StatusSummary | null;
  projects: ProjectWithCounts[];
  /** ACTIVE and NEXT projects (plus the current one) unless showAllProjects is on. */
  visibleProjects: ProjectWithCounts[];
  showAllProjects: boolean;
  setShowAllProjects: (on: boolean) => void;
  currentProjectId: string | null;
  currentProject: ProjectWithCounts | null;
  tasks: Task[];
  checks: EvidenceRow[];
  /** Requests waiting for a person: approvals, questions from the brain. */
  attention: Approval[];
  section: Section;
  selectedTaskId: string | null;
  selectedWorkerId: string | null;
  conversationId: string | null;
  selectConversation: (id: string | null) => void;
  workMode: WorkMode;
  workFilter: string | null;
  /** "m:<milestone>" or "e:<milestone>|<epic>" to narrow the Work view. */
  workGroup: string | null;
  setWorkGroup: (group: string | null) => void;
  bottomOpen: boolean;
  bottomTab: BottomTab;
  sidebarOpen: boolean;
  paletteOpen: boolean;
  dialog: DialogKind;
  feed: DevEvent[];
  output: Map<string, OutputChunk[]>;
  toasts: Toast[];
  setSection: (section: Section) => void;
  selectProject: (id: string | null) => void;
  selectTask: (id: string | null) => void;
  selectWorker: (id: string | null) => void;
  setWorkMode: (mode: WorkMode) => void;
  setWorkFilter: (filter: string | null) => void;
  setBottom: (open: boolean, tab?: BottomTab) => void;
  toggleSidebar: () => void;
  setPalette: (open: boolean) => void;
  openDialog: (kind: DialogKind) => void;
  refresh: () => Promise<void>;
  toast: (kind: Toast["kind"], text: string) => void;
  dismissToast: (id: number) => void;
  /** Wrap an API call: shows the error as a toast, refreshes on success. */
  act: <T>(fn: () => Promise<T>, successText?: string) => Promise<T | undefined>;
  /** Move a task; if only unfinished dependencies block it, offer to queue it anyway. */
  moveTaskAsked: (id: string, to: TaskStatus) => Promise<Task | undefined>;
}

const StoreContext = createContext<StoreValue | null>(null);

const REFRESH_EVENTS = new Set([
  "PROJECT_ADDED",
  "PROJECT_UPDATED",
  "PROJECT_REMOVED",
  "TASK_CREATED",
  "TASK_UPDATED",
  "TASK_DELETED",
  "TASK_STATUS_CHANGED",
  "TASK_STARTED",
  "TASK_COMPLETED",
  "TASK_BLOCKED",
  "TASK_CANCELLED",
  "PLAN_APPLIED",
  "WORKER_HEALTH",
  "COMMAND_FINISHED",
  "EVIDENCE_RECORDED",
  "GIT_COMMIT",
  "APPROVAL_REQUESTED",
  "APPROVAL_RESOLVED",
]);

/** Events that mean a person has to act. These raise a toast and an OS notification. */
function describeAttention(event: DevEvent): { title: string; text: string } | null {
  switch (event.type) {
    case "REVIEW_REQUESTED":
      return { title: "DEV needs your review", text: `A task is waiting for your review${event.data.reason ? `: ${event.data.reason}` : ""}.` };
    case "APPROVAL_REQUESTED":
      return { title: event.data.action === "human-input" ? "DEV has a question for you" : "DEV needs your approval", text: String(event.data.reason ?? event.data.action ?? "") };
    case "TASK_BLOCKED": {
      const failure = event.data.failure as { kind?: string; reason?: string } | undefined;
      if (!failure) return null;
      if (failure.kind === "worker-unavailable" || failure.kind === "approval-denied" || failure.kind === "dependency-missing" || failure.kind === "review-rejected") return null;
      return { title: "A task is blocked", text: `${failure.kind}: ${String(failure.reason ?? "").slice(0, 140)}` };
    }
    default:
      return null;
  }
}

const MAX_FEED = 400;
const MAX_OUTPUT_CHUNKS = 2000;
const LEGACY_SECTIONS: Record<string, Section> = { home: "overview", project: "work", tasks: "work" };

export function StoreProvider({ children, initialBaseUrl }: { children: ReactNode; initialBaseUrl?: string }) {
  const api = useMemo(() => new Api(initialBaseUrl ?? "http://127.0.0.1:47831"), [initialBaseUrl]);
  const [connection, setConnection] = useState<StoreValue["connection"]>("connecting");
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [home, setHome] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusSummary | null>(null);
  const [projects, setProjects] = useState<ProjectWithCounts[]>([]);
  const [showAllProjects, setShowAllProjectsState] = useState<boolean>(() => safeStorage("get", "dev.projects.all") === "1");
  const setShowAllProjects = useCallback((on: boolean) => {
    setShowAllProjectsState(on);
    safeStorage("set", "dev.projects.all", on ? "1" : "0");
  }, []);
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(() => safeStorage("get", "dev.project"));
  /** The project a request was made for. Anything that arrives for a different one is discarded. */
  const projectRef = useRef<string | null>(currentProjectId);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [checks, setChecks] = useState<EvidenceRow[]>([]);
  const [attention, setAttention] = useState<Approval[]>([]);
  const [section, setSectionState] = useState<Section>(() => {
    const saved = safeStorage("get", "dev.section") ?? "overview";
    return (LEGACY_SECTIONS[saved] ?? (SECTIONS.some((s) => s.id === saved) ? saved : "overview")) as Section;
  });
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedWorkerId, setSelectedWorkerId] = useState<string | null>(null);
  const [conversationId, setConversationIdState] = useState<string | null>(() => safeStorage("get", "dev.conversation"));
  const [workMode, setWorkModeState] = useState<WorkMode>(() => (safeStorage("get", "dev.workMode") as WorkMode | null) ?? "board");
  const [workFilter, setWorkFilter] = useState<string | null>(null);
  const [workGroup, setWorkGroup] = useState<string | null>(null);
  const [bottomOpen, setBottomOpen] = useState<boolean>(() => safeStorage("get", "dev.bottom") !== "closed");
  const [bottomTab, setBottomTab] = useState<BottomTab>(() => (safeStorage("get", "dev.bottomTab") as BottomTab | null) ?? "activity");
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => safeStorage("get", "dev.sidebar") !== "closed");
  const [paletteOpen, setPalette] = useState(false);
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [feed, setFeed] = useState<DevEvent[]>([]);
  const [output, setOutput] = useState<Map<string, OutputChunk[]>>(new Map());
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);
  const refreshTimer = useRef<number | null>(null);
  const connectionRef = useRef(connection);
  connectionRef.current = connection;

  const toast = useCallback((kind: Toast["kind"], text: string) => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, kind, text }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 8000 : 3500);
  }, []);
  const dismissToast = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const refresh = useCallback(async () => {
    // The project is read from the ref, not from a closure: a refresh started before a project
    // switch must never write the old project's tasks over the new one's.
    try {
      const [summary, list, pending] = await Promise.all([api.status(), api.projects(), api.approvals("pending").catch(() => [] as Approval[])]);
      setStatus(summary);
      setAttention(pending);
      setHome(summary.home);
      setProjects(list);
      setConnection("connected");
      setConnectionError(null);
      const asked = projectRef.current;
      const projectId = asked && list.some((p) => p.id === asked) ? asked : (list[0]?.id ?? null);
      if (projectId !== asked) {
        projectRef.current = projectId;
        setCurrentProjectId(projectId);
        safeStorage("set", "dev.project", projectId ?? "");
      }
      if (projectId) {
        const [taskList, evidence] = await Promise.all([api.tasks(projectId), api.evidence(projectId, 60).catch(() => [] as EvidenceRow[])]);
        // Drop the answer if the user moved on while it was in flight.
        if (projectRef.current !== projectId) return;
        setTasks(taskList);
        setChecks(evidence);
      } else {
        setTasks([]);
        setChecks([]);
      }
    } catch (error) {
      setConnection("offline");
      setConnectionError((error as Error).message);
    }
  }, [api]);

  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current !== null) return;
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = null;
      void refresh();
    }, 150);
  }, [refresh]);

  // Boot: make sure the control plane is up (inside Tauri), then load and subscribe.
  useEffect(() => {
    let closer: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const info = await ensureControlPlane();
      if (cancelled) return;
      if (info?.url) api.baseUrl = info.url;
      if (info?.error) setConnectionError(info.error);
      await refresh();
      if (cancelled) return;
      closer = api.subscribe(
        (event) => {
          if (event.type === "COMMAND_OUTPUT") {
            const key = event.executionId ?? "?";
            setOutput((current) => {
              const next = new Map(current);
              const chunks = [...(next.get(key) ?? []), { stream: (event.data.stream as "stdout" | "stderr") ?? "stdout", chunk: String(event.data.chunk ?? "") }];
              next.set(key, chunks.length > MAX_OUTPUT_CHUNKS ? chunks.slice(-MAX_OUTPUT_CHUNKS) : chunks);
              return next;
            });
            return;
          }
          setFeed((current) => {
            const next = [...current, event];
            return next.length > MAX_FEED ? next.slice(-MAX_FEED) : next;
          });
          if (REFRESH_EVENTS.has(event.type)) scheduleRefresh();
          const human = describeAttention(event);
          if (human) {
            toast("info", human.text);
            void notify(human.title, human.text);
          }
        },
        (connected) => {
          if (connected) setConnection("connected");
          else {
            setConnection("offline");
            scheduleRefresh();
          }
        },
      );
    })();
    const poll = window.setInterval(() => {
      if (connectionRef.current === "offline") void refresh();
    }, 5000);
    return () => {
      cancelled = true;
      closer?.();
      window.clearInterval(poll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  // Load the selected project's work. Every answer is checked against the project that is still
  // selected when it arrives, so a slow reply for the previous project is discarded rather than shown.
  useEffect(() => {
    const wanted = currentProjectId;
    if (!wanted) {
      setTasks([]);
      setChecks([]);
      setFeed([]);
      return;
    }
    // The id is remembered across restarts, so on a cold start it may name a
    // project this database has never heard of (it was deleted, or DEV_HOME
    // changed). Wait until the server's list confirms it exists: refresh()
    // loads the tasks itself once it has picked a valid project, so nothing is
    // lost by not firing three requests that can only 404.
    if (!projects.some((p) => p.id === wanted)) return;
    let stale = false;
    const fresh = <T,>(apply: (value: T) => void) => (value: T) => {
      if (!stale && projectRef.current === wanted) apply(value);
    };
    api.tasks(wanted).then(fresh(setTasks)).catch(() => undefined);
    api.evidence(wanted, 60).then(fresh(setChecks)).catch(() => undefined);
    api.events({ projectId: wanted, limit: 100 }).then(fresh(setFeed)).catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [api, currentProjectId, projects]);

  const setSection = useCallback((next: Section) => {
    setSectionState(next);
    safeStorage("set", "dev.section", next);
  }, []);
  const selectProject = useCallback(
    (id: string | null) => {
      // Point the ref at the new project before anything is fetched, and clear the old project's
      // work immediately: the board shows nothing rather than the wrong project's tasks.
      projectRef.current = id;
      setCurrentProjectId(id);
      safeStorage("set", "dev.project", id ?? "");
      setSelectedTaskId(null);
      setTasks([]);
      setChecks([]);
      setFeed([]);
      void refresh();
    },
    [refresh],
  );
  const selectTask = useCallback((id: string | null) => {
    setSelectedTaskId(id);
    if (id) setSelectedWorkerId(null);
  }, []);
  const selectWorker = useCallback((id: string | null) => {
    setSelectedWorkerId(id);
    if (id) setSelectedTaskId(null);
  }, []);
  const selectConversation = useCallback((id: string | null) => {
    setConversationIdState(id);
    safeStorage("set", "dev.conversation", id ?? "");
  }, []);
  const setWorkMode = useCallback((mode: WorkMode) => {
    setWorkModeState(mode);
    safeStorage("set", "dev.workMode", mode);
  }, []);
  const setBottom = useCallback((open: boolean, tab?: BottomTab) => {
    setBottomOpen(open);
    safeStorage("set", "dev.bottom", open ? "open" : "closed");
    if (tab) {
      setBottomTab(tab);
      safeStorage("set", "dev.bottomTab", tab);
    }
  }, []);
  const toggleSidebar = useCallback(() => {
    setSidebarOpen((open) => {
      safeStorage("set", "dev.sidebar", open ? "closed" : "open");
      return !open;
    });
  }, []);
  const openDialog = useCallback((kind: DialogKind) => setDialog(kind), []);
  const act = useCallback(
    async <T,>(fn: () => Promise<T>, successText?: string): Promise<T | undefined> => {
      try {
        const result = await fn();
        if (successText) toast("success", successText);
        scheduleRefresh();
        return result;
      } catch (error) {
        toast("error", (error as Error).message);
        return undefined;
      }
    },
    [scheduleRefresh, toast],
  );

  /**
   * Move a task, and when the state machine refuses only because upstream work is unfinished,
   * say which task blocks it and let the user queue it anyway. Anything else is a plain error.
   */
  const moveTaskAsked = useCallback(
    async (id: string, to: TaskStatus) => {
      try {
        const moved = await api.moveTask(id, to);
        toast("success", `Moved to ${to.charAt(0) + to.slice(1).toLowerCase()}`);
        scheduleRefresh();
        return moved;
      } catch (error) {
        const message = (error as Error).message;
        if (!/still depends on/i.test(message)) {
          toast("error", message);
          return undefined;
        }
        // The core names the blocking tasks by id; show their titles, which is what the user recognises.
        const ids = message.match(/tsk_[a-z0-9]+/gi) ?? [];
        const named = ids.map((depId) => {
          const dep = tasks.find((t) => t.id === depId);
          const state = message.match(new RegExp(depId + " [(]([A-Z]+)[)]"))?.[1] ?? "";
          return dep ? `“${dep.title}”${state ? ` (${state.toLowerCase()})` : ""}` : depId;
        });
        const unfinished = named.length ? named.join(", ") : message.replace(/^.*still depends on /i, "").replace(/\. Finish those.*$/i, "");
        const question = `This task still depends on ${unfinished}.

Queue it anyway? The worker starts without those results in its brief.`;
        if (!window.confirm(question)) return undefined;
        const forced = await act(() => api.moveTask(id, to, { force: true, reason: "queued by the user before its dependencies finished" }), "Queued anyway");
        return forced;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, act, scheduleRefresh, tasks, toast],
  );


  const value: StoreValue = {
    api,
    moveTaskAsked,
    connection,
    connectionError,
    home,
    status,
    projects,
    visibleProjects: showAllProjects ? projects : projects.filter((p) => p.lifecycle === "ACTIVE" || p.lifecycle === "NEXT" || p.id === currentProjectId),
    showAllProjects,
    setShowAllProjects,
    currentProjectId,
    currentProject: projects.find((p) => p.id === currentProjectId) ?? null,
    tasks,
    checks,
    attention,
    section,
    selectedTaskId,
    selectedWorkerId,
    conversationId,
    selectConversation,
    workMode,
    workFilter,
    workGroup,
    setWorkGroup,
    bottomOpen,
    bottomTab,
    sidebarOpen,
    paletteOpen,
    dialog,
    feed,
    output,
    toasts,
    setSection,
    selectProject,
    selectTask,
    selectWorker,
    setWorkMode,
    setWorkFilter,
    setBottom,
    toggleSidebar,
    setPalette,
    openDialog,
    refresh,
    toast,
    dismissToast,
    act,
  };
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreValue {
  const value = useContext(StoreContext);
  if (!value) throw new Error("useStore outside StoreProvider");
  return value;
}

function safeStorage(op: "get", key: string): string | null;
function safeStorage(op: "set", key: string, value: string): void;
function safeStorage(op: "get" | "set", key: string, value?: string): string | null | void {
  try {
    if (op === "get") return window.localStorage.getItem(key);
    window.localStorage.setItem(key, value ?? "");
  } catch {
    return null;
  }
}

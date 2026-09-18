import { useEffect, useState } from "react";

import type { Artifact, Conversation, GitStatus, TaskStatus, ProjectWithCounts } from "../lib/api.ts";
import { ago, STATUS_LABEL, STATUS_ORDER, STATUS_SYMBOL, truncate } from "../lib/format.ts";
import { SECTIONS, useStore } from "../lib/store.tsx";
import { Icon } from "./Icon.tsx";
import { Term } from "./Term.tsx";

/**
 * Sections whose content belongs to one project, and so are the only ones that should carry the
 * project switcher. It used to render on all nine, which put a project picker on Settings, Workers
 * and Resources (none of which read the current project at all) and a second, redundant one on
 * Overview, whose whole body is already a searchable project list that selects a project.
 */
const PROJECT_SCOPED = new Set(["chat", "work", "editor", "flows", "terminal", "git", "artifacts"]);

/** Contextual navigation for the current section. Real state only. */
export function SideBar() {
  const { section, visibleProjects: projects, currentProjectId, selectProject, currentProject } = useStore();
  const label = SECTIONS.find((s) => s.id === section)?.label ?? "";
  return (
    <aside className="sidebar" aria-label={`${label} navigation`}>
      <div className="sidebar-head">
        {label}
        <span className="spacer" />
      </div>
      {PROJECT_SCOPED.has(section) && (
        <div className="project-switch">
          <select value={currentProjectId ?? ""} onChange={(e) => selectProject(e.target.value || null)} aria-label="Current project" title={currentProject?.path ?? ""}>
            {projects.length === 0 && <option value="">No project</option>}
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="sidebar-body">
        {section === "overview" && <OverviewSide />}
        {section === "chat" && <ChatSide />}
        {section === "work" && <WorkSide />}
        {section === "workers" && <WorkersSide />}
        {section === "terminal" && <TerminalSide />}
        {section === "git" && <GitSide />}
        {section === "artifacts" && <ArtifactsSide />}
        {section === "resources" && <ResourcesSide />}
        {section === "settings" && <SettingsSide />}
      </div>
    </aside>
  );
}

function OverviewSide() {
  const { projects, visibleProjects, showAllProjects, setShowAllProjects, currentProjectId, selectProject, openDialog } = useStore();
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const pool = q ? projects : visibleProjects;
  const shown = q ? pool.filter((p) => `${p.name} ${p.aliases.join(" ")} ${p.lifecycle}`.toLowerCase().includes(q)) : pool;
  const ids = new Set(shown.map((p) => p.id));
  // parents first, children indented; a child whose parent is hidden shows at depth 0
  const rows: { p: ProjectWithCounts; depth: number }[] = [];
  const visit = (parentId: string | null, depth: number) => {
    const level = shown.filter((x) => (parentId ? x.parentId === parentId : !x.parentId || !ids.has(x.parentId))).sort((a, b) => a.name.localeCompare(b.name));
    for (const p of level) {
      if (rows.some((r) => r.p.id === p.id)) continue;
      rows.push({ p, depth });
      visit(p.id, depth + 1);
    }
  };
  visit(null, 0);
  const hidden = projects.length - visibleProjects.length;
  return (
    <>
      <div className="tree-group">
        Projects <span className="count">{shown.length}</span>
        <span className="spacer" />
        <button className={`btn ghost small${showAllProjects ? " active" : ""}`} onClick={() => setShowAllProjects(!showAllProjects)} title={showAllProjects ? "Show only active and next projects" : `Show all ${projects.length} projects, including planned, incubator, parked and archived`}>
          {showAllProjects ? "Active only" : `All${hidden ? ` +${hidden}` : ""}`}
        </button>
      </div>
      <input className="input" placeholder="Find any project" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Find a project" style={{ margin: "4px 8px", width: "calc(100% - 16px)" }} />
      {rows.map(({ p, depth }) => (
        <button key={p.id} className={`tree-row${p.id === currentProjectId ? " active" : ""}`} onClick={() => selectProject(p.id)} title={`${p.lifecycle} · ${p.kind}${p.path ? ` · ${p.path}` : " · no repository yet"}`} style={{ paddingLeft: 10 + depth * 14 }}>
          <span className="t">{p.name}</span>
          <span className="m">
            {p.lifecycle !== "ACTIVE" && <span className={`lc ${p.lifecycle}`}>{p.lifecycle.toLowerCase()}</span>}
            {p.tasks.READY + p.tasks.WORKING > 0 ? ` ${p.tasks.READY + p.tasks.WORKING}` : ""}
            {p.tasks.BLOCKED ? <span className="err"> !{p.tasks.BLOCKED}</span> : null}
          </span>
        </button>
      ))}
      <button className="tree-row" onClick={() => openDialog("newProject")}>
        <Icon name="plus" size={12} />
        <span className="t">New project</span>
      </button>
    </>
  );
}

function ChatSide() {
  const { api, conversationId, selectConversation, feed, currentProjectId, projects } = useStore();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const n = feed.filter((e) => e.type === "CHAT_MESSAGE").length;
  useEffect(() => {
    api.conversations().then(setConversations).catch(() => setConversations([]));
  }, [api, n, conversationId]);
  const projectName = (id: string | null) => (id ? (projects.find((p) => p.id === id)?.name ?? "") : "");
  return (
    <>
      <button className="tree-row" onClick={() => selectConversation(null)}>
        <Icon name="plus" size={12} />
        <span className="t">New conversation</span>
      </button>
      <div className="tree-group">
        Conversations <span className="count">{conversations.length}</span>
      </div>
      {conversations.length === 0 && <div className="tree-row dim">None yet</div>}
      {conversations.map((c) => (
        <button key={c.id} className={`tree-row${c.id === conversationId ? " active" : ""}`} onClick={() => selectConversation(c.id)} title={c.title}>
          <span className="t">{c.title}</span>
          <span className="m">{c.projectId === currentProjectId ? "" : truncate(projectName(c.projectId), 10)}</span>
          <span className="m">{ago(c.updatedAt)}</span>
        </button>
      ))}
    </>
  );
}

function WorkSide() {
  const { tasks, currentProject, workFilter, setWorkFilter, selectedTaskId, selectTask, workGroup, setWorkGroup } = useStore();
  const counts = Object.fromEntries(STATUS_ORDER.map((s) => [s, tasks.filter((t) => t.status === s).length])) as Record<TaskStatus, number>;
  const open = tasks.filter((t) => t.status !== "DONE" && t.status !== "CANCELLED");
  const milestones = new Map<string, { total: number; done: number; epics: Map<string, { total: number; done: number }> }>();
  for (const t of tasks) {
    if (!t.milestone || t.status === "CANCELLED") continue;
    const m = milestones.get(t.milestone) ?? { total: 0, done: 0, epics: new Map() };
    m.total++;
    if (t.status === "DONE") m.done++;
    if (t.epic) {
      const e = m.epics.get(t.epic) ?? { total: 0, done: 0 };
      e.total++;
      if (t.status === "DONE") e.done++;
      m.epics.set(t.epic, e);
    }
    milestones.set(t.milestone, m);
  }
  return (
    <>
      <div className="tree-group">
        <Term word="milestone">Milestones</Term> <span className="count">{milestones.size}</span>
      </div>
      {milestones.size === 0 && (
        <div className="tree-row" style={{ cursor: "default" }} title={currentProject?.milestone ?? ""}>
          <span className="t">{currentProject?.milestone ?? <span className="dim">none set</span>}</span>
        </div>
      )}
      {Array.from(milestones).map(([name, m]) => (
        <div key={name}>
          <button className={`tree-row${workGroup === `m:${name}` ? " active" : ""}`} onClick={() => setWorkGroup(workGroup === `m:${name}` ? null : `m:${name}`)} title={name}>
            <span className="t">{name}</span>
            <span className="m">
              {m.done}/{m.total}
            </span>
          </button>
          {workGroup?.startsWith(`m:${name}`) || workGroup?.startsWith(`e:${name}|`)
            ? Array.from(m.epics).map(([epic, e]) => (
                <button key={epic} className={`tree-row${workGroup === `e:${name}|${epic}` ? " active" : ""}`} style={{ paddingLeft: 26 }} onClick={() => setWorkGroup(workGroup === `e:${name}|${epic}` ? `m:${name}` : `e:${name}|${epic}`)} title={epic}>
                  <span className="t">{epic}</span>
                  <span className="m">
                    {e.done}/{e.total}
                  </span>
                </button>
              ))
            : null}
        </div>
      ))}
      <div className="tree-group">Status</div>
      <button className={`tree-row${workFilter === null ? " active" : ""}`} onClick={() => setWorkFilter(null)}>
        <span className="t">Open</span>
        <span className="m">{open.length}</span>
      </button>
      {STATUS_ORDER.map((s) => (
        <button key={s} className={`tree-row${workFilter === s ? " active" : ""}`} onClick={() => setWorkFilter(workFilter === s ? null : s)}>
          <span className={`sym ${s}`}>{STATUS_SYMBOL[s]}</span>
          <span className="t">{STATUS_LABEL[s]}</span>
          <span className="m">{counts[s]}</span>
        </button>
      ))}
      <div className="tree-group">
        Tasks <span className="count">{open.length}</span>
      </div>
      {open.length === 0 && <div className="tree-row dim">No open tasks</div>}
      {open.map((t) => (
        <button key={t.id} className={`tree-row${t.id === selectedTaskId ? " active" : ""}`} onClick={() => selectTask(t.id)} title={t.title}>
          <span className={`sym ${t.status}`}>{STATUS_SYMBOL[t.status]}</span>
          <span className="t">{t.title}</span>
          <span className="m">#{t.ordinal}</span>
        </button>
      ))}
    </>
  );
}

function WorkersSide() {
  const { status, selectedWorkerId, selectWorker } = useStore();
  const workers = status?.workers ?? [];
  return (
    <>
      <div className="tree-group">
        <Term word="worker">Workers</Term> <span className="count">{workers.length}</span>
      </div>
      {workers.map((w) => (
        <button key={w.id} className={`tree-row${w.id === selectedWorkerId ? " active" : ""}`} onClick={() => selectWorker(w.id)}>
          <span className={w.health ? (w.health.ok ? "ok" : "err") : "dim"}>{w.health ? "●" : "○"}</span>
          <span className="t">{w.name}</span>
          <span className="m">{w.currentTaskId ? "busy" : ""}</span>
        </button>
      ))}
    </>
  );
}

function TerminalSide() {
  const { currentProject } = useStore();
  return (
    <>
      <div className="tree-group">Sessions</div>
      <div className="dim" style={{ padding: "2px 14px 6px", lineHeight: 1.45, whiteSpace: "normal" }}>
        Each tab is a real <Term word="PTY">PTY</Term> shell started in {currentProject ? <span className="mono">{truncate(currentProject.path, 40)}</span> : "the project directory"}.
      </div>
      <div className="tree-group">Keys</div>
      <div className="tree-row dim">
        <span className="t">New terminal</span>
        <kbd>Ctrl</kbd>
        <kbd>Shift</kbd>
        <kbd>T</kbd>
      </div>
    </>
  );
}

function GitSide() {
  const { api, currentProjectId, currentProject, feed } = useStore();
  const [status, setStatus] = useState<GitStatus | null>(null);
  const gitEvents = feed.filter((e) => e.type === "GIT_COMMIT" || e.type === "FILE_CHANGED").length;
  const hasRepo = !!currentProject?.path;
  useEffect(() => {
    if (!currentProjectId || !hasRepo) {
      setStatus(null);
      return;
    }
    api.gitStatus(currentProjectId).then(setStatus).catch(() => setStatus(null));
  }, [api, currentProjectId, hasRepo, gitEvents]);
  return (
    <>
      <div className="tree-group">
        <Term word="branch">Branch</Term>
      </div>
      <div className="tree-row" style={{ cursor: "default" }}>
        <span className="t mono">{status?.branch ?? (status?.detached ? "detached" : status?.isRepo === false ? "not a repo" : "…")}</span>
      </div>
      <div className="tree-group">
        <Term word="working tree">Working tree</Term> <span className="count">{status?.changes.length ?? 0}</span>
      </div>
      {status?.changes.length === 0 && <div className="tree-row ok">clean</div>}
      {status?.changes.map((c) => (
        <div key={c.path} className="tree-row" title={c.path}>
          <span className="m warn" style={{ width: 18 }}>
            {c.status}
          </span>
          <span className="t mono">{c.path}</span>
        </div>
      ))}
    </>
  );
}

function ArtifactsSide() {
  const { api, currentProjectId, feed } = useStore();
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const n = feed.filter((e) => e.type === "ARTIFACT_CREATED").length;
  useEffect(() => {
    if (!currentProjectId) return;
    api.artifacts({ projectId: currentProjectId }).then(setArtifacts).catch(() => setArtifacts([]));
  }, [api, currentProjectId, n]);
  const kinds = new Map<string, number>();
  for (const a of artifacts) kinds.set(a.kind, (kinds.get(a.kind) ?? 0) + 1);
  return (
    <>
      <div className="tree-group">
        <Term word="artifact">Kinds</Term> <span className="count">{artifacts.length}</span>
      </div>
      {Array.from(kinds).map(([k, c]) => (
        <div key={k} className="tree-row">
          <span className="t mono">{k}</span>
          <span className="m">{c}</span>
        </div>
      ))}
      {artifacts.length === 0 && <div className="tree-row dim">None yet</div>}
    </>
  );
}

function ResourcesSide() {
  const { api } = useStore();
  const [nexus, setNexus] = useState<{ skills: number; mcps: number; apis: number; workflows: number } | null>(null);
  useEffect(() => {
    api.nexusStatus().then(setNexus).catch(() => setNexus(null));
  }, [api]);
  return (
    <>
      <div className="tree-group">
        <Term word="Nexus">Nexus</Term>
      </div>
      {nexus ? (
        <>
          <div className="tree-row">
            <span className="t">Skills</span>
            <span className="m">{nexus.skills}</span>
          </div>
          <div className="tree-row">
            <span className="t">
              <Term word="MCP">MCP servers</Term>
            </span>
            <span className="m">{nexus.mcps}</span>
          </div>
          <div className="tree-row">
            <span className="t">APIs</span>
            <span className="m">{nexus.apis}</span>
          </div>
          <div className="tree-row">
            <span className="t">Workflows</span>
            <span className="m">{nexus.workflows}</span>
          </div>
        </>
      ) : (
        <div className="tree-row err">unreachable</div>
      )}
    </>
  );
}

function SettingsSide() {
  const groups = ["Workers", "Context budget", "Planning & approvals", "Nexus", "Terminal & storage"];
  return (
    <>
      <div className="tree-group">Groups</div>
      {groups.map((g) => (
        <a key={g} className="tree-row" href={`#settings-${g.replace(/\W+/g, "-").toLowerCase()}`} style={{ textDecoration: "none" }}>
          <span className="t">{g}</span>
        </a>
      ))}
    </>
  );
}

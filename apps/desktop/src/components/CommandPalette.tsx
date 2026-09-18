import { useEffect, useMemo, useRef, useState } from "react";

import { STATUS_SYMBOL } from "../lib/format.ts";
import { SECTIONS, useStore } from "../lib/store.tsx";

export interface Command {
  id: string;
  group: string;
  title: string;
  meta?: string;
  keywords?: string;
  run: () => unknown;
}

/** Keyboard-first actions. Only things that exist and can act right now are listed. */
export function useCommands(): Command[] {
  const store = useStore();
  const { projects, currentProject, tasks, status, api, act, setSection, selectProject, selectTask, openDialog, setBottom, toggleSidebar, refresh } = store;
  return useMemo(() => {
    const commands: Command[] = [];
    for (const s of SECTIONS) commands.push({ id: `go:${s.id}`, group: "Go to", title: s.label, meta: `Ctrl+${s.key}`, run: () => setSection(s.id) });
    for (const p of projects) if (p.id !== currentProject?.id) commands.push({ id: `project:${p.id}`, group: "Switch project", title: p.name, meta: `${p.lifecycle.toLowerCase()} · ${p.path ?? "no repository yet"}`, keywords: p.aliases.join(" "), run: () => selectProject(p.id) });
    if (currentProject) {
      commands.push({ id: "new-task", group: "Work", title: "New task", run: () => (setSection("work"), openDialog("task")) });
      commands.push({ id: "plan", group: "Work", title: "Plan a goal", meta: "bounded plan for the next milestone", run: () => (setSection("work"), openDialog("plan")) });
      const runnable = tasks.filter((t) => t.status === "READY" && t.dependsOn.every((d) => tasks.find((x) => x.id === d)?.status === "DONE"));
      const auto = status?.auto.find((a) => a.projectId === currentProject.id);
      if (auto) commands.push({ id: "auto-stop", group: "Work", title: "Stop auto-run", meta: `${auto.ran} done so far`, run: () => act(() => api.autoStop(currentProject.id), "Auto-run stopping") });
      else if (runnable.length > 0) commands.push({ id: "auto", group: "Work", title: `Run all ready (${runnable.length})`, meta: "dependency order", run: () => act(() => api.autoRun(currentProject.id), "Auto-run started") });
      for (const t of runnable) commands.push({ id: `run:${t.id}`, group: "Run task", title: t.title, meta: `#${t.ordinal}`, keywords: "run start", run: () => act(() => api.runTask(t.id), "Started") });
      for (const t of tasks.filter((x) => x.status !== "CANCELLED")) commands.push({ id: `open:${t.id}`, group: "Open task", title: t.title, meta: `${STATUS_SYMBOL[t.status]} #${t.ordinal}`, keywords: t.status, run: () => (setSection("work"), selectTask(t.id)) });
      commands.push({ id: "edit-project", group: "Project", title: "Edit project (goal, milestone, defaults)", run: () => (setSection("work"), openDialog("editProject")) });
      commands.push({ id: "git", group: "Git", title: "Commit changes", meta: "opens Git", run: () => setSection("git") });
      commands.push({ id: "terminal", group: "Terminal", title: "New terminal in project", meta: "Ctrl+Shift+T", run: () => (setSection("terminal"), window.dispatchEvent(new CustomEvent("dev:new-terminal"))) });
    }
    commands.push({ id: "new-project", group: "Project", title: "New project (create or register)", run: () => (setSection("overview"), openDialog("newProject")) });
    commands.push({ id: "chat", group: "Chat", title: "Talk to DEV", meta: "plan, create and launch work by chat", run: () => setSection("chat") });
    commands.push({ id: "workers-check", group: "Workers", title: "Check all workers", run: () => act(async () => { for (const w of status?.workers ?? []) await api.checkWorker(w.id); }, "Workers checked") });
    commands.push({ id: "doctor", group: "System", title: "Run doctor", run: () => (setSection("settings"), window.dispatchEvent(new CustomEvent("dev:run-doctor"))) });
    commands.push({ id: "refresh", group: "System", title: "Refresh from control plane", run: () => refresh() });
    commands.push({ id: "panel", group: "View", title: "Toggle bottom panel", meta: "Ctrl+J", run: () => setBottom(!store.bottomOpen) });
    commands.push({ id: "sidebar", group: "View", title: "Toggle sidebar", meta: "Ctrl+B", run: () => toggleSidebar() });
    return commands;
  }, [projects, currentProject, tasks, status, api, act, setSection, selectProject, selectTask, openDialog, setBottom, toggleSidebar, refresh, store.bottomOpen]);
}

export function filterCommands(commands: Command[], query: string): Command[] {
  const q = query.trim().toLowerCase();
  if (!q) return commands.filter((c) => !c.id.startsWith("open:")).slice(0, 40);
  const words = q.split(/\s+/);
  return commands
    .map((c) => {
      const hay = `${c.group} ${c.title} ${c.meta ?? ""} ${c.keywords ?? ""}`.toLowerCase();
      const score = words.reduce((n, w) => (hay.includes(w) ? n + (c.title.toLowerCase().startsWith(w) ? 3 : c.title.toLowerCase().includes(w) ? 2 : 1) : n - 100), 0);
      return { c, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 40)
    .map((x) => x.c);
}

export function CommandPalette() {
  const { paletteOpen, setPalette } = useStore();
  const commands = useCommands();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const shown = useMemo(() => filterCommands(commands, query), [commands, query]);
  useEffect(() => {
    if (paletteOpen) {
      setQuery("");
      setIndex(0);
      window.setTimeout(() => input.current?.focus(), 0);
    }
  }, [paletteOpen]);
  useEffect(() => setIndex(0), [query]);
  if (!paletteOpen) return null;
  const run = (c: Command) => {
    setPalette(false);
    void c.run();
  };
  let lastGroup = "";
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && setPalette(false)}>
      <div className="palette" role="dialog" aria-label="Command palette">
        <input
          ref={input}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Type a command, task or project…"
          aria-label="Command"
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setIndex((i) => Math.min(shown.length - 1, i + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIndex((i) => Math.max(0, i - 1));
            } else if (e.key === "Enter") {
              const c = shown[index];
              if (c) run(c);
            } else if (e.key === "Escape") {
              setPalette(false);
            }
          }}
        />
        <div className="palette-list" role="listbox">
          {shown.length === 0 && <div className="palette-empty">Nothing matches. Commands only list actions that can run right now.</div>}
          {shown.map((c, i) => {
            const header = c.group !== lastGroup ? <div className="palette-group">{c.group}</div> : null;
            lastGroup = c.group;
            return (
              <div key={c.id}>
                {header}
                <div role="option" aria-selected={i === index} className={`palette-item${i === index ? " active" : ""}`} onMouseEnter={() => setIndex(i)} onClick={() => run(c)}>
                  <span className="t">{c.title}</span>
                  {c.meta && <span className="m">{c.meta}</span>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

import { useEffect } from "react";

import { ActivityBar } from "./components/ActivityBar.tsx";
import { BottomPanel } from "./components/BottomPanel.tsx";
import { CommandPalette } from "./components/CommandPalette.tsx";
import { NewProjectDialog } from "./components/NewProjectDialog.tsx";
import { NewTaskDialog } from "./components/NewTaskDialog.tsx";
import { PlanDialog } from "./components/PlanDialog.tsx";
import { SideBar } from "./components/SideBar.tsx";
import { Split } from "./components/Split.tsx";
import { StatusBar } from "./components/StatusBar.tsx";
import { TaskInspector } from "./components/TaskInspector.tsx";
import { Toasts } from "./components/Toasts.tsx";
import { WorkerInspector } from "./components/WorkerInspector.tsx";
import { SECTIONS, useStore } from "./lib/store.tsx";
import { ArtifactsView } from "./views/ArtifactsView.tsx";
import { ChatView } from "./views/ChatView.tsx";
import { GitView } from "./views/GitView.tsx";
import { OfflineView } from "./views/OfflineView.tsx";
import { FlowsView } from "./views/FlowsView.tsx";
import { OverviewView } from "./views/OverviewView.tsx";
import { EditProjectDialog } from "./views/ProjectDialogs.tsx";
import { ResourcesView } from "./views/ResourcesView.tsx";
import { SettingsView } from "./views/SettingsView.tsx";
import { TerminalView } from "./views/TerminalView.tsx";
import { EditorView } from "./views/EditorView.tsx";
import { WorkView } from "./views/WorkView.tsx";
import { WorkersView } from "./views/WorkersView.tsx";

/**
 * The workbench: activity bar, contextual sidebar, workspace with an optional
 * inspector, a bottom panel, and the status bar. Sizes persist per pane.
 */
export function App() {
  const { section, setSection, connection, selectTask, selectWorker, selectedTaskId, selectedWorkerId, bottomOpen, setBottom, sidebarOpen, toggleSidebar, paletteOpen, setPalette, dialog, openDialog, status, currentProject, selectProject } = useStore();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const editing = (() => {
        const el = document.activeElement as HTMLElement | null;
        return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable || el.classList.contains("xterm-helper-textarea"));
      })();
      if (e.ctrlKey && !e.shiftKey && !e.altKey) {
        const hit = SECTIONS.find((s) => s.key === e.key);
        if (hit && !editing) {
          e.preventDefault();
          setSection(hit.id);
          return;
        }
        if (e.key.toLowerCase() === "k") {
          e.preventDefault();
          setPalette(!paletteOpen);
          return;
        }
        if (e.key.toLowerCase() === "j" && !editing) {
          e.preventDefault();
          setBottom(!bottomOpen);
          return;
        }
        if (e.key.toLowerCase() === "b" && !editing) {
          e.preventDefault();
          toggleSidebar();
          return;
        }
      }
      if (e.key === "Escape" && !paletteOpen && !dialog) {
        const active = document.activeElement as HTMLElement | null;
        if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) active.blur();
        else {
          selectTask(null);
          selectWorker(null);
        }
      }
    };
    const onSelectTask = (e: Event) => selectTask(String((e as CustomEvent).detail));
    window.addEventListener("keydown", onKey);
    window.addEventListener("dev:select-task", onSelectTask);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("dev:select-task", onSelectTask);
    };
  }, [setSection, selectTask, selectWorker, setPalette, paletteOpen, setBottom, bottomOpen, toggleSidebar, dialog]);

  // The inspector belongs to the section that selects into it: tasks in Overview/Work/Artifacts, workers in Workers.
  const taskSections = new Set(["overview", "work", "artifacts", "resources", "chat"]);
  const inspector =
    selectedTaskId && taskSections.has(section) ? <TaskInspector taskId={selectedTaskId} onClose={() => selectTask(null)} /> : selectedWorkerId && section === "workers" ? <WorkerInspector workerId={selectedWorkerId} onClose={() => selectWorker(null)} /> : null;
  const workspace = (
    <div className="workspace">{connection === "offline" ? <OfflineView /> : <View section={section} />}</div>
  );
  const editor = (
    <Split id="editor-bottom" direction="vertical" fixed="second" initial={230} min={100} max={800} first={<Split id="workspace-inspector" fixed="second" initial={440} min={320} max={900} first={workspace} second={inspector} />} second={bottomOpen && section !== "terminal" && section !== "chat" ? <BottomPanel /> : null} />
  );

  return (
    <div className="app">
      <div className="workbench">
        <ActivityBar />
        {sidebarOpen ? <Split id="sidebar" fixed="first" initial={236} min={180} max={480} first={<SideBar />} second={<div className="editor-area">{editor}</div>} /> : <div className="editor-area">{editor}</div>}
      </div>
      <StatusBar />
      <Toasts />
      <CommandPalette />
      {dialog === "task" && <NewTaskDialog onClose={() => openDialog(null)} workers={status?.workers ?? []} />}
      {dialog === "plan" && <PlanDialog onClose={() => openDialog(null)} workers={status?.workers ?? []} />}
      {(dialog === "project" || dialog === "newProject") && (
        <NewProjectDialog
          onClose={() => openDialog(null)}
          onDone={(id) => {
            selectProject(id);
            setSection("overview");
          }}
        />
      )}
      {dialog === "editProject" && currentProject && <EditProjectDialog project={currentProject} workers={(status?.workers ?? []).map((w) => w.id)} onClose={() => openDialog(null)} />}
    </div>
  );
}

function View({ section }: { section: string }) {
  switch (section) {
    case "overview":
      return <OverviewView />;
    case "chat":
      return <ChatView />;
    case "work":
      return <WorkView />;
    case "flows":
      return <FlowsView />;
    case "editor":
      return <EditorView />;
    case "workers":
      return <WorkersView />;
    case "terminal":
      return <TerminalView />;
    case "git":
      return <GitView />;
    case "artifacts":
      return <ArtifactsView />;
    case "resources":
      return <ResourcesView />;
    case "settings":
      return <SettingsView />;
    default:
      return <OverviewView />;
  }
}

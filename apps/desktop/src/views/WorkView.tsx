import { useMemo, useState } from "react";

import { Board } from "../components/Board.tsx";
import { Dialog } from "../components/Dialog.tsx";
import { Graph } from "../components/Graph.tsx";
import { Icon } from "../components/Icon.tsx";
import { Term } from "../components/Term.tsx";
import type { TaskStatus } from "../lib/api.ts";
import { ago, STATUS_LABEL, STATUS_SYMBOL, truncate } from "../lib/format.ts";
import { useStore } from "../lib/store.tsx";

/** The work surface: board, list or graph of the milestone's tasks, with real actions. */
export function WorkView() {
  const [autopilotOpen, setAutopilotOpen] = useState(false);
  const { api, act, toast, moveTaskAsked, currentProject, tasks, selectedTaskId, selectTask, status, workMode, setWorkMode, workFilter, setWorkFilter, openDialog, workGroup, setWorkGroup } = useStore();
  const [query, setQuery] = useState("");
  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const runnable = tasks.filter((t) => t.status === "READY" && t.dependsOn.every((d) => byId.get(d)?.status === "DONE"));
  const auto = status?.auto.find((a) => a.projectId === currentProject?.id);
  const visible = tasks.filter((t) => {
    if (workFilter ? t.status !== workFilter : t.status === "CANCELLED" && workMode !== "board") return false;
    if (workGroup?.startsWith("m:") && t.milestone !== workGroup.slice(2)) return false;
    if (workGroup?.startsWith("e:")) {
      const [m, e] = workGroup.slice(2).split("|");
      if (t.milestone !== m || t.epic !== e) return false;
    }
    if (query && !`${t.title} ${t.id} ${t.outcome}`.toLowerCase().includes(query.toLowerCase())) return false;
    return true;
  });
  const shownList = workFilter ? visible : visible.filter((t) => t.status !== "DONE" || workMode !== "list");

  if (!currentProject) {
    return (
      <div className="view">
        <div className="toolbar">
          <h1>Work</h1>
        </div>
        <div className="view-body">
          <div className="empty">
            <b>No project selected.</b> Add one in Overview.
          </div>
        </div>
      </div>
    );
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (workMode !== "list" || !shownList.length) return;
    const index = shownList.findIndex((t) => t.id === selectedTaskId);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      selectTask(shownList[Math.min(shownList.length - 1, index + 1)]?.id ?? null);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      selectTask(shownList[Math.max(0, index - 1)]?.id ?? null);
    } else if (e.key === "Enter" && selectedTaskId) {
      const t = byId.get(selectedTaskId);
      if (t?.status === "READY") void act(() => api.runTask(t.id), "Started");
    }
  };

  const startAutopilot = async (maxTasks: number | undefined) => {
    setAutopilotOpen(false);
    await act(() => api.autoRun(currentProject.id, { promoteBacklog: true, maxTasks }), "Autopilot started");
  };

  return (
    <div className="view">
      {autopilotOpen && <AutopilotDialog project={currentProject.name} runnable={runnable.length} backlog={tasks.filter((t) => t.status === "BACKLOG").length} needsHuman={tasks.filter((t) => t.needsHuman && t.status !== "DONE").length} onCancel={() => setAutopilotOpen(false)} onStart={startAutopilot} />}
      <div className="toolbar">
        <h1>Work</h1>
        <span className="sub">{currentProject.milestone ? currentProject.milestone : `${tasks.filter((t) => t.status !== "DONE" && t.status !== "CANCELLED").length} open`}</span>
        <span className="sep" />
        <div className="segmented" role="tablist" aria-label="View">
          {(["board", "list", "graph"] as const).map((m) => (
            <button key={m} role="tab" aria-selected={workMode === m} className={workMode === m ? "active" : ""} onClick={() => setWorkMode(m)}>
              {m === "board" ? "Board" : m === "list" ? "List" : "Graph"}
            </button>
          ))}
        </div>
        {workGroup && (
          <button className="btn ghost small" onClick={() => setWorkGroup(null)} title="Clear milestone filter">
            {workGroup.startsWith("e:") ? workGroup.slice(2).replace("|", " / ") : workGroup.slice(2)} <Icon name="x" size={11} />
          </button>
        )}
        {workFilter && (
          <button className="btn ghost small" onClick={() => setWorkFilter(null)} title="Clear filter">
            <span className={`sym ${workFilter}`}>{STATUS_SYMBOL[workFilter as TaskStatus]}</span> {STATUS_LABEL[workFilter as TaskStatus]} <Icon name="x" size={11} />
          </button>
        )}
        <input className="input" style={{ width: 200 }} placeholder="Filter tasks" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Filter tasks" />
        <span className="spacer" />
        {auto ? (
          <button className="btn danger small" onClick={() => act(() => api.autoStop(currentProject.id), "Auto-run stopping")}>
            <Icon name="stop" size={11} /> Stop {auto.promoteBacklog ? "autopilot" : "auto-run"} ({auto.ran} done)
          </button>
        ) : (
          <>
            <button className="btn small" disabled={runnable.length === 0} title={runnable.length ? `Run ${runnable.length} runnable task(s) in dependency order` : "Nothing runnable: tasks must be Ready with all dependencies Done"} onClick={() => act(() => api.autoRun(currentProject.id), "Auto-run started")}>
              <Icon name="play" size={11} /> Run all ready ({runnable.length})
            </button>
            <button className="btn small warn-btn" title="Autopilot: DEV promotes backlog tasks and keeps working through them on its own" onClick={() => setAutopilotOpen(true)}>
              <Icon name="play" size={11} /> Autopilot…
            </button>
          </>
        )}
        <button className="btn small" onClick={() => openDialog("plan")}>
          Plan a goal
        </button>
        <button className="btn primary small" onClick={() => openDialog("task")}>
          <Icon name="plus" size={11} /> Task
        </button>
      </div>
      {tasks.length === 0 ? (
        <div className="view-body">
          <div className="empty">
            <b>No tasks in {currentProject.name}.</b>
            <br />
            Create one, or describe a goal and let DEV plan the next <Term word="milestone">milestone</Term>.
            <div className="row" style={{ marginTop: 10 }}>
              <button className="btn primary" onClick={() => openDialog("task")}>
                New task
              </button>
              <button className="btn" onClick={() => openDialog("plan")}>
                Plan a goal
              </button>
            </div>
          </div>
        </div>
      ) : workMode === "board" ? (
        <Board
          tasks={visible}
          selectedId={selectedTaskId}
          onSelect={selectTask}
          onMove={(id, to) => void moveTaskAsked(id, to)}
          onRefused={(task, to, why) => toast("error", `Can't move "${truncate(task.title, 40)}" to ${STATUS_LABEL[to]}. ${why}`)}
          onRun={(id) => act(() => api.runTask(id), "Started")}
          onRetry={(id) => act(() => api.runTask(id), "Retrying")}
          onCancel={(id) => act(() => api.cancelTask(id), "Run stopped; task back in Ready")}
          onApprove={(id) => act(() => api.approveTask(id, "Approved on the board"), "Approved")}
        />
      ) : workMode === "graph" ? (
        <Graph tasks={visible} selectedId={selectedTaskId} onSelect={selectTask} />
      ) : (
        <div className="view-body tight" tabIndex={0} onKeyDown={onKey} style={{ outline: "none", overflow: "auto" }}>
          {shownList.length === 0 ? (
            <div className="view-body">
              <div className="empty">Nothing matches this filter.</div>
            </div>
          ) : (
            <table className="table rows">
              <thead>
                <tr>
                  <th style={{ width: 36 }}>#</th>
                  <th style={{ width: 20 }}></th>
                  <th>Title</th>
                  <th style={{ width: 96 }}>Status</th>
                  <th style={{ width: 90 }}>
                    <Term word="dependency">Deps</Term>
                  </th>
                  <th style={{ width: 100 }}>Worker</th>
                  <th style={{ width: 90 }}>Verify</th>
                  <th style={{ width: 80 }}>Updated</th>
                </tr>
              </thead>
              <tbody>
                {shownList.map((t) => (
                  <tr key={t.id} className={`clickable${t.id === selectedTaskId ? " selected" : ""}`} onClick={() => selectTask(t.id)} onDoubleClick={() => t.status === "READY" && act(() => api.runTask(t.id), "Started")}>
                    <td className="mono dim">{t.ordinal}</td>
                    <td className={`sym ${t.status}`}>{STATUS_SYMBOL[t.status]}</td>
                    <td className="ellipsis" title={t.title}>
                      {t.kind !== "ticket" && <span className="mono dim small">{t.kind} </span>}
                      {t.title}
                      {t.risk === "high" && <span className="err small"> high risk</span>}
                      {t.needsHuman && <span className="warn small"> needs you</span>}
                      {t.status === "BLOCKED" && t.failure && <span className="err small"> {truncate(t.failure.reason, 70)}</span>}
                    </td>
                    <td>
                      <span className={`pill ${t.status}`}>{STATUS_LABEL[t.status]}</span>
                    </td>
                    <td className="mono dim">{t.dependsOn.map((d) => `#${byId.get(d)?.ordinal ?? "?"}`).join(" ")}</td>
                    <td className="mono dim">{t.workerId ?? (t.command ? "shell" : "auto")}</td>
                    <td className="mono dim">{t.verification.length ? t.verification.length : ""}</td>
                    <td className="dim small">{ago(t.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Autopilot is the one control in DEV that acts without asking each time, so it states plainly
 * what it will do before it starts and offers a bounded run.
 */
export function AutopilotDialog({ project, runnable, backlog, needsHuman, onCancel, onStart }: { project: string; runnable: number; backlog: number; needsHuman: number; onCancel: () => void; onStart: (maxTasks: number | undefined) => void }) {
  const [limit, setLimit] = useState("5");
  const [understood, setUnderstood] = useState(false);
  const max = limit === "unlimited" ? undefined : Number(limit);
  return (
    <Dialog
      title="Autopilot"
      onClose={onCancel}
      footer={
        <>
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="btn danger"
            disabled={!understood}
            // A disabled control must say why, or it reads as a broken button.
            title={understood ? `Promote and run up to ${max === undefined ? "every" : max} task(s) without asking` : "Tick the box below first: autopilot works unattended, so it needs your acknowledgement"}
            onClick={() => onStart(max)}
          >
            Start autopilot
          </button>
        </>
      }
    >
      <div className="danger-box">
        <b>Autopilot runs without asking you each time.</b>
        <ul className="bullets" style={{ marginTop: 6 }}>
          <li>It moves backlog tasks into Ready itself, in dependency order, and runs them.</li>
          <li>Workers edit files, run commands and can commit in {project}.</li>
          <li>It keeps going until the queue is empty, the limit is reached, or you stop it.</li>
          <li>You are not approving each step. Use it on work you are happy to have done unattended.</li>
        </ul>
        <div className="dim small">Tasks that need you ({needsHuman}) are never promoted; they wait for your answer. A blocked task stops its own branch, not the run.</div>
      </div>
      <div className="kv" style={{ margin: "12px 0" }}>
        <span className="k">ready now</span>
        <span className="v">{runnable}</span>
        <span className="k">backlog it may promote</span>
        <span className="v">{backlog}</span>
        <span className="k">stop after</span>
        <span className="v">
          <select className="select" style={{ width: "auto" }} value={limit} onChange={(e) => setLimit(e.target.value)} aria-label="Task limit">
            <option value="1">1 task</option>
            <option value="3">3 tasks</option>
            <option value="5">5 tasks</option>
            <option value="10">10 tasks</option>
            <option value="25">25 tasks</option>
            <option value="unlimited">no limit (until the queue is empty)</option>
          </select>
        </span>
      </div>
      <label className={`row autopilot-ack${understood ? " ticked" : ""}`} style={{ gap: 8, alignItems: "flex-start" }}>
        <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
        <span>
          I understand DEV will work through tickets on its own in this repository.
          {!understood && <b className="warn"> — required before autopilot can start</b>}
        </span>
      </label>
    </Dialog>
  );
}

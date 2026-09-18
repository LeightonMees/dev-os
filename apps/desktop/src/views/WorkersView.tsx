import { useEffect, useState } from "react";

import { Term } from "../components/Term.tsx";
import type { ExecutionRow, WorkerInfo } from "../lib/api.ts";
import { ago, duration, elapsed, truncate } from "../lib/format.ts";
import { useStore } from "../lib/store.tsx";

/** Real workers only, as engineering resources. Select one for the inspector. */
export function WorkersView() {
  const { api, status, refresh, toast, selectedWorkerId, selectWorker, selectTask, setSection } = useStore();
  const [checking, setChecking] = useState<string | null>(null);
  const [recent, setRecent] = useState<ExecutionRow[]>([]);
  const workers = status?.workers ?? [];
  useEffect(() => {
    api.executions({ limit: 40 }).then(setRecent).catch(() => setRecent([]));
  }, [api, status?.running.length, status?.tasks.DONE, status?.tasks.BLOCKED]);
  const check = async (id: string) => {
    setChecking(id);
    try {
      const info = await api.checkWorker(id);
      toast(info.health?.ok ? "success" : "error", `${id}: ${info.health?.detail}`);
      await refresh();
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setChecking(null);
    }
  };
  const runningFor = (id: string) => (status?.running ?? []).find((e) => e.workerId === id);
  return (
    <div className="view">
      <div className="toolbar">
        <h1>
          <Term word="worker">Workers</Term>
        </h1>
        <span className="sub">
          {workers.filter((w) => w.health?.ok).length} healthy of {workers.length}
        </span>
        <span className="spacer" />
        <button
          className="btn small"
          disabled={checking !== null}
          onClick={async () => {
            for (const w of workers) await check(w.id);
          }}
        >
          Check all
        </button>
      </div>
      <div className="view-body tight" style={{ overflow: "auto" }}>
        <table className="table rows">
          <thead>
            <tr>
              <th style={{ width: 20 }}></th>
              <th style={{ width: 200 }}>Worker</th>
              <th style={{ width: 90 }}>Type</th>
              <th style={{ width: 160 }}>Capabilities</th>
              <th style={{ width: 240 }}>Current task</th>
              <th style={{ width: 110 }}>Record</th>
              <th>Health</th>
              <th style={{ width: 70 }}></th>
            </tr>
          </thead>
          <tbody>
            {workers.map((w: WorkerInfo) => {
              const running = runningFor(w.id);
              return (
                <tr key={w.id} className={`clickable${selectedWorkerId === w.id ? " selected" : ""}`} onClick={() => selectWorker(w.id)}>
                  <td className={w.health ? (w.health.ok ? "ok" : "err") : "dim"}>{w.health ? "●" : "○"}</td>
                  <td className="nowrap">
                    {w.name} <span className="mono dim small">{w.id}</span>
                  </td>
                  <td className="mono dim nowrap">{w.type}</td>
                  <td className="mono dim ellipsis" title={w.capabilities.join(", ")}>
                    {w.capabilities.join(", ")}
                  </td>
                  <td className="ellipsis">
                    {running ? (
                      <a href="#" onClick={(e) => (e.preventDefault(), e.stopPropagation(), selectTask(running.taskId), setSection("work"))}>
                        <span className="brass sym">▶</span> {truncate(recent.find((r) => r.id === running.id)?.taskTitle ?? running.taskId, 34)} <span className="dim mono">{elapsed(running.startedAt)}</span>
                      </a>
                    ) : (
                      <span className="dim">idle</span>
                    )}
                  </td>
                  <td className="mono">
                    {w.stats.succeeded}/{w.stats.executions}
                    {w.stats.avgDurationMs ? <span className="dim"> {duration(w.stats.avgDurationMs)}</span> : null}
                  </td>
                  <td className="ellipsis small" title={w.health?.detail}>
                    {w.health ? (
                      <>
                        <span className={w.health.ok ? "ok" : "err"}>{w.health.ok ? "ok" : "down"}</span> <span className="muted">{truncate(w.health.detail, 70)}</span> <span className="dim">{ago(w.health.checkedAt)}</span>
                      </>
                    ) : (
                      <span className="dim">not checked yet</span>
                    )}
                  </td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <button className="btn small" disabled={checking !== null} onClick={() => check(w.id)}>
                      {checking === w.id ? "…" : "Check"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="section" style={{ margin: "18px 14px" }}>
          <div className="label">
            Recent <Term word="execution">executions</Term> <span className="count">{recent.length}</span>
          </div>
          {recent.length === 0 ? (
            <div className="dim">No executions yet.</div>
          ) : (
            <table className="table rows">
              <thead>
                <tr>
                  <th>Execution</th>
                  <th>Task</th>
                  <th>Worker</th>
                  <th>Status</th>
                  <th>Duration</th>
                  <th>Context</th>
                  <th>Files</th>
                  <th>Started</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((e) => (
                  <tr key={e.id} className="clickable" onClick={() => (selectTask(e.taskId), setSection("work"))}>
                    <td className="mono dim">{e.id}</td>
                    <td className="ellipsis">{truncate(e.taskTitle ?? e.taskId, 50)}</td>
                    <td className="mono">{e.workerId}</td>
                    <td className={e.status === "succeeded" ? "ok" : e.status === "running" ? "brass" : "err"}>{e.status}</td>
                    <td className="mono">{duration(e.durationMs)}</td>
                    <td className="mono dim">{e.contextTokens != null ? `~${e.contextTokens}t` : ""}</td>
                    <td className="mono">{e.changedFiles.length}</td>
                    <td className="dim small">{ago(e.startedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

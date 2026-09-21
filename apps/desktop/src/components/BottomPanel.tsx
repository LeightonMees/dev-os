import { useEffect, useState } from "react";

import type { ExecutionRow, WorkerInfo } from "../lib/api.ts";
import { ago, duration, truncate } from "../lib/format.ts";
import { useStore, type BottomTab } from "../lib/store.tsx";
import { Feed } from "./Feed.tsx";
import { Icon } from "./Icon.tsx";
import { Output } from "./Output.tsx";
import { Term } from "./Term.tsx";

/** Activity, live output, checks (verification evidence) and problems. Always real state. */
export function BottomPanel() {
  const { bottomTab, setBottom, feed, currentProjectId, status, tasks, checks, output, selectTask, setSection, api, act, connection, selectWorker, attention } = useStore();
  const [answer, setAnswer] = useState<Record<string, string>>({});
  const projectFeed = feed.filter((e) => e.projectId === currentProjectId);
  const running = (status?.running ?? []).filter((e) => e.projectId === currentProjectId);
  const [lastExecution, setLastExecution] = useState<ExecutionRow | null>(null);
  useEffect(() => {
    if (!currentProjectId || running.length > 0) return;
    api.executions({ projectId: currentProjectId, limit: 1 }).then((rows) => setLastExecution(rows[0] ?? null)).catch(() => setLastExecution(null));
  }, [api, currentProjectId, running.length, status?.tasks.DONE, status?.tasks.BLOCKED]);
  const live = running[0];
  const liveChunks = live ? (output.get(live.id) ?? []) : lastExecution ? (output.get(lastExecution.id) ?? []) : [];
  const liveTask = live ? tasks.find((t) => t.id === live.taskId) : null;

  const blocked = tasks.filter((t) => t.status === "BLOCKED");
  const review = tasks.filter((t) => t.status === "REVIEW");
  const unhealthy = (status?.workers ?? []).filter((w) => w.health && !w.health.ok);
  const failedChecks = checks.filter((c) => !c.passed).length;
  const problems = blocked.length + review.length + unhealthy.length + (connection === "offline" ? 1 : 0) + attention.length;

  const tabs: [BottomTab, string, number | null, string][] = [
    ["activity", "Activity", projectFeed.length || null, ""],
    ["output", "Output", live ? 1 : null, ""],
    ["checks", "Checks", failedChecks || null, failedChecks ? "err" : ""],
    ["problems", "Problems", problems || null, problems ? "err" : ""],
  ];
  return (
    <div className="bottom" data-testid="bottom-panel">
      <div className="bottom-tabs" role="tablist">
        {tabs.map(([id, label, n, cls]) => (
          <button key={id} role="tab" aria-selected={bottomTab === id} className={`bottom-tab${bottomTab === id ? " active" : ""}`} onClick={() => setBottom(true, id)}>
            {label}
            {n !== null && <span className={`n ${cls}`}>{n}</span>}
          </button>
        ))}
        <span className="spacer" />
        <button className="btn ghost small" onClick={() => setBottom(false)} title="Hide panel  Ctrl+J" aria-label="Hide panel">
          <Icon name="x" size={12} />
        </button>
      </div>
      <div className="bottom-body">
        {bottomTab === "activity" && <Feed events={projectFeed} onSelectTask={(id) => (selectTask(id), setSection("work"))} />}
        {bottomTab === "output" && (
          <>
            <div className="panel-strip">
              {live ? (
                <>
                  <span className="brass sym">▶</span>
                  <span>
                    {live.workerId} on{" "}
                    <a href="#" onClick={(e) => (e.preventDefault(), selectTask(live.taskId), setSection("work"))}>
                      {liveTask?.title ?? live.taskId}
                    </a>
                  </span>
                  <span className="dim mono">{ago(live.startedAt)}</span>
                </>
              ) : lastExecution ? (
                <span className="dim">
                  Last execution: {lastExecution.workerId} on {truncate(lastExecution.taskTitle ?? lastExecution.taskId, 50)}, {lastExecution.status} in {duration(lastExecution.durationMs)}
                </span>
              ) : (
                <span className="dim">Nothing has run yet.</span>
              )}
            </div>
            <Output chunks={liveChunks} fill placeholder={live ? "Waiting for output…" : "Output from the next execution streams here. Earlier logs are in Artifacts."} />
          </>
        )}
        {bottomTab === "checks" && (
          <div className="view-body tight" style={{ overflow: "auto" }}>
            {checks.length === 0 ? (
              <div className="view-body">
                <div className="empty">
                  No <Term word="verification">verification</Term> has run yet. Add a verification command to a task or a project-wide one in the project settings; every run is recorded here.
                </div>
              </div>
            ) : (
              <table className="table rows">
                <thead>
                  <tr>
                    <th style={{ width: 20 }}></th>
                    <th style={{ width: 120 }}>Kind</th>
                    <th>Result</th>
                    <th style={{ width: 240 }}>Task</th>
                    <th style={{ width: 90 }}>When</th>
                    <th style={{ width: 80 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {checks.map((c) => {
                    const task = tasks.find((t) => t.id === c.taskId);
                    return (
                      <tr key={c.id} className="clickable" onClick={() => (selectTask(c.taskId), setSection("work"))}>
                        <td className={c.passed ? "ok" : "err"}>{c.passed ? "✓" : "✗"}</td>
                        <td className="mono">{c.kind}</td>
                        <td className="ellipsis selectable" title={c.summary}>
                          {c.summary}
                        </td>
                        <td className="ellipsis">{c.taskTitle ?? c.taskId}</td>
                        <td className="dim small">{ago(c.createdAt)}</td>
                        <td onClick={(e) => e.stopPropagation()}>
                          {!c.passed && task && (task.status === "BLOCKED" || task.status === "REVIEW") && (
                            <button className="btn small" onClick={() => act(() => api.runTask(task.id), "Re-running")}>
                              Rerun
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        )}
        {bottomTab === "problems" && (
          <div className="view-body tight" style={{ overflow: "auto" }}>
            {problems === 0 ? (
              <div className="view-body">
                <div className="empty">No problems. Blocked tasks, tasks waiting for review, unhealthy workers and connection failures appear here.</div>
              </div>
            ) : (
              <table className="table rows">
                <tbody>
                  {attention.map((a) => (
                    <tr key={a.id} className="attention">
                      <td className="warn" style={{ width: 20 }}>
                        ?
                      </td>
                      <td style={{ width: 280 }} className="ellipsis" title={a.reason}>
                        {a.action === "human-input" ? "DEV asks" : a.action === "git.commit" ? "Commit (approving commits it)" : a.action === "git.push" ? "Push (approving pushes it)" : a.action === "run-command" ? "Run a gated command" : a.action}
                        {a.taskId && (
                          <>
                            {" "}
                            <a href="#" onClick={(e) => (e.preventDefault(), selectTask(a.taskId as string), setSection("work"))}>
                              task
                            </a>
                          </>
                        )}
                      </td>
                      <td className="selectable" style={{ whiteSpace: "normal" }}>
                        {a.reason}
                      </td>
                      <td style={{ width: 360 }} onClick={(e) => e.stopPropagation()}>
                        <div className="row">
                          <input className="input" placeholder="answer or note" value={answer[a.id] ?? ""} onChange={(e) => setAnswer((s) => ({ ...s, [a.id]: e.target.value }))} onKeyDown={(e) => e.key === "Enter" && act(() => api.resolveApproval(a.id, "approved", answer[a.id]), "Answered")} aria-label="Answer" />
                          <button className="btn small primary" onClick={() => act(() => api.resolveApproval(a.id, "approved", answer[a.id]), "Answered")}>
                            {a.action === "human-input" ? "Answer" : "Approve"}
                          </button>
                          <button className="btn small danger" onClick={() => act(() => api.resolveApproval(a.id, "denied", answer[a.id]), "Denied")}>
                            {a.action === "human-input" ? "Decline" : "Deny"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {connection === "offline" && (
                    <tr>
                      <td className="err" style={{ width: 20 }}>
                        ✗
                      </td>
                      <td>Control plane unreachable</td>
                      <td className="dim">retrying every 5s</td>
                    </tr>
                  )}
                  {blocked.map((t) => (
                    <tr key={t.id} className="clickable" onClick={() => (selectTask(t.id), setSection("work"))}>
                      <td className="err" style={{ width: 20 }}>
                        ■
                      </td>
                      <td style={{ width: 280 }} className="ellipsis">
                        {t.title}
                      </td>
                      <td className="ellipsis" title={t.failure?.reason}>
                        <span className="mono dim">{t.failure?.kind}</span> {truncate(t.failure?.reason ?? "", 120)}
                      </td>
                      <td className="dim small ellipsis" style={{ width: 260 }} title={t.failure?.nextAction}>
                        {t.failure?.nextAction}
                      </td>
                    </tr>
                  ))}
                  {review.map((t) => (
                    <tr key={t.id} className="clickable" onClick={() => (selectTask(t.id), setSection("work"))}>
                      <td style={{ width: 20, color: "var(--st-review)" }}>◆</td>
                      <td style={{ width: 280 }} className="ellipsis">
                        {t.title}
                      </td>
                      <td>waiting for your review</td>
                      <td className="dim small">approve or reject in the inspector</td>
                    </tr>
                  ))}
                  {unhealthy.map((w) => (
                    <tr key={w.id}>
                      <td className="err" style={{ width: 20 }}>
                        ✗
                      </td>
                      <td style={{ width: 280 }} className="clickable" onClick={() => (selectWorker(w.id), setSection("workers"))}>
                        worker {w.name}
                      </td>
                      <td className="ellipsis">{w.health?.detail}</td>
                      <td style={{ width: 230 }}>
                        <WorkerFix worker={w} />
                      </td>
                    </tr>
                  ))}

                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * A problem is only useful if it can be fixed here. Reads the worker's own health detail and
 * offers the matching action: add the missing key, enable the provider, or re-probe.
 */
function WorkerFix({ worker }: { worker: WorkerInfo }) {
  const { api, act, toast } = useStore();
  const [busy, setBusy] = useState(false);
  const detail = worker.health?.detail ?? "";
  const missingKey = detail.match(/([A-Z][A-Z0-9_]{2,})\s+is not set/)?.[1] ?? null;
  const disabled = /disabled in config/i.test(detail);

  const addKey = async () => {
    const value = window.prompt(`Paste the value for ${missingKey}. It is written to your secrets file and never shown again.`);
    if (!value?.trim()) return;
    setBusy(true);
    try {
      const saved = await api.setSecret(missingKey as string, value.trim());
      toast("success", `${saved.name} saved to ${saved.file}. Restart the control plane to use it.`);
      await api.checkWorker(worker.id).catch(() => undefined);
    } catch (error) {
      toast("error", (error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const enable = () =>
    act(async () => {
      const result = await api.setProviderEnabled(worker.id, true);
      if (!result.keySet && result.keyEnv) toast("info", `${worker.name} is enabled, but ${result.keyEnv} still needs a key.`);
      return result;
    }, `${worker.name} enabled · restart the control plane`);

  if (missingKey)
    return (
      <button className="btn small" disabled={busy} onClick={addKey} title={`Write ${missingKey} into your secrets file`}>
        {busy ? "Saving…" : `Add ${missingKey}`}
      </button>
    );
  if (disabled)
    return (
      <button className="btn small" onClick={enable} title="Turn this provider on in config.json">
        Enable {worker.name}
      </button>
    );
  return (
    <button className="btn ghost small" onClick={() => act(() => api.checkWorker(worker.id), `Checked ${worker.name}`)} title="Probe it again">
      Check again
    </button>
  );
}

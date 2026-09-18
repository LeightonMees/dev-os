import { useEffect, useState } from "react";

import type { DevConfig, ExecutionRow } from "../lib/api.ts";
import { ago, describeEvent, duration, elapsed, truncate } from "../lib/format.ts";
import { useStore } from "../lib/store.tsx";
import { Term } from "./Term.tsx";

/** One worker as an engineering resource: what it is, whether it works, what it is doing, what it did. */
export function WorkerInspector({ workerId, onClose }: { workerId: string; onClose: () => void }) {
  const { api, status, feed, refresh, toast, selectTask, setSection } = useStore();
  const [config, setConfig] = useState<DevConfig | null>(null);
  const [recent, setRecent] = useState<ExecutionRow[]>([]);
  const [checking, setChecking] = useState(false);
  const worker = status?.workers.find((w) => w.id === workerId);
  useEffect(() => {
    api.config().then((c) => setConfig(c.config)).catch(() => setConfig(null));
  }, [api]);
  useEffect(() => {
    api.executions({ limit: 200 }).then((rows) => setRecent(rows.filter((r) => r.workerId === workerId).slice(0, 15))).catch(() => setRecent([]));
  }, [api, workerId, status?.running.length, status?.tasks.DONE, status?.tasks.BLOCKED]);
  if (!worker) return null;
  const running = (status?.running ?? []).find((e) => e.workerId === workerId);
  const runningRow = running ? recent.find((r) => r.id === running.id) : undefined;
  const lastEvent = running ? feed.filter((e) => e.executionId === running.id).at(-1) : undefined;
  const model = modelFor(workerId, config);
  const check = async () => {
    setChecking(true);
    try {
      const info = await api.checkWorker(workerId);
      toast(info.health?.ok ? "success" : "error", `${worker.name}: ${info.health?.detail}`);
      await refresh();
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setChecking(false);
    }
  };
  return (
    <aside className="inspector" data-testid="worker-inspector">
      <div className="inspector-head">
        <div className="row">
          <span className={worker.health ? (worker.health.ok ? "ok" : "err") : "dim"}>{worker.health ? (worker.health.ok ? "● healthy" : "● down") : "○ unchecked"}</span>
          <span className="mono dim">{worker.id}</span>
          <button className="btn ghost small" style={{ marginLeft: "auto" }} onClick={onClose} aria-label="Close inspector">
            ✕
          </button>
        </div>
        <h2>{worker.name}</h2>
        <div className="inspector-actions">
          <button className="btn small" onClick={check} disabled={checking}>
            {checking ? "Checking…" : "Check now"}
          </button>
          {running && (
            <button className="btn small danger" onClick={() => api.cancelTask(running.taskId).then(() => toast("info", "Cancellation requested")).catch((e: Error) => toast("error", e.message))}>
              Cancel current task
            </button>
          )}
        </div>
      </div>
      <div className="inspector-body">
        <div className="section">
          <div className="label">Resource</div>
          <div className="kv">
            <span className="k">type</span>
            <span className="v">
              {worker.type}
              {worker.type === "cli-agent" && (
                <span className="dim">
                  {" "}
                  (<Term word="adapter">adapter</Term> over a CLI)
                </span>
              )}
            </span>
            {model && (
              <>
                <span className="k">model</span>
                <span className="v mono">{model}</span>
              </>
            )}
            <span className="k">capabilities</span>
            <span className="v">{worker.capabilities.join(", ")}</span>
            <span className="k">config</span>
            <span className="v mono">{worker.configRef}</span>
            <span className="k">health</span>
            <span className="v selectable">
              {worker.health ? (
                <>
                  {worker.health.detail}
                  <div className="dim small">checked {ago(worker.health.checkedAt)}</div>
                </>
              ) : (
                <span className="dim">not checked yet</span>
              )}
            </span>
          </div>
        </div>
        <div className="section">
          <div className="label">Now</div>
          {running ? (
            <div className="kv">
              <span className="k">task</span>
              <span className="v">
                <a href="#" onClick={(e) => (e.preventDefault(), selectTask(running.taskId), setSection("work"))}>
                  {runningRow?.taskTitle ?? running.taskId}
                </a>
              </span>
              <span className="k">started</span>
              <span className="v">
                {ago(running.startedAt)} <span className="dim">({elapsed(running.startedAt)} elapsed)</span>
              </span>
              <span className="k">context</span>
              <span className="v">{runningRow?.contextTokens != null ? `~${runningRow.contextTokens} tokens sent` : <span className="dim">no brief (command task)</span>}</span>
              <span className="k">last action</span>
              <span className="v ellipsis">{lastEvent ? `${lastEvent.type} ${describeEvent(lastEvent.type, lastEvent.data)}` : <span className="dim">—</span>}</span>
            </div>
          ) : (
            <div className="dim">Idle.</div>
          )}
        </div>
        <div className="section">
          <div className="label">
            Record <span className="count">{worker.stats.succeeded}/{worker.stats.executions} succeeded</span>
          </div>
          {recent.length === 0 ? (
            <div className="dim">No executions yet.</div>
          ) : (
            <ul className="list">
              {recent.map((e) => (
                <li key={e.id} className="row small">
                  <span className={e.status === "succeeded" ? "ok" : e.status === "running" ? "brass" : "err"}>{e.status === "succeeded" ? "✓" : e.status === "running" ? "▶" : "✗"}</span>
                  <a href="#" className="grow ellipsis" onClick={(ev) => (ev.preventDefault(), selectTask(e.taskId), setSection("work"))}>
                    {truncate(e.taskTitle ?? e.taskId, 44)}
                  </a>
                  <span className="dim mono">{duration(e.durationMs)}</span>
                  {e.contextTokens != null && <span className="dim mono">~{e.contextTokens}t</span>}
                  <span className="dim">{ago(e.startedAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </aside>
  );
}

function modelFor(workerId: string, config: DevConfig | null): string | null {
  if (!config) return null;
  if (workerId === "claude-code") return config.workers.claudeCode.model ?? "CLI default";
  if (workerId === "codex") return config.workers.codex.model ?? "CLI default";
  if (workerId === "ollama") return config.workers.ollama.model;
  return null;
}

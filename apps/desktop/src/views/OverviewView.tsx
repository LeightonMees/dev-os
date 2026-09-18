import { useEffect, useState } from "react";

import { Feed } from "../components/Feed.tsx";
import { Term } from "../components/Term.tsx";
import type { ExecutionRow, ProjectDetail, UsageReport } from "../lib/api.ts";
import { ago, duration, elapsed, truncate } from "../lib/format.ts";
import { useStore } from "../lib/store.tsx";

/** The engineering overview of the current project: what, where, what is next, what is running, what needs you. */
export function OverviewView() {
  const { api, act, currentProject, tasks, status, checks, feed, selectTask, setSection, openDialog, projects, selectProject, attention, setBottom, visibleProjects } = useStore();
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [recentExecutions, setRecentExecutions] = useState<ExecutionRow[]>([]);
  const [usage, setUsage] = useState<UsageReport | null>(null);
  const projectId = currentProject?.id ?? null;
  useEffect(() => {
    if (!projectId) return;
    api.project(projectId).then(setDetail).catch(() => setDetail(null));
    api.executions({ projectId, limit: 8 }).then(setRecentExecutions).catch(() => setRecentExecutions([]));
    api.usage(30).then(setUsage).catch(() => setUsage(null));
  }, [api, projectId, tasks.length, feed.length]);

  if (!currentProject) {
    return (
      <div className="view">
        <div className="toolbar">
          <h1>Overview</h1>
        </div>
        <div className="view-body">
          <div className="empty">
            <b>{projects.length === 0 ? "No projects yet." : "No project selected."}</b>
            <br />
            {projects.length === 0 ? (
              <>
                Register a directory to start, or from a terminal: <code>dev project add .</code>
              </>
            ) : (
              "Pick one in the sidebar."
            )}
            <div style={{ marginTop: 10 }}>
              <button className="btn primary" onClick={() => openDialog("project")}>
                Add project
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const open = (id: string) => {
    selectTask(id);
    setSection("work");
  };
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const runnable = tasks.filter((t) => t.status === "READY" && t.dependsOn.every((d) => byId.get(d)?.status === "DONE"));
  const running = (status?.running ?? []).filter((e) => e.projectId === projectId);
  const blocked = tasks.filter((t) => t.status === "BLOCKED");
  const review = tasks.filter((t) => t.status === "REVIEW");
  const recentDone = tasks.filter((t) => t.status === "DONE").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 6);
  const auto = status?.auto.find((a) => a.projectId === projectId);
  const git = detail?.git;
  const lastCheck = checks[0];
  const counts = currentProject.tasks;

  const nextAction = (() => {
    if (attention.length > 0) return { title: attention[0]!.action === "human-input" ? "Answer DEV's question" : `Approve or deny: ${attention[0]!.action}`, why: attention[0]!.reason || "DEV is waiting for you.", action: { label: "Open Problems", run: () => setBottom(true, "problems") } };
    if (running.length > 0) return { title: `${running.length} execution(s) in progress`, why: "Watch Output; the next task starts when a dependency finishes.", action: null as null | { label: string; run: () => void } };
    if (review.length > 0) return { title: `Review “${review[0]!.title}”`, why: "It succeeded and waits for your approval.", action: { label: "Open", run: () => open(review[0]!.id) } };
    if (blocked.length > 0 && runnable.length === 0) return { title: `Unblock “${blocked[0]!.title}”`, why: blocked[0]!.failure?.nextAction ?? "See the failure in the inspector.", action: { label: "Open", run: () => open(blocked[0]!.id) } };
    if (runnable.length > 0) return { title: `Run “${runnable[0]!.title}”`, why: runnable.length > 1 ? `${runnable.length} tasks are runnable; auto-run takes them in dependency order.` : "Its dependencies are done.", action: { label: runnable.length > 1 ? "Run all ready" : "Run", run: () => (runnable.length > 1 ? act(() => api.autoRun(currentProject.id), "Auto-run started") : act(() => api.runTask(runnable[0]!.id), "Started")) } };
    if (tasks.some((t) => t.status === "BACKLOG")) return { title: "Backlog tasks are waiting on dependencies", why: "Nothing is runnable until an upstream task finishes.", action: { label: "Open Work", run: () => setSection("work") } };
    return { title: tasks.length === 0 ? "Plan the first milestone" : "Milestone complete", why: tasks.length === 0 ? "Describe a goal; DEV proposes a small bounded task list." : "Plan the next slice.", action: { label: "Plan a goal", run: () => (setSection("work"), openDialog("plan")) } };
  })();

  return (
    <div className="view">
      <div className="toolbar">
        <h1>{currentProject.name}</h1>
        <span className="sub selectable" title={currentProject.path ?? "no repository yet"}>
          {truncate(currentProject.path, 70)}
        </span>
        {git?.isRepo ? (
          <span className="sub">
            <span className="brass">{git.branch ?? (git.detached ? "detached" : "?")}</span>
            {git.dirty ? <span className="warn"> ●{git.changes.length} changed</span> : <span className="ok"> clean</span>}
            {git.lastCommit && <span className="dim"> {git.lastCommit.short} {truncate(git.lastCommit.subject, 40)}</span>}
          </span>
        ) : (
          <span className="sub dim">not a git repository</span>
        )}
        <span className="spacer" />
        <button className="btn small" onClick={() => setSection("work")}>
          Open Work
        </button>
        <button className="btn ghost small" onClick={() => openDialog("editProject")}>
          Edit project
        </button>
      </div>
      <div className="subbar">
        <span className="grow ellipsis">
          <span className="k">Goal</span>
          <span className="selectable">{currentProject.goal ?? <span className="dim">none set</span>}</span>
        </span>
        <span className="ellipsis">
          <span className="k">
            <Term word="milestone">Milestone</Term>
          </span>
          {currentProject.milestone ?? <span className="dim">none set</span>}
        </span>
        <span className="dim">updated {ago(currentProject.updatedAt)}</span>
      </div>
      <div className="view-body">
        <div className="figures" style={{ marginBottom: 18 }}>
          <Figure n={counts.BACKLOG} l="backlog" />
          <Figure n={counts.READY} l="ready" />
          <Figure n={counts.WORKING} l="working" cls={counts.WORKING ? "brass" : ""} />
          <Figure n={counts.BLOCKED} l="blocked" cls={counts.BLOCKED ? "err" : ""} />
          <Figure n={counts.REVIEW} l="review" cls={counts.REVIEW ? "warn" : ""} />
          <Figure n={counts.DONE} l="done" cls="ok" />
          <Figure n={checks.filter((c) => c.kind === "verification" || c.kind === "file-exists").length} l="checks run" />
          <Figure n={checks.filter((c) => !c.passed).length} l="checks failed" cls={checks.some((c) => !c.passed) ? "err" : ""} />
        </div>
        <ProgressAndUsage counts={counts} usage={usage} workers={status?.workers ?? []} />
        <div className="next-action" style={{ marginBottom: 18 }}>
          <div className="what">
            <b>Next: {nextAction.title}</b>
            <div className="why">{nextAction.why}</div>
          </div>
          {auto && (
            <button className="btn danger small" onClick={() => act(() => api.autoStop(currentProject.id), "Auto-run stopping")}>
              Stop auto-run ({auto.ran} done)
            </button>
          )}
          {nextAction.action && !auto && (
            <button className="btn primary" onClick={nextAction.action.run}>
              {nextAction.action.label}
            </button>
          )}
        </div>
        <div className="overview">
          <div className="ov-block">
            <div className="label">
              Running now <span className="count">{running.length}</span>
            </div>
            {running.length === 0 && <div className="ov-row dim">Nothing running.</div>}
            {running.map((e) => {
              const row = recentExecutions.find((r) => r.id === e.id);
              return (
                <div key={e.id} className="ov-row clickable" onClick={() => open(e.taskId)}>
                  <span className="brass sym">▶</span>
                  <span className="t">{byId.get(e.taskId)?.title ?? e.taskId}</span>
                  <span className="m">{e.workerId}</span>
                  {row?.contextTokens != null && <span className="m">~{row.contextTokens}t</span>}
                  <span className="m">{elapsed(e.startedAt)}</span>
                </div>
              );
            })}
          </div>
          <div className="ov-block">
            <div className="label">
              Needs attention <span className="count">{blocked.length + review.length + attention.length}</span>
            </div>
            {blocked.length + review.length + attention.length === 0 && <div className="ov-row dim">Nothing waiting on you.</div>}
            {attention.map((a) => (
              <div key={a.id} className="ov-row clickable" onClick={() => setBottom(true, "problems")}>
                <span className="warn">?</span>
                <span className="t" title={a.reason}>
                  {a.reason}
                </span>
                <span className="m">{a.action === "human-input" ? "question" : a.action}</span>
              </div>
            ))}
            {review.map((t) => (
              <div key={t.id} className="ov-row clickable" onClick={() => open(t.id)}>
                <span className="sym REVIEW">◆</span>
                <span className="t">{t.title}</span>
                <span className="m">review</span>
              </div>
            ))}
            {blocked.map((t) => (
              <div key={t.id} className="ov-row clickable" onClick={() => open(t.id)}>
                <span className="sym BLOCKED">■</span>
                <span className="t">{t.title}</span>
                <span className="r" title={t.failure?.reason}>
                  {truncate(t.failure?.reason ?? "", 60)}
                </span>
              </div>
            ))}
          </div>
          <div className="ov-block">
            <div className="label">
              Last <Term word="verification">checks</Term> <span className="count">{checks.length}</span>
            </div>
            {!lastCheck && <div className="ov-row dim">No verification has run yet.</div>}
            {checks.slice(0, 6).map((c) => (
              <div key={c.id} className="ov-row clickable" onClick={() => open(c.taskId)}>
                <span className={c.passed ? "ok" : "err"}>{c.passed ? "✓" : "✗"}</span>
                <span className="t" title={c.summary}>
                  {c.summary}
                </span>
                <span className="m">{truncate(c.taskTitle ?? "", 24)}</span>
                <span className="m">{ago(c.createdAt)}</span>
              </div>
            ))}
          </div>
          <div className="ov-block">
            <div className="label">
              <Term word="worker">Workers</Term> <span className="count">{status?.workers.filter((w) => w.health?.ok).length ?? 0}/{status?.workers.length ?? 0} healthy</span>
            </div>
            {(status?.workers ?? []).map((w) => (
              <div key={w.id} className="ov-row clickable" onClick={() => setSection("workers")}>
                <span className={w.health ? (w.health.ok ? "ok" : "err") : "dim"}>{w.health ? "●" : "○"}</span>
                <span className="t">{w.name}</span>
                <span className="m">{w.currentTaskId ? "busy" : w.health?.ok ? "idle" : w.health ? "down" : "unchecked"}</span>
                <span className="m">
                  {w.stats.succeeded}/{w.stats.executions}
                </span>
              </div>
            ))}
          </div>
          <div className="ov-block">
            <div className="label">
              Recently done <span className="count">{recentDone.length}</span>
            </div>
            {recentDone.length === 0 && <div className="ov-row dim">Nothing finished yet.</div>}
            {recentDone.map((t) => (
              <div key={t.id} className="ov-row clickable" onClick={() => open(t.id)}>
                <span className="sym DONE">●</span>
                <span className="t">{t.title}</span>
                <span className="m">{ago(t.updatedAt)}</span>
              </div>
            ))}
          </div>
          <div className="ov-block">
            <div className="label">
              Recent executions <span className="count">{recentExecutions.length}</span>
            </div>
            {recentExecutions.length === 0 && <div className="ov-row dim">None yet.</div>}
            {recentExecutions.slice(0, 6).map((e) => (
              <div key={e.id} className="ov-row clickable" onClick={() => open(e.taskId)}>
                <span className={e.status === "succeeded" ? "ok" : e.status === "running" ? "brass" : "err"}>{e.status === "succeeded" ? "✓" : e.status === "running" ? "▶" : "✗"}</span>
                <span className="t">{e.taskTitle ?? e.taskId}</span>
                <span className="m">{e.workerId}</span>
                <span className="m">{duration(e.durationMs)}</span>
              </div>
            ))}
          </div>
          {detail && detail.decisions.length > 0 && (
            <div className="ov-block">
              <div className="label">
                Decisions <span className="count">{detail.decisions.length}</span>
              </div>
              {detail.decisions.slice(0, 5).map((d) => (
                <div key={d.id} className="ov-row" title={d.reason}>
                  <span className="t">{d.title}</span>
                  <span className="m">{truncate(d.decision, 40)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="section" style={{ marginTop: 20 }}>
          <div className="label">Recent activity</div>
          <div style={{ border: "1px solid var(--rule)", maxHeight: 220, display: "flex", background: "var(--ink-1)" }}>
            <Feed events={feed.filter((e) => e.projectId === projectId)} onSelectTask={open} limit={50} />
          </div>
        </div>
        {visibleProjects.length > 1 && (
          <div className="section">
            <div className="label">Other active projects</div>
            <div className="row" style={{ flexWrap: "wrap" }}>
              {visibleProjects
                .filter((p) => p.id !== projectId)
                .map((p) => (
                  <button key={p.id} className="btn small" onClick={() => selectProject(p.id)} title={p.path ?? "no repository yet"}>
                    {p.name} <span className="dim">{p.tasks.READY + p.tasks.WORKING} active</span>
                  </button>
                ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Figure({ n, l, cls = "" }: { n: number; l: string; cls?: string }) {
  return (
    <div className="figure">
      <div className={`n ${cls}`}>{n}</div>
      <div className="l">{l}</div>
    </div>
  );
}

/**
 * How far this project has come, and what the workers have actually spent. Every number here is
 * measured: task counts from the board, tokens and cost from what each worker reported after a run.
 */
function ProgressAndUsage({ counts, usage, workers }: { counts: Record<string, number>; usage: UsageReport | null; workers: { id: string; name: string; health: { ok: boolean; detail: string } | null }[] }) {
  const total = Object.entries(counts).filter(([k]) => k !== "CANCELLED").reduce((n, [, v]) => n + v, 0);
  const done = counts.DONE ?? 0;
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  const inFlight = (counts.WORKING ?? 0) + (counts.REVIEW ?? 0);
  const tokens = usage ? usage.total.input + usage.total.output : 0;
  const money = usage?.total.costUsd ?? 0;
  const ran = new Set((usage?.byWorker ?? []).map((w) => w.workerId));
  // Healthy workers that have run nothing: the honest counterpart to the ones that have.
  const idle = workers.filter((w) => w.health?.ok && !ran.has(w.id));
  // Free-tier and quota notes come from each worker's own health probe, not from a guess.
  const limits = workers.filter((w) => w.health && /free tier|tokens\/day|quota|limit/i.test(w.health.detail)).slice(0, 4);
  return (
    <div className="ov-block" style={{ marginBottom: 18 }}>
      <div className="label">
        Progress and usage <span className="dim small" style={{ fontWeight: 400 }}>· last {usage?.days ?? 30} days</span>
      </div>
      <div className="row" style={{ gap: 10, alignItems: "center", margin: "6px 0 10px" }}>
        <div className="progress-track" title={`${done} of ${total} tasks done`}>
          <div className="progress-fill" style={{ width: `${percent}%` }} />
        </div>
        <span className="mono">{percent}%</span>
        <span className="dim small">
          {done} of {total} done{inFlight ? `, ${inFlight} in flight` : ""}
        </span>
      </div>
      <div className="figures">
        <Figure n={usage?.total.executions ?? 0} l="runs" />
        <Figure n={Math.round(tokens / 1000)} l="k tokens" />
        <Figure n={Math.round((usage?.total.cacheRead ?? 0) / 1000)} l="k cached" />
        <Figure n={Math.round((usage?.total.durationMs ?? 0) / 60000)} l="worker minutes" />
      </div>
      <div className="row" style={{ gap: 14, marginTop: 8, flexWrap: "wrap" }}>
        <span className="dim small">
          cost reported: <b className={money > 0 ? "warn" : "ok"}>${money.toFixed(2)}</b>
          {money === 0 ? " (free tiers and local models)" : ""}
        </span>
      </div>
      {/* Every worker that ran, not only the ones that report tokens: who did the work matters as
          much as what it cost, and a worker reporting nothing is not a worker doing nothing. */}
      <table className="table rows" style={{ marginTop: 8 }}>
        <thead>
          <tr>
            <th>Worker</th>
            <th style={{ width: 70 }}>Runs</th>
            <th style={{ width: 90 }}>Tokens</th>
            <th style={{ width: 80 }}>Cost</th>
            <th style={{ width: 90 }}>Time</th>
          </tr>
        </thead>
        <tbody>
          {(usage?.byWorker ?? []).map((w) => (
            <tr key={w.workerId}>
              <td>{w.workerId}</td>
              <td className="mono">{w.executions}</td>
              <td className="mono">{w.input + w.output > 0 ? `${Math.round((w.input + w.output) / 1000)}k` : <span className="dim">not reported</span>}</td>
              <td className="mono">{w.costUsd > 0 ? `$${w.costUsd.toFixed(2)}` : <span className="dim">—</span>}</td>
              <td className="mono dim">{Math.round(w.durationMs / 60000)}m</td>
            </tr>
          ))}
          {idle.map((w) => (
            <tr key={w.id} className="dim">
              <td>{w.id}</td>
              <td className="mono">0</td>
              <td colSpan={3} className="small">
                healthy, nothing routed to it yet
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {limits.length > 0 && (
        <div className="dim small" style={{ marginTop: 6 }}>
          Provider limits: {limits.map((w) => `${w.name} — ${w.health?.detail.replace(/^.*?;\s*/, "")}`).join(" · ")}
        </div>
      )}
      {usage && usage.total.executions > 0 && <div className="dim small" style={{ marginTop: 6 }}>{usage.note}</div>}
    </div>
  );
}

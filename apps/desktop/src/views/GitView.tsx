import { useEffect, useState } from "react";

import { Term } from "../components/Term.tsx";
import type { GitStatus } from "../lib/api.ts";
import { ago, truncate } from "../lib/format.ts";
import { useStore } from "../lib/store.tsx";

export function GitView() {
  const { api, act, currentProject, feed, toast } = useStore();
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [log, setLog] = useState<{ hash: string; short: string; subject: string; author: string; date: string }[]>([]);
  const [branches, setBranches] = useState<{ current: string | null; all: string[] }>({ current: null, all: [] });
  const [diff, setDiff] = useState<string>("");
  const [path, setPath] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [newBranch, setNewBranch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const projectId = currentProject?.path ? currentProject.id : undefined;
  const gitEvents = feed.filter((e) => e.type === "GIT_COMMIT" || e.type === "FILE_CHANGED" || e.type === "TASK_COMPLETED").length;

  const load = async () => {
    if (!projectId) return;
    try {
      const [s, l, b] = await Promise.all([api.gitStatus(projectId), api.gitLog(projectId, 30), api.gitBranches(projectId)]);
      setStatus(s);
      setLog(l);
      setBranches(b);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, gitEvents]);
  useEffect(() => {
    if (!projectId) return;
    api
      .gitDiff(projectId, { path: path ?? undefined })
      .then((d) => setDiff(d.diff))
      .catch(() => setDiff(""));
  }, [api, projectId, path, gitEvents]);

  if (!currentProject) return <div className="view"><div className="toolbar"><h1>Git</h1></div><div className="view-body"><div className="empty">No project selected.</div></div></div>;
  if (status && !status.isRepo)
    return (
      <div className="view">
        <div className="toolbar">
          <h1>Git</h1>
          <span className="sub">{currentProject.name}</span>
        </div>
        <div className="view-body">
          <div className="empty">
            <b>{currentProject.path}</b> is not a git repository.
            <br />
            Run <code>git init</code> in the terminal to start tracking it; DEV then captures changed files and diffs for every task.
          </div>
        </div>
      </div>
    );

  const commit = async () => {
    if (!message.trim()) return;
    const result = await act(() => api.gitCommit(currentProject.id, message.trim()));
    if (!result) return;
    if ("approvalRequired" in result) {
      // Nothing was committed: the project asks for a decision first. Approving
      // it in the Attention panel performs the commit with this same message.
      toast("info", "Commit filed for your approval — approve it in Attention to commit");
    } else {
      toast("success", `Committed ${result.short}`);
    }
    setMessage("");
    await load();
  };
  const untrackedSelected = path && status?.changes.find((c) => c.path === path)?.status === "??";

  return (
    <div className="view">
      <div className="toolbar">
        <h1>Git</h1>
        {status && (
          <span className="sub">
            <span className="brass">{status.branch ?? (status.detached ? "detached HEAD" : "?")}</span>
            {status.remote && <span className="dim"> {status.remote}</span>}
            {(status.ahead || status.behind) ? <span className="dim"> ↑{status.ahead} ↓{status.behind}</span> : null}
          </span>
        )}
        <span className="spacer" />
        <select
          className="select auto"
          value={branches.current ?? ""}
          aria-label="Branch"
          onChange={(e) => {
            const ref = e.target.value;
            if (ref && ref !== branches.current) void act(() => api.gitCheckout(currentProject.id, ref), `Checked out ${ref}`).then(load);
          }}
        >
          {branches.all.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
        <input className="input" style={{ width: 180 }} placeholder="new branch name" aria-label="New branch name" value={newBranch} onChange={(e) => setNewBranch(e.target.value)} onKeyDown={(e) => e.key === "Enter" && newBranch.trim() && act(() => api.gitBranch(currentProject.id, newBranch.trim()), `Created ${newBranch}`).then(() => (setNewBranch(""), load()))} />
        <button className="btn small" onClick={load}>
          Refresh
        </button>
      </div>
      <div className="split">
        <div className="pane" style={{ flex: "0 0 380px", borderRight: "1px solid var(--rule)", overflow: "auto" }}>
          <div className="view-body">
            {error && <div className="failure">{error}</div>}
            <div className="section">
              <div className="label">
                <Term word="working tree">Working tree</Term> <span className="count">{status?.changes.length ?? 0} changed</span>
              </div>
              {status?.changes.length === 0 ? (
                <div className="ok small">clean</div>
              ) : (
                <ul className="list mono small">
                  {status?.changes.map((c) => (
                    <li key={c.path} className={`row`} style={{ cursor: "default", background: path === c.path ? "var(--ink-3)" : undefined, padding: "3px 4px" }} onClick={() => setPath(path === c.path ? null : c.path)} title={c.path}>
                      <span className="warn" style={{ width: 22 }}>
                        {c.status}
                      </span>
                      <span className="selectable ellipsis">{c.path}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {status && status.changes.length > 0 && (
              <div className="section">
                <div className="label">
                  <Term word="commit">Commit</Term> all changes
                </div>
                <textarea className="textarea" value={message} onChange={(e) => setMessage(e.target.value)} placeholder="feat: describe the change" aria-label="Commit message" onKeyDown={(e) => e.key === "Enter" && (e.ctrlKey || e.metaKey) && commit()} />
                <div className="row" style={{ marginTop: 6 }}>
                  <button className="btn primary small" onClick={commit} disabled={!message.trim()}>
                    Commit
                  </button>
                  <span className="dim small">Ctrl+Enter</span>
                </div>
              </div>
            )}
            <div className="section">
              <div className="label">
                History <span className="count">{log.length}</span>
              </div>
              <ul className="list">
                {log.map((c) => (
                  <li key={c.hash} className="row small">
                    <span className="mono warn" style={{ width: 60 }} onClick={() => navigator.clipboard?.writeText(c.hash).then(() => toast("info", "Hash copied"))} title={`${c.hash} (click to copy)`}>
                      {c.short}
                    </span>
                    <span className="grow selectable ellipsis" title={c.subject}>
                      {truncate(c.subject, 44)}
                    </span>
                    <span className="dim">{ago(c.date)}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
        <div className="pane" style={{ flex: 1 }}>
          <div className="panel-strip">
            <span className="label">Unstaged diff</span>
            {path && (
              <>
                <span className="mono">{path}</span>
                <button className="btn ghost small" onClick={() => setPath(null)}>
                  all files
                </button>
              </>
            )}
          </div>
          {diff.trim() ? (
            <div className="output fill">
              {diff.split("\n").map((line, i) => (
                <div key={i} className={`diff-line ${line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") ? "file" : line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : line.startsWith("@@") ? "hunk" : ""}`}>
                  {line}
                </div>
              ))}
            </div>
          ) : (
            <div className="view-body">
              <div className="empty">{untrackedSelected ? "Untracked file: git has no previous version to diff against." : "No unstaged changes."}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

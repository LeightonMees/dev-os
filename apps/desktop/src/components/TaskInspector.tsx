import { useEffect, useMemo, useState } from "react";

import type { ContextPreview, TaskDetail } from "../lib/api.ts";

type Verification = TaskDetail["verification"][number];
import { ago, bytes, duration, MANUAL_MOVES, STATUS_LABEL, STATUS_SYMBOL, truncate } from "../lib/format.ts";
import { openInFileManager } from "../lib/native.ts";
import { useStore } from "../lib/store.tsx";
import { Feed } from "./Feed.tsx";
import { Output } from "./Output.tsx";

type Tab = "overview" | "execution" | "context" | "evidence" | "events";

/** Everything about one task, in the right-hand pane. Refreshes on relevant events. */
export function TaskInspector({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const { api, act, feed, output, selectTask, toast, moveTaskAsked, tasks: projectTasks, status } = useStore();
  const milestoneOptions = [...new Set(projectTasks.map((t) => t.milestone).filter((m): m is string => !!m))].sort();
  const epicOptions = [...new Set(projectTasks.map((t) => t.epic).filter((m): m is string => !!m))].sort();
  const workerOptions = (status?.workers ?? []).map((w) => ({ id: w.id, label: `${w.name}${w.health && !w.health.ok ? " (down)" : ""}` }));
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [context, setContext] = useState<ContextPreview | null>(null);
  // The brief editor. promptDraft is local until saved; task.promptOverride is the saved truth.
  const [editingPrompt, setEditingPrompt] = useState(false);
  const [promptDraft, setPromptDraft] = useState("");
  const [log, setLog] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    api
      .task(taskId)
      .then((t) => {
        setTask(t);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));

  useEffect(() => {
    setTask(null);
    setContext(null);
    setLog("");
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  // Re-fetch when an event for this task arrives.
  const lastForTask = feed.filter((e) => e.taskId === taskId).at(-1)?.id;
  useEffect(() => {
    if (lastForTask !== undefined) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastForTask]);

  useEffect(() => {
    if (tab === "context" && !context) api.context(taskId).then(setContext).catch((e: Error) => toast("error", e.message));
    if (tab === "execution" && task?.executions[0] && task.status !== "WORKING") api.log(taskId, { tail: 60_000 }).then((r) => setLog(r.log)).catch(() => setLog(""));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, taskId, task?.executions.length, task?.status]);

  if (error) return <div className="inspector"><div className="inspector-body"><div className="failure">{error}</div></div></div>;
  if (!task) return <div className="inspector"><div className="inspector-body muted">Loading…</div></div>;

  const latest = task.executions[0];
  const locked = task.status === "WORKING";
  const save = (patch: Record<string, unknown>) => act(() => api.updateTask(task.id, patch), "Saved").then(() => load());
  const live = latest ? (output.get(latest.id) ?? []) : [];
  const evidence = task.evidence;
  const taskEvents = feed.filter((e) => e.taskId === taskId);
  const events = taskEvents.length >= task.events.length ? taskEvents : task.events;

  return (
    <aside className="inspector" data-testid="inspector">
      <div className="inspector-head">
        <div className="row">
          <span className={`pill ${task.status}`}>
            <span className="sym">{STATUS_SYMBOL[task.status]}</span>
            {STATUS_LABEL[task.status]}
          </span>
          <span className="mono dim">
            {task.id} · #{task.ordinal}
          </span>
          <button className="btn ghost small" style={{ marginLeft: "auto" }} onClick={onClose} aria-label="Close inspector">
            ✕
          </button>
        </div>
        <EditableText as="h2" value={task.title} disabled={locked} placeholder="Task title" onSave={(v) => v.trim() && save({ title: v.trim() })} />
        <div className="inspector-actions">
          {task.status === "READY" && (
            <button className="btn primary small" onClick={() => act(() => api.runTask(task.id), "Started")}>
              Run
            </button>
          )}
          {task.status === "BACKLOG" && (
            <button className="btn small" title="Queue it for a worker" onClick={() => void moveTaskAsked(task.id, "READY").then(() => load())}>
              Mark ready
            </button>
          )}
          {(task.status === "BLOCKED" || task.status === "REVIEW") && (
            <button className="btn small" onClick={() => act(() => api.runTask(task.id), "Retrying")}>
              Retry
            </button>
          )}
          {task.status === "WORKING" && (
            <button className="btn danger small" title="Stop the run and put the task back in Ready; nothing is deleted" onClick={() => act(() => api.cancelTask(task.id), "Run stopped; task back in Ready")}>
              Stop run
            </button>
          )}
          {task.status === "REVIEW" && (
            <>
              <button className="btn primary small" onClick={() => act(() => api.approveTask(task.id, "Approved in desktop review"), "Approved")}>
                Approve
              </button>
              <button
                className="btn danger small"
                onClick={() => {
                  const reason = window.prompt("Why is this rejected?");
                  if (reason) void act(() => api.rejectTask(task.id, reason), "Rejected");
                }}
              >
                Reject
              </button>
            </>
          )}
          <MoveMenu status={task.status} onMove={(to) => void moveTaskAsked(task.id, to).then(() => load())} />
          {task.status !== "WORKING" && (
            <button
              className="btn ghost small"
              onClick={() => {
                if (window.confirm(`Delete task "${task.title}" and its history?`)) void act(() => api.deleteTask(task.id), "Deleted").then(() => selectTask(null));
              }}
            >
              Delete
            </button>
          )}
        </div>
      </div>
      <div className="tabs">
        {(
          [
            ["overview", "Overview", null],
            ["execution", "Execution", task.executions.length],
            ["context", "Context", null],
            ["evidence", "Evidence", evidence.length + task.artifacts.length],
            ["events", "Events", events.length],
          ] as [Tab, string, number | null][]
        ).map(([id, label, n]) => (
          <button key={id} className={`tab${tab === id ? " active" : ""}`} onClick={() => setTab(id)}>
            {label}
            {n !== null && n > 0 && <span className="n">{n}</span>}
          </button>
        ))}
      </div>
      <div className="inspector-body">
        {tab === "overview" && (
          <>
            {task.failure && (
              <div className="failure">
                <div className="k">{task.failure.kind}</div>
                <div className="selectable">{task.failure.reason}</div>
                <div className="next">→ {task.failure.nextAction}</div>
              </div>
            )}
            {task.resultSummary && <div className="result-box">{task.resultSummary}</div>}
            {task.needsHuman && task.status !== "DONE" && task.status !== "CANCELLED" && (
              <NeedsYou
                question={task.needsHuman}
                locked={locked}
                previous={task.evidence.filter((e) => e.kind === "human-input")}
                onAnswer={(answer, then) => act(() => api.answerTask(task.id, answer, then), then === "done" ? "Answered and done" : then === "ready" ? "Answered, marked ready" : "Answer saved").then(() => load())}
              />
            )}
            <div className="section">
              <div className="label">
                Desired outcome
                {!locked && <span className="dim small"> · click any field to edit</span>}
              </div>
              <EditableText as="p" multiline value={task.outcome ?? ""} disabled={locked} placeholder="What should be true when this task is done?" onSave={(v) => save({ outcome: v.trim() })} />
            </div>
            <div className="section">
              <div className="label">Requirements</div>
              <EditableList items={task.requirements} disabled={locked} placeholder="One requirement per line" onSave={(items) => save({ requirements: items })} />
            </div>
            <div className="section">
              <div className="label">Acceptance criteria</div>
              <EditableList items={task.acceptance} disabled={locked} placeholder="One criterion per line" onSave={(items) => save({ acceptance: items })} />
            </div>
            <div className="section">
              <div className="label">Details</div>
              <div className="kv">
                <span className="k">milestone</span>
                <EditableCombo value={task.milestone ?? ""} options={milestoneOptions} disabled={locked} placeholder="none" className="v" onSave={(v) => save({ milestone: v.trim() || null })} />
                <span className="k">epic</span>
                <EditableCombo value={task.epic ?? ""} options={epicOptions} disabled={locked} placeholder="none" className="v" onSave={(v) => save({ epic: v.trim() || null })} />
                <span className="k">kind</span>
                <EditableSelect value={task.kind} options={["ticket", "epic", "subtask", "prep", "decision"]} disabled={locked} className="v" onSave={(v) => save({ kind: v })} />
                <span className="k">risk</span>
                <EditableSelect value={task.risk} options={["low", "normal", "high"]} disabled={locked} className={`v ${task.risk === "high" ? "err" : ""}`} onSave={(v) => save({ risk: v })} />
                <span className="k">size</span>
                <EditableSelect value={task.effort} options={["low", "medium", "high"]} disabled={locked} className="v" onSave={(v) => save({ effort: v })} />
                {/* A different axis from size: how hard the model is told to think on this one task. */}
                <span className="k">reasoning</span>
                <EditableSelect
                  value={task.reasoningEffort ?? "from size"}
                  options={["from size", "minimal", "low", "medium", "high", "xhigh", "max"]}
                  disabled={locked}
                  className="v"
                  onSave={(v) => save({ reasoningEffort: v === "from size" ? null : v })}
                />
                <span className="k">needs you</span>
                <EditableText value={task.needsHuman ?? ""} disabled={locked} placeholder="nothing; a worker can do it" className={`v${task.needsHuman ? " warn" : ""}`} onSave={(v) => save({ needsHuman: v.trim() || null })} />
                <span className="k">worker</span>
                <span className="v">
                  <select className="select editable-select" value={task.workerId ?? ""} disabled={locked} aria-label="Worker" onChange={(e) => void save({ workerId: e.target.value || null })}>
                    <option value="">auto (DEV routes it)</option>
                    {workerOptions.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.label}
                      </option>
                    ))}
                    {task.workerId && !workerOptions.some((w) => w.id === task.workerId) && <option value={task.workerId}>{task.workerId}</option>}
                  </select>
                </span>
                <span className="k">command</span>
                <EditableText value={task.command ?? ""} disabled={locked} placeholder="none (the worker decides)" className="v mono" onSave={(v) => save({ command: v.trim() || null })} />
                <span className="k">verification</span>
                <EditableList mono items={task.verification.map(formatVerification)} disabled={locked} placeholder={"One per line: command: npm test · file: path\\to\\output · manual: label"} className="v" onSave={(lines) => save({ verification: lines.map(parseVerification) })} />
                <span className="k">files</span>
                <EditableList mono items={task.files} disabled={locked} placeholder="One path per line" className="v" onSave={(items) => save({ files: items })} />
                {task.capabilities.length > 0 && (
                  <>
                    <span className="k">capabilities</span>
                    <span className="v">{task.capabilities.map((c) => `${c.kind}:${c.name}`).join(", ")}</span>
                  </>
                )}
                <span className="k">retries</span>
                <span className="v">{task.retryCount}</span>
                <span className="k">updated</span>
                <span className="v">{ago(task.updatedAt)}</span>
              </div>
            </div>
            {(task.dependencies.length > 0 || task.dependents.length > 0) && (
              <div className="section">
                <div className="label">Graph</div>
                <ul className="list">
                  {task.dependencies.map((d) => (
                    <li key={d.id} className="row">
                      <span className="dim mono">⇠ needs</span>
                      <a href="#" onClick={(e) => (e.preventDefault(), selectTask(d.id))} className="grow">
                        {d.title}
                      </a>
                      <span className={`pill ${d.status}`}>{STATUS_LABEL[d.status]}</span>
                    </li>
                  ))}
                  {task.dependents.map((d) => (
                    <li key={d.id} className="row">
                      <span className="dim mono">⇢ unblocks</span>
                      <a href="#" onClick={(e) => (e.preventDefault(), selectTask(d.id))} className="grow">
                        {d.title}
                      </a>
                      <span className={`pill ${d.status}`}>{STATUS_LABEL[d.status]}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}

        {tab === "execution" && (
          <>
            {task.executions.length === 0 && <div className="empty">Not executed yet.</div>}
            {latest && (
              <>
                <div className="kv" style={{ marginBottom: 8 }}>
                  <span className="k">execution</span>
                  <span className="v mono">{latest.id}</span>
                  <span className="k">worker</span>
                  <span className="v">{latest.workerId}</span>
                  <span className="k">status</span>
                  <span className={`v ${latest.status === "succeeded" ? "ok" : latest.status === "running" ? "accent" : "err"}`}>{latest.status}</span>
                  {latest.error && (
                    <>
                      <span className="k">why</span>
                      <span className="v err selectable">{latest.error}</span>
                    </>
                  )}
                  <span className="k">duration</span>
                  <span className="v">{duration(latest.durationMs)}</span>
                  <span className="k">exit</span>
                  <span className="v mono">{latest.exitCode ?? "—"}</span>
                  {latest.command && (
                    <>
                      <span className="k">command</span>
                      <span className="v mono">{truncate(latest.command, 200)}</span>
                    </>
                  )}
                  {latest.usage && (
                    <>
                      <span className="k">usage</span>
                      <span className="v mono small">{Object.entries(latest.usage).map(([k, v]) => `${k}=${typeof v === "number" ? Math.round(v * 1000) / 1000 : String(v)}`).join("  ")}</span>
                    </>
                  )}
                  {latest.changedFiles.length > 0 && (
                    <>
                      <span className="k">changed</span>
                      <span className="v mono small">{latest.changedFiles.join("\n")}</span>
                    </>
                  )}
                </div>
                <div className="label" style={{ marginBottom: 4 }}>
                  {task.status === "WORKING" ? "Live output" : "Log"}
                </div>
                {task.status === "WORKING" || live.length > 0 ? <Output chunks={live} placeholder="Waiting for output…" /> : <pre className="output">{log || <span className="dim">Log empty.</span>}</pre>}
                {task.executions.length > 1 && (
                  <div className="section" style={{ marginTop: 12 }}>
                    <div className="label">Earlier executions</div>
                    <ul className="list">
                      {task.executions.slice(1).map((e) => (
                        <li key={e.id} className="row mono small">
                          <span>{e.id}</span>
                          <span>{e.workerId}</span>
                          <span className={e.status === "succeeded" ? "ok" : "err"}>{e.status}</span>
                          <span className="dim">{duration(e.durationMs)}</span>
                          <span className="dim" style={{ marginLeft: "auto" }}>
                            {ago(e.startedAt)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
          </>
        )}

        {tab === "context" && (
          <>
            {!context && <div className="muted">Assembling preview…</div>}
            {context && (
              <>
                <div className="row small">
                  <span>
                    ~{context.usedTokens} of {context.budgetTokens} tokens
                  </span>
                  <span className="dim">{context.sections.filter((s) => s.included).length} sections in</span>
                  <button className="btn ghost small" style={{ marginLeft: "auto" }} onClick={() => api.context(taskId).then(setContext)}>
                    Refresh
                  </button>
                </div>
                <div className="ctx-bar" title="share of the budget per section">
                  {context.sections
                    .filter((s) => s.included)
                    .map((s) => (
                      <span key={s.name} className={s.truncated ? "cut" : ""} style={{ width: `${Math.max(1, (s.tokens / Math.max(context.budgetTokens, 1)) * 100)}%` }} title={`${s.name}: ~${s.tokens}`} />
                    ))}
                </div>
                <table className="table">
                  <thead>
                    <tr>
                      <th></th>
                      <th>Section</th>
                      <th>Tokens</th>
                    </tr>
                  </thead>
                  <tbody>
                    {context.sections.map((s) => (
                      <tr key={s.name}>
                        <td className={s.included ? (s.truncated ? "warn" : "ok") : "dim"}>{s.included ? (s.truncated ? "cut" : "in") : "out"}</td>
                        <td className="mono">
                          {s.name}
                          {s.source && <span className="dim"> · {s.source}</span>}
                        </td>
                        <td className="mono">~{s.tokens}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="label" style={{ margin: "10px 0 4px" }}>
                  Exact prompt the worker receives
                  {task.promptOverride !== null && <span className="warn" style={{ marginLeft: 8 }}>edited by you</span>}
                  <span className="spacer" />
                  {!editingPrompt && !locked && (
                    <button className="link" onClick={() => (setPromptDraft(task.promptOverride ?? context.prompt), setEditingPrompt(true))}>
                      Edit
                    </button>
                  )}
                  {task.promptOverride !== null && !editingPrompt && (
                    <button className="link" style={{ marginLeft: 8 }} onClick={() => void save({ promptOverride: null })}>
                      Reset to assembled
                    </button>
                  )}
                </div>
                {editingPrompt ? (
                  <>
                    <textarea
                      className="input mono"
                      style={{ width: "100%", minHeight: 320, maxHeight: 480 }}
                      value={promptDraft}
                      aria-label="Edit the brief"
                      onChange={(e) => setPromptDraft(e.target.value)}
                    />
                    <div className="dim small" style={{ margin: "4px 0 8px" }}>
                      ~{Math.ceil(promptDraft.length / 4)} tokens. Saved text is sent verbatim; context assembly is skipped until you reset it.
                    </div>
                    <div className="row">
                      <button className="btn" onClick={() => void save({ promptOverride: promptDraft }).then(() => setEditingPrompt(false))}>
                        Save brief
                      </button>
                      <button className="btn ghost" onClick={() => setEditingPrompt(false)}>
                        Cancel
                      </button>
                    </div>
                  </>
                ) : (
                  <pre className="output" style={{ maxHeight: 420 }}>
                    {task.promptOverride ?? context.prompt}
                  </pre>
                )}
                {context.snapshots.length > 0 && (
                  <div className="dim small" style={{ marginTop: 6 }}>
                    Last sent: ~{context.snapshots[0]?.usedTokens} tokens {ago(context.snapshots[0]?.createdAt)}
                  </div>
                )}
              </>
            )}
          </>
        )}

        {tab === "evidence" && (
          <>
            <div className="section">
              <div className="label">
                Evidence <span className="count">{evidence.length}</span>
              </div>
              {evidence.length === 0 ? (
                <div className="empty">
                  No evidence yet. A task reaches <b>Done</b> only with passing evidence: a verification, a successful command, or a human approval.
                </div>
              ) : (
                <ul className="list">
                  {evidence.map((e) => (
                    <li key={e.id} className="row">
                      <span className={e.passed ? "ok" : "err"}>{e.passed ? "✓" : "✗"}</span>
                      <span className="mono dim">{e.kind}</span>
                      <span className="grow selectable">{e.summary}</span>
                      <span className="dim small">{ago(e.createdAt)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="section">
              <div className="label">
                Artifacts <span className="count">{task.artifacts.length}</span>
              </div>
              {task.artifacts.length === 0 ? (
                <div className="dim">None.</div>
              ) : (
                <ul className="list">
                  {task.artifacts.map((a) => (
                    <li key={a.id} className="row">
                      <span className="mono dim">{a.kind}</span>
                      <a href="#" className="grow" onClick={(e) => (e.preventDefault(), openInFileManager(a.path))} title={a.path}>
                        {a.name}
                      </a>
                      <span className="dim small">{bytes(a.size)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}

        {tab === "events" && <Feed events={events} autoScroll={false} />}
      </div>
    </aside>
  );
}

// ----- your input -----

/** The task needs the user: show the question, take the answer, record it, optionally move the task on. */
function NeedsYou({ question, locked, previous, onAnswer }: { question: string; locked: boolean; previous: { id: string; summary: string; createdAt: string }[]; onAnswer: (answer: string, then: "none" | "ready" | "done") => unknown }) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (then: "none" | "ready" | "done") => {
    const answer = draft.trim();
    if (!answer || busy) return;
    setBusy(true);
    try {
      await onAnswer(answer, then);
      setDraft("");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="needs-you" data-testid="needs-you">
      <div className="label">Needs you</div>
      <div className="question selectable">{question}</div>
      {previous.length > 0 && (
        <ul className="list small" style={{ margin: "6px 0" }}>
          {previous.map((e) => (
            <li key={e.id} className="row">
              <span className="dim mono">you</span>
              <span className="grow selectable">{e.summary}</span>
              <span className="dim small">{ago(e.createdAt)}</span>
            </li>
          ))}
        </ul>
      )}
      <textarea
        className="input"
        rows={3}
        value={draft}
        disabled={locked || busy}
        placeholder={locked ? "Locked while a worker is on it" : "Type your answer, decision or the information the task needs… (Ctrl+Enter saves)"}
        aria-label="Your answer"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void submit("none");
          }
        }}
      />
      <div className="row" style={{ marginTop: 6, gap: 6 }}>
        <button className="btn small" disabled={!draft.trim() || busy || locked} onClick={() => submit("none")} title="Record the answer on the task (evidence + a project decision + a line in the worker's brief)">
          Save answer
        </button>
        <button className="btn small primary" disabled={!draft.trim() || busy || locked} onClick={() => submit("ready")} title="Record the answer and mark the task Ready so a worker can pick it up">
          Save &amp; mark ready
        </button>
        <button className="btn small" disabled={!draft.trim() || busy || locked} onClick={() => submit("done")} title="Record the answer and close the task; use when your answer is the whole job">
          Save &amp; done
        </button>
      </div>
    </div>
  );
}

// ----- in-place editing -----

/** Text field with a dropdown of existing values (native datalist); free text still allowed. */
function EditableCombo({ value, options, onSave, disabled, placeholder, className = "" }: { value: string; options: string[]; onSave: (value: string) => unknown; disabled?: boolean; placeholder?: string; className?: string }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const listId = useMemo(() => `combo-${Math.random().toString(36).slice(2, 8)}`, []);
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);
  const commit = () => {
    setEditing(false);
    if (draft !== value) void onSave(draft);
  };
  if (editing)
    return (
      <span className={className}>
        <input
          autoFocus
          list={listId}
          className="input editable-input"
          value={draft}
          placeholder={placeholder}
          aria-label={placeholder ?? "Edit value"}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setDraft(value);
              setEditing(false);
            } else if (e.key === "Enter") {
              e.preventDefault();
              commit();
            }
          }}
        />
        <datalist id={listId}>
          {options.map((o) => (
            <option key={o} value={o} />
          ))}
        </datalist>
      </span>
    );
  return (
    <span
      className={`editable combo${disabled ? " locked" : ""}${value ? "" : " empty"} ${className}`.trim()}
      title={disabled ? "Locked while a worker is on it" : `Click to edit; ${options.length} existing value${options.length === 1 ? "" : "s"} to pick from`}
      tabIndex={disabled ? -1 : 0}
      onClick={() => !disabled && setEditing(true)}
      onKeyDown={(e) => {
        if (!disabled && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          setEditing(true);
        }
      }}
    >
      {value || placeholder}
      {!disabled && <span className="dim"> ▾</span>}
    </span>
  );
}

function formatVerification(v: Verification): string {
  if (v.kind === "command") return `command: ${v.command ?? ""}`;
  if (v.kind === "file-exists") return `file: ${v.path ?? ""}`;
  return `manual: ${v.label ?? ""}`;
}

/** "command: npm test" | "file: dist/app.exe" | "manual: reviewed" | a bare line is a command. */
function parseVerification(line: string): Verification {
  const m = line.match(/^\s*(command|cmd|file|file-exists|manual)\s*:\s*(.*)$/i);
  if (!m) return { kind: "command", command: line.trim() };
  const kind = (m[1] ?? "").toLowerCase();
  const rest = (m[2] ?? "").trim();
  if (kind === "file" || kind === "file-exists") return { kind: "file-exists", path: rest };
  if (kind === "manual") return { kind: "manual", label: rest || "Reviewed by a human" };
  return { kind: "command", command: rest };
}

interface EditableTextProps {
  value: string;
  onSave: (value: string) => unknown;
  disabled?: boolean;
  placeholder?: string;
  multiline?: boolean;
  as?: "h2" | "p" | "span";
  className?: string;
}

/** Click to edit; Enter (Ctrl+Enter when multiline) saves, Esc cancels, blur saves if changed. */
function EditableText({ value, onSave, disabled, placeholder, multiline, as = "span", className = "" }: EditableTextProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);
  const commit = () => {
    setEditing(false);
    if (draft !== value) void onSave(draft);
  };
  const cancel = () => {
    setDraft(value);
    setEditing(false);
  };
  if (editing) {
    const common = {
      autoFocus: true,
      value: draft,
      onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(e.target.value),
      onBlur: commit,
      onKeyDown: (e: React.KeyboardEvent) => {
        if (e.key === "Escape") cancel();
        else if (e.key === "Enter" && (!multiline || e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          commit();
        }
      },
      placeholder,
      "aria-label": placeholder ?? "Edit value",
    };
    return multiline ? <textarea className={`input editable-input ${className}`} rows={Math.min(12, Math.max(3, draft.split("\n").length + 1))} {...common} /> : <input className={`input editable-input ${className}`} {...common} />;
  }
  const Tag = as;
  const empty = !value;
  return (
    <Tag
      className={`editable${disabled ? " locked" : ""}${empty ? " empty" : ""} ${className}`.trim()}
      title={disabled ? "Locked while a worker is on it" : "Click to edit"}
      tabIndex={disabled ? -1 : 0}
      onClick={() => !disabled && setEditing(true)}
      onKeyDown={(e) => {
        if (!disabled && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          setEditing(true);
        }
      }}
    >
      {empty ? placeholder : value}
    </Tag>
  );
}

/** Bullet list edited as a textarea, one item per line. */
function EditableList({ items, onSave, disabled, placeholder, mono, className = "" }: { items: string[]; onSave: (items: string[]) => unknown; disabled?: boolean; placeholder?: string; mono?: boolean; className?: string }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(items.join("\n"));
  useEffect(() => {
    if (!editing) setDraft(items.join("\n"));
  }, [items, editing]);
  const commit = () => {
    setEditing(false);
    const next = draft.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (next.join("\n") !== items.join("\n")) void onSave(next);
  };
  if (editing)
    return (
      <textarea
        autoFocus
        className={`input editable-input${mono ? " mono" : ""} ${className}`}
        rows={Math.min(14, Math.max(3, draft.split("\n").length + 1))}
        value={draft}
        placeholder={placeholder}
        aria-label={placeholder ?? "Edit list"}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setDraft(items.join("\n"));
            setEditing(false);
          } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            commit();
          }
        }}
      />
    );
  const open = () => !disabled && setEditing(true);
  if (items.length === 0)
    return (
      <span className={`editable empty${disabled ? " locked" : ""} ${className}`.trim()} title={disabled ? "Locked while a worker is on it" : "Click to add"} tabIndex={disabled ? -1 : 0} onClick={open} onKeyDown={(e) => e.key === "Enter" && open()}>
        {placeholder ?? "none"}
      </span>
    );
  return (
    <ul className={`bullets editable${mono ? " mono" : ""}${disabled ? " locked" : ""} ${className}`.trim()} title={disabled ? "Locked while a worker is on it" : "Click to edit"} tabIndex={disabled ? -1 : 0} onClick={open} onKeyDown={(e) => e.key === "Enter" && open()}>
      {items.map((it, i) => (
        <li key={i}>{it}</li>
      ))}
    </ul>
  );
}

function EditableSelect<T extends string>({ value, options, onSave, disabled, className = "" }: { value: T; options: readonly T[]; onSave: (value: T) => unknown; disabled?: boolean; className?: string }) {
  return (
    <span className={className}>
      <select className="select editable-select" value={value} disabled={disabled} aria-label="Edit value" onChange={(e) => void onSave(e.target.value as T)}>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </span>
  );
}

function MoveMenu({ status, onMove }: { status: TaskDetail["status"]; onMove: (to: TaskDetail["status"]) => void }) {
  const options = MANUAL_MOVES[status];
  if (options.length === 0) return null;
  return (
    <select
      className="select"
      style={{ width: "auto", padding: "2px 6px", fontSize: 11 }}
      value=""
      onChange={(e) => {
        const to = e.target.value as TaskDetail["status"];
        if (to) onMove(to);
      }}
    >
      <option value="">Move to…</option>
      {options.map((s) => (
        <option key={s} value={s}>
          {STATUS_LABEL[s]}
        </option>
      ))}
    </select>
  );
}

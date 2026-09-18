import { useState } from "react";

import type { PlanProposal, WorkerInfo } from "../lib/api.ts";
import { useStore } from "../lib/store.tsx";
import { Dialog } from "./Dialog.tsx";

/** Goal → bounded plan → confirm → tasks. Nothing is persisted until Apply. */
export function PlanDialog({ onClose, workers }: { onClose: () => void; workers: WorkerInfo[] }) {
  const { api, act, currentProjectId, toast } = useStore();
  const [goal, setGoal] = useState("");
  const [workerId, setWorkerId] = useState("");
  const [maxTasks, setMaxTasks] = useState(6);
  const [busy, setBusy] = useState(false);
  const [proposal, setProposal] = useState<PlanProposal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const planners = workers.filter((w) => w.capabilities.includes("plan"));

  const plan = async () => {
    if (!goal.trim() || !currentProjectId) return;
    setBusy(true);
    setError(null);
    try {
      setProposal(await api.plan(currentProjectId, goal.trim(), { workerId: workerId || null, maxTasks }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    if (!proposal || !currentProjectId) return;
    setBusy(true);
    const created = await act(() => api.applyPlan(currentProjectId, proposal), `Created ${proposal.tasks.length} task(s)`);
    setBusy(false);
    if (created) onClose();
    else toast("error", "Plan was not applied");
  };

  return (
    <Dialog
      title="Plan a goal"
      onClose={onClose}
      wide
      footer={
        proposal ? (
          <>
            <button className="btn" onClick={() => setProposal(null)} disabled={busy}>
              Back
            </button>
            <button className="btn primary" onClick={apply} disabled={busy}>
              Create {proposal.tasks.length} task(s)
            </button>
          </>
        ) : (
          <>
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
            <button className="btn primary" onClick={plan} disabled={!goal.trim() || busy}>
              {busy ? "Planning…" : "Plan"}
            </button>
          </>
        )
      }
    >
      {!proposal && (
        <>
          <div className="field">
            <span className="label">Goal</span>
            <textarea className="textarea" autoFocus value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="Add authentication with sessions and a login page" />
            <span className="hint">DEV inspects the repository, asks Nexus for relevant capabilities, and has one planning worker propose only the next milestone (at most {maxTasks} tasks).</span>
          </div>
          <div className="field-row">
            <div className="field">
              <span className="label">Planning worker</span>
              <select className="select" value={workerId} onChange={(e) => setWorkerId(e.target.value)}>
                <option value="">auto</option>
                {planners.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <span className="label">Max tasks</span>
              <input className="input" type="number" min={1} max={12} value={maxTasks} onChange={(e) => setMaxTasks(Number(e.target.value) || 6)} />
            </div>
          </div>
          {busy && <div className="muted small">Planning can take a minute or two: the worker reads the repository first.</div>}
          {error && <div className="failure">{error}</div>}
        </>
      )}
      {proposal && (
        <>
          <div>
            <div className="label">Milestone</div>
            <div style={{ fontSize: 13, fontWeight: 600 }}>{proposal.milestone}</div>
            {proposal.summary && <div className="muted" style={{ marginTop: 4 }}>{proposal.summary}</div>}
            <div className="dim small" style={{ marginTop: 4 }}>planned by {proposal.workerId}</div>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>#</th>
                <th>Task</th>
                <th>After</th>
                <th>Effort</th>
                <th>Verification</th>
              </tr>
            </thead>
            <tbody>
              {proposal.tasks.map((t, i) => (
                <tr key={i}>
                  <td className="mono">{i + 1}</td>
                  <td>
                    <div>{t.title}</div>
                    {t.outcome && <div className="muted small">{t.outcome}</div>}
                    {t.acceptance.length > 0 && (
                      <ul className="bullets small muted">
                        {t.acceptance.map((a, j) => (
                          <li key={j}>{a}</li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td className="mono">{t.dependsOn.map((d) => `#${d + 1}`).join(" ") || "—"}</td>
                  <td>{t.effort}</td>
                  <td className="mono">{t.verification.map((v) => v.command ?? v.path ?? v.kind).join("; ") || <span className="dim">none</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {proposal.capabilities.length > 0 && (
            <div className="small muted">
              Capabilities via Nexus: {proposal.capabilities.map((c) => `${c.kind}:${c.name}`).join(", ")}
            </div>
          )}
          {proposal.notes.map((n, i) => (
            <div key={i} className="warn small">
              {n}
            </div>
          ))}
        </>
      )}
    </Dialog>
  );
}

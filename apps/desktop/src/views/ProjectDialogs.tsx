import { useState } from "react";

import { Dialog } from "../components/Dialog.tsx";
import type { Project } from "../lib/api.ts";
import { useStore } from "../lib/store.tsx";

export function AddProjectDialog({ onClose, onAdded }: { onClose: () => void; onAdded: (id: string) => void }) {
  const { api, act } = useStore();
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const submit = async () => {
    if (!path.trim()) return;
    const created = await act(() => api.addProject({ path: path.trim(), name: name.trim() || undefined, goal: goal.trim() || undefined }), "Project added");
    if (created) {
      onAdded(created.id);
      onClose();
    }
  };
  return (
    <Dialog
      title="Add project"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={submit} disabled={!path.trim()}>
            Add project
          </button>
        </>
      }
    >
      <div className="field">
        <span className="label">Directory</span>
        <input className="input mono" autoFocus value={path} onChange={(e) => setPath(e.target.value)} placeholder="C:\Projects\my-project" onKeyDown={(e) => e.key === "Enter" && submit()} />
        <span className="hint">An existing directory. A git repository is recommended but not required.</span>
      </div>
      <div className="field-row">
        <div className="field">
          <span className="label">Name</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="defaults to the folder name" />
        </div>
        <div className="field">
          <span className="label">Goal</span>
          <input className="input" value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="what this project is for" />
        </div>
      </div>
    </Dialog>
  );
}

export function EditProjectDialog({ project, workers, onClose }: { project: Project; workers: string[]; onClose: () => void }) {
  const { api, act } = useStore();
  const [name, setName] = useState(project.name);
  const [goal, setGoal] = useState(project.goal ?? "");
  const [milestone, setMilestone] = useState(project.milestone ?? "");
  const [summary, setSummary] = useState(project.summary ?? "");
  const [defaultWorker, setDefaultWorker] = useState(project.config.defaultWorker ?? "");
  const [reviewRequired, setReviewRequired] = useState(project.config.reviewRequired === true);
  const [verification, setVerification] = useState((project.config.verification ?? []).map((v) => v.command ?? "").join("\n"));
  const submit = async () => {
    const ok = await act(
      () =>
        api.updateProject(project.id, {
          name: name.trim() || project.name,
          goal: goal.trim() || null,
          milestone: milestone.trim() || null,
          summary: summary.trim() || null,
          config: {
            defaultWorker: defaultWorker || undefined,
            reviewRequired,
            verification: verification
              .split("\n")
              .map((l) => l.trim())
              .filter(Boolean)
              .map((command) => ({ kind: "command", command })),
          },
        }),
      "Project saved",
    );
    if (ok) onClose();
  };
  return (
    <Dialog
      title="Edit project"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={submit}>
            Save project
          </button>
        </>
      }
    >
      <div className="field-row">
        <div className="field">
          <span className="label">Name</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <span className="label">Current milestone</span>
          <input className="input" value={milestone} onChange={(e) => setMilestone(e.target.value)} />
        </div>
      </div>
      <div className="field">
        <span className="label">Goal</span>
        <input className="input" value={goal} onChange={(e) => setGoal(e.target.value)} />
      </div>
      <div className="field">
        <span className="label">Summary (architecture, conventions; sent to workers within the context budget)</span>
        <textarea className="textarea" value={summary} onChange={(e) => setSummary(e.target.value)} style={{ minHeight: 100 }} />
      </div>
      <div className="field-row">
        <div className="field">
          <span className="label">Default worker</span>
          <select className="select" value={defaultWorker} onChange={(e) => setDefaultWorker(e.target.value)}>
            <option value="">preference order</option>
            {workers
              .filter((w) => w !== "shell")
              .map((w) => (
                <option key={w} value={w}>
                  {w}
                </option>
              ))}
          </select>
        </div>
        <div className="field">
          <span className="label">Review</span>
          <label className="row small" style={{ marginTop: 6 }}>
            <input type="checkbox" checked={reviewRequired} onChange={(e) => setReviewRequired(e.target.checked)} /> Successful tasks wait in Review for approval
          </label>
        </div>
      </div>
      <div className="field">
        <span className="label">Project-wide verification commands (one per line, run after every task)</span>
        <textarea className="textarea mono" value={verification} onChange={(e) => setVerification(e.target.value)} placeholder="npm test" />
      </div>
    </Dialog>
  );
}

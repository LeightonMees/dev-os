import { useState } from "react";

import type { Task, WorkerInfo } from "../lib/api.ts";
import { useStore } from "../lib/store.tsx";
import { Dialog } from "./Dialog.tsx";

export function NewTaskDialog({ onClose, workers }: { onClose: () => void; workers: WorkerInfo[] }) {
  const { api, act, currentProjectId, tasks, selectTask } = useStore();
  const [title, setTitle] = useState("");
  const [outcome, setOutcome] = useState("");
  const [requirements, setRequirements] = useState("");
  const [acceptance, setAcceptance] = useState("");
  const [command, setCommand] = useState("");
  const [verify, setVerify] = useState("");
  const [files, setFiles] = useState("");
  const [workerId, setWorkerId] = useState("");
  const [effort, setEffort] = useState<"low" | "medium" | "high">("medium");
  const [deps, setDeps] = useState<string[]>([]);
  const [milestone, setMilestone] = useState("");
  const [epic, setEpic] = useState("");
  const [ready, setReady] = useState(true);
  const [busy, setBusy] = useState(false);
  const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);

  const submit = async () => {
    if (!title.trim() || !currentProjectId) return;
    setBusy(true);
    const created = await act(
      () =>
        api.createTask({
          projectId: currentProjectId,
          title: title.trim(),
          outcome,
          requirements: lines(requirements),
          acceptance: lines(acceptance),
          command: command.trim() || null,
          verification: lines(verify).map((c) => ({ kind: "command", command: c })),
          files: lines(files),
          workerId: workerId || null,
          effort,
          dependsOn: deps,
          milestone: milestone.trim() || null,
          epic: epic.trim() || null,
          status: ready && deps.length === 0 ? "READY" : "BACKLOG",
        }),
      "Task created",
    );
    setBusy(false);
    if (created) {
      selectTask((created as Task).id);
      onClose();
    }
  };

  return (
    <Dialog
      title="New task"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={submit} disabled={!title.trim() || busy}>
            Create
          </button>
        </>
      }
    >
      <div className="field">
        <span className="label">Title</span>
        <input className="input" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add a /health endpoint" onKeyDown={(e) => e.key === "Enter" && (e.ctrlKey || e.metaKey) && submit()} />
      </div>
      <div className="field">
        <span className="label">Desired outcome</span>
        <textarea className="textarea" value={outcome} onChange={(e) => setOutcome(e.target.value)} placeholder="What exists when this is done" />
      </div>
      <div className="field-row">
        <div className="field">
          <span className="label">Requirements (one per line)</span>
          <textarea className="textarea" value={requirements} onChange={(e) => setRequirements(e.target.value)} />
        </div>
        <div className="field">
          <span className="label">Acceptance criteria (one per line)</span>
          <textarea className="textarea" value={acceptance} onChange={(e) => setAcceptance(e.target.value)} />
        </div>
      </div>
      <div className="field-row">
        <div className="field">
          <span className="label">Verification commands (one per line)</span>
          <textarea className="textarea mono" value={verify} onChange={(e) => setVerify(e.target.value)} placeholder="npm test" />
          <span className="hint">Run in the project directory after the worker finishes. Exit 0 passes.</span>
        </div>
        <div className="field">
          <span className="label">Relevant files (one per line)</span>
          <textarea className="textarea mono" value={files} onChange={(e) => setFiles(e.target.value)} placeholder="src/server.ts" />
          <span className="hint">Included in the worker's context, within budget.</span>
        </div>
      </div>
      <div className="field-row">
        <div className="field">
          <span className="label">Milestone</span>
          <input className="input" list="dev-milestones" value={milestone} onChange={(e) => setMilestone(e.target.value)} placeholder="optional" />
          <datalist id="dev-milestones">
            {Array.from(new Set(tasks.map((t) => t.milestone).filter(Boolean))).map((m) => (
              <option key={m as string} value={m as string} />
            ))}
          </datalist>
        </div>
        <div className="field">
          <span className="label">Epic</span>
          <input className="input" list="dev-epics" value={epic} onChange={(e) => setEpic(e.target.value)} placeholder="optional" />
          <datalist id="dev-epics">
            {Array.from(new Set(tasks.map((t) => t.epic).filter(Boolean))).map((m) => (
              <option key={m as string} value={m as string} />
            ))}
          </datalist>
        </div>
      </div>
      <div className="field">
        <span className="label">Deterministic command (optional)</span>
        <input className="input mono" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npm run build" />
        <span className="hint">When set, the shell worker runs this instead of an agent.</span>
      </div>
      <div className="field-row">
        <div className="field">
          <span className="label">Worker</span>
          <select className="select" value={workerId} onChange={(e) => setWorkerId(e.target.value)} disabled={!!command.trim()}>
            <option value="">auto (preference order)</option>
            {workers
              .filter((w) => w.id !== "shell")
              .map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                  {w.health && !w.health.ok ? " (unhealthy)" : ""}
                </option>
              ))}
          </select>
        </div>
        <div className="field">
          <span className="label">Effort</span>
          <select className="select" value={effort} onChange={(e) => setEffort(e.target.value as "low" | "medium" | "high")}>
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
          </select>
        </div>
      </div>
      <div className="field">
        <span className="label">Depends on</span>
        <select
          className="select"
          multiple
          size={Math.min(6, Math.max(2, tasks.length))}
          value={deps}
          onChange={(e) => setDeps(Array.from(e.target.selectedOptions).map((o) => o.value))}
        >
          {tasks
            .filter((t) => t.status !== "CANCELLED")
            .map((t) => (
              <option key={t.id} value={t.id}>
                #{t.ordinal} {t.title} [{t.status}]
              </option>
            ))}
        </select>
        <span className="hint">Ctrl-click to select several. A task with dependencies starts in Backlog and becomes Ready when they are Done.</span>
      </div>
      <label className="row small">
        <input type="checkbox" checked={ready} onChange={(e) => setReady(e.target.checked)} disabled={deps.length > 0} /> Mark READY now
      </label>
    </Dialog>
  );
}

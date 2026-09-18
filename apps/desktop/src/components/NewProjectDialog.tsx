import { useEffect, useState } from "react";

import { useStore } from "../lib/store.tsx";
import { Dialog } from "./Dialog.tsx";
import { Term } from "./Term.tsx";

/** Create a new project directory, or register an existing one. */
export function NewProjectDialog({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const { api, act } = useStore();
  const [mode, setMode] = useState<"create" | "register">("create");
  const [name, setName] = useState("");
  const [dir, setDir] = useState("");
  const [template, setTemplate] = useState<"empty" | "node" | "python">("node");
  const [git, setGit] = useState(true);
  const [goal, setGoal] = useState("");
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.config().then((c) => setDir(c.config.projects.defaultDir)).catch(() => undefined);
  }, [api]);
  const canSubmit = mode === "create" ? /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name.trim()) && dir.trim() : path.trim();
  const submit = async () => {
    if (!canSubmit || busy) return;
    setBusy(true);
    const created = await act(
      () => (mode === "create" ? api.createProject({ name: name.trim(), dir: dir.trim(), template, git, goal: goal.trim() || undefined }) : api.addProject({ path: path.trim(), goal: goal.trim() || undefined })),
      mode === "create" ? "Project created" : "Project added",
    );
    setBusy(false);
    if (created) {
      onDone(created.id);
      onClose();
    }
  };
  return (
    <Dialog
      title={mode === "create" ? "New project" : "Add existing project"}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={submit} disabled={!canSubmit || busy}>
            {busy ? "Working…" : mode === "create" ? "Create project" : "Add project"}
          </button>
        </>
      }
    >
      <div className="segmented" role="tablist" style={{ alignSelf: "flex-start" }}>
        <button role="tab" aria-selected={mode === "create"} className={mode === "create" ? "active" : ""} onClick={() => setMode("create")}>
          Create new
        </button>
        <button role="tab" aria-selected={mode === "register"} className={mode === "register" ? "active" : ""} onClick={() => setMode("register")}>
          Register existing
        </button>
      </div>
      {mode === "create" ? (
        <>
          <div className="field-row">
            <div className="field">
              <span className="label">Name</span>
              <input className="input mono" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="recipe-app" onKeyDown={(e) => e.key === "Enter" && submit()} />
              <span className="hint">Letters, digits, dot, dash, underscore. Becomes the folder name.</span>
            </div>
            <div className="field">
              <span className="label">Parent directory</span>
              <input className="input mono" value={dir} onChange={(e) => setDir(e.target.value)} />
              <span className="hint">The project lives at {dir ? `${dir}\\${name || "<name>"}` : "<dir>\\<name>"}.</span>
            </div>
          </div>
          <div className="field-row">
            <div className="field">
              <span className="label">Template</span>
              <select className="select" value={template} onChange={(e) => setTemplate(e.target.value as "empty" | "node" | "python")}>
                <option value="node">Node (package.json, src/, a passing test, verification: npm test)</option>
                <option value="python">Python (main.py, unittest, verification: python -m unittest)</option>
                <option value="empty">Empty (README and .gitignore only)</option>
              </select>
            </div>
            <div className="field">
              <span className="label">Version control</span>
              <label className="row small" style={{ marginTop: 6 }}>
                <input type="checkbox" checked={git} onChange={(e) => setGit(e.target.checked)} /> <Term word="commit">git init</Term> and make the first commit
              </label>
            </div>
          </div>
        </>
      ) : (
        <div className="field">
          <span className="label">Directory</span>
          <input className="input mono" autoFocus value={path} onChange={(e) => setPath(e.target.value)} placeholder="G:\Desktop\my-project" onKeyDown={(e) => e.key === "Enter" && submit()} />
          <span className="hint">An existing directory. A git repository is recommended but not required.</span>
        </div>
      )}
      <div className="field">
        <span className="label">Goal</span>
        <input className="input" value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="what this project is for, in one line" />
        <span className="hint">Shown on the Overview and sent to workers in every brief. You can plan the first milestone right after.</span>
      </div>
    </Dialog>
  );
}

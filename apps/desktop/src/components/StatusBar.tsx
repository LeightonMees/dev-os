import { useEffect, useState } from "react";

import type { GitStatus } from "../lib/api.ts";
import { useStore } from "../lib/store.tsx";

export function StatusBar() {
  const { connection, api, status, home, currentProject, setSection, bottomOpen, setBottom, feed } = useStore();
  const [git, setGit] = useState<GitStatus | null>(null);
  const gitEvents = feed.filter((e) => e.type === "GIT_COMMIT" || e.type === "FILE_CHANGED" || e.type === "TASK_COMPLETED").length;
  useEffect(() => {
    if (!currentProject?.path) {
      setGit(null);
      return;
    }
    api.gitStatus(currentProject.id).then(setGit).catch(() => setGit(null));
  }, [api, currentProject, gitEvents]);
  const running = status?.running ?? [];
  const auto = status?.auto ?? [];
  const okWorkers = status?.workers.filter((w) => w.health?.ok).length ?? 0;
  const blocked = currentProject?.tasks.BLOCKED ?? 0;
  const review = currentProject?.tasks.REVIEW ?? 0;
  return (
    <footer className="statusbar" aria-label="Status">
      <span className="item" title={`control plane ${api.baseUrl}`}>
        <span className={`dot ${connection === "connected" ? "ok" : connection === "offline" ? "err" : ""}`} />
        {connection === "connected" ? api.baseUrl.replace("http://", "") : connection}
      </span>
      {currentProject && (
        <button className="item" onClick={() => setSection("overview")} title={currentProject.path ?? "no repository yet"}>
          {currentProject.name}
        </button>
      )}
      {git?.isRepo && (
        <button className="item" onClick={() => setSection("git")} title="Git">
          {git.branch ?? "detached"}
          {git.dirty ? <span className="warn">●{git.changes.length}</span> : <span className="ok">clean</span>}
        </button>
      )}
      <button className="item" onClick={() => setBottom(true, "output")} title="Executions">
        {running.length > 0 ? <span className="dot live" /> : <span className="dot" />}
        {running.length > 0 ? `${running.length} running` : "idle"}
        {auto.length > 0 ? ` auto ${auto[0]?.ran ?? 0}` : ""}
      </button>
      {(blocked > 0 || review > 0) && (
        <button className="item" onClick={() => setBottom(true, "problems")} title="Problems">
          {blocked > 0 && <span className="err">■ {blocked}</span>}
          {review > 0 && <span style={{ color: "var(--st-review)" }}>◆ {review}</span>}
        </button>
      )}
      <button className="item" onClick={() => setSection("workers")} title="Workers">
        {okWorkers}/{status?.workers.length ?? 0} workers
      </button>
      <button className="item" onClick={() => setBottom(!bottomOpen)} title="Toggle panel  Ctrl+J">
        {bottomOpen ? "panel ▾" : "panel ▴"}
      </button>
      <span className="item right" title={home ?? ""}>
        {home ?? ""}
      </span>
    </footer>
  );
}

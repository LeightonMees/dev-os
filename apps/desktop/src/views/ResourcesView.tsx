import { useEffect, useState } from "react";

import { Term } from "../components/Term.tsx";
import type { NexusMatch } from "../lib/api.ts";
import { useStore } from "../lib/store.tsx";

/** Capability discovery through Nexus. Nothing is copied locally; every search hits the hub. */
export function ResourcesView() {
  const { api, tasks, selectTask, setSection } = useStore();
  const [nexus, setNexus] = useState<{ skills: number; mcps: number; apis: number; workflows: number; root: string } | null>(null);
  const [nexusError, setNexusError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<NexusMatch[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [workflows, setWorkflows] = useState<{ name: string; description: string; hasRunner: boolean }[] | null>(null);
  useEffect(() => {
    api.workflows().then(setWorkflows).catch(() => setWorkflows([]));
  }, [api]);
  useEffect(() => {
    api
      .nexusStatus()
      .then((s) => {
        setNexus(s);
        setNexusError(null);
      })
      .catch((e: Error) => setNexusError(e.message));
  }, [api]);
  const search = async () => {
    if (!query.trim()) return;
    setBusy(true);
    try {
      setResults(await api.nexusSearch(query.trim(), 12));
      setNexusError(null);
    } catch (e) {
      setNexusError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const withCaps = tasks.filter((t) => t.capabilities.length > 0);
  return (
    <div className="view">
      <div className="toolbar">
        <h1>Resources</h1>
        <span className="sub">{nexus ? `Nexus at ${nexus.root}` : nexusError ? "Nexus unreachable" : "connecting to Nexus…"}</span>
      </div>
      <div className="view-body">
        {nexusError && (
          <div className="failure">
            <div className="k">Nexus</div>
            {nexusError}
            <div className="next">Check nexus.command and nexus.args in Settings, then restart the control plane.</div>
          </div>
        )}
        <div className="row" style={{ marginBottom: 12, maxWidth: 760 }}>
          <input className="input" placeholder="What do you need? e.g. browser testing, scrape a docs site, generate sprites" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && search()} autoFocus aria-label="Capability search" />
          <button className="btn primary" onClick={search} disabled={busy || !query.trim()}>
            {busy ? "…" : "Search"}
          </button>
        </div>
        {results && results.length === 0 && <div className="empty">Nexus found nothing for that. Try different words.</div>}
        {results && results.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 16 }}></th>
                <th style={{ width: 70 }}>Kind</th>
                <th style={{ width: 200 }}>Name</th>
                <th>What</th>
                <th style={{ width: 50 }}>Score</th>
                <th style={{ width: 260 }}>Activate</th>
              </tr>
            </thead>
            <tbody>
              {results.map((m) => (
                <tr key={`${m.kind}:${m.name}`}>
                  <td className={m.ready ? "ok" : "warn"} title={m.blockers.join("\n")}>
                    {m.ready ? "●" : "!"}
                  </td>
                  <td className="mono">{m.kind}</td>
                  <td>{m.name}</td>
                  <td className="muted small">
                    {m.what}
                    {m.blockers.length > 0 && <div className="warn">{m.blockers.join("; ")}</div>}
                  </td>
                  <td className="mono">{m.score}</td>
                  <td className="mono dim small selectable">{m.activate}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!results && !nexusError && (
          <div className="empty">
            Search the hub for skills, <Term word="MCP">MCP servers</Term>, APIs and workflows relevant to a task.
            <br />
            The planner does this automatically and stores the selection on each task as a <Term word="capability">capability</Term> reference.
          </div>
        )}
        <div className="section" style={{ marginTop: 20 }}>
          <div className="label">
            Nexus workflows <span className="count">{workflows?.length ?? "…"}</span>
          </div>
          {workflows && workflows.length === 0 && <div className="dim">Nexus lists no workflows.</div>}
          {workflows && workflows.length > 0 && (
            <table className="table rows">
              <thead>
                <tr>
                  <th style={{ width: 220 }}>Workflow</th>
                  <th>Description</th>
                  <th style={{ width: 90 }}>Runner</th>
                </tr>
              </thead>
              <tbody>
                {workflows.map((w) => (
                  <tr key={w.name}>
                    <td className="mono">{w.name}</td>
                    <td className="ellipsis" title={w.description}>
                      {w.description}
                    </td>
                    <td className="dim">{w.hasRunner ? "yes" : "manual"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="dim small" style={{ marginTop: 4 }}>
            Workflows are reusable procedures stored in Nexus. Ask for one in Chat or through a task's requirements; DEV does not run them directly yet.
          </div>
        </div>
        <div className="section">
          <div className="label">
            Selected on tasks <span className="count">{withCaps.length}</span>
          </div>
          {withCaps.length === 0 ? (
            <div className="dim">No task has capabilities attached yet.</div>
          ) : (
            <ul className="list">
              {withCaps.map((t) => (
                <li key={t.id}>
                  <a href="#" onClick={(e) => (e.preventDefault(), selectTask(t.id), setSection("work"))}>
                    {t.title}
                  </a>
                  <div className="mono dim small">{t.capabilities.map((c) => `${c.kind}:${c.name}`).join("  ")}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

import { useCallback, useEffect, useMemo, useState } from "react";

import { ArtifactCanvas, type Board } from "../components/ArtifactCanvas.tsx";
import { ArtifactEditor } from "../components/ArtifactEditor.tsx";
import { ArtifactPreview } from "../components/ArtifactPreview.tsx";
import { Term } from "../components/Term.tsx";
import type { Artifact, ArtifactContent } from "../lib/api.ts";
import { ago, bytes } from "../lib/format.ts";
import { openInFileManager } from "../lib/native.ts";
import { useStore } from "../lib/store.tsx";

type Mode = "list" | "split" | "canvas";

/** Forms the canvas can draw as an artboard. */
const DRAWABLE = new Set(["html", "svg", "image"]);

/** Extension is the only thing the client knows before asking for content. */
export function boardForm(path: string): Board["form"] | null {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  if (ext === ".html" || ext === ".htm") return "html";
  if (ext === ".svg") return "svg";
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp"].includes(ext)) return "image";
  return null;
}

export function ArtifactsView() {
  const { api, currentProject, tasks, selectTask, setSection, feed, toast } = useStore();
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [selected, setSelected] = useState<Artifact | null>(null);
  const [head, setHead] = useState<ArtifactContent | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [kind, setKind] = useState("all");
  const [mode, setMode] = useState<Mode>("list");
  const artifactEvents = feed.filter((e) => e.type === "ARTIFACT_CREATED").length;

  const reload = useCallback(() => {
    if (!currentProject) return;
    api.artifacts({ projectId: currentProject.id }).then(setArtifacts).catch(() => setArtifacts([]));
  }, [api, currentProject]);
  useEffect(reload, [reload, artifactEvents]);

  useEffect(() => {
    if (!selected) {
      setHead(null);
      return;
    }
    let live = true;
    setHead(null);
    api
      .artifactContent(selected.id)
      .then((r) => {
        if (!live) return;
        setHead(r);
        setDraft(r.content);
      })
      .catch((e: Error) => {
        if (live) toast("error", e.message);
      });
    return () => {
      live = false;
    };
  }, [api, selected, toast]);

  const kinds = useMemo(() => Array.from(new Set(artifacts.map((a) => a.kind))), [artifacts]);
  const shown = useMemo(() => artifacts.filter((a) => kind === "all" || a.kind === kind), [artifacts, kind]);
  const boards = useMemo<Board[]>(
    () =>
      shown
        .map((artifact) => ({ artifact, form: boardForm(artifact.path) }))
        .filter((b): b is { artifact: Artifact; form: Board["form"] } => b.form !== null && DRAWABLE.has(b.form))
        .map(({ artifact, form }) => ({ artifact, form, rawUrl: api.artifactRawUrl(artifact.id) })),
    [api, shown],
  );
  const taskTitle = (id: string | null) => (id ? (tasks.find((t) => t.id === id)?.title ?? id) : "—");

  const open = (artifact: Artifact) => {
    setSelected(artifact);
    setMode("split");
  };

  const save = async () => {
    if (!head) return;
    setSaving(true);
    try {
      const next = await api.reviseArtifact(head.artifact.id, draft);
      toast("success", `Saved as version ${String(next.meta.version ?? "?")} — the original is untouched`);
      reload();
      setSelected(next);
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const dirty = head !== null && draft !== head.content;

  return (
    <div className="view">
      <div className="toolbar">
        <h1>
          <Term word="artifact">Artifacts</Term>
        </h1>
        <span className="sub">{currentProject?.name ?? "no project"}</span>
        <select className="select auto" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind">
          <option value="all">all kinds</option>
          {kinds.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <div className="segmented" role="tablist" aria-label="Artifact layout">
          {(["list", "split", "canvas"] as Mode[]).map((m) => (
            <button
              key={m}
              role="tab"
              aria-selected={mode === m}
              className={mode === m ? "active" : ""}
              disabled={m === "split" && !selected}
              title={m === "split" && !selected ? "Pick an artifact first" : undefined}
              onClick={() => setMode(m)}
            >
              {m === "list" ? "List" : m === "split" ? "Preview" : "Canvas"}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <span className="sub">{mode === "canvas" ? `${boards.length} drawable` : shown.length}</span>
      </div>

      {mode === "canvas" && currentProject ? (
        <ArtifactCanvas projectId={currentProject.id} boards={boards} selectedId={selected?.id ?? null} onSelect={setSelected} onOpen={open} />
      ) : (
        <div className="split">
          {mode === "list" && (
            <div className="pane" style={{ flex: 1 }}>
              <div className="view-body tight" style={{ overflow: "auto" }}>
                {shown.length === 0 ? (
                  <div className="view-body">
                    <div className="empty">
                      <b>No artifacts yet.</b>
                      <br />
                      Every execution produces a log; diffs, worker summaries and test output are added as they happen.
                    </div>
                  </div>
                ) : (
                  <table className="table rows">
                    <thead>
                      <tr>
                        <th style={{ width: 90 }}>Kind</th>
                        <th>Name</th>
                        <th>Task</th>
                        <th style={{ width: 80 }}>Size</th>
                        <th style={{ width: 90 }}>Created</th>
                      </tr>
                    </thead>
                    <tbody>
                      {shown.map((a) => (
                        <tr key={a.id} className={`clickable${selected?.id === a.id ? " selected" : ""}`} onClick={() => setSelected(a)} onDoubleClick={() => open(a)}>
                          <td className="mono nowrap">{a.kind}</td>
                          <td className="ellipsis">
                            {a.name}
                            {typeof a.meta.version === "number" && <span className="dim small"> v{String(a.meta.version)}</span>}
                          </td>
                          <td className="ellipsis">
                            {a.taskId ? (
                              <a href="#" onClick={(e) => (e.preventDefault(), e.stopPropagation(), selectTask(a.taskId), setSection("work"))}>
                                {taskTitle(a.taskId)}
                              </a>
                            ) : (
                              "—"
                            )}
                          </td>
                          <td className="mono">{bytes(a.size)}</td>
                          <td className="dim small">{ago(a.createdAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          )}

          {selected && (
            <div className="pane" style={mode === "split" ? { flex: 1 } : { flex: "0 0 50%", borderLeft: "1px solid var(--rule)" }}>
              <div className="panel-strip">
                <span className="mono">{selected.name}</span>
                <span className="dim selectable ellipsis" title={selected.path}>
                  {selected.path}
                </span>
                <span className="spacer" style={{ flex: 1 }} />
                {head && head.versions > 1 && <span className="dim small">{head.versions} versions</span>}
                <button className="btn ghost small" onClick={() => openInFileManager(selected.path).catch((e) => toast("error", String(e)))}>
                  Reveal
                </button>
                <button className="btn ghost small" onClick={() => (setSelected(null), setMode("list"))} aria-label="Close preview">
                  ✕
                </button>
              </div>
              {!head ? (
                <div className="view-body">
                  <div className="empty">Loading…</div>
                </div>
              ) : selected.kind === "diff" ? (
                <div className="output fill">
                  {head.content.split("\n").map((line, i) => (
                    <div
                      key={i}
                      className={`diff-line ${line.startsWith("+++") || line.startsWith("---") ? "file" : line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : line.startsWith("@@") ? "hunk" : ""}`}
                    >
                      {line}
                    </div>
                  ))}
                </div>
              ) : mode === "split" && head.media.text ? (
                <div className="artifact-split">
                  <div className="artifact-stage-pane">
                    <ArtifactPreview head={head} rawUrl={api.artifactRawUrl(head.artifact.id)} draft={dirty ? draft : undefined} />
                  </div>
                  <ArtifactEditor head={head} draft={draft} onDraft={setDraft} onSave={save} saving={saving} />
                </div>
              ) : (
                <ArtifactPreview head={head} rawUrl={api.artifactRawUrl(head.artifact.id)} />
              )}
              {head?.truncated && <div className="dim small" style={{ padding: "2px 10px" }}>showing the tail; reveal the file for everything</div>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

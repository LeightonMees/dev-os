import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { FileEntry } from "../lib/api.ts";
import { bytes } from "../lib/format.ts";
import { useStore } from "../lib/store.tsx";

interface OpenFile {
  path: string;
  content: string;
  /** What was last read from or written to disk; the tab is dirty when content differs. */
  saved: string;
  modified: string;
  error: string | null;
}

/**
 * Write code here, not just read it. A tree of the project's own files, tabs, an editor with line
 * numbers, and Ctrl+S to save. Saving refuses to clobber a change made on disk since the file was
 * opened, so a worker editing the same file cannot lose your work or you theirs.
 */
export function EditorView() {
  const { api, currentProject, toast, feed } = useStore();
  const projectId = currentProject?.id ?? null;
  const [tree, setTree] = useState<Map<string, FileEntry[]>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set([""]));
  const [open, setOpen] = useState<OpenFile[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const gutterRef = useRef<HTMLPreElement | null>(null);

  const loadDir = useCallback(
    async (path: string) => {
      // A project without a directory has no files to list; asking would only
      // produce a 409 the view already explains.
      if (!projectId || !currentProject?.path) return;
      try {
        const result = await api.files(projectId, path);
        setTree((t) => new Map(t).set(path, result.entries));
        setTreeError(null);
      } catch (error) {
        setTreeError((error as Error).message);
      }
    },
    [api, projectId, currentProject?.path],
  );

  // Reset everything when the project changes: another project's files must never linger.
  useEffect(() => {
    setTree(new Map());
    setExpanded(new Set([""]));
    setOpen([]);
    setActive(null);
    setTreeError(null);
    if (projectId) void loadDir("");
  }, [projectId, loadDir]);

  const current = open.find((f) => f.path === active) ?? null;
  const dirty = useMemo(() => new Set(open.filter((f) => f.content !== f.saved).map((f) => f.path)), [open]);

  const openFile = async (path: string) => {
    if (!projectId) return;
    if (open.some((f) => f.path === path)) {
      setActive(path);
      return;
    }
    setBusy(true);
    try {
      const file = await api.file(projectId, path);
      setOpen((list) => [...list, { path, content: file.content, saved: file.content, modified: file.modified, error: null }]);
      setActive(path);
    } catch (error) {
      toast("error", (error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const save = useCallback(
    async (path?: string) => {
      const target = open.find((f) => f.path === (path ?? active));
      if (!projectId || !target || target.content === target.saved) return;
      try {
        const result = await api.saveFile(projectId, target.path, target.content, target.modified);
        setOpen((list) => list.map((f) => (f.path === target.path ? { ...f, saved: target.content, modified: result.modified, error: null } : f)));
        toast("success", `Saved ${target.path}`);
      } catch (error) {
        const message = (error as Error).message;
        setOpen((list) => list.map((f) => (f.path === target.path ? { ...f, error: message } : f)));
        toast("error", message);
      }
    },
    [api, projectId, open, active, toast],
  );

  const reload = async (path: string) => {
    if (!projectId) return;
    const file = await api.file(projectId, path).catch((e: Error) => {
      toast("error", e.message);
      return null;
    });
    if (!file) return;
    setOpen((list) => list.map((f) => (f.path === path ? { ...f, content: file.content, saved: file.content, modified: file.modified, error: null } : f)));
    toast("info", `Reloaded ${path} from disk`);
  };

  const close = (path: string) => {
    if (dirty.has(path) && !window.confirm(`${path} has unsaved changes. Close it and lose them?`)) return;
    setOpen((list) => list.filter((f) => f.path !== path));
    if (active === path) setActive((a) => (a === path ? (open.find((f) => f.path !== path)?.path ?? null) : a));
  };

  // Ctrl+S saves the open file wherever focus is in this view.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  // A worker changing a file you have open is worth knowing about immediately.
  const lastFileEvent = feed.filter((e) => e.type === "FILE_CHANGED").at(-1);
  useEffect(() => {
    const changed = lastFileEvent?.data?.path as string | undefined;
    if (!changed) return;
    const hit = open.find((f) => f.path === changed || f.path.endsWith(changed));
    if (hit && hit.content === hit.saved) void reload(hit.path);
    else if (hit) toast("info", `${hit.path} changed on disk while you were editing it. Reload to take that version.`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastFileEvent?.id]);

  if (!currentProject) {
    return (
      <div className="view">
        <div className="toolbar">
          <h1>Editor</h1>
        </div>
        <div className="view-body">
          <div className="empty">No project selected.</div>
        </div>
      </div>
    );
  }
  if (!currentProject.path) {
    return (
      <div className="view">
        <div className="toolbar">
          <h1>Editor</h1>
        </div>
        <div className="view-body">
          <div className="empty">
            <b>{currentProject.name} has no repository yet.</b>
            <br />
            Give it a directory and its files appear here.
          </div>
        </div>
      </div>
    );
  }

  const lineCount = current ? current.content.split("\n").length : 0;

  return (
    <div className="view">
      <div className="toolbar">
        <h1>Editor</h1>
        <span className="sub selectable" title={currentProject.path}>
          {currentProject.name}
        </span>
        <span className="spacer" />
        {current && (
          <>
            <span className="dim small">
              {lineCount} line{lineCount === 1 ? "" : "s"} · {bytes(new TextEncoder().encode(current.content).length)}
            </span>
            <button className="btn ghost small" onClick={() => void reload(current.path)} title="Discard your edits and take what is on disk">
              Reload
            </button>
            <button className="btn primary small" disabled={!dirty.has(current.path)} onClick={() => void save()} title="Save  Ctrl+S">
              {dirty.has(current.path) ? "Save" : "Saved"}
            </button>
          </>
        )}
      </div>
      <div className="editor-split">
        <div className="editor-tree">
          {treeError && <div className="failure small">{treeError}</div>}
          <FileTree entries={tree} expanded={expanded} path="" depth={0} activePath={active} dirty={dirty} onToggle={(p) => { const next = new Set(expanded); if (next.has(p)) next.delete(p); else { next.add(p); if (!tree.has(p)) void loadDir(p); } setExpanded(next); }} onOpen={(p) => void openFile(p)} />
        </div>
        <div className="editor-main">
          {open.length > 0 && (
            <div className="editor-tabs" role="tablist">
              {open.map((f) => (
                <button key={f.path} role="tab" aria-selected={f.path === active} className={`editor-tab${f.path === active ? " active" : ""}`} onClick={() => setActive(f.path)} title={f.path}>
                  {dirty.has(f.path) && <span className="dot" aria-label="unsaved" />}
                  {f.path.split("/").pop()}
                  <span
                    className="x"
                    role="button"
                    aria-label={`Close ${f.path}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      close(f.path);
                    }}
                  >
                    ✕
                  </span>
                </button>
              ))}
            </div>
          )}
          {!current ? (
            <div className="view-body">
              <div className="empty">{busy ? "Opening…" : "Pick a file on the left to read and edit it. Ctrl+S saves."}</div>
            </div>
          ) : (
            <>
              {current.error && <div className="failure small">{current.error}</div>}
              <div className="editor-pane">
                <pre className="editor-gutter" ref={gutterRef} aria-hidden="true">
                  {Array.from({ length: lineCount }, (_, i) => i + 1).join("\n")}
                </pre>
                <textarea
                  ref={areaRef}
                  className="editor-area mono"
                  spellCheck={false}
                  value={current.content}
                  aria-label={`${current.path} contents`}
                  onScroll={(e) => {
                    if (gutterRef.current) gutterRef.current.scrollTop = e.currentTarget.scrollTop;
                  }}
                  onKeyDown={(e) => {
                    // Tab indents rather than leaving the editor, which is what a code editor does.
                    if (e.key === "Tab") {
                      e.preventDefault();
                      const el = e.currentTarget;
                      const { selectionStart: start, selectionEnd: end, value } = el;
                      const next = value.slice(0, start) + "  " + value.slice(end);
                      setOpen((list) => list.map((f) => (f.path === current.path ? { ...f, content: next } : f)));
                      requestAnimationFrame(() => el.setSelectionRange(start + 2, start + 2));
                    }
                  }}
                  onChange={(e) => setOpen((list) => list.map((f) => (f.path === current.path ? { ...f, content: e.target.value } : f)))}
                />
              </div>
              <div className="editor-status">
                <span className="mono dim">{current.path}</span>
                <span className="spacer" />
                {dirty.has(current.path) ? <span className="warn">unsaved</span> : <span className="dim">saved</span>}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function FileTree({ entries, expanded, path, depth, activePath, dirty, onToggle, onOpen }: { entries: Map<string, FileEntry[]>; expanded: Set<string>; path: string; depth: number; activePath: string | null; dirty: Set<string>; onToggle: (path: string) => void; onOpen: (path: string) => void }) {
  const list = entries.get(path);
  if (!list) return depth === 0 ? <div className="dim small" style={{ padding: 8 }}>Reading the project…</div> : null;
  return (
    <>
      {list.map((entry) =>
        entry.directory ? (
          <div key={entry.path}>
            <button className="tree-row" style={{ paddingLeft: 8 + depth * 12 }} onClick={() => onToggle(entry.path)}>
              <span className="dim mono">{expanded.has(entry.path) ? "▾" : "▸"}</span>
              <span className="t">{entry.name}</span>
            </button>
            {expanded.has(entry.path) && <FileTree entries={entries} expanded={expanded} path={entry.path} depth={depth + 1} activePath={activePath} dirty={dirty} onToggle={onToggle} onOpen={onOpen} />}
          </div>
        ) : (
          <button key={entry.path} className={`tree-row${entry.path === activePath ? " active" : ""}`} style={{ paddingLeft: 20 + depth * 12 }} onClick={() => onOpen(entry.path)} title={entry.path}>
            <span className="t">{entry.name}</span>
            <span className="m">
              {dirty.has(entry.path) && <span className="warn">●</span>}
              {entry.size !== null && <span className="dim"> {bytes(entry.size)}</span>}
            </span>
          </button>
        ),
      )}
      {list.length === 0 && depth > 0 && <div className="dim small" style={{ paddingLeft: 20 + depth * 12 }}>empty</div>}
    </>
  );
}


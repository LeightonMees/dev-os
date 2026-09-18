import { useCallback, useEffect, useRef, useState } from "react";

import type { Artifact } from "../lib/api.ts";

export interface Board {
  artifact: Artifact;
  /** How the artboard should draw its contents. */
  form: "html" | "svg" | "image";
  rawUrl: string;
}

interface Placement {
  x: number;
  y: number;
}

const BOARD_W = 420;
const BOARD_H = 300;
const GAP = 48;
const COLUMNS = 3;

/** Where a board sits before anyone moves it: a stable grid in list order. */
export function defaultPlacement(index: number): Placement {
  return { x: (index % COLUMNS) * (BOARD_W + GAP), y: Math.floor(index / COLUMNS) * (BOARD_H + GAP) };
}

export function layoutKey(projectId: string): string {
  return `dev.artifact-canvas.${projectId}`;
}

/**
 * Hand-moved board positions. This is a view preference, not project state: it
 * stays in the window's own storage and is never written back as a record, so
 * nothing in DEV's history depends on where someone dragged a card.
 */
export function loadLayout(projectId: string): Record<string, Placement> {
  try {
    const stored = window.localStorage.getItem(layoutKey(projectId));
    const parsed = stored ? (JSON.parse(stored) as unknown) : null;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, Placement> = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      const p = value as Partial<Placement>;
      if (typeof p?.x === "number" && typeof p?.y === "number" && Number.isFinite(p.x) && Number.isFinite(p.y)) out[id] = { x: p.x, y: p.y };
    }
    return out;
  } catch {
    return {};
  }
}

function saveLayout(projectId: string, layout: Record<string, Placement>): void {
  try {
    window.localStorage.setItem(layoutKey(projectId), JSON.stringify(layout));
  } catch {
    // A canvas that cannot remember positions still works; nothing to report.
  }
}

/** Zoom is clamped so the canvas can never be lost off-scale. */
export function clampZoom(value: number): number {
  return Math.min(2.5, Math.max(0.2, value));
}

export function ArtifactCanvas({
  projectId,
  boards,
  selectedId,
  onSelect,
  onOpen,
}: {
  projectId: string;
  boards: Board[];
  selectedId: string | null;
  onSelect: (artifact: Artifact) => void;
  onOpen: (artifact: Artifact) => void;
}) {
  const [zoom, setZoom] = useState(0.7);
  const [pan, setPan] = useState({ x: 40, y: 40 });
  const [layout, setLayout] = useState<Record<string, Placement>>(() => loadLayout(projectId));
  const drag = useRef<{ id: string | null; startX: number; startY: number; originX: number; originY: number } | null>(null);

  useEffect(() => {
    setLayout(loadLayout(projectId));
    setPan({ x: 40, y: 40 });
  }, [projectId]);

  const placement = useCallback((board: Board, index: number) => layout[board.artifact.id] ?? defaultPlacement(index), [layout]);

  const wheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setZoom((z) => clampZoom(z * (e.deltaY < 0 ? 1.1 : 0.9)));
  };

  const down = (e: React.MouseEvent, board: Board | null, index: number) => {
    // Middle button and empty space pan; a board drags itself.
    if (board && e.button === 0) {
      onSelect(board.artifact);
      const start = placement(board, index);
      drag.current = { id: board.artifact.id, startX: e.clientX, startY: e.clientY, originX: start.x, originY: start.y };
    } else {
      drag.current = { id: null, startX: e.clientX, startY: e.clientY, originX: pan.x, originY: pan.y };
    }
    e.preventDefault();
  };

  const move = (e: React.MouseEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.startX) / (d.id ? zoom : 1);
    const dy = (e.clientY - d.startY) / (d.id ? zoom : 1);
    if (d.id === null) setPan({ x: d.originX + dx, y: d.originY + dy });
    else setLayout((current) => ({ ...current, [d.id as string]: { x: d.originX + dx, y: d.originY + dy } }));
  };

  const up = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.id) setLayout((current) => (saveLayout(projectId, current), current));
  };

  if (boards.length === 0) {
    return (
      <div className="view-body">
        <div className="empty">
          <b>Nothing to lay out yet.</b>
          <br />
          The canvas shows artifacts that can be drawn — pages, drawings and images. Logs and diffs stay in the list.
        </div>
      </div>
    );
  }

  return (
    <div className="artifact-canvas-wrap">
      <div className="panel-strip">
        <span className="dim small">{boards.length} artboards</span>
        <span className="spacer" style={{ flex: 1 }} />
        <span className="dim small">drag to move · ctrl+wheel to zoom · double-click to open</span>
        <button className="btn ghost small" onClick={() => setZoom((z) => clampZoom(z - 0.1))} aria-label="Zoom out">
          −
        </button>
        <span className="mono small" style={{ minWidth: 38, textAlign: "center" }}>{Math.round(zoom * 100)}%</span>
        <button className="btn ghost small" onClick={() => setZoom((z) => clampZoom(z + 0.1))} aria-label="Zoom in">
          +
        </button>
        <button
          className="btn ghost small"
          onClick={() => {
            setLayout({});
            saveLayout(projectId, {});
            setZoom(0.7);
            setPan({ x: 40, y: 40 });
          }}
        >
          Reset
        </button>
      </div>
      <div className="artifact-canvas" onWheel={wheel} onMouseDown={(e) => down(e, null, 0)} onMouseMove={move} onMouseUp={up} onMouseLeave={up} role="presentation">
        <div className="artifact-canvas-surface" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}>
          {boards.map((board, index) => {
            const at = placement(board, index);
            const selected = board.artifact.id === selectedId;
            return (
              <div
                key={board.artifact.id}
                className={`artboard${selected ? " selected" : ""}`}
                style={{ left: at.x, top: at.y, width: BOARD_W, height: BOARD_H }}
                onMouseDown={(e) => (e.stopPropagation(), down(e, board, index))}
                onDoubleClick={() => onOpen(board.artifact)}
              >
                <div className="artboard-label">
                  <span className="ellipsis">{board.artifact.name}</span>
                  <span className="dim">{board.artifact.kind}</span>
                </div>
                <div className="artboard-body">
                  {board.form === "image" ? (
                    <img src={board.rawUrl} alt={board.artifact.name} draggable={false} />
                  ) : (
                    // A thumbnail is a still: the /raw response carries a full CSP
                    // sandbox, so scripts would not run here even if we asked.
                    <iframe title={board.artifact.name} src={board.rawUrl} sandbox="" scrolling="no" tabIndex={-1} />
                  )}
                  {/* The board is a thumbnail, not a live surface: clicks belong to the canvas. */}
                  <div className="artboard-shield" />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

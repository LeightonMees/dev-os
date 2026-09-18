import type { Task } from "../lib/api.ts";
import { STATUS_SYMBOL, truncate } from "../lib/format.ts";
import { edgePath, layoutGraph, NODE_H, NODE_W } from "../lib/graph.ts";
import { Term } from "./Term.tsx";

/**
 * The task graph as it is: columns are dependency depth, nodes carry live status.
 * Read left to right: what must finish before what, what is running, what is stuck.
 */
export function Graph({ tasks, selectedId, onSelect }: { tasks: Task[]; selectedId: string | null; onSelect: (id: string) => void }) {
  const layout = layoutGraph(tasks);
  const byId = new Map(layout.nodes.map((n) => [n.id, n]));
  if (tasks.length === 0) {
    return (
      <div className="view-body">
        <div className="empty">
          No tasks to draw. The <Term word="task graph">task graph</Term> appears once tasks exist; dependencies become edges.
        </div>
      </div>
    );
  }
  return (
    <>
      <div className="graph-legend">
        <span>columns = dependency depth</span>
        <span>→ = must finish first</span>
        <span className="brass">▶ running</span>
        <span className="err">■ blocked</span>
        <span className="ok">● done</span>
      </div>
      <div className="graph-wrap" data-testid="graph">
        <svg width={Math.max(layout.width, 200)} height={Math.max(layout.height, 120)} role="img" aria-label="Task dependency graph">
          {layout.edges.map((e) => {
            const from = byId.get(e.from);
            const to = byId.get(e.to);
            if (!from || !to) return null;
            const cls = from.task.status === "DONE" ? "done" : to.task.status === "BLOCKED" ? "blocked" : "";
            return <path key={`${e.from}-${e.to}`} className={`graph-edge ${cls}`} d={edgePath(from, to)} />;
          })}
          {layout.nodes.map((n) => (
            <g key={n.id} className={`graph-node${n.id === selectedId ? " selected" : ""}`} transform={`translate(${n.x}, ${n.y})`} onClick={() => onSelect(n.id)} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onSelect(n.id)}>
              <rect width={NODE_W} height={NODE_H} rx={2} />
              <rect className="bar" width={3} height={NODE_H} fill={`var(--st-${n.task.status.toLowerCase()})`} />
              <text x={12} y={18}>{truncate(n.task.title, 24)}</text>
              <text className="meta" x={12} y={34}>
                {`${STATUS_SYMBOL[n.task.status]} ${n.task.status.toLowerCase()}  #${n.task.ordinal}${n.task.workerId ? `  ${n.task.workerId}` : ""}`}
              </text>
            </g>
          ))}
        </svg>
      </div>
    </>
  );
}

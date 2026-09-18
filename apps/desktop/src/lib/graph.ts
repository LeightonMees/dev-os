import type { Task } from "./api.ts";

export interface GraphNode {
  id: string;
  task: Task;
  /** Column: longest path from a root. */
  depth: number;
  /** Row within the column. */
  lane: number;
  x: number;
  y: number;
}

export interface GraphEdge {
  from: string;
  to: string;
}

export interface GraphLayout {
  nodes: GraphNode[];
  edges: GraphEdge[];
  width: number;
  height: number;
  columns: number;
}

export const NODE_W = 188;
export const NODE_H = 44;
export const COL_GAP = 56;
export const ROW_GAP = 12;
export const PAD = 16;

/**
 * Deterministic layered layout for the task graph: depth = longest dependency
 * chain, lanes ordered by ordinal so the picture is stable between renders.
 * Cycles cannot exist (the core rejects them), so a memoised walk is enough.
 */
export function layoutGraph(tasks: Task[]): GraphLayout {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const depthOf = new Map<string, number>();
  const depth = (id: string, seen: Set<string> = new Set()): number => {
    const cached = depthOf.get(id);
    if (cached !== undefined) return cached;
    if (seen.has(id)) return 0;
    seen.add(id);
    const task = byId.get(id);
    const deps = task?.dependsOn.filter((d) => byId.has(d)) ?? [];
    const value = deps.length === 0 ? 0 : 1 + Math.max(...deps.map((d) => depth(d, seen)));
    depthOf.set(id, value);
    return value;
  };
  for (const task of tasks) depth(task.id);
  const columns = new Map<number, Task[]>();
  for (const task of tasks) {
    const d = depthOf.get(task.id) ?? 0;
    columns.set(d, [...(columns.get(d) ?? []), task]);
  }
  const nodes: GraphNode[] = [];
  let maxLanes = 0;
  for (const [d, column] of columns) {
    column.sort((a, b) => a.ordinal - b.ordinal);
    maxLanes = Math.max(maxLanes, column.length);
    column.forEach((task, lane) => {
      nodes.push({ id: task.id, task, depth: d, lane, x: PAD + d * (NODE_W + COL_GAP), y: PAD + lane * (NODE_H + ROW_GAP) });
    });
  }
  const edges: GraphEdge[] = [];
  for (const task of tasks) for (const dep of task.dependsOn) if (byId.has(dep)) edges.push({ from: dep, to: task.id });
  const columnCount = columns.size === 0 ? 0 : Math.max(...columns.keys()) + 1;
  return {
    nodes: nodes.sort((a, b) => a.depth - b.depth || a.lane - b.lane),
    edges,
    width: PAD * 2 + Math.max(0, columnCount * NODE_W + Math.max(0, columnCount - 1) * COL_GAP),
    height: PAD * 2 + Math.max(0, maxLanes * NODE_H + Math.max(0, maxLanes - 1) * ROW_GAP),
    columns: columnCount,
  };
}

/** Orthogonal-ish connector: a cubic from the right edge of `from` to the left edge of `to`. */
export function edgePath(from: GraphNode, to: GraphNode): string {
  const x1 = from.x + NODE_W;
  const y1 = from.y + NODE_H / 2;
  const x2 = to.x;
  const y2 = to.y + NODE_H / 2;
  const dx = Math.max(24, (x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

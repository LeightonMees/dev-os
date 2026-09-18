import { describe, expect, it } from "vitest";

import { edgePath, layoutGraph, NODE_W } from "../src/lib/graph.ts";
import type { Task } from "../src/lib/api.ts";

function task(id: string, ordinal: number, dependsOn: string[] = [], status: Task["status"] = "BACKLOG"): Task {
  return { id, projectId: "p", title: id, milestone: null, epic: null, kind: "ticket", risk: "normal", needsHuman: null, outcome: "", requirements: [], acceptance: [], status, dependsOn, workerId: null, capabilities: [], effort: "medium", reasoningEffort: null, command: null, promptOverride: null, files: [], verification: [], resultSummary: null, failure: null, retryCount: 0, ordinal, createdAt: "", updatedAt: "" };
}

describe("layoutGraph", () => {
  it("places tasks in columns by dependency depth and keeps lanes ordered by ordinal", () => {
    const layout = layoutGraph([task("schema", 1, [], "DONE"), task("api", 2, ["schema"], "READY"), task("ui", 3, ["api"]), task("docs", 4, ["schema"]), task("tests", 5, ["api", "ui"])]);
    const depth = Object.fromEntries(layout.nodes.map((n) => [n.id, n.depth]));
    expect(depth).toEqual({ schema: 0, api: 1, docs: 1, ui: 2, tests: 3 });
    expect(layout.columns).toBe(4);
    const lanes = layout.nodes.filter((n) => n.depth === 1).map((n) => [n.id, n.lane]);
    expect(lanes).toEqual([["api", 0], ["docs", 1]]);
    expect(layout.edges).toHaveLength(5);
    expect(layout.width).toBeGreaterThan(4 * NODE_W);
  });

  it("ignores dependencies on tasks outside the set and handles an empty list", () => {
    expect(layoutGraph([])).toMatchObject({ nodes: [], edges: [], columns: 0 });
    const layout = layoutGraph([task("a", 1, ["missing"])]);
    expect(layout.nodes[0]?.depth).toBe(0);
    expect(layout.edges).toEqual([]);
  });

  it("draws edges from the right edge of the upstream node to the left edge of the downstream node", () => {
    const layout = layoutGraph([task("a", 1), task("b", 2, ["a"])]);
    const [a, b] = layout.nodes;
    const d = edgePath(a!, b!);
    expect(d.startsWith(`M ${a!.x + NODE_W}`)).toBe(true);
    expect(d.endsWith(`${b!.x} ${b!.y + 22}`)).toBe(true);
  });
});

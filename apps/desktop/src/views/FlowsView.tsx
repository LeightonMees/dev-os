import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Icon } from "../components/Icon.tsx";
import type { Flow, FlowEdge, FlowNode, FlowNodeRun, FlowProblem, FlowRun } from "../lib/api.ts";
import { useStore } from "../lib/store.tsx";

const NODE_WIDTH = 190;
const NODE_HEIGHT = 74;

/** What each kind of step is for, shown where the user picks one rather than hidden in docs. */
const KINDS: { id: FlowNode["kind"]; label: string; blurb: string }[] = [
  { id: "shell", label: "Command", blurb: "Run a command in the project directory." },
  { id: "prompt", label: "Prompt", blurb: "Give an agent worker a brief. Routed like a task." },
  { id: "condition", label: "Condition", blurb: "Branch on what an earlier step produced." },
  { id: "human", label: "Ask me", blurb: "Pause and ask you a question in Attention. Your answer is this step's output." },
];

function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Where an edge attaches: the right edge of the source, the left edge of the target. */
function anchors(from: FlowNode, to: FlowNode) {
  return { x1: from.x + NODE_WIDTH, y1: from.y + NODE_HEIGHT / 2, x2: to.x, y2: to.y + NODE_HEIGHT / 2 };
}

/** A cubic curve between two anchors, so crossing wires stay tellable apart. */
function wirePath(x1: number, y1: number, x2: number, y2: number): string {
  const dx = Math.max(40, Math.abs(x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

export function FlowsView() {
  const { api, toast, currentProject, feed } = useStore();
  const [flows, setFlows] = useState<Flow[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [flow, setFlow] = useState<Flow | null>(null);
  const [problems, setProblems] = useState<FlowProblem[]>([]);
  const [runs, setRuns] = useState<FlowRun[]>([]);
  const [activeRun, setActiveRun] = useState<{ run: FlowRun; steps: FlowNodeRun[] } | null>(null);
  const [running, setRunning] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [wiringFrom, setWiringFrom] = useState<{ nodeId: string; branch: "true" | "false" | null } | null>(null);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);

  const loadList = useCallback(() => {
    if (!currentProject) return;
    api
      .flows(currentProject.id)
      .then((list) => {
        setFlows(list);
        setSelectedId((current) => current ?? list[0]?.id ?? null);
      })
      .catch((e: Error) => toast("error", e.message));
  }, [api, currentProject, toast]);
  useEffect(loadList, [loadList]);

  const loadFlow = useCallback(
    (id: string) => {
      api
        .flow(id)
        .then((r) => {
          setFlow(r.flow);
          setProblems(r.problems);
          setRuns(r.runs);
          setRunning(!!r.running);
          setDirty(false);
        })
        .catch((e: Error) => toast("error", e.message));
    },
    [api, toast],
  );
  useEffect(() => {
    if (selectedId) loadFlow(selectedId);
    else setFlow(null);
  }, [selectedId, loadFlow]);

  // A run's progress arrives as events; the run view follows it rather than polling.
  useEffect(() => {
    const last = feed[feed.length - 1];
    if (!last || !flow) return;
    const data = (last.data ?? {}) as { flowId?: string; runId?: string | null };
    if (data.flowId !== flow.id) return;
    if (last.type === "FLOW_RUN_STARTED" || last.type === "FLOW_RUN_FINISHED") {
      setRunning(last.type === "FLOW_RUN_STARTED");
      loadFlow(flow.id);
      if (data.runId) void api.flowRun(data.runId).then(setActiveRun).catch(() => undefined);
    }
  }, [feed, flow, api, loadFlow]);

  // While a run is in flight, refresh the step states so the canvas lights up as it goes.
  useEffect(() => {
    if (!running || !flow) return;
    const timer = setInterval(() => {
      void api
        .flow(flow.id)
        .then((r) => {
          setRunning(!!r.running);
          const latest = r.runs[0];
          if (latest) void api.flowRun(latest.id).then(setActiveRun).catch(() => undefined);
        })
        .catch(() => undefined);
    }, 700);
    return () => clearInterval(timer);
  }, [running, flow, api]);

  const stepStatus = useMemo(() => {
    const map = new Map<string, FlowNodeRun>();
    for (const step of activeRun?.steps ?? []) map.set(step.nodeId, step);
    return map;
  }, [activeRun]);

  const save = useCallback(
    async (next: Flow) => {
      try {
        const r = await api.saveFlow(next.id, { name: next.name, description: next.description, nodes: next.nodes, edges: next.edges });
        setFlow(r.flow);
        setProblems(r.problems);
        setDirty(false);
        loadList();
      } catch (error) {
        toast("error", (error as Error).message);
      }
    },
    [api, toast, loadList],
  );

  const mutate = (change: (f: Flow) => Flow) => {
    setFlow((current) => {
      if (!current) return current;
      const next = change(current);
      setDirty(true);
      return next;
    });
  };

  const addNode = (kind: FlowNode["kind"]) => {
    mutate((f) => {
      // Drop it clear of what is already there rather than on top of it.
      const x = f.nodes.length === 0 ? 60 : Math.max(...f.nodes.map((n) => n.x)) + NODE_WIDTH + 70;
      const y = 80;
      const node: FlowNode = {
        id: newId(kind === "condition" ? "cond" : kind === "prompt" ? "ask" : "run"),
        kind,
        label: kind === "shell" ? "New command" : kind === "prompt" ? "New prompt" : kind === "human" ? "New question" : "New condition",
        x,
        y,
        ...(kind === "shell" ? { command: "" } : {}),
        ...(kind === "prompt" ? { prompt: "", capability: "code", workerId: null } : {}),
        ...(kind === "condition" ? { expression: "" } : {}),
        ...(kind === "human" ? { prompt: "" } : {}),
      };
      setSelectedNode(node.id);
      return { ...f, nodes: [...f.nodes, node] };
    });
  };

  const removeNode = (id: string) => {
    mutate((f) => ({ ...f, nodes: f.nodes.filter((n) => n.id !== id), edges: f.edges.filter((e) => e.from !== id && e.to !== id) }));
    setSelectedNode(null);
  };

  const connect = (from: string, to: string, branch: "true" | "false" | null) => {
    if (from === to) return;
    mutate((f) => {
      const exists = f.edges.some((e) => e.from === from && e.to === to && (e.when ?? null) === branch);
      if (exists) return f;
      return { ...f, edges: [...f.edges, { id: newId("e"), from, to, when: branch }] };
    });
  };

  // ----- dragging a node -----
  const dragging = useRef<{ id: string; dx: number; dy: number } | null>(null);
  const onNodePointerDown = (event: React.PointerEvent, node: FlowNode) => {
    if (event.button !== 0) return;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    dragging.current = { id: node.id, dx: event.clientX - rect.left - node.x, dy: event.clientY - rect.top - node.y };
    setSelectedNode(node.id);
    (event.target as Element).setPointerCapture?.(event.pointerId);
  };
  const onCanvasPointerMove = (event: React.PointerEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = event.clientX - rect.left + (canvasRef.current?.scrollLeft ?? 0);
    const y = event.clientY - rect.top + (canvasRef.current?.scrollTop ?? 0);
    if (wiringFrom) setPointer({ x, y });
    const drag = dragging.current;
    if (!drag) return;
    mutate((f) => ({ ...f, nodes: f.nodes.map((n) => (n.id === drag.id ? { ...n, x: Math.max(0, x - drag.dx), y: Math.max(0, y - drag.dy) } : n)) }));
  };
  const onCanvasPointerUp = () => {
    dragging.current = null;
  };

  const run = async () => {
    if (!flow) return;
    if (dirty) await save(flow);
    try {
      await api.runFlow(flow.id);
      setRunning(true);
      toast("info", `Running "${flow.name}"`);
    } catch (error) {
      toast("error", (error as Error).message);
    }
  };

  if (!currentProject) return <div className="empty">Open a project to build flows in it.</div>;

  const node = flow?.nodes.find((n) => n.id === selectedNode) ?? null;

  return (
    <div className="view">
      <div className="toolbar">
        <h1>Flows</h1>
          <select className="select" style={{ maxWidth: 240 }} value={selectedId ?? ""} aria-label="Flow" onChange={(e) => setSelectedId(e.target.value || null)}>
            {(flows ?? []).length === 0 && <option value="">no flows yet</option>}
            {(flows ?? []).map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
          <button
            className="btn small"
            onClick={async () => {
              const name = window.prompt("Name this flow", "New flow");
              if (!name?.trim()) return;
              const created = await api.createFlow({ projectId: currentProject.id, name: name.trim() });
              loadList();
              setSelectedId(created.id);
            }}
          >
            <Icon name="plus" /> New flow
          </button>
          {flow && (
            <>
              <span className="spacer" />
              {KINDS.map((k) => (
                <button key={k.id} className="btn ghost small" title={k.blurb} onClick={() => addNode(k.id)}>
                  + {k.label}
                </button>
              ))}
              <button className="btn small primary" disabled={!dirty} onClick={() => void save(flow)}>
                {dirty ? "Save" : "Saved"}
              </button>
              {running ? (
                <button className="btn small warn" onClick={() => void api.stopFlow(flow.id).then(() => setRunning(false))}>
                  <Icon name="stop" /> Stop
                </button>
              ) : (
                <button className="btn small" disabled={problems.length > 0} title={problems.length ? problems.map((p) => p.message).join("\n") : "Run this flow"} onClick={() => void run()}>
                  <Icon name="play" /> Run
                </button>
              )}
            </>
          )}
      </div>

      {/* A flow that cannot run says so here, while it is being drawn, not only when it is run. */}
      {problems.length > 0 && (
        <div className="flow-problems">
          {problems.map((p, i) => (
            <div key={i}>{p.message}</div>
          ))}
        </div>
      )}

      {!flow ? (
        <div className="empty">
          No flow selected. A flow is a procedure DEV can run end to end: commands, prompts to workers, and branches on what they produce.
        </div>
      ) : (
        <div className="flow-body">
          <div
            className="flow-canvas"
            ref={canvasRef}
            onPointerMove={onCanvasPointerMove}
            onPointerUp={onCanvasPointerUp}
            onClick={() => {
              setWiringFrom(null);
              setPointer(null);
            }}
          >
            <svg className="flow-wires">
              {flow.edges.map((edge) => {
                const from = flow.nodes.find((n) => n.id === edge.from);
                const to = flow.nodes.find((n) => n.id === edge.to);
                if (!from || !to) return null;
                const a = anchors(from, to);
                // A repeat arrow goes back the way it came; drawn as a dip beneath the steps so it
                // never lies on top of the forward wire between the same two nodes.
                const loopY = Math.max(from.y, to.y) + NODE_HEIGHT + 70;
                const path = edge.loop
                  ? `M ${from.x + NODE_WIDTH / 2} ${from.y + NODE_HEIGHT} C ${from.x + NODE_WIDTH / 2} ${loopY}, ${to.x + NODE_WIDTH / 2} ${loopY}, ${to.x + NODE_WIDTH / 2} ${to.y + NODE_HEIGHT}`
                  : wirePath(a.x1, a.y1, a.x2, a.y2);
                const labelX = edge.loop ? (from.x + to.x + NODE_WIDTH) / 2 : (a.x1 + a.x2) / 2;
                const labelY = edge.loop ? loopY - 14 : (a.y1 + a.y2) / 2 - 6;
                return (
                  <g key={edge.id} className={`wire${edge.when ? ` ${edge.when}` : ""}${edge.loop ? " loop" : ""}`}>
                    <path d={path} />
                    {(edge.when || edge.loop) && (
                      <text x={labelX} y={labelY} textAnchor="middle">
                        {edge.loop ? `↺ ${edge.when ?? ""} ×${edge.maxLoops ?? 10}`.trim() : edge.when}
                      </text>
                    )}
                    <title>
                      {from.label} → {to.label}
                      {edge.when ? ` (${edge.when})` : ""}
                      {edge.loop ? ` — repeat, at most ${edge.maxLoops ?? 10} times` : ""}
                    </title>
                  </g>
                );
              })}
              {/* The wire being drawn, so connecting two steps is visible as it happens. */}
              {wiringFrom &&
                pointer &&
                (() => {
                  const from = flow.nodes.find((n) => n.id === wiringFrom.nodeId);
                  if (!from) return null;
                  return <path className="wire drawing" d={wirePath(from.x + NODE_WIDTH, from.y + NODE_HEIGHT / 2, pointer.x, pointer.y)} />;
                })()}
            </svg>

            {flow.nodes.map((n) => {
              const step = stepStatus.get(n.id);
              return (
                <div
                  key={n.id}
                  className={`flow-node ${n.kind}${selectedNode === n.id ? " selected" : ""}${step ? ` ${step.status.toLowerCase()}` : ""}`}
                  style={{ left: n.x, top: n.y, width: NODE_WIDTH, height: NODE_HEIGHT }}
                  onPointerDown={(e) => onNodePointerDown(e, n)}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (wiringFrom) {
                      connect(wiringFrom.nodeId, n.id, wiringFrom.branch);
                      setWiringFrom(null);
                      setPointer(null);
                    } else setSelectedNode(n.id);
                  }}
                >
                  <div className="flow-node-kind">{KINDS.find((k) => k.id === n.kind)?.label}</div>
                  <div className="flow-node-label">{n.label}</div>
                  {step && (
                    <div className={`flow-node-status ${step.status.toLowerCase()}`} title={step.detail ?? undefined}>
                      {step.status.toLowerCase()}
                    </div>
                  )}
                  {/* Condition nodes wire from two ports, so which branch an arrow is cannot be ambiguous. */}
                  {n.kind === "condition" ? (
                    <>
                      <button className="port true" title="Wire the true branch" onClick={(e) => (e.stopPropagation(), setWiringFrom({ nodeId: n.id, branch: "true" }))} />
                      <button className="port false" title="Wire the false branch" onClick={(e) => (e.stopPropagation(), setWiringFrom({ nodeId: n.id, branch: "false" }))} />
                    </>
                  ) : (
                    <button className="port" title="Wire this step to the next" onClick={(e) => (e.stopPropagation(), setWiringFrom({ nodeId: n.id, branch: null }))} />
                  )}
                </div>
              );
            })}

            {flow.nodes.length === 0 && <div className="empty">Add a step to start. Commands and prompts do the work; conditions choose between them.</div>}
          </div>

          <aside className="flow-inspector">
            {node ? (
              <NodeEditor
                node={node}
                flow={flow}
                run={stepStatus.get(node.id) ?? null}
                onChange={(patch) => mutate((f) => ({ ...f, nodes: f.nodes.map((n) => (n.id === node.id ? { ...n, ...patch } : n)) }))}
                onRemove={() => removeNode(node.id)}
                onRemoveEdge={(edgeId) => mutate((f) => ({ ...f, edges: f.edges.filter((e) => e.id !== edgeId) }))}
                onEditEdge={(edgeId, patch) => mutate((f) => ({ ...f, edges: f.edges.map((e) => (e.id === edgeId ? { ...e, ...patch } : e)) }))}
              />
            ) : (
              <RunHistory runs={runs} active={activeRun} onOpen={(id) => void api.flowRun(id).then(setActiveRun)} />
            )}
          </aside>
        </div>
      )}
    </div>
  );
}

/** Everything about one step, including what it did on the run being viewed. */
function NodeEditor({
  node,
  flow,
  run,
  onChange,
  onRemove,
  onRemoveEdge,
  onEditEdge,
}: {
  node: FlowNode;
  flow: Flow;
  run: FlowNodeRun | null;
  onChange: (patch: Partial<FlowNode>) => void;
  onRemove: () => void;
  onRemoveEdge: (edgeId: string) => void;
  onEditEdge: (edgeId: string, patch: Partial<FlowEdge>) => void;
}) {
  const { status } = useStore();
  const incoming = flow.edges.filter((e) => e.to === node.id);
  const outgoing = flow.edges.filter((e) => e.from === node.id);
  const earlier = flow.nodes.filter((n) => n.id !== node.id);
  const label = (id: string) => flow.nodes.find((n) => n.id === id)?.label ?? id;

  return (
    <div className="section">
      <div className="label">{KINDS.find((k) => k.id === node.kind)?.label} step</div>
      <label className="field">
        <span>Name</span>
        <input className="input" value={node.label} onChange={(e) => onChange({ label: e.target.value })} />
      </label>

      {node.kind === "shell" && (
        <label className="field">
          <span>Command</span>
          <textarea className="input mono" rows={3} value={node.command ?? ""} placeholder="npm test" onChange={(e) => onChange({ command: e.target.value })} />
        </label>
      )}

      {node.kind === "human" && (
        <>
          <label className="field">
            <span>Question</span>
            <textarea className="input" rows={4} value={node.prompt ?? ""} placeholder="The tests passed — ship it? Answer with the release note to use." onChange={(e) => onChange({ prompt: e.target.value })} />
          </label>
          <div className="dim small">The run pauses here and the question appears in Attention. Approve with a note to continue — the note becomes {`{{${node.label || "this step"}.output}}`}. Decline to stop the run.</div>
        </>
      )}

      {node.kind === "prompt" && (
        <>
          <label className="field">
            <span>Brief</span>
            <textarea className="input" rows={6} value={node.prompt ?? ""} placeholder="Review the failing test output and fix the cause." onChange={(e) => onChange({ prompt: e.target.value })} />
          </label>
          <label className="field">
            <span>Worker</span>
            <select className="select" value={node.workerId ?? ""} onChange={(e) => onChange({ workerId: e.target.value || null })}>
              <option value="">auto (routed like a task)</option>
              {(status?.workers ?? []).map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                  {w.health && !w.health.ok ? " (down)" : ""}
                </option>
              ))}
            </select>
          </label>
          <div className="row">
            <label className="field">
              <span>Kind of work</span>
              <select className="select" value={node.capability ?? "code"} onChange={(e) => onChange({ capability: e.target.value })}>
                {["code", "plan", "review", "research"].map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Reasoning</span>
              <select className="select" value={node.reasoningEffort ?? ""} onChange={(e) => onChange({ reasoningEffort: e.target.value || null })}>
                <option value="">the worker's own level</option>
                {["minimal", "low", "medium", "high", "xhigh", "max"].map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="row check">
            <input type="checkbox" checked={node.readOnly ?? false} onChange={(e) => onChange({ readOnly: e.target.checked })} />
            <span>Read-only — a review or analysis pass that must not change files</span>
          </label>
        </>
      )}

      {node.kind === "condition" && (
        <label className="field">
          <span>Test</span>
          <input className="input mono" value={node.expression ?? ""} placeholder={'{{' + (earlier[0]?.label ?? "step") + '.output}} contains "passing"'} onChange={(e) => onChange({ expression: e.target.value })} />
        </label>
      )}

      {/* Referencing earlier steps is the whole mechanism, so it is documented where it is used. */}
      {(node.kind !== "condition" ? earlier.length > 0 : true) && (
        <div className="dim small">
          Refer to an earlier step with <code>{"{{name.output}}"}</code>, <code>{"{{name.status}}"}</code> or <code>{"{{name.exitCode}}"}</code>.
          {earlier.length > 0 && <> Steps you can name: {earlier.map((n) => n.label).join(", ")}.</>}
        </div>
      )}

      <div className="label" style={{ marginTop: 10 }}>
        Wiring
      </div>
      <div className="small">
        {incoming.length === 0 ? <div className="dim">Nothing before it — the flow starts here.</div> : incoming.map((e) => <div key={e.id}>after {label(e.from)}{e.when ? ` (${e.when})` : ""}</div>)}
        {outgoing.map((e) => (
          <div key={e.id} className="row">
            <span>
              {e.loop ? "↺" : "→"} {label(e.to)}
              {e.when ? ` (${e.when})` : ""}
            </span>
            {/* A repeat arrow points back at an earlier step and is followed up to its limit. */}
            <button
              className={`btn ghost small${e.loop ? " active" : ""}`}
              onClick={() => onEditEdge(e.id, { loop: !e.loop, maxLoops: e.loop ? null : (e.maxLoops ?? 10) })}
              title={e.loop ? "Make this an ordinary arrow" : "Make this a repeat arrow: following it re-runs its target and everything after it, up to a limit"}
            >
              repeat
            </button>
            {e.loop && (
              <input
                className="input mono"
                style={{ width: 56 }}
                type="number"
                min={1}
                value={e.maxLoops ?? 10}
                aria-label="Repeat limit"
                title="How many times at most this arrow is followed in one run"
                onChange={(ev) => onEditEdge(e.id, { maxLoops: Math.max(1, Math.floor(Number(ev.target.value) || 1)) })}
              />
            )}
            <button className="btn ghost small" onClick={() => onRemoveEdge(e.id)} title="Remove this arrow">
              <Icon name="x" />
            </button>
          </div>
        ))}
      </div>

      {run && (
        <>
          <div className="label" style={{ marginTop: 10 }}>
            This run
          </div>
          <div className={`small ${run.status === "FAILED" ? "err" : ""}`}>
            {run.status.toLowerCase()}
            {run.workerId ? ` · ${run.workerId}` : ""}
            {run.detail ? ` · ${run.detail}` : ""}
          </div>
          {run.output && <pre className="output small">{run.output}</pre>}
        </>
      )}

      <button className="btn ghost small" style={{ marginTop: 12 }} onClick={onRemove}>
        Delete this step
      </button>
    </div>
  );
}

/** Past runs, and what each step did. Editing a flow never rewrites its history. */
function RunHistory({ runs, active, onOpen }: { runs: FlowRun[]; active: { run: FlowRun; steps: FlowNodeRun[] } | null; onOpen: (id: string) => void }) {
  return (
    <div className="section">
      <div className="label">Runs</div>
      {runs.length === 0 && <div className="dim small">This flow has not run yet.</div>}
      <table className="table rows">
        <tbody>
          {runs.map((r) => (
            <tr key={r.id} className={`clickable${active?.run.id === r.id ? " selected" : ""}`} onClick={() => onOpen(r.id)}>
              <td className={r.status === "FAILED" ? "err" : r.status === "PASSED" ? "ok" : ""}>{r.status.toLowerCase()}</td>
              <td className="dim">{new Date(r.startedAt).toLocaleTimeString()}</td>
              <td className="dim small">{r.detail ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {active && (
        <>
          <div className="label" style={{ marginTop: 10 }}>
            Steps
          </div>
          <table className="table rows">
            <tbody>
              {active.steps.map((s) => (
                <tr key={s.id}>
                  <td className={s.status === "FAILED" ? "err" : s.status === "SKIPPED" ? "dim" : ""}>{s.status.toLowerCase()}</td>
                  <td className="small">{s.detail ?? s.output.slice(0, 80)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

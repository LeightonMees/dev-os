import { useState } from "react";

import type { Task, TaskStatus } from "../lib/api.ts";
import { ago, MANUAL_MOVES, STATUS_LABEL, STATUS_ORDER, STATUS_SYMBOL, truncate } from "../lib/format.ts";

interface BoardProps {
  tasks: Task[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onMove: (id: string, to: TaskStatus) => void;
  /** Called when a card is dropped on a column the state machine does not allow, with a human explanation. */
  onRefused?: (task: Task, to: TaskStatus, why: string) => void;
  onRun: (id: string) => void;
  onRetry: (id: string) => void;
  onCancel: (id: string) => void;
  onApprove: (id: string) => void;
}

/** Why a manual move is refused: the columns a worker or the verifier owns cannot be entered by hand. */
export function explainRefusedMove(from: TaskStatus, to: TaskStatus): string {
  const allowed = MANUAL_MOVES[from];
  const options = allowed.length ? `From ${STATUS_LABEL[from]} you can drag it to ${allowed.map((s) => STATUS_LABEL[s]).join(" or ")}.` : `Nothing can be moved out of ${STATUS_LABEL[from]} by hand.`;
  const hint =
    to === "WORKING" ? "Working is entered by running the task (Ready → Run)." :
    to === "DONE" ? "Done needs evidence: run the task, or approve it from Review." :
    to === "REVIEW" ? "Review is where a finished run waits for your approval." :
    to === "BLOCKED" ? "Blocked is set by a failed run or a missing dependency." : "";
  return `${options} ${hint}`.trim();
}

/** The status columns, drag to move where the state machine allows, quick actions on hover. */
export function Board({ tasks, selectedId, onSelect, onMove, onRefused, onRun, onRetry, onCancel, onApprove }: BoardProps) {
  const [dragging, setDragging] = useState<Task | null>(null);
  const [over, setOver] = useState<TaskStatus | null>(null);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  // Cancelled is not a working column, but a cancelled card must never vanish: show it when one exists.
  const columns: TaskStatus[] = tasks.some((t) => t.status === "CANCELLED") || dragging?.status === "CANCELLED" ? [...STATUS_ORDER, "CANCELLED"] : STATUS_ORDER;
  return (
    <div className="board" data-testid="board">
      {columns.map((status) => {
        const items = tasks.filter((t) => t.status === status);
        const legal = dragging ? dragging.status === status || MANUAL_MOVES[dragging.status].includes(status) : false;
        const cls = dragging && over === status ? (legal ? " drop-ok" : " drop-no") : "";
        return (
          <section
            key={status}
            className={`column${cls}`}
            data-testid={`column-${status}`}
            onDragOver={(e) => {
              if (!dragging) return;
              e.preventDefault();
              // Keep "move" even for an illegal target: with "none" Chromium never fires drop, and the user gets no explanation.
              e.dataTransfer.dropEffect = "move";
              if (over !== status) setOver(status);
            }}
            onDragLeave={(e) => {
              // Children fire dragleave as the pointer crosses them; only clear when the column itself is left.
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null);
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (dragging && dragging.status !== status) {
                if (legal) onMove(dragging.id, status);
                else onRefused?.(dragging, status, explainRefusedMove(dragging.status, status));
              }
              setDragging(null);
              setOver(null);
            }}
          >
            <header className="column-head" style={{ color: `var(--st-${status.toLowerCase()})` }}>
              <span className="sym">{STATUS_SYMBOL[status]}</span>
              {STATUS_LABEL[status]}
              <span className="count">{items.length}</span>
            </header>
            <div className="column-body">
              {items.length === 0 && <div className="dim small" style={{ padding: "8px 4px", textAlign: "center" }}>—</div>}
              {items.map((task) => (
                <article
                  key={task.id}
                  className={`card st-${task.status}${task.id === selectedId ? " selected" : ""}${dragging?.id === task.id ? " dragging" : ""}`}
                  draggable
                  title="Drag to another column to move it"
                  onDragStart={(e) => {
                    e.dataTransfer.setData("text/plain", task.id);
                    e.dataTransfer.effectAllowed = "move";
                    setDragging(task);
                  }}
                  onDragEnd={() => {
                    setDragging(null);
                    setOver(null);
                  }}
                  onClick={() => onSelect(task.id)}
                  onDoubleClick={() => {
                    if (task.status === "READY") onRun(task.id);
                  }}
                  data-testid={`card-${task.id}`}
                >
                  <div className="title">{task.title}</div>
                  <div className="meta">
                    {task.dependsOn.length === 0 ? (
                      <span>#{task.ordinal}</span>
                    ) : (
                      <span className="deps" title={task.dependsOn.map((d) => byId.get(d)?.title ?? d).join("\n")}>
                        {task.dependsOn.map((d) => `#${byId.get(d)?.ordinal ?? "?"}`).join(" ")} → #{task.ordinal}
                      </span>
                    )}
                    {task.needsHuman && <span className="warn" title={task.needsHuman}>you</span>}
                    {task.workerId && <span>{task.workerId}</span>}
                    {task.command && <span title={task.command}>$</span>}
                    <span style={{ marginLeft: "auto" }}>{ago(task.updatedAt)}</span>
                  </div>
                  {task.status === "BLOCKED" && task.failure && <div className="reason">{truncate(task.failure.reason, 110)}</div>}
                  {task.status === "DONE" && task.resultSummary && <div className="result">{truncate(task.resultSummary, 90)}</div>}
                  <QuickActions task={task} onRun={onRun} onRetry={onRetry} onCancel={onCancel} onApprove={onApprove} />
                </article>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function QuickActions({ task, onRun, onRetry, onCancel, onApprove }: { task: Task; onRun: (id: string) => void; onRetry: (id: string) => void; onCancel: (id: string) => void; onApprove: (id: string) => void }) {
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  if (task.status === "READY")
    return (
      <div className="row" style={{ marginTop: 6 }} onClick={stop}>
        <button className="btn small primary" onClick={() => onRun(task.id)}>
          Run
        </button>
      </div>
    );
  if (task.status === "BLOCKED")
    return (
      <div className="row" style={{ marginTop: 6 }} onClick={stop}>
        <button className="btn small" onClick={() => onRetry(task.id)}>
          Retry
        </button>
      </div>
    );
  if (task.status === "WORKING")
    return (
      <div className="row" style={{ marginTop: 6 }} onClick={stop}>
        <button className="btn small danger" title="Stop this run and put the task back in Ready; nothing is deleted" onClick={() => onCancel(task.id)}>
          Stop run
        </button>
      </div>
    );
  if (task.status === "REVIEW")
    return (
      <div className="row" style={{ marginTop: 6 }} onClick={stop}>
        <button className="btn small primary" onClick={() => onApprove(task.id)}>
          Approve
        </button>
      </div>
    );
  return null;
}

import { useEffect, useRef } from "react";

import type { DevEvent } from "../lib/api.ts";
import { clock, describeEvent } from "../lib/format.ts";

const OK = new Set(["TASK_COMPLETED", "VERIFICATION_PASSED"]);
const ERR = new Set(["TASK_BLOCKED", "VERIFICATION_FAILED"]);
const LIVE = new Set(["TASK_STARTED", "COMMAND_STARTED", "WORKER_SELECTED", "CONTEXT_ASSEMBLED"]);

export function Feed({ events, onSelectTask, limit = 200, autoScroll = true }: { events: DevEvent[]; onSelectTask?: (id: string) => void; limit?: number; autoScroll?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const shown = events.slice(-limit);
  useEffect(() => {
    if (!autoScroll || !ref.current) return;
    ref.current.scrollTop = ref.current.scrollHeight;
  }, [shown.length, autoScroll]);
  if (shown.length === 0) return <div className="empty">No events yet. Events appear here as tasks are created, run and verified.</div>;
  return (
    <div className="feed" ref={ref} data-testid="feed">
      {shown.map((e, i) => (
        <div key={`${e.id}-${i}`} className={`feed-row${e.taskId && onSelectTask ? " clickable" : ""}`} onClick={() => e.taskId && onSelectTask?.(e.taskId)}>
          <span className="t">{clock(e.ts)}</span>
          <span className={`type${OK.has(e.type) ? " ok" : ERR.has(e.type) ? " err" : LIVE.has(e.type) ? " live" : ""}`}>{e.type}</span>
          <span className="what" title={JSON.stringify(e.data)}>
            {describeEvent(e.type, e.data)}
          </span>
        </div>
      ))}
    </div>
  );
}

import { useEffect, useRef } from "react";

import type { OutputChunk } from "../lib/store.tsx";

/** Live worker output for one execution. Follows the tail unless the user scrolled up. */
export function Output({ chunks, fill = false, placeholder = "No output yet." }: { chunks: OutputChunk[]; fill?: boolean; placeholder?: string }) {
  const ref = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || !stick.current) return;
    el.scrollTop = el.scrollHeight;
  }, [chunks.length]);
  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };
  return (
    <pre className={`output${fill ? " fill" : ""}`} ref={ref} onScroll={onScroll} data-testid="output">
      {chunks.length === 0 ? <span className="dim">{placeholder}</span> : chunks.map((c, i) => (c.stream === "stderr" ? <span key={i} className="stderr">{c.chunk}</span> : <span key={i}>{c.chunk}</span>))}
    </pre>
  );
}

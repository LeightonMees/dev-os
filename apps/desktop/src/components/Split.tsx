import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

interface SplitProps {
  /** Persist the size under this key. */
  id: string;
  direction?: "horizontal" | "vertical";
  /** Which pane keeps a fixed, persisted size. */
  fixed?: "first" | "second";
  initial: number;
  min?: number;
  max?: number;
  first: ReactNode;
  second: ReactNode | null;
}

/** Two panes with a draggable gutter. One pane has a fixed, persisted size; the other fills. */
export function Split({ id, direction = "horizontal", fixed = "second", initial, min = 160, max = 1600, first, second }: SplitProps) {
  const [size, setSize] = useState<number>(() => {
    try {
      const saved = window.localStorage.getItem(`dev.split.${id}`);
      return saved ? Number(saved) : initial;
    } catch {
      return initial;
    }
  });
  const dragging = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(false);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragging.current = true;
      setActive(true);
      document.body.style.cursor = direction === "horizontal" ? "col-resize" : "row-resize";
    },
    [direction],
  );

  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!dragging.current || !root.current) return;
      const rect = root.current.getBoundingClientRect();
      let next: number;
      if (direction === "horizontal") next = fixed === "second" ? rect.right - e.clientX : e.clientX - rect.left;
      else next = fixed === "second" ? rect.bottom - e.clientY : e.clientY - rect.top;
      setSize(Math.max(min, Math.min(max, next)));
    };
    const up = () => {
      if (!dragging.current) return;
      dragging.current = false;
      setActive(false);
      document.body.style.cursor = "";
      setSize((s) => {
        try {
          window.localStorage.setItem(`dev.split.${id}`, String(s));
        } catch {
          // ignore
        }
        return s;
      });
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [direction, fixed, id, max, min]);

  const fixedStyle = direction === "horizontal" ? { flex: `0 0 ${size}px`, width: size } : { flex: `0 0 ${size}px`, height: size };
  const fillStyle = { flex: 1 };
  if (second === null) {
    return (
      <div className={`split ${direction}`} ref={root}>
        <div className="pane" style={fillStyle}>
          {first}
        </div>
      </div>
    );
  }
  return (
    <div className={`split ${direction}`} ref={root}>
      <div className="pane" style={fixed === "first" ? fixedStyle : fillStyle}>
        {first}
      </div>
      <div className={`gutter${active ? " active" : ""}`} onMouseDown={onMouseDown} role="separator" aria-orientation={direction === "horizontal" ? "vertical" : "horizontal"} />
      <div className="pane" style={fixed === "second" ? fixedStyle : fillStyle}>
        {second}
      </div>
    </div>
  );
}

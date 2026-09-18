import { useEffect, useRef, useState } from "react";

import { Icon } from "../components/Icon.tsx";
import { TerminalPane } from "../components/Terminal.tsx";
import { inTauri } from "../lib/native.ts";
import { useStore } from "../lib/store.tsx";

interface Tab {
  key: number;
  cwd: string | null;
  title: string;
}

/** Multiple real PTY sessions, each opened in the current project directory. */
export function TerminalView() {
  const { currentProject, api } = useStore();
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<number | null>(null);
  const [shell, setShell] = useState<string | null>(null);
  const nextKey = useRef(1);
  const opened = useRef(false);

  useEffect(() => {
    api
      .config()
      .then((c) => setShell(c.config.terminal.shell))
      .catch(() => setShell(null));
  }, [api]);

  const open = () => {
    const key = nextKey.current++;
    const tab: Tab = { key, cwd: currentProject?.path ?? null, title: currentProject?.name ?? "shell" };
    setTabs((t) => [...t, tab]);
    setActive(key);
  };
  const close = (key: number) => {
    setTabs((t) => {
      const next = t.filter((x) => x.key !== key);
      if (active === key) setActive(next[next.length - 1]?.key ?? null);
      return next;
    });
  };
  useEffect(() => {
    if (opened.current || !currentProject) return;
    opened.current = true;
    open();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProject?.path]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "t") {
        e.preventDefault();
        open();
      }
    };
    const onNew = () => open();
    window.addEventListener("keydown", onKey);
    window.addEventListener("dev:new-terminal", onNew);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("dev:new-terminal", onNew);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProject?.path]);

  return (
    <div className="view">
      <div className="toolbar" style={{ gap: 2, paddingLeft: 6 }}>
        {tabs.map((t) => (
          <button key={t.key} className={`tab${t.key === active ? " active" : ""}`} onClick={() => setActive(t.key)} title={t.cwd ?? ""} style={{ height: 33, display: "inline-flex", alignItems: "center", gap: 8 }}>
            <span className="mono">
              {t.title} {t.key}
            </span>
            <span
              className="dim"
              onClick={(e) => {
                e.stopPropagation();
                close(t.key);
              }}
              aria-label="Close terminal"
            >
              <Icon name="x" size={10} />
            </span>
          </button>
        ))}
        <button className="btn ghost small" onClick={open} title="New terminal  Ctrl+Shift+T" aria-label="New terminal">
          <Icon name="plus" size={12} />
        </button>
        <span className="spacer" />
        <span className="sub">
          {shell ?? "powershell"} in {currentProject?.path ?? "no project"}
          {!inTauri() && " (browser preview: display only)"}
        </span>
      </div>
      {tabs.length === 0 && (
        <div className="view-body">
          <div className="empty">
            No terminal open.{" "}
            <button className="btn small" onClick={open}>
              Open one
            </button>
          </div>
        </div>
      )}
      {tabs.map((t) => (
        <div key={t.key} style={{ display: t.key === active ? "flex" : "none", flex: 1, minHeight: 0, flexDirection: "column" }}>
          <TerminalPane cwd={t.cwd} shell={shell} onExit={() => close(t.key)} />
        </div>
      ))}
    </div>
  );
}

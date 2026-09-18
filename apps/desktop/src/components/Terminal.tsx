import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";

import { inTauri, invoke, listen } from "../lib/native.ts";

/**
 * One real PTY session rendered with xterm.js. The shell runs natively (ConPTY on
 * Windows through the Tauri side); this component only shuttles bytes and size.
 */
export function TerminalPane({ cwd, shell, onExit, onSession }: { cwd: string | null; shell: string | null; onExit?: (code: number | null) => void; onSession?: (id: number | null) => void }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const term = new XTerm({
      fontFamily: '"Cascadia Code", "Cascadia Mono", Consolas, monospace',
      fontSize: 12.5,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true,
      theme: {
        background: "#0d1015",
        foreground: "#d9dee6",
        cursor: "#5ed2ff",
        selectionBackground: "#2a5f75",
        black: "#1f252f",
        brightBlack: "#56606e",
        red: "#ff6b6b",
        green: "#5fd38a",
        yellow: "#ffc457",
        blue: "#6aa6ff",
        magenta: "#c792ea",
        cyan: "#5ed2ff",
        white: "#d9dee6",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();

    let id: number | null = null;
    let disposed = false;
    const offs: (() => void)[] = [];

    if (!inTauri()) {
      term.writeln("\x1b[2mIntegrated terminal needs the desktop app (Tauri). In the browser this is display-only.\x1b[0m");
      term.writeln(`\x1b[2mcwd: ${cwd ?? "(none)"}\x1b[0m`);
    } else {
      (async () => {
        try {
          const offOut = await listen<{ id: number; data: string }>("pty-output", (p) => {
            if (!disposed && p.id === id) term.write(p.data);
          });
          const offExit = await listen<{ id: number; code: number | null }>("pty-exit", (p) => {
            if (!disposed && p.id === id) {
              term.writeln(`\r\n\x1b[2m[process exited${p.code !== null ? ` with code ${p.code}` : ""}]\x1b[0m`);
              onExit?.(p.code);
            }
          });
          if (disposed) {
            // Unmounted while the listeners were being registered (StrictMode double mount).
            offOut();
            offExit();
            return;
          }
          offs.push(offOut, offExit);
          const spawned = await invoke<number>("pty_spawn", { cwd, shell, cols: term.cols, rows: term.rows });
          if (disposed) {
            await invoke("pty_kill", { id: spawned });
            return;
          }
          id = spawned;
          onSession?.(id);
        } catch (error) {
          if (!disposed) term.writeln(`\x1b[31mCould not start terminal: ${String(error)}\x1b[0m`);
        }
      })();
    }

    // Keystrokes are coalesced and sent one IPC call at a time, so their order is preserved
    // even though each invoke is asynchronous.
    let pending = "";
    let flushing = false;
    const flush = async () => {
      if (flushing || id === null || pending.length === 0) return;
      flushing = true;
      try {
        while (pending.length > 0 && !disposed) {
          const data = pending;
          pending = "";
          await invoke("pty_write", { id, data });
        }
      } catch {
        // session gone
      } finally {
        flushing = false;
      }
    };
    const dataSub = term.onData((data) => {
      pending += data;
      void flush();
    });
    const resizeSub = term.onResize(({ cols, rows }) => {
      if (id !== null) void invoke("pty_resize", { id, cols, rows }).catch(() => undefined);
    });
    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        // host not visible
      }
    });
    observer.observe(el);
    term.focus();

    return () => {
      disposed = true;
      observer.disconnect();
      dataSub.dispose();
      resizeSub.dispose();
      for (const off of offs) off();
      if (id !== null) void invoke("pty_kill", { id }).catch(() => undefined);
      term.dispose();
      onSession?.(null);
    };
    // A pane is bound to one session for its lifetime; remount to change cwd/shell.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <div className="term-host" ref={host} data-testid="terminal" />;
}

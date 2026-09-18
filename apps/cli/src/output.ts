import type { TaskStatus } from "@dev/core";

const useColor = process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb";

function paint(code: string, text: string): string {
  return useColor ? `\x1b[${code}m${text}\x1b[0m` : text;
}

export const c = {
  dim: (t: string) => paint("2", t),
  bold: (t: string) => paint("1", t),
  red: (t: string) => paint("31", t),
  green: (t: string) => paint("32", t),
  yellow: (t: string) => paint("33", t),
  blue: (t: string) => paint("34", t),
  magenta: (t: string) => paint("35", t),
  cyan: (t: string) => paint("36", t),
};

export const SYMBOL = {
  ok: c.green("✓"),
  warn: c.yellow("!"),
  fail: c.red("✗"),
  running: c.cyan("▶"),
  dot: c.dim("·"),
};

export function statusSymbol(status: TaskStatus): string {
  switch (status) {
    case "BACKLOG":
      return c.dim("○");
    case "READY":
      return c.blue("◔");
    case "WORKING":
      return c.cyan("▶");
    case "BLOCKED":
      return c.red("■");
    case "REVIEW":
      return c.yellow("◆");
    case "DONE":
      return c.green("●");
    case "CANCELLED":
      return c.dim("×");
  }
}

export function statusColor(status: TaskStatus): string {
  switch (status) {
    case "BLOCKED":
      return c.red(status);
    case "DONE":
      return c.green(status);
    case "WORKING":
      return c.cyan(status);
    case "REVIEW":
      return c.yellow(status);
    case "READY":
      return c.blue(status);
    default:
      return c.dim(status);
  }
}

/** Visible width without ANSI escapes. */
function width(text: string): number {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "").length;
}

export function table(rows: string[][], options: { header?: string[]; indent?: number; maxWidth?: number } = {}): string {
  const all = options.header ? [options.header, ...rows] : rows;
  if (all.length === 0) return "";
  const cols = Math.max(...all.map((r) => r.length));
  const widths = Array.from({ length: cols }, (_, i) => Math.max(...all.map((r) => width(r[i] ?? ""))));
  const cap = options.maxWidth ?? 80;
  const pad = " ".repeat(options.indent ?? 0);
  const line = (row: string[], dim = false) =>
    pad +
    row
      .map((cell, i) => {
        const w = Math.min(widths[i] ?? 0, cap);
        const text = width(cell) > cap ? cell.slice(0, cap - 1) + "…" : cell;
        const padded = i === row.length - 1 ? text : text + " ".repeat(Math.max(0, w - width(text)));
        return dim ? c.dim(padded) : padded;
      })
      .join("  ");
  const out: string[] = [];
  if (options.header) out.push(line(options.header, true));
  for (const row of rows) out.push(line(row));
  return out.join("\n");
}

export function kv(pairs: [string, string | number | null | undefined][], indent = 0): string {
  const w = Math.max(...pairs.map(([k]) => k.length));
  return pairs
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${" ".repeat(indent)}${c.dim(k.padEnd(w))}  ${v === null ? c.dim("—") : String(v)}`)
    .join("\n");
}

export function ago(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s - m * 60)}s`;
}

export function truncate(text: string | null | undefined, max: number): string {
  if (!text) return "";
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

export function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

export function println(text = ""): void {
  process.stdout.write(text + "\n");
}

export function eprintln(text = ""): void {
  process.stderr.write(text + "\n");
}

export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean | string[]>;
}

const BOOLEAN_FLAGS = new Set(["json", "help", "h", "force", "follow", "yes", "y", "all", "desktop", "verbose", "no-wait", "detach", "stat", "staged", "read-only", "open", "git", "ready", "backlog", "manual-review", "quiet", "stop-on-failure", "full", "no-run", "foreground", "dev", "no-checkout", "promote-backlog", "autopilot"]);

/** Tiny argv parser: --key value, --key=value, boolean flags, repeated --key collects. */
export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};
  const push = (key: string, value: string | boolean) => {
    const existing = flags[key];
    if (existing === undefined) flags[key] = value;
    else if (Array.isArray(existing)) existing.push(String(value));
    else flags[key] = [String(existing), String(value)];
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) {
        push(body.slice(0, eq), body.slice(eq + 1));
        continue;
      }
      if (body.startsWith("no-") && BOOLEAN_FLAGS.has(body.slice(3))) {
        push(body.slice(3), false);
        continue;
      }
      const next = argv[i + 1];
      if (BOOLEAN_FLAGS.has(body) || next === undefined || next.startsWith("--")) push(body, true);
      else {
        push(body, next);
        i++;
      }
      continue;
    }
    if (arg.startsWith("-") && arg.length === 2) {
      const short = arg.slice(1);
      const next = argv[i + 1];
      if (BOOLEAN_FLAGS.has(short) || next === undefined || next.startsWith("-")) push(short, true);
      else {
        push(short, next);
        i++;
      }
      continue;
    }
    positionals.push(arg);
  }
  return { positionals, flags };
}

export function flagString(flags: ParsedArgs["flags"], key: string): string | undefined {
  const value = flags[key];
  if (value === undefined || value === false) return undefined;
  if (value === true) return "";
  return Array.isArray(value) ? value[value.length - 1] : value;
}

/** Flags whose single value may hold a comma-separated list (ids, tags). Free text flags never split. */
const COMMA_LISTS = new Set(["depends", "after", "tags", "status", "type", "file"]);

export function flagList(flags: ParsedArgs["flags"], key: string): string[] {
  const value = flags[key];
  if (value === undefined || typeof value === "boolean") return [];
  const raw = Array.isArray(value) ? value : [value];
  const split = COMMA_LISTS.has(key) ? raw.flatMap((v) => v.split(",")) : raw;
  return split.map((v) => v.trim()).filter(Boolean);
}

export function flagBool(flags: ParsedArgs["flags"], key: string): boolean {
  const value = flags[key];
  return value === true || value === "true" || value === "1";
}

export function flagNumber(flags: ParsedArgs["flags"], key: string): number | undefined {
  const raw = flagString(flags, key);
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new UsageError(`--${key} expects a number, got "${raw}"`);
  return n;
}

export class UsageError extends Error {}

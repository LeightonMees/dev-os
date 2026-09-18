import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { openDev, type Dev, type Project } from "@dev/core";

import { flagString, UsageError, type ParsedArgs } from "./args.ts";

/** Repository root of this DEV checkout (apps/cli/src -> ../../..). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export function resolveHome(flags: ParsedArgs["flags"]): string {
  return resolve(flagString(flags, "home") ?? process.env.DEV_HOME ?? join(REPO_ROOT, ".dev-home"));
}

export interface CliContext {
  dev: Dev;
  home: string;
  json: boolean;
  flags: ParsedArgs["flags"];
  positionals: string[];
}

export function openContext(parsed: ParsedArgs): CliContext {
  const home = resolveHome(parsed.flags);
  const dev = openDev({ home });
  return { dev, home, json: parsed.flags.json === true, flags: parsed.flags, positionals: parsed.positionals };
}

/** `--project` wins; otherwise the registered project whose path contains the cwd; otherwise the only project. */
export function currentProject(ctx: CliContext, options: { required?: boolean } = {}): Project | undefined {
  const explicit = flagString(ctx.flags, "project") ?? flagString(ctx.flags, "p");
  if (explicit) {
    const project = ctx.dev.projects.resolve(explicit);
    if (!project) throw new UsageError(`No project matches "${explicit}". Try: dev project list`);
    return project;
  }
  const cwd = resolve(process.cwd()).toLowerCase();
  const projects = ctx.dev.projects.list({ status: "active" });
  const containing = projects
    .filter((p): p is typeof p & { path: string } => !!p.path)
    .filter((p) => cwd === p.path.toLowerCase() || cwd.startsWith(p.path.toLowerCase() + "\\") || cwd.startsWith(p.path.toLowerCase() + "/"))
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (containing) return containing;
  if (projects.length === 1) return projects[0];
  if (options.required === false) return undefined;
  if (projects.length === 0) throw new UsageError("No projects yet. Add one with: dev project add <path>");
  throw new UsageError(`Which project? Pass --project <id|name>, or run from inside a project directory. Known: ${projects.map((p) => `${p.name} (${p.id})`).join(", ")}`);
}

export interface ControlPlaneInfo {
  pid: number;
  host: string;
  port: number;
  startedAt: string;
  url: string;
}

export function controlPlaneInfoPath(home: string): string {
  return join(home, "control-plane.json");
}

/** The running control plane, if its lock file exists and it answers /health. */
export async function controlPlane(home: string): Promise<ControlPlaneInfo | null> {
  const file = controlPlaneInfoPath(home);
  if (!existsSync(file)) return null;
  try {
    const info = JSON.parse(readFileSync(file, "utf8")) as ControlPlaneInfo;
    const response = await fetch(`${info.url}/health`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return null;
    return info;
  } catch {
    return null;
  }
}

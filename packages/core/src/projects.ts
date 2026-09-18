import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import type { EventBus } from "./events/bus.ts";
import { newId, now } from "./ids.ts";
import type { Db, Row } from "./persistence/db.ts";
import { json } from "./persistence/db.ts";
import type { Lifecycle, Priority, Project, ProjectConfig, ProjectKind, ProjectMeta, ProjectStatus } from "./schemas.ts";
import { templateFiles, type ProjectTemplate } from "./templates.ts";

export interface ProjectInput {
  /** Omit or null for a planned project with no repository yet. */
  path?: string | null;
  name?: string;
  goal?: string | null;
  repository?: string | null;
  summary?: string | null;
  milestone?: string | null;
  config?: ProjectConfig;
  lifecycle?: Lifecycle;
  kind?: ProjectKind;
  priority?: Priority;
  parentId?: string | null;
  aliases?: string[];
  meta?: ProjectMeta;
}

export interface CreateProjectInput {
  name: string;
  /** Parent directory; the project lives at <dir>/<name>. */
  dir: string;
  template?: ProjectTemplate;
  git?: boolean;
  goal?: string | null;
}

export interface ProjectPatch {
  name?: string;
  path?: string | null;
  goal?: string | null;
  repository?: string | null;
  summary?: string | null;
  milestone?: string | null;
  status?: ProjectStatus;
  config?: ProjectConfig;
  lifecycle?: Lifecycle;
  kind?: ProjectKind;
  priority?: Priority;
  parentId?: string | null;
  aliases?: string[];
  meta?: ProjectMeta;
}

export class ProjectStore {
  readonly #db: Db;
  readonly #events: EventBus;

  constructor(db: Db, events: EventBus) {
    this.#db = db;
    this.#events = events;
  }

  add(input: ProjectInput): Project {
    const path = input.path ? resolve(input.path) : null;
    if (path && (!existsSync(path) || !statSync(path).isDirectory())) {
      throw new Error(`Project path does not exist or is not a directory: ${path}`);
    }
    if (!path && !input.name?.trim()) throw new Error("A project without a path needs a name");
    const existing = path ? this.byPath(path) : this.list().find((p) => p.name.toLowerCase() === input.name?.trim().toLowerCase());
    if (existing) throw new Error(`Project already registered as ${existing.id} (${existing.name})`);
    if (input.parentId && !this.get(input.parentId)) throw new Error(`Unknown parent project ${input.parentId}`);
    const ts = now();
    const project: Project = {
      id: newId("prj"),
      name: input.name?.trim() || basename(path as string),
      path,
      repository: input.repository ?? null,
      lifecycle: input.lifecycle ?? "ACTIVE",
      kind: input.kind ?? "project",
      priority: input.priority ?? "normal",
      parentId: input.parentId ?? null,
      aliases: dedupeAliases(input.aliases ?? []),
      meta: input.meta ?? {},
      goal: input.goal ?? null,
      summary: input.summary ?? null,
      milestone: input.milestone ?? null,
      status: input.lifecycle === "ARCHIVED" || input.lifecycle === "CLOSED" ? "archived" : "active",
      config: input.config ?? {},
      createdAt: ts,
      updatedAt: ts,
    };
    this.#db.run(
      `INSERT INTO projects (id, name, path, repository, goal, summary, milestone, status, lifecycle, kind, priority, parent_id, aliases_json, meta_json, config_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      project.id,
      project.name,
      project.path,
      project.repository,
      project.goal,
      project.summary,
      project.milestone,
      project.status,
      project.lifecycle,
      project.kind,
      project.priority,
      project.parentId,
      JSON.stringify(project.aliases),
      JSON.stringify(project.meta),
      JSON.stringify(project.config),
      ts,
      ts,
    );
    this.#events.emit("PROJECT_ADDED", { projectId: project.id, data: { name: project.name, path } });
    return project;
  }

  /**
   * Create a new project directory from a small template, optionally `git init`
   * it, and register it. Refuses to touch a non-empty existing directory.
   */
  create(input: CreateProjectInput): Project {
    const name = input.name.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new Error(`Project name "${name}" must be letters, digits, dot, dash or underscore`);
    const dir = resolve(input.dir);
    if (!existsSync(dir)) throw new Error(`Parent directory does not exist: ${dir}`);
    if (/onedrive/i.test(dir)) throw new Error("Refusing to create a project under OneDrive; choose a local directory");
    const path = join(dir, name);
    if (existsSync(path) && readdirSync(path).length > 0) throw new Error(`${path} already exists and is not empty. Register it instead of creating it.`);
    mkdirSync(path, { recursive: true });
    const template = input.template ?? "empty";
    const files = templateFiles(name, template, input.goal ?? null);
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(join(path, rel, ".."), { recursive: true });
      writeFileSync(join(path, rel), content);
    }
    if (input.git !== false) {
      try {
        execFileSync("git", ["init", "-q", "-b", "main"], { cwd: path, windowsHide: true });
        execFileSync("git", ["add", "-A"], { cwd: path, windowsHide: true });
        execFileSync("git", ["-c", "user.email=dev@local", "-c", "user.name=DEV", "commit", "-q", "-m", "chore: scaffold project with DEV"], { cwd: path, windowsHide: true });
      } catch (error) {
        throw new Error(`Directory created at ${path} but git init failed: ${(error as Error).message}`);
      }
    }
    const config: ProjectConfig = template === "node" ? { verification: [{ kind: "command", command: "npm test" }] } : template === "python" ? { verification: [{ kind: "command", command: "python -m unittest -q" }] } : {};
    return this.add({ path, name, goal: input.goal ?? null, config, summary: files["README.md"] ? `Scaffolded from the ${template} template.` : null, meta: { sources: ["created by DEV"], stack: template === "node" ? ["node"] : template === "python" ? ["python"] : [] } });
  }

  get(id: string): Project | undefined {
    const row = this.#db.get("SELECT * FROM projects WHERE id = ?", id);
    return row ? rowToProject(row) : undefined;
  }

  /** Resolve by id, exact name, alias, or path (absolute or relative to cwd). */
  resolve(ref: string): Project | undefined {
    const wanted = ref.trim().toLowerCase();
    const all = this.list();
    return (
      this.get(ref) ??
      this.byPath(resolve(ref)) ??
      all.find((p) => p.name.toLowerCase() === wanted) ??
      all.find((p) => p.aliases.some((a) => a.toLowerCase() === wanted))
    );
  }

  children(parentId: string): Project[] {
    return this.#db.all("SELECT * FROM projects WHERE parent_id = ? ORDER BY name", parentId).map(rowToProject);
  }

  /** Root projects first, each with its descendants, for tree views. */
  tree(): { project: Project; depth: number }[] {
    const all = this.list();
    const byParent = new Map<string | null, Project[]>();
    for (const p of all) byParent.set(p.parentId, [...(byParent.get(p.parentId) ?? []), p]);
    const out: { project: Project; depth: number }[] = [];
    const visit = (parentId: string | null, depth: number) => {
      for (const p of (byParent.get(parentId) ?? []).sort((a, b) => a.name.localeCompare(b.name))) {
        out.push({ project: p, depth });
        visit(p.id, depth + 1);
      }
    };
    visit(null, 0);
    // orphans whose parent vanished
    for (const p of all) if (p.parentId && !all.some((x) => x.id === p.parentId) && !out.some((o) => o.project.id === p.id)) out.push({ project: p, depth: 0 });
    return out;
  }

  byPath(path: string): Project | undefined {
    const row = this.#db.get("SELECT * FROM projects WHERE lower(path) = lower(?)", resolve(path));
    return row ? rowToProject(row) : undefined;
  }

  list(filter: { status?: ProjectStatus; lifecycle?: Lifecycle[]; parentId?: string | null } = {}): Project[] {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.status) {
      where.push("status = ?");
      params.push(filter.status);
    }
    if (filter.lifecycle && filter.lifecycle.length > 0) {
      where.push(`lifecycle IN (${filter.lifecycle.map(() => "?").join(",")})`);
      params.push(...filter.lifecycle);
    }
    if (filter.parentId === null) where.push("parent_id IS NULL");
    else if (filter.parentId) {
      where.push("parent_id = ?");
      params.push(filter.parentId);
    }
    return this.#db.all(`SELECT * FROM projects ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY updated_at DESC`, ...params).map(rowToProject);
  }

  update(id: string, patch: ProjectPatch): Project {
    const current = this.get(id);
    if (!current) throw new Error(`Unknown project ${id}`);
    if (patch.parentId) {
      if (patch.parentId === id) throw new Error("A project cannot be its own parent");
      if (!this.get(patch.parentId)) throw new Error(`Unknown parent project ${patch.parentId}`);
      let cursor: string | null = patch.parentId;
      while (cursor) {
        if (cursor === id) throw new Error("That parent would create a cycle");
        cursor = this.get(cursor)?.parentId ?? null;
      }
    }
    if (patch.path) {
      const abs = resolve(patch.path);
      if (!existsSync(abs)) throw new Error(`Path does not exist: ${abs}`);
      const clash = this.byPath(abs);
      if (clash && clash.id !== id) throw new Error(`Path already belongs to ${clash.name} (${clash.id})`);
      patch = { ...patch, path: abs };
    }
    const next: Project = {
      ...current,
      ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
      config: patch.config ? { ...current.config, ...patch.config } : current.config,
      meta: patch.meta ? { ...current.meta, ...patch.meta } : current.meta,
      aliases: patch.aliases ? dedupeAliases(patch.aliases) : current.aliases,
      updatedAt: now(),
    };
    if (patch.lifecycle && !patch.status) next.status = patch.lifecycle === "ARCHIVED" || patch.lifecycle === "CLOSED" ? "archived" : "active";
    this.#db.run(
      `UPDATE projects SET name = ?, path = ?, repository = ?, goal = ?, summary = ?, milestone = ?, status = ?, lifecycle = ?, kind = ?, priority = ?, parent_id = ?, aliases_json = ?, meta_json = ?, config_json = ?, updated_at = ? WHERE id = ?`,
      next.name,
      next.path,
      next.repository,
      next.goal,
      next.summary,
      next.milestone,
      next.status,
      next.lifecycle,
      next.kind,
      next.priority,
      next.parentId,
      JSON.stringify(next.aliases),
      JSON.stringify(next.meta),
      JSON.stringify(next.config),
      next.updatedAt,
      id,
    );
    this.#events.emit("PROJECT_UPDATED", { projectId: id, data: { fields: Object.keys(patch) } });
    return next;
  }

  touch(id: string): void {
    this.#db.run("UPDATE projects SET updated_at = ? WHERE id = ?", now(), id);
  }

  remove(id: string): void {
    const project = this.get(id);
    if (!project) throw new Error(`Unknown project ${id}`);
    this.#db.run("DELETE FROM projects WHERE id = ?", id);
    this.#events.emit("PROJECT_REMOVED", { projectId: id, data: { name: project.name } });
  }
}

function dedupeAliases(aliases: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of aliases) {
    const t = a.trim();
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out;
}

export function rowToProject(row: Row): Project {
  return {
    id: String(row.id),
    name: String(row.name),
    path: (row.path as string | null) ?? null,
    repository: (row.repository as string | null) ?? null,
    lifecycle: ((row.lifecycle as Lifecycle | null) ?? "ACTIVE") as Lifecycle,
    kind: ((row.kind as ProjectKind | null) ?? "project") as ProjectKind,
    priority: ((row.priority as Priority | null) ?? "normal") as Priority,
    parentId: (row.parent_id as string | null) ?? null,
    aliases: json<string[]>(row.aliases_json, []),
    meta: json<ProjectMeta>(row.meta_json, {}),
    goal: (row.goal as string | null) ?? null,
    summary: (row.summary as string | null) ?? null,
    milestone: (row.milestone as string | null) ?? null,
    status: row.status as ProjectStatus,
    config: json<ProjectConfig>(row.config_json, {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

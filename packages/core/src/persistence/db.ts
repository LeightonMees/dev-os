import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { MIGRATIONS } from "./migrations.ts";

export type Row = Record<string, unknown>;

/** Thin wrapper over node:sqlite with migrations, WAL and JSON helpers. */
export class Db {
  readonly path: string;
  readonly #db: DatabaseSync;

  constructor(path: string) {
    this.path = path;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    if (path !== ":memory:") this.#db.exec("PRAGMA journal_mode = WAL;");
    this.#db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  migrate(): number {
    this.#db.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
    );
    const applied = new Set(this.all("SELECT version FROM schema_migrations").map((r) => Number(r.version)));
    let latest = 0;
    for (const migration of MIGRATIONS) {
      latest = Math.max(latest, migration.version);
      if (applied.has(migration.version)) continue;
      // Table rebuilds (create-copy-drop-rename) must not cascade deletes through
      // ON DELETE CASCADE, so foreign keys are off for the duration of a migration.
      // The pragma is a no-op inside a transaction, hence it runs before BEGIN.
      this.#db.exec("PRAGMA foreign_keys = OFF");
      this.#db.exec("BEGIN");
      try {
        this.#db.exec(migration.sql);
        const broken = this.#db.prepare("PRAGMA foreign_key_check").all();
        if (broken.length > 0) throw new Error(`${broken.length} rows would violate foreign keys after the migration`);
        this.run(
          "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
          migration.version,
          migration.name,
          new Date().toISOString(),
        );
        this.#db.exec("COMMIT");
      } catch (error) {
        this.#db.exec("ROLLBACK");
        this.#db.exec("PRAGMA foreign_keys = ON");
        throw new Error(`Migration ${migration.version} (${migration.name}) failed: ${(error as Error).message}`);
      }
      this.#db.exec("PRAGMA foreign_keys = ON");
    }
    return latest;
  }

  version(): number {
    const row = this.get("SELECT MAX(version) AS v FROM schema_migrations");
    return Number(row?.v ?? 0);
  }

  exec(sql: string): void {
    this.#db.exec(sql);
  }

  run(sql: string, ...params: SQLInputValue[]): { changes: number | bigint; lastInsertRowid: number | bigint } {
    return this.#db.prepare(sql).run(...params);
  }

  get(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.#db.prepare(sql).get(...params) as Row | undefined;
  }

  all(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.#db.prepare(sql).all(...params) as Row[];
  }

  #depth = 0;

  /** Nested calls join the outer transaction; only the outermost commits or rolls back. */
  transaction<T>(fn: () => T): T {
    if (this.#depth > 0) {
      this.#depth++;
      try {
        return fn();
      } finally {
        this.#depth--;
      }
    }
    this.#db.exec("BEGIN");
    this.#depth = 1;
    try {
      const result = fn();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    } finally {
      this.#depth = 0;
    }
  }

  close(): void {
    this.#db.close();
  }
}

export function json<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || value === "") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

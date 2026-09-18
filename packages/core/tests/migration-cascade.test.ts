import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";

import { MIGRATIONS } from "../src/persistence/migrations.ts";
import { Db } from "../src/persistence/db.ts";

test("migrating a v3 database to v4 keeps tasks, executions and evidence", () => {
  const dir = mkdtempSync(join(process.env.DEV_TEST_TMP ?? tmpdir(), "dev-mig-"));
  const file = join(dir, "dev.sqlite");
  const raw = new DatabaseSync(file);
  raw.exec("PRAGMA foreign_keys = ON");
  raw.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
  for (const m of MIGRATIONS.filter((m) => m.version <= 3)) {
    raw.exec(m.sql);
    raw.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(m.version, m.name, "2026-01-01T00:00:00Z");
  }
  const ts = "2026-01-01T00:00:00Z";
  raw.prepare("INSERT INTO projects (id, name, path, status, config_json, created_at, updated_at) VALUES ('prj_1','P','C:/x','active','{}',?,?)").run(ts, ts);
  raw.prepare("INSERT INTO tasks (id, project_id, ordinal, title, outcome, requirements_json, acceptance_json, verification_json, files_json, effort, status, created_at, updated_at) VALUES ('tsk_1','prj_1',1,'t','','[]','[]','[]','[]','low','BACKLOG',?,?)").run(ts, ts);
  raw.close();

  const db = new Db(file);
  assert.equal(db.version(), MIGRATIONS[MIGRATIONS.length - 1]?.version);
  assert.equal(db.get("SELECT count(*) AS c FROM tasks")?.c, 1);
  assert.equal(db.get("SELECT count(*) AS c FROM projects")?.c, 1);
  assert.equal(db.get("SELECT lifecycle FROM projects WHERE id = 'prj_1'")?.lifecycle, "ACTIVE");
  assert.equal(db.get("PRAGMA foreign_keys")?.foreign_keys, 1);
  db.close();
});

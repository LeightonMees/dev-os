import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { Db, MIGRATIONS, openDev } from "../src/index.ts";
import { tempRoot } from "./helpers.ts";

test("migrations apply once and record the schema version", () => {
  const db = new Db(":memory:");
  assert.equal(db.version(), MIGRATIONS[MIGRATIONS.length - 1]?.version);
  assert.equal(db.migrate(), db.version(), "re-running migrate is a no-op");
  const tables = db.all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((r) => r.name);
  for (const expected of ["projects", "tasks", "task_dependencies", "events", "executions", "artifacts", "evidence", "decisions", "approvals", "context_snapshots", "worker_health"]) {
    assert.ok(tables.includes(expected), `missing table ${expected}`);
  }
  db.close();
});

test("state survives closing and reopening the same home", () => {
  const home = tempRoot();
  const first = openDev({ home });
  const project = first.projects.add({ path: home, name: "persist-me" });
  const task = first.tasks.create({ projectId: project.id, title: "remember" });
  first.close();
  assert.ok(existsSync(join(home, "dev.sqlite")));
  const second = openDev({ home });
  assert.equal(second.projects.get(project.id)?.name, "persist-me");
  assert.equal(second.tasks.get(task.id)?.title, "remember");
  second.close();
});

test("transactions roll back on error", () => {
  const db = new Db(":memory:");
  assert.throws(() =>
    db.transaction(() => {
      db.run("INSERT INTO projects (id, name, path, created_at, updated_at) VALUES ('p1', 'a', '/a', 'now', 'now')");
      throw new Error("boom");
    }),
  );
  assert.equal(db.all("SELECT * FROM projects").length, 0);
  db.close();
});

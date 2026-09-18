// Numbered, forward-only migrations. Never edit a shipped migration; add a new one.
export const MIGRATIONS: { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: "initial",
    sql: `
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  repository TEXT,
  goal TEXT,
  summary TEXT,
  milestone TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  outcome TEXT NOT NULL DEFAULT '',
  requirements_json TEXT NOT NULL DEFAULT '[]',
  acceptance_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'BACKLOG',
  worker_id TEXT,
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  effort TEXT NOT NULL DEFAULT 'medium',
  command TEXT,
  files_json TEXT NOT NULL DEFAULT '[]',
  verification_json TEXT NOT NULL DEFAULT '[]',
  result_summary TEXT,
  failure_json TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  ordinal INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX tasks_project_status ON tasks(project_id, status);

CREATE TABLE task_dependencies (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on_id)
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  project_id TEXT,
  task_id TEXT,
  execution_id TEXT,
  data_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX events_project ON events(project_id, id);
CREATE INDEX events_task ON events(task_id, id);

CREATE TABLE executions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  exit_code INTEGER,
  command TEXT,
  cwd TEXT NOT NULL,
  log_path TEXT,
  changed_files_json TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  duration_ms INTEGER,
  context_snapshot_id TEXT,
  summary TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  usage_json TEXT
);
CREATE INDEX executions_task ON executions(task_id, started_at);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT,
  execution_id TEXT,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  meta_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX artifacts_task ON artifacts(task_id);

CREATE TABLE evidence (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  execution_id TEXT,
  kind TEXT NOT NULL,
  passed INTEGER NOT NULL,
  summary TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}',
  artifact_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX evidence_task ON evidence(task_id);

CREATE TABLE decisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  alternatives_json TEXT NOT NULL DEFAULT '[]',
  tags_json TEXT NOT NULL DEFAULT '[]',
  revisit TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  task_id TEXT,
  execution_id TEXT,
  action TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  requested_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT
);

CREATE TABLE context_snapshots (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  execution_id TEXT,
  budget_tokens INTEGER NOT NULL,
  used_tokens INTEGER NOT NULL,
  sections_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE worker_health (
  worker_id TEXT PRIMARY KEY,
  ok INTEGER NOT NULL,
  checked_at TEXT NOT NULL,
  detail TEXT NOT NULL,
  version TEXT
);
`,
  },
  {
    version: 2,
    name: "chat",
    sql: `
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT,
  tool_calls_json TEXT,
  tool_call_id TEXT,
  name TEXT,
  meta_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX chat_messages_conversation ON chat_messages(conversation_id, id);
`,
  },
  {
    version: 3,
    name: "backlog-structure",
    sql: `
ALTER TABLE tasks ADD COLUMN milestone TEXT;
ALTER TABLE tasks ADD COLUMN epic TEXT;
ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'ticket';
ALTER TABLE tasks ADD COLUMN risk TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE tasks ADD COLUMN needs_human TEXT;
ALTER TABLE approvals ADD COLUMN note TEXT;
CREATE INDEX tasks_project_milestone ON tasks(project_id, milestone);
`,
  },
  {
    version: 4,
    name: "project-ecosystem",
    sql: `
CREATE TABLE projects_new (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT,
  repository TEXT,
  goal TEXT,
  summary TEXT,
  milestone TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  lifecycle TEXT NOT NULL DEFAULT 'ACTIVE',
  kind TEXT NOT NULL DEFAULT 'project',
  priority TEXT NOT NULL DEFAULT 'normal',
  parent_id TEXT,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  meta_json TEXT NOT NULL DEFAULT '{}',
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO projects_new (id, name, path, repository, goal, summary, milestone, status, config_json, created_at, updated_at)
  SELECT id, name, path, repository, goal, summary, milestone, status, config_json, created_at, updated_at FROM projects;
DROP TABLE projects;
ALTER TABLE projects_new RENAME TO projects;
CREATE UNIQUE INDEX projects_path ON projects(lower(path)) WHERE path IS NOT NULL;
CREATE INDEX projects_parent ON projects(parent_id);
CREATE INDEX projects_lifecycle ON projects(lifecycle);
`,
  },
  {
    version: 5,
    name: "reasoning-effort",
    sql: `
ALTER TABLE tasks ADD COLUMN reasoning_effort TEXT;
`,
  },
  {
    version: 6,
    name: "flows",
    sql: `
CREATE TABLE flows (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  nodes_json TEXT NOT NULL DEFAULT '[]',
  edges_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX flows_project ON flows(project_id);

CREATE TABLE flow_runs (
  id TEXT PRIMARY KEY,
  flow_id TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'RUNNING',
  detail TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX flow_runs_flow ON flow_runs(flow_id, started_at DESC);

CREATE TABLE flow_node_runs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES flow_runs(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  output TEXT NOT NULL DEFAULT '',
  detail TEXT,
  worker_id TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX flow_node_runs_run ON flow_node_runs(run_id);
`,
  },
  {
    version: 7,
    name: "task_prompt_override",
    sql: `
-- A human-edited brief. NULL means "assemble it", which is every task by default; a string means a
-- person opened the brief, changed it, and that exact text is what the worker gets. Added because
-- the composer showed the assembled prompt read-only: you could see a brief was wrong and had no
-- way to correct it without changing the inputs and hoping.
ALTER TABLE tasks ADD COLUMN prompt_override TEXT;
`,
  },
];

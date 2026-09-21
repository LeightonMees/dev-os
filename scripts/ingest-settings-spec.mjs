// Ingest the "Configuration, Onboarding & Operating-Policy" specification into
// DEV's own backlog as milestones, epics and tickets with dependencies.
// Idempotent: skips titles that already exist in the DEV project.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { openDev } from "../packages/core/src/index.ts";

const home = process.env.DEV_HOME ?? resolve(fileURLToPath(import.meta.url), "..", "..", ".dev-home");
const dev = openDev({ home });
const project = dev.projects.resolve("DEV");
if (!project) throw new Error("Register DEV first: dev project add <path-to-this-repo> --name DEV");

const existing = new Map(dev.tasks.list({ projectId: project.id }).map((t) => [t.title, t]));
const ids = new Map();
const V = "npm test";
const created = [];

function add(key, spec) {
  const found = existing.get(spec.title);
  if (found) {
    ids.set(key, found.id);
    return found;
  }
  const task = dev.tasks.create({
    projectId: project.id,
    title: spec.title,
    outcome: spec.outcome ?? "",
    requirements: spec.req ?? [],
    acceptance: spec.accept ?? [],
    verification: spec.verify === null ? [] : [{ kind: "command", command: spec.verify ?? V }],
    files: spec.files ?? [],
    effort: spec.effort ?? "medium",
    milestone: spec.milestone,
    epic: spec.epic ?? null,
    kind: spec.kind ?? "ticket",
    risk: spec.risk ?? "normal",
    needsHuman: spec.needsHuman ?? null,
    dependsOn: (spec.deps ?? []).map((k) => {
      const id = ids.get(k);
      if (!id) throw new Error(`unknown dependency key ${k} for ${spec.title}`);
      return id;
    }),
    status: "BACKLOG",
  });
  ids.set(key, task.id);
  created.push(task);
  return task;
}

const A = "Settings A: schema + storage";
const B = "Settings B: global settings UI";
const C = "Settings C: project overrides";
const Dm = "Settings D: approval matrix";
const E = "Settings E: worker configuration + routing";
const F = "Settings F: Learn / Pair / Build modes";
const G = "Settings G: budgets, security, advanced policies";
const H = "Settings H: first-run interview + presets";

// ---------- prep / decisions ----------
add("prep-baseline", { milestone: A, epic: "Prep", kind: "prep", title: "Baseline audit: map the current config.ts and Settings view against spec §45/§51", outcome: "A short docs note listing which spec sections the baseline already covers (flat config.json, dotted-key editing, Settings groups, worker health probes, approvals table) and which it does not (schema/versioning/validation, scopes, matrix).", req: ["Read packages/core/src/config.ts, apps/desktop/src/views/SettingsView.tsx, records.ts approvals", "Write docs/settings/BASELINE.md with a table: spec section → exists / partial / missing"], accept: ["docs/settings/BASELINE.md exists and lists every spec section 1–55 with a status", "No code changes"], verify: null, effort: "low", risk: "low" });
add("dec-format", { milestone: A, epic: "Prep", kind: "decision", title: "Decision: configuration file layout and scope precedence (global → project → session → task)", outcome: "An ADR under docs/adr/ fixing: one versioned config.json per scope (global in .dev-home, project in <repo>/.dev/config.json), merge order, and which keys are 'restricted' (may not be loosened by lower scopes, e.g. privacy=LOCAL_ONLY).", accept: ["docs/adr/0001-config-scopes.md exists with context, decision, alternatives, consequences", "Lists the restricted keys explicitly"], verify: null, needsHuman: "Confirm the file layout and the restricted-key rule before implementation", effort: "low", risk: "high", deps: ["prep-baseline"] });

// ---------- Phase A ----------
add("a-epic", { milestone: A, epic: "Configuration schema + storage", kind: "epic", title: "Epic: versioned, validated configuration model (spec §45, acceptance criteria 1–10)", outcome: "DEV has a schema-validated, versioned configuration with defaults, safe rejection of invalid input, project overrides and an effective-config calculation; the baseline keeps working.", accept: ["All child tickets DONE", "npm test passes", "Existing dev doctor / dev ui unaffected"], verify: null, effort: "low", deps: ["dec-format"] });
add("a1", { milestone: A, epic: "Configuration schema + storage", title: "Define the config schema module with version, defaults and typed sections", outcome: "packages/core/src/config/schema.ts declares every section the spec anticipates (user, machine, workers, routing, autonomy, approvals, testing, git, learning, budget, tools, security, notifications, ui, advanced) with defaults and a schemaVersion, without behaviour changes.", req: ["No new dependencies: hand-written validators or a tiny zod-free checker", "Unknown fields are preserved, not dropped", "Every field has a description string for the Settings UI"], accept: ["DEFAULT_CONFIG builds from the schema", "schema exports a list of {key, type, description, default, scope, restartRequired}", "Unit test: defaults validate"], files: ["packages/core/src/config.ts"], effort: "high", risk: "high", deps: ["dec-format"] });
add("a2", { milestone: A, epic: "Configuration schema + storage", title: "Validate configuration on load and reject invalid values safely", outcome: "loadConfig validates against the schema; invalid values fall back to defaults with a recorded warning instead of crashing; the doctor reports config warnings.", accept: ["Test: a config.json with a wrong type loads with defaults and a warning", "Test: unknown keys survive a load/save round trip", "dev doctor shows 'config' with warnings when present"], effort: "medium", risk: "normal", deps: ["a1"] });
add("a3", { milestone: A, epic: "Configuration schema + storage", title: "Config versioning and migration mechanism", outcome: "config.json carries schemaVersion; a migrations list upgrades older files on load and never rewrites a file it cannot understand.", accept: ["Test: a v0 (unversioned) config upgrades to the current version", "Test: a config from a future version is left untouched and reported"], effort: "medium", risk: "normal", deps: ["a1"] });
add("a4", { milestone: A, epic: "Configuration schema + storage", title: "Project-scope overrides and effective-config calculation", outcome: "Projects may hold <repo>/.dev/config.json (subset); effectiveConfig(projectId) merges global → project honouring restricted keys; the runner, planner and workers read the effective config.", accept: ["Test: project override changes one setting; a restricted key cannot be loosened by the project", "dev config get --project <id> shows the effective value with its source scope"], effort: "high", risk: "high", deps: ["a2", "a3"] });
add("a5", { milestone: A, epic: "Configuration schema + storage", title: "Config export / import / reset with confirmation", outcome: "dev config export|import|reset <section> and matching control-plane routes; reset requires --yes / a confirm dialog.", accept: ["Export produces human-readable JSON", "Import validates before writing", "Reset without confirmation is refused"], effort: "low", deps: ["a2"] });
add("a6", { milestone: A, epic: "Configuration schema + storage", title: "Audit log for configuration changes and autonomous actions (spec §54, minimal)", outcome: "An audit table records who/what changed a setting or took a policy-gated action, with time and the relevant policy; never secrets.", accept: ["Changing a setting via CLI or UI writes an audit row", "dev audit lists rows; secrets are redacted by name pattern"], effort: "medium", deps: ["a2"] });

// ---------- Phase B ----------
add("b-epic", { milestone: B, epic: "Global settings UI", kind: "epic", title: "Epic: schema-driven Settings screen with categories and search (spec §51–§53)", outcome: "Settings renders from the schema: categories, name/description/value/default/scope/restart flag, search, and an explanation of where a value comes from.", verify: null, effort: "low", deps: ["a4"] });
add("b1", { milestone: B, epic: "Global settings UI", title: "Render Settings from the schema with categories and per-setting metadata", outcome: "SettingsView is generated from the schema list; no hard-coded field groups remain.", accept: ["Every schema key appears once under its category", "Restart-required keys show the indicator", "Component test renders three categories from a fake schema"], verify: "npm run test:desktop", effort: "high", deps: ["b-epic"] });
add("b2", { milestone: B, epic: "Global settings UI", title: "Settings search across names, descriptions and keys", outcome: "Typing 'commit' lists commit-related settings from any category.", accept: ["Component test: search narrows to matching settings"], verify: "npm run test:desktop", effort: "low", deps: ["b1"] });
add("b3", { milestone: B, epic: "Global settings UI", title: "'Why is this value in effect?' explanation per setting", outcome: "Each setting can show its source scope (default / global / project) and, for policy-gated denials, the policy that decided.", accept: ["Effective-config source is shown next to overridden values"], verify: "npm run test:desktop", effort: "medium", deps: ["b1", "a4"] });

// ---------- Phase C ----------
add("c-epic", { milestone: C, epic: "Project overrides", kind: "epic", title: "Epic: project profile and per-project overrides in the UI (spec §4–§8, §44)", outcome: "Projects carry type, languages, size, phase, planning depth, ticket size and definition of done; the Edit project dialog edits overrides and shows inherited values.", verify: null, effort: "low", deps: ["b1"] });
add("c1", { milestone: C, epic: "Project overrides", title: "Project profile fields (type, languages, frameworks, size, phase, priority, risk)", outcome: "Schema + project config carry the profile; Overview shows type/phase/size.", accept: ["Migration adds nothing to the DB: profile lives in the project config JSON", "Test: profile round-trips through PATCH /api/projects/:id"], effort: "medium", deps: ["c-epic"] });
add("c2", { milestone: C, epic: "Project overrides", title: "Definition of done and planning depth as project settings that the runner enforces", outcome: "DONE requires the project's configured checks (tests/lint/typecheck) as evidence; planning depth bounds planGoal's maxTasks.", accept: ["Test: a project requiring lint blocks DONE until lint evidence exists"], effort: "high", risk: "high", deps: ["c1"] });
add("c3", { milestone: C, epic: "Project overrides", title: "Adaptive ticket size: automatic decomposition of large tasks", outcome: "A task marked 'large' or estimated high effort is decomposed by the planner into subtasks with dependencies before running.", accept: ["Test: planGoal with ticketSize=micro yields smaller tasks than standard"], effort: "high", risk: "high", deps: ["c2"] });

// ---------- Phase D ----------
add("d-epic", { milestone: Dm, epic: "Approval matrix", kind: "epic", title: "Epic: approval matrix, command classification and protected files (spec §12–§14, §30)", outcome: "Every gated action consults a policy (ALWAYS_ALLOW / ALLOW_WITHIN_TICKET / ASK / ALWAYS_ASK / DENY); asks pause the run and notify; protected paths need review.", verify: null, effort: "low", deps: ["a4"] });
add("d1", { milestone: Dm, epic: "Approval matrix", title: "Approval policy model and evaluation function", outcome: "packages/core/src/policy.ts: actions enum from spec §13, policy values, evaluate(action, scope) → allow | ask | deny with the deciding policy.", accept: ["Unit tests cover every value and the restricted-key rule"], effort: "medium", deps: ["d-epic"] });
add("d2", { milestone: Dm, epic: "Approval matrix", title: "Pause an execution on ASK and resume after approval", outcome: "The runner emits APPROVAL_REQUESTED, the task shows 'needs you', and the run continues or is blocked when the approval resolves.", accept: ["Test: a shell task whose command is classified DESTRUCTIVE waits for approval and blocks when denied"], effort: "high", risk: "high", deps: ["d1"] });
add("d3", { milestone: Dm, epic: "Approval matrix", title: "Command classification (SAFE_READ / NORMAL_DEV / SYSTEM_CHANGE / DESTRUCTIVE / UNKNOWN)", outcome: "A classifier with a small rule table and tests; the API worker's run_command and shell tasks consult it.", accept: ["Tests for pwd, pytest, npm install, rm -rf, unknown"], effort: "medium", deps: ["d1"] });
add("d4", { milestone: Dm, epic: "Approval matrix", title: "Protected paths per project require review", outcome: "Changed files matching protected globs move the task to REVIEW even when verification passed.", accept: ["Test: editing a protected path ends in REVIEW"], effort: "medium", deps: ["d2"] });

// ---------- Phase E ----------
add("e-epic", { milestone: E, epic: "Worker configuration + routing", kind: "epic", title: "Epic: worker metadata, routing modes and local/cloud policy (spec §9–§11, §38, §41)", outcome: "Workers carry cost/speed/privacy classes and concurrency limits; routing modes are configurable; LOCAL_ONLY projects never reach cloud workers.", verify: null, effort: "low", deps: ["a4"] });
add("e1", { milestone: E, epic: "Worker configuration + routing", title: "Worker metadata in config: enabled, cost class, speed class, privacy class, preferred tasks, fallbacks, concurrency", outcome: "The existing worker registry reads these from the schema; the Workers view shows them.", accept: ["dev workers --json includes the metadata", "Disabled workers never get selected"], effort: "medium", deps: ["e-epic"] });
add("e2", { milestone: E, epic: "Worker configuration + routing", title: "Routing modes: MANUAL, RULE_BASED, COST_FIRST, QUALITY_FIRST, LOCAL_FIRST", outcome: "select() honours the configured mode using the metadata; the chosen reason is recorded on WORKER_SELECTED.", accept: ["Tests per mode with fake workers"], effort: "high", deps: ["e1"] });
add("e3", { milestone: E, epic: "Worker configuration + routing", title: "Local/cloud policy with project override that cannot be loosened", outcome: "LOCAL_ONLY excludes remote-model and cloud CLI workers for that project; the chat brain respects it too.", accept: ["Test: LOCAL_ONLY project routes to ollama/shell only"], effort: "medium", risk: "high", deps: ["e2"] });
add("e4", { milestone: E, epic: "Worker configuration + routing", title: "Worker concurrency and parallel auto-run of independent tasks", outcome: "autoRun runs up to N independent runnable tasks at once, never two on the same repository unless allowed.", accept: ["Test: two independent tasks run concurrently with concurrency=2; dependent ones wait"], effort: "high", risk: "high", deps: ["e1"] });

// ---------- Phase F ----------
add("f-epic", { milestone: F, epic: "Working modes", kind: "epic", title: "Epic: Learn / Pair / Build / Autopilot modes and learning settings (spec §3, §24)", outcome: "A per-project mode changes what workers may do and how the chat explains; Learn mode escalates help gradually.", verify: null, effort: "low", deps: ["d2", "c1"] });
add("f1", { milestone: F, epic: "Working modes", title: "Mode setting per project with capability gates (Learn: no worker edits; Pair: contained edits + explanation; Build; Autopilot)", outcome: "The runner refuses agent edits in LEARN, requires explanation summaries in PAIR, and only AUTOPILOT may auto-run queues.", accept: ["Tests for each mode's gate"], effort: "high", deps: ["f-epic"] });
add("f2", { milestone: F, epic: "Working modes", title: "Learn-mode chat behaviour: hint ladder and explanation depth", outcome: "The chat brain's system prompt and tools follow the escalation ladder from the spec with a 'more help' command.", accept: ["Prompt snapshot test; hint level increments on request"], effort: "medium", deps: ["f1"] });

// ---------- Phase G ----------
add("g-epic", { milestone: G, epic: "Budgets, security, advanced", kind: "epic", title: "Epic: budgets, failure/stuck policy, security & sandbox, notifications, handover (spec §15–§20, §26–§29, §31, §42–§43)", outcome: "Real token accounting from providers that expose it, budget warnings/stops, failure and stuck policies, notification channels, session handover documents.", verify: null, effort: "low", deps: ["d2", "e1"] });
add("g1", { milestone: G, epic: "Budgets, security, advanced", title: "Token/cost accounting from execution usage and budget thresholds", outcome: "Usage already captured on executions feeds per-session/day/project totals; warning and hard-limit settings stop new runs.", accept: ["Never estimates when a provider gives no numbers; shows 'unknown'", "Test: hard limit blocks a run with a structured failure"], effort: "medium", risk: "normal", deps: ["g-epic"] });
add("g2", { milestone: G, epic: "Budgets, security, advanced", title: "Failure policy and stuck detection", outcome: "Configurable RETRY_SAME / RETRY_WITH_CONTEXT / DIFFERENT_WORKER / ESCALATE / REQUEST_HUMAN / BLOCK with retry limits; repeated identical failures escalate.", accept: ["Test: two identical failures escalate per policy; retry limit is honoured"], effort: "high", risk: "high", deps: ["g-epic"] });
add("g3", { milestone: G, epic: "Budgets, security, advanced", title: "Notification channels and rules (UI, desktop; email deferred)", outcome: "Notification settings choose which events notify and how; the existing toast + OS notification path becomes rule-driven.", accept: ["Test: a muted event type does not notify"], effort: "medium", deps: ["g-epic"] });
add("g4", { milestone: G, epic: "Budgets, security, advanced", title: "Session handover document and resume behaviour", outcome: "dev handover writes HANDOFF.md from real state (done, changed, tests, decisions, next task); on startup DEV reads unfinished executions and offers the safe next action.", accept: ["Handover lists only recorded facts", "Restart with a running execution marks it abandoned and surfaces it"], effort: "medium", deps: ["g-epic"] });
add("g5", { milestone: G, epic: "Budgets, security, advanced", title: "Security and privacy settings enforced (network, cloud, secrets, log retention, sandbox preference)", outcome: "Settings exist and the relevant code paths consult them; secrets never enter prompts or logs.", accept: ["Test: secret values redacted from logs and briefs"], effort: "high", risk: "high", deps: ["e3", "d3"] });

// ---------- Phase H ----------
add("h-epic", { milestone: H, epic: "Onboarding", kind: "epic", title: "Epic: first-run interview, presets and project creation interview (spec §1–§2, §47–§49)", outcome: "A guided first-run wizard in logical sections, presets that populate settings, and a project creation interview producing brief/requirements/prep checklist/milestones.", verify: null, effort: "low", deps: ["b1", "c1", "f1"] });
add("h1", { milestone: H, epic: "Onboarding", title: "First-run wizard (user, machine detection, experience, mode, workers, autonomy, approvals, notifications)", outcome: "Runs once when no global config exists; every answer lands in the schema and stays editable in Settings.", accept: ["Wizard writes a valid config; skipping keeps defaults", "Component test for one section"], verify: "npm run test:desktop", effort: "high", deps: ["h-epic"] });
add("h2", { milestone: H, epic: "Onboarding", title: "Presets (learning, solo professional, rapid prototype, production, private/local, low-cost, high-assurance)", outcome: "Presets are data that populate settings; applying one is a normal, auditable config change.", accept: ["Test: applying a preset changes only the keys it defines"], effort: "medium", deps: ["h1"] });
add("h3", { milestone: H, epic: "Onboarding", title: "Project creation interview → brief, requirements, prep checklist, milestones, initial backlog", outcome: "The New project flow asks only material questions and produces PROJECT_BRIEF.md, requirements and a bounded first milestone via the planner; prep items become 'prep' tasks needing a human.", accept: ["Interview output files exist in the new project", "Prep tasks show 'needs you'"], effort: "high", risk: "high", deps: ["h1", "c1"] });
add("h4", { milestone: H, epic: "Onboarding", title: "Idea / plan-only mode", outcome: "A project phase where workers may research and plan but never implement.", accept: ["Test: running a task in IDEA phase is refused with a clear reason"], effort: "low", deps: ["f1"] });

dev.projects.update(project.id, { milestone: A });
console.log(JSON.stringify({ created: created.length, skipped: existing.size, total: dev.tasks.list({ projectId: project.id }).length, structure: dev.tasks.structure(project.id).milestones.map((m) => ({ milestone: m.name, tasks: Object.values(m.counts).reduce((a, b) => a + b, 0), epics: m.epics.map((e) => e.name) })) }, null, 2));
dev.close();

# State model

All state is in `.dev-home/dev.sqlite`. Types are in `packages/core/src/schemas.ts`.

## Records

| Table | Purpose | Notes |
|---|---|---|
| `projects` | every project DEV knows about, with or without a directory | path (nullable), lifecycle, kind, priority, parent_id, aliases, meta (sources, stack, related, working/planned features, legacy paths), goal, summary, milestone, config (default worker, verification, reviewRequired) |
| `tasks` | units of work | outcome, requirements, acceptance, status, worker, capabilities, effort (size), reasoning effort, command, files, verification, result summary, structured failure, retry count, ordinal |
| `task_dependencies` | edges | cycle-checked on insert |
| `events` | structured log | never raw output |
| `executions` | one run of one task by one worker | status, exit code, cwd, log path, changed files, duration, usage, cancel flag, context snapshot |
| `artifacts` | files DEV produced or captured | log, diff, report, test-result, … ; an edit in the artifact zone appends a new row (`meta.rootId`, `meta.version`) and never overwrites the original file |
| `evidence` | why a task may be DONE | command-exit, verification, file-exists, human-approval, … |
| `decisions` | lightweight decision records | title, decision, reason, alternatives, tags, revisit |
| `approvals` | consequential-action requests | pending / approved / denied |
| `context_snapshots` | what a worker was sent | budget, used tokens, sections in/out/cut |
| `worker_health` | last probe per worker | ok, detail, version, checked at |

## Project lifecycle and hierarchy

`lifecycle` is one of ACTIVE (being worked on now), NEXT (queued), PLANNED (defined, not started), INCUBATOR (idea or research), PARKED (paused on purpose), MAINTENANCE (finished, kept running), ARCHIVED (kept for reference) and CLOSED (finished for good). Default views show ACTIVE and NEXT only; everything else stays searchable. `kind` is project, subproject, module, capability, workflow, idea, program or infrastructure. `parent_id` builds the tree (cycle-checked); `aliases` are alternative names used for matching and resolution; `path` is null until a project has a directory, and the runner refuses to execute tasks for such a project (it blocks them with `dependency-missing`). Lifecycle ARCHIVED/CLOSED also sets the legacy `status` to `archived`.

Migrations run with foreign keys switched off (schema v4 rebuilt the projects table; with `ON DELETE CASCADE` and foreign keys on, `DROP TABLE` would have deleted every task). `Db.migrate` checks `PRAGMA foreign_key_check` before committing.

## Task state machine

```
BACKLOG ─→ READY ─→ WORKING ─→ DONE
   │          │        │  └──→ REVIEW ─→ DONE
   │          │        └─────→ BLOCKED ─→ READY (retry)
   └──────────┴──────────────→ CANCELLED ─→ BACKLOG
DONE ─→ READY (reopen)
```

Rules enforced in `tasks.ts`:

- READY requires every dependency DONE (unless forced).
- DONE requires at least one passing evidence row (unless forced by an approval, which itself records human-approval evidence).
- When a task becomes DONE, dependents in BACKLOG whose dependencies are all DONE move to READY (`TASK_READY` event).
- BLOCKED carries a `failure` with `kind`, `reason`, `nextAction`, `executionId`. Retry clears it and bumps `retryCount`.

## Failure kinds

`process-failed`, `timeout`, `verification-failed`, `worker-unavailable`, `dependency-missing`, `approval-denied`, `launch-failed`, `cancelled`, `review-rejected`.

## Events

`PROJECT_*`, `TASK_CREATED/UPDATED/DELETED/STATUS_CHANGED/READY/STARTED/BLOCKED/COMPLETED/CANCELLED`, `WORKER_SELECTED`, `WORKER_HEALTH`, `CONTEXT_ASSEMBLED`, `COMMAND_STARTED/OUTPUT/FINISHED`, `FILE_CHANGED`, `VERIFICATION_STARTED/PASSED/FAILED`, `ARTIFACT_CREATED`, `EVIDENCE_RECORDED`, `REVIEW_REQUESTED`, `APPROVAL_REQUESTED/RESOLVED`, `DECISION_RECORDED`, `PLAN_PROPOSED/APPLIED`, `GIT_COMMIT`, `AUTO_RUN_STARTED/FINISHED`.

`COMMAND_OUTPUT` is transient: delivered to live listeners and SSE, written to the log artifact, never inserted.

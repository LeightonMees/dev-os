# Architecture

```
┌──────────────┐    ┌──────────────────┐    ┌──────────────────────┐
│  dev (CLI)   │    │  DEV desktop     │    │  any other client    │
│  apps/cli    │    │  apps/desktop    │    │  (curl, scripts)     │
└──────┬───────┘    └────────┬─────────┘    └──────────┬───────────┘
       │ in-process or HTTP  │ HTTP + SSE               │ HTTP
       ▼                     ▼                          ▼
┌───────────────────────────────────────────────────────────────────┐
│  control plane  apps/control-plane   (node:http, one process)     │
└───────────────────────────────┬───────────────────────────────────┘
                                ▼
┌───────────────────────────────────────────────────────────────────┐
│  core  packages/core                                              │
│  Dev facade → stores (projects, tasks, decisions, artifacts,       │
│  evidence, approvals, executions, context snapshots)              │
│  EventBus · WorkerRegistry · runner · autoRun · assembleContext   │
│  planGoal · doctor · git · NexusClient                            │
└───────────────────────────────┬───────────────────────────────────┘
                                ▼
                    .dev-home/dev.sqlite (WAL) + logs/
```

## Why this shape

- **One source of truth.** SQLite in WAL mode; the CLI can open it directly, the desktop goes through the control plane. When the control plane is running the CLI delegates `run` and `auto` to it, so live output appears in both places from one execution.
- **No microservices.** One Node process for the control plane, one Tauri process for the window. The Tauri side holds only what cannot live in Node: the PTY (ConPTY via `portable-pty`) and the "make sure the control plane is running" bootstrap.
- **Events, not chat.** Every meaningful step emits a typed event row. The desktop subscribes over SSE; the CLI can `--follow`. Raw worker output is transient (streamed, written to the log artifact, never stored as events).
- **Workers are adapters.** `Worker { id, type, capabilities, probe(), run() }`. Claude Code and Codex are driven headless with the prompt on stdin; Ollama over HTTP; shell through cmd.exe. Routing is deterministic and its reason is recorded on a `WORKER_SELECTED` event.
- **Nexus is the capability front door.** DEV keeps no catalogue. `NexusClient` speaks stdio JSON-RPC to the Nexus MCP server on demand (`find_capability`, `search`, `get_skill`). Selected capabilities are stored as small references on the task.

## Modules (packages/core/src)

| Module | Responsibility |
|---|---|
| `schemas.ts` | every persisted record type |
| `persistence/` | `Db` wrapper over `node:sqlite`, forward-only migrations |
| `events/bus.ts` | durable + transient events, listeners, listing |
| `projects.ts`, `tasks.ts`, `records.ts` | stores; `tasks.ts` owns the state machine and the graph |
| `workers/` | interface, registry/router, adapters |
| `workers/efforts.ts` | per-worker reasoning ladders, read from each CLI, with the source recorded |
| `workers/benchmarks.ts` | public benchmark evidence and the worker order it implies, weighted per benchmark |
| `execution/process.ts` | spawn with timeout, cancel, tree kill, bounded capture |
| `execution/runner.ts` | the lifecycle of one execution |
| `execution/auto.ts` | run runnable tasks in dependency order |
| `context/assemble.ts` | budgeted worker brief + section report |
| `verification.ts` | command / file-exists / manual |
| `plan.ts` | goal → bounded proposal → apply |
| `git.ts` | status, snapshot/changed files, diff, log, commit, branches, worktrees |
| `nexus/client.ts` | stdio MCP client |
| `doctor.ts` | environment checks with remediation |
| `dev.ts` | the facade that composes everything |

## Control plane API (selection)

`GET /health`, `GET /api/status`, `GET /api/doctor`, `GET|PATCH /api/config`
`GET|POST /api/projects`, `GET|PATCH|DELETE /api/projects/:id`, `/git`, `/git/diff`, `/git/log`, `/git/commit`, `/decisions`, `POST /auto`, `POST /auto/stop`
`GET|POST /api/tasks`, `GET|PATCH|DELETE /api/tasks/:id`, `/status`, `/run`, `/retry`, `/cancel`, `/approve`, `/reject`, `/deps`, `/context`, `/log`
`GET /api/executions`, `GET /api/workers`, `POST /api/workers/:id/check`, `GET /api/resources/search?q=`, `GET /api/artifacts`, `/content`, `/raw`, `/versions`, `POST /api/artifacts/:id/revise`, `GET /api/approvals`, `POST /api/plan`, `POST /api/plan/apply`
`GET /api/events`, `GET /api/events/stream` (SSE)

## Desktop

React 19 + Vite; a single store (`lib/store.tsx`) that loads through the typed `Api` client and refreshes on SSE events. Views are thin; state lives in the control plane.

Workbench layout (see `docs/DESIGN.md`): activity bar → contextual sidebar → workspace (+ optional inspector) → bottom panel (Activity, Output, Checks, Problems) → status bar. Panes resize through `Split` and remember their size. `Ctrl+1..8` switch sections, `Ctrl+K` opens the command palette (only actions that can run now), `Ctrl+J` / `Ctrl+B` toggle the panel and sidebar. The Work section renders the same tasks as a board, a list or a layered dependency graph (`lib/graph.ts`).

`src-tauri/src/lib.rs` exposes `pty_spawn/write/resize/kill/kill_all/list`, `control_plane_ensure` and `open_in_file_manager`. PTY sessions are ConPTY through `portable-pty`; input is serialised through one writer thread per session, and sessions are always dropped outside the registry lock (closing a ConPTY blocks until its reader drains).

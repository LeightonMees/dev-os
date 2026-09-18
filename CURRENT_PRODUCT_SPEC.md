# DEV V1 — current product spec

Derived from the rebuild brief (2026-09-16) and what the code verifiably does. When this file and the code disagree, fix one of them.

## Principle

DEV knows how to develop; it does not know in advance what will be developed. Project-, domain-, model-, provider- and tool-agnostic. Small enough to understand.

## Must (all implemented)

1. Desktop app launches (Tauri 2 + React 19); CLI works; both share `.dev-home/dev.sqlite` through one control plane.
2. Projects: add/open/status/list/remove; goal, summary, milestone, config; git state.
3. Tasks: fields per `schemas.ts`; statuses BACKLOG/READY/WORKING/BLOCKED/REVIEW/DONE/CANCELLED; dependency graph with cycle rejection, gating and automatic promotion.
4. Capability discovery through Nexus (`find_capability`) at plan time and on demand (`dev resources search`, Resources view). Selected capabilities stored as references on tasks.
5. Workers: Claude Code, Codex, Ollama, shell behind one interface; probes recorded; deterministic routing with a recorded reason.
6. Execution: timeout, cancellation (in-process and cross-process), live output, changed-file capture, log/diff/report artifacts, verification (command, file-exists, manual), evidence, structured failure → BLOCKED with next action.
7. Auto-run over the graph: runnable tasks in dependency order, upstream summaries in the brief.
8. Context assembly with a token budget, section report, snapshot per execution, preview in CLI and desktop.
9. Goal → bounded plan (≤ `planning.maxTasks`, default 6) → confirm → tasks with dependencies; plan recorded as a decision.
10. Events: typed, durable, streamed (SSE); desktop updates from events.
11. Git: status, diff, log, branches, checkout, commit (CLI + desktop).
12. Integrated terminal: real ConPTY sessions in the project directory, multiple tabs.
13. `dev doctor`: home, database, node, git, every worker, Nexus, shell, projects, cargo, WebView2, control plane.
14. Settings: every config key editable in the app and via `dev config set`.
15. Tests: core, CLI, control plane, desktop components, integration loop.

## Must not

Fabricate state, show controls that do nothing, store secrets, send the backlog to a worker, generate large speculative backlogs.

## Deferred

See `ROADMAP.md`.

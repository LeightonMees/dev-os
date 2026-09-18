# Product

DEV is a general development operating system that runs on one machine. It is project-, domain-, model-, provider- and tool-agnostic. It orchestrates the tools you already have (git, coding agents, a local model, Nexus) instead of re-implementing them.

## The loop

| Stage | What DEV does |
|---|---|
| Goal | `dev plan "<goal>"` or the Plan dialog. DEV inspects the repository map, asks Nexus for relevant capabilities, and has one planning worker propose at most a handful of tasks for the next milestone. Nothing is saved until you confirm. |
| Tasks | Title, desired outcome, requirements, acceptance criteria, verification, files, dependencies. |
| Graph | Dependencies gate READY. When a task finishes, dependents whose dependencies are all DONE are promoted automatically. |
| Worker | Deterministic routing: a task with a command runs on the shell worker; an explicit worker wins; otherwise project default, then preference order, first healthy worker with the needed capability. |
| Execute | Timeout, cancellation, live output, changed-file capture, log artifact. |
| Verify | Project-wide and task-level verification: commands (exit 0), file-exists, manual review. |
| Evidence | Command exit, verification results, human approval. DONE requires passing evidence. |
| Report | Concise result summary on the task; raw output stays in artifacts. |

## Task states

`BACKLOG → READY → WORKING → DONE`, with `BLOCKED` (structured failure with a next action), `REVIEW` (waiting for a human) and `CANCELLED`.

## Token discipline

Workers never receive the backlog or history. Each brief contains: the task, upstream task outcomes, a short project summary, relevant decisions, the task's files, a two-level repository map, a few recent outcomes and the selected capabilities, in that priority, cut to a configurable token budget. Every execution records which sections were sent and how many tokens they cost. `dev task context <id>` and the Context tab show the exact prompt before it goes out. Long worker output is condensed by the local Ollama model when available.

## Automation layer

`dev auto` (or "Run all ready" in the app) executes runnable tasks one after another in dependency order. Each task's brief includes the result summaries of the tasks it depends on, so agents pick up each other's work through DEV's structured state rather than through chat.

## Interfaces

- CLI: tables, status symbols, readable errors, `--json` everywhere.
- Desktop: Home, Project workspace (board + activity + live output + inspector), Tasks, Workers, Terminal (real PTY), Artifacts, Resources (Nexus), Git, Settings.

## Deliberately not in V1

Marketplace, multi-user, billing, ML routing, cloud compute, workflow designer, voice, VR, robotics, training lab, domain packs, autonomous multi-day operation, resource crawler. See `ROADMAP.md`.

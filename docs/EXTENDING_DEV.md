# Extending DEV

## Add a worker

1. Implement `Worker` from `packages/core/src/workers/types.ts`: `id`, `name`, `type`, `capabilities`, `configRef`, `probe()`, `run(request)`.
2. `run` must honour `request.signal` and `request.timeoutMs`, call `request.onOutput` for live output, and return a `WorkerRunResult` with an honest `ok`, `exitCode`, `summary`, `commandLine`.
3. Register it in `buildWorkers()` (`workers/registry.ts`) and add its configuration to `DevConfig` (`config.ts`).
4. `dev worker doctor` must show it; the desktop Workers view picks it up automatically.

Use `launchSpec()` from `execution/process.ts` when driving a CLI so `.cmd` shims on Windows work without shell quoting problems.

## Add a verification kind

Extend `VerificationSpec.kind` in `schemas.ts` and handle it in `verification.ts`. Return `passed`, a one-line `summary` and small `data`; large output goes to an artifact by the runner.

## Add an event type

Append to `EVENT_TYPES` in `events/bus.ts` (and `EVENT_TYPES` in the desktop `lib/api.ts` so SSE listeners receive it). Describe it in the desktop's `describeEvent` for a readable feed line.

## Add a CLI command

Create a function in `apps/cli/src/commands/`, wire it in `main.ts`, add it to `HELP`. Support `--json`. Throw `UsageError` for user mistakes (exit 1), anything else exits 2.

## Add a control-plane route

`add(method, path, handler)` in `apps/control-plane/src/server.ts`. Handlers return JSON; throw `HttpError(status, message)` for client errors.

## Add a desktop view

Add a `Section` in `lib/store.tsx`, a view in `views/`, a case in `App.tsx`. Read through `useStore().api`; do not keep separate copies of task or project state.

## Capability discovery

`dev.nexus.findCapability(need)` returns ranked matches; `toCapabilityRefs()` reduces them to small references you can store on a task. Do not copy Nexus catalogues into DEV.

## Extension points intentionally left open

- Worker routing: outcomes are recorded per execution (`executions.worker_id`, duration, status); a smarter router can read them later.
- Approvals: `ApprovalStore` exists with a pending/approved/denied lifecycle; wire an action to it when it needs a gate.
- Branch/worktree isolation: `git.ts` has `worktreeAdd/Remove`; the runner currently works in place.

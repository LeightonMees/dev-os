# Contributing to DEV

Thanks for looking. This is a small project with strong opinions about how it is built; the rules
below are the ones that actually get enforced in review.

## Getting set up

```bash
git clone <your fork>
cd DEV
npm install
npm test            # core, CLI, control plane, integration
npm run test:desktop
```

Node 24+ is required: the core, CLI and control plane run TypeScript sources directly with no build
step. The desktop app is Vite + React inside Tauri 2, so building *that* needs the Rust toolchain and
your platform's webview dependencies (see [Tauri's prerequisites](https://tauri.app/start/prerequisites/)).

You do not need the desktop app to work on the core, the CLI or the control plane.

## Before you open a pull request

```bash
npm run check   # lint, typecheck, all tests, desktop tests
```

`npm run check` must pass. If it does not pass on your machine for a reason unrelated to your change,
say so in the PR rather than working around it.

## House rules

These are the things most likely to get a change sent back.

**Never fabricate state, controls, metrics or results.** A button that cannot do anything is either
removed or disabled with a reason the user can read. A number shown in the UI must come from a real
measurement. This is the single most important rule in the project: DEV is a tool for supervising
automated work, and it is worthless if its display cannot be trusted.

**Small, verified slices.** A pull request should do one thing and arrive with tests that would fail
without it. Prefer several small PRs over one large one.

**Tests must be able to fail.** A test that asserts what the code happens to do, rather than what it
should do, is worse than no test. Where a bug is fixed, the test should reproduce the bug first.

**Keep prose out of records.** Database rows hold facts. Long output belongs in an artifact on disk.

**No secrets in the repository.** Local state lives in `.dev-home/`, which is ignored.

**Workers get bounded context.** Context reaches a worker through `assembleContext` and its budget —
never the whole backlog, never the whole history.

## Architecture in one paragraph

`packages/core` owns everything that matters: the data model, the task state machine, execution,
workers, context assembly. `apps/control-plane` is an HTTP and SSE wrapper around a single core
instance so several clients can watch the same state. `apps/cli` and `apps/desktop` are clients. If
you find yourself putting logic in a client that another client would also need, it belongs in core.

Read `docs/ARCHITECTURE.md` before any substantial change.

## Adding an AI provider

Most providers speak the OpenAI chat-completions shape, and DEV's API worker already handles that
family. Adding one is usually a single entry in `DEFAULT_API_PROVIDERS` in
`packages/core/src/workers/api.ts`: an id, a base URL, a default model, and the environment variable
its key is read from. Providers ship disabled or keyless-inert — nothing runs without a key.

A provider that does not speak that shape needs its own worker implementing the `Worker` interface in
`packages/core/src/workers/types.ts`. Look at `ollama.ts` for a compact example.

Please do not add a provider you have not actually run a task against, and say in the PR which model
you tested with.

## Commit messages

Conventional-commit prefixes (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`) with a scope where it
helps: `fix(desktop): …`. The body should say why, not restate the diff.

## Reporting bugs

Include what you ran, what happened, what you expected, your OS and Node version, and the relevant
artifact or log from `.dev-home/` if there is one. A failing test is the best possible bug report.

Security issues go through the private process in [SECURITY.md](SECURITY.md), not the issue tracker.

## Licence

By contributing you agree that your contribution is licensed under the Apache License 2.0, the same
licence as the project.

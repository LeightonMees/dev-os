# Development

## Setup

```powershell
npm install
dev doctor
```

Node 24+ runs the TypeScript sources directly (no build for core, CLI, control plane). The desktop app is built by Vite; the Rust side by Cargo (`CARGO_TARGET_DIR` is honoured; on this machine it points at `F:\devcache\cargo-target`).

## Run

| What | Command |
|---|---|
| CLI | `node apps/cli/bin/dev.mjs …` or `dev …` after `npm link` |
| control plane | `dev control-plane start` (detached) · `--foreground` to see logs |
| first run | `dev welcome` seeds the guide project; the control plane seeds it automatically on an empty database |
| desktop, dev mode | `dev ui` (starts the control plane, then `tauri dev`; first compile takes minutes) |
| desktop, release | `npm run desktop:build`, then `dev ui` launches the exe |

The launcher prefers the release exe, so **a change is invisible until `npm run desktop:build` runs again** — a stale exe looks exactly like a missing feature.

`dragDropEnabled` is `false` on the main window in `tauri.conf.json`. Tauri defaults it to true, and on Windows the WebView2 file-drop handler then swallows HTML5 drag events, which kills card dragging on the board. jsdom has no such handler, so the tests pass either way: do not turn it back on.

## Test

```powershell
npm test               # packages/core, apps/cli, apps/control-plane, tests/ (node --test)
npm run test:desktop   # vitest + testing-library (jsdom)
npm run typecheck
npm run lint
npm run check          # everything
```

Tests create their state under `F:\tmp\dev-tests` when that drive exists (this machine's disk rule) or the OS temp dir otherwise. They never touch `.dev-home`.

## Conventions

- Small logical commits; conventional prefixes (`feat`, `fix`, `docs`, `chore`).
- `erasableSyntaxOnly`: no parameter properties, no enums; the sources must run untranspiled.
- Prose stays out of records. Anything large is an artifact on disk with a row pointing at it.
- No fake controls. A button that cannot work is not rendered, or is disabled with a reason.
- Never store secrets; workers read their own credentials from their own configuration.

## Adding a migration

Append to `packages/core/src/persistence/migrations.ts` with the next version number. Never edit a shipped migration.

## Configuration scopes

Four scopes merge over `DEFAULT_CONFIG`, later winning: global (`<DEV_HOME>/config.json`),
project (`<repo>/.dev/config.json`, may be committed), session and task. Each file carries a
`version` integer; a missing version means 1 and a newer one is refused by name. Unknown keys
and wrong types are dropped with a readable error rather than merged.

The restricted keys listed in `docs/adr/0001-config-scopes.md` (`privacy.mode`, `secrets.files`,
`approvals.requireForCommit`, `workers.timeoutMs`, `chat.maxToolCalls`, `nexus.enabled`,
`projects.defaultDir`) may be tightened by project, session and task, never loosened: a loosening
value is refused, the inherited value stands, and the refusal names the file, the key and the value.

`resolveConfigFor({ home, projectDir, session, task })` returns the effective config, the scope
that supplied each key, the refusals and the validation errors.

## Where state lives

`.dev-home/` (gitignored): `config.json`, `dev.sqlite`, `logs/<execution>.log|.diff|.summary.md|.verify-N.log`, `control-plane.json` (lock file of the running control plane).

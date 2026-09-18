# ADR 0001: Configuration file layout and scope precedence

- Status: accepted
- Date: 2026-09-17
- Milestone: Settings A (schema + storage)

## Context

Today DEV has exactly one configuration file. `packages/core/src/config.ts` resolves
`config.json` inside the DEV home (`.dev-home/`, or `DEV_HOME`), deep-merges it over
`DEFAULT_CONFIG`, and writes it back whole. There is no file version, no per-project
override, and nothing a task or session can set for the duration of a run.

That is not enough for V1. A project on a client repository needs its own worker
preferences and context budget without the user editing a global file each time they
switch; a single run needs to pin a worker or raise a timeout without leaving that
setting behind; and some settings — the ones that keep work local and keep commits under
human control — must not be quietly weakened by a file that arrives with a cloned
repository.

A `.dev/config.json` committed to a repository is untrusted input. Whoever cloned the
repository did not necessarily read it. A merge that lets it turn privacy off, or point
secrets at a new file, is a way to exfiltrate work from a machine that believed it was
running locally.

## Decision

### One versioned file per scope

There are four scopes. Two are files; two are in-memory.

| Scope | Where | Persisted |
| --- | --- | --- |
| global | `<DEV_HOME>/config.json` (default `.dev-home/config.json`) | yes |
| project | `<repo>/.dev/config.json` | yes, and may be committed |
| session | the running control plane, set by `dev config set --session` or the Settings view | no |
| task | the task record's `configOverrides` field | with the task record |

Each persisted file is a JSON object with a `version` integer at the top level and
configuration keys beside it. `version` is the schema version of the file, not of DEV.
A file with an unknown (higher) version is an error, not a best-effort parse: DEV refuses
to load it and says which file and which version. Missing `version` means version 0: the
pre-ADR-0001 shape, which the migrations walk up to the current version on load, so
existing `.dev-home/config.json` files keep working.

Upgrades run through the ordered list in `packages/core/src/config/migrations.ts`. Each
entry takes a file at version `n` and returns it at `n + 1`; a shipped migration is never
edited, only followed by a new one. `inspectConfigFile` reports what a file is without
writing anything (`absent`, `current`, `migrated`, `future`, `unsupported`, `unreadable`),
`readConfigFile` returns the migrated patch, and a file DEV cannot understand — a version
from a later build, a gap with no migration, unreadable JSON — is left exactly as written:
both `writeConfigFile` and `saveConfig` refuse to overwrite one.

A value inside a readable file is a different matter: a wrong type, an out-of-range
number or an unknown enum member never stops DEV from starting. The key is dropped, its
default stands, and the problem is recorded as a config warning that `dev doctor` shows
under `config`. Keys this build has no field for are kept as written — so a file survives
a load/save round trip across versions — and reported the same way.

Only keys the writer meant to change appear in a file. A scope file is a patch, never a
full snapshot of the effective config. `saveConfig` for the global scope may continue to
write the full object, since the global file is the one the defaults are for; project,
session and task layers are always sparse.

### Merge order

```
DEFAULT_CONFIG  →  global  →  project  →  session  →  task
```

Later wins. The merge is the existing `deepMerge`: plain objects merge key by key,
everything else — including arrays such as `workers.preferences` and `secrets.files` —
is replaced wholesale by the later scope. Arrays are replaced rather than concatenated
because a preference order that silently grows is not a preference order.

The effective config is computed once per task run and recorded with the run, so a
record shows the configuration it actually executed under.

### Restricted keys

A restricted key may be **tightened** by a lower-precedence scope but never **loosened**.
"Lower-precedence" here means project, session and task; global is the user's own machine
and may set any value. If a lower scope tries to loosen a restricted key, the value is
ignored, the effective value stays as it was, and DEV emits a warning naming the file,
the key, and the value that was refused. It is not a silent drop and it is not a fatal
error.

The restricted keys are:

| Key | Tightening direction | Why |
| --- | --- | --- |
| `privacy.mode` | `LOCAL_ONLY` is the tightest; a lower scope may move toward it, never away | a cloned repository must not be able to turn on remote calls |
| `secrets.files` | may be narrowed to a subset of the inherited list; new paths are refused | a repository must not be able to point DEV at a new secret file, or at one it also reads |
| `approvals.requireForCommit` | `false → true` allowed; `true → false` refused | human approval of commits is the user's setting, not the repository's |
| `workers.timeoutMs` | may be lowered; raising above the inherited value is refused | bounds an unattended run |
| `chat.maxToolCalls` | may be lowered only | bounds an unattended run |
| `nexus.enabled` | `true → false` allowed; `false → true` refused | enabling an external tool server is the user's decision |
| `projects.defaultDir` | global scope only; lower scopes are refused outright | governs where DEV writes on disk |

`privacy.mode` does not exist in `DevConfig` yet. This ADR fixes its name, its position
in the schema, and its rule; the key itself lands with the Settings A schema work, with
`LOCAL_ONLY` as the tightest value and the ordering declared in one place alongside the
restriction table so the two cannot drift.

Every other key is freely overridable by every scope.

## Alternatives considered

**Keep one global file.** Simplest, and it is what exists. Rejected: per-project worker
preferences and context budgets are in the V1 spec, and a user who works across several
repositories would be editing the global file on every switch.

**Cascading files without a restricted set.** A plain last-wins merge across all four
scopes. Rejected: it makes `.dev/config.json` a remote-code-adjacent capability. A cloned
repository could disable commit approval and redirect `secrets.files` before the user
read a line of it.

**Restricted keys as hard errors.** Refuse to run when a project file tries to loosen
one. Rejected: it makes a clone of a repository written for a more permissive machine
unusable, and the honest outcome — run under the tighter value, and say so — is available.

**Per-domain files** (`workers.json`, `context.json`, …). Rejected: more files to find,
more merge surfaces, and no benefit at V1's key count.

**Environment variables as a scope.** Rejected for now. `DEV_HOME` stays the one
environment input; a general `DEV_CONFIG_*` layer can be added later as a scope between
global and project without changing anything here.

## Consequences

- `loadConfig(home)` gains a sibling that resolves all four layers and returns the
  effective config plus the list of refusals. The single-file loader stays for the global
  file itself.
- `.dev/config.json` is a new thing repositories may contain. It needs documenting in
  `docs/DEVELOPMENT.md` and a mention in `README.md`.
- The Settings view has to show, per key, which scope supplied the current value, and
  must disable editing of a restricted key it cannot loosen — with the reason visible,
  per the project rule that a control which cannot work is disabled with a reason.
- `dev config set` needs a scope flag (`--global`, default; `--project`, `--session`).
  Setting a restricted key at a scope that may not loosen it fails at the CLI with the
  reason, rather than writing a file whose value is then ignored.
- Refusals are worth surfacing as events on the bus, so an unattended run's record shows
  that a project file asked for something it did not get.
- Version 1 is the current shape. Any future incompatible change to the file layout bumps
  `CONFIG_SCHEMA_VERSION` and appends one migration; files are upgraded in memory on load
  and the new version is written the next time the file is saved.

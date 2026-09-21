# Changelog

All notable changes to DEV are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Repeat arrows in flows.** An arrow marked *repeat* may point back at an earlier step; following
  it re-runs that step and everything after it, up to a limit (default 10), after which the run
  carries on past it. Ordinary arrows must still form a DAG, and the editor says which arrow closes a
  cycle. With conditions and "Ask me" steps this completes the flow editor's first version.
- The first-run guide ends with a step on the three safety settings (worktree isolation, gated
  commands, gated pushes/commits), so a new user decides how much to trust autopilot before using it.

### Fixed
- A project without a directory shows "no repository yet" in the Git view instead of an empty status
  table, and the Editor no longer requests its files.

## [0.2.0] - 2026-09-21

One day after 0.1.0, driven by running DEV the way a stranger would and fixing what that surfaced,
plus the safety features autopilot needed before it could be trusted unattended.

### Added
- **Worktree isolation** (`git.isolation: worktree`, per project or global). Each run gets its own git
  worktree on a branch named `dev/<task>`; what changed is committed there and the worktree removed,
  so a worker can never leave your checkout half-edited. The safe setting for autopilot. Plain
  directories fall back to running in place and say so in the log.
- `dev artifacts` lists every file runs produced, filterable by task and kind; `dev artifacts show <id>`
  gives the path and details.
- **Gated commands** (`approvals.gatedCommands`, default `git push`, `npm publish`, `docker push`,
  `terraform apply`, `kubectl apply`, `rm -rf`). A shell task whose command contains one of these
  waits in Attention before running; approve to run it as written, deny to block the task with your
  reason. Autopilot stops at the machine's edge instead of crossing it.
- **Push, gated by default** (`approvals.requireForPush`, on unless the global settings turn it off; a project can demand it, never waive it). Push in the
  Git view or from a run files an approval; approving it performs the push. `dev git push` at a
  terminal is the person acting and pushes directly. A branch with no upstream is pushed to `origin`
  and set to track it.
- **Approval gate on commits** (`approvals.requireForCommit`). Commit in the Git view files an approval
  instead of committing; approving it performs the commit with that message, denying it drops it.
  Nothing is half-done in between.
- `dev auto --all` runs every active project in turn, one worker at a time, and reports per project.
- **Codex output is structured.** `codex exec --json` events are parsed: the agent's final message is
  the summary, commands it ran show as commands with their output, token usage is recorded, and a
  turn Codex reports as failed fails the task with Codex's own message (for example, a model the
  account cannot use) instead of a buried line of text.
- **Routing learns from this machine.** With no preference stated, a worker that has finished
  its runs here is tried before one a public benchmark merely recommends: success rate first, then
  speed, after at least three finished runs. The routing reason says so in plain words.
- `dev flow list|show|run|runs` runs flows drawn in the app headless, printing each step as it
  finishes, so a flow can live in a script or a scheduler. `dev flow export` / `import` move a flow
  as a JSON file with no ids in it, so flows can be kept in a repository and shared.
- `dev approvals approve|deny <id> [note]` — the words after the id are the answer, so a flow's
  question or a gated commit can be settled from the terminal.
- **Human steps in flows.** A `human` node asks the person a question; the run waits in Attention
  until they answer, and the answer is the step's output for later steps. Declining fails the step.
- **A 3D viewport for GLB/GLTF artifacts**: orbit, zoom and pan, framed to the model's bounds, with mesh
  and triangle counts read from the loaded scene. Where WebGL is missing it says so instead of showing
  a black box.

### Fixed
- The default Nexus configuration pointed at a path on the maintainer's machine. It is now empty, and
  DEV says "Nexus is not set up on this machine" with the exact setting to change, instead of
  spawning `node` with no script and reporting "Nexus exited (0)".
- Nexus-backed endpoints answer 503 rather than 500 when Nexus is absent: unavailable, not broken.
- Path placeholders in the project dialogs no longer show the maintainer's drive.
- `dev project new` on a fresh machine failed with "Parent directory does not exist" because the
  default project directory had never been created. It is created now; OneDrive is still refused.
- Two in-place runs in one checkout now say so in their logs: changed files are read from the tree,
  so each would otherwise claim the other's edits as its own.
- `runnable()` no longer stops at the first 500 READY tasks; a large queue could leave work that never
  ran and never said why.

## [0.1.0] - 2026-09-21

First public release. Version numbers start at 0.1.0 to say what the software is: used daily,
tested, and still moving.

### Added
- **Autopilot actually promotes Backlog.** It used to toast “started” and exit if nothing was
  already Ready, or if the first 500 Backlog tickets could not start. It now scans the whole
  Backlog, skips tickets that need you or have unmet deps, emits `AUTO_RUN_STARTED` /
  `AUTO_RUN_FINISHED`, and says so when there is nothing to run. CLI: `dev auto --promote-backlog`.
- **The brief is editable.** The composer showed the assembled prompt read-only, so you could see a
  brief was wrong and had no way to correct it except by changing the inputs and hoping. A task now
  carries `promptOverride`: edit the brief, save, and that exact text is what the worker receives,
  with assembly skipped and the run log saying so. "Reset to assembled" clears it. The section
  breakdown still shows what DEV *would* have sent, so an override stays reviewable.

### Changed
- **Coding agents get two hours, not 30 minutes.** `workers.timeoutMs` (default 30 minutes) now
  applies to shell commands. Agents use `workers.agentTimeoutMs` (default 2 hours). A retry after a
  timeout doubles the cap once, up to 4 hours. The board shows “exceeded 30 minutes” and the next
  action, not `1800s`. Settings labels these in minutes.
- **Attached files are excerpted by relevance to the task, not by position in the file.** Head
  truncation assumed the useful part of a document sits at the top. That holds for a source file and
  fails for the reference documents planners actually attach. Files are now split on markdown
  headings, each section scored on how much of the task's own vocabulary it uses, and the best kept
  in document order until the budget is spent. The opening section is always kept, and every gap is
  marked so a worker knows it holds an excerpt rather than a whole file. Measured on the real
  16,953-character MASTER PLAN: the section carrying the priority order survives, in **609 tokens
  instead of 2,000**. The scoring is lexical, not semantic — it keeps sections that share wording
  with the task, which is a heuristic and not comprehension.
- **The planner is told what `files` costs.** It was shown `files: ["relative/path/to/file"]` with no
  explanation of the field, so it listed background reading and every entry was pasted into the
  worker's brief in full. It now reads: the files the task will actually create or edit, never
  things it merely refers to.
- **One document can no longer own a whole brief.** `context.maxFileTokens` drops from 2,000 to 600.
  Measured on 2026-09-18: a task whose entire job was "decide the next milestone for Agency" shipped
  ~3,199 tokens, of which ~2,000 were the first 8,000 characters of a 17,160-character MASTER PLAN —
  62% of the brief, to answer a question the one-line decisions section had already answered.
- **The project switcher only appears where a project is the subject.** It rendered on all nine
  sections, which put a project picker on Settings, Workers and Resources — none of which read the
  current project at all — and a second, redundant one on Overview, whose whole body is already a
  searchable project list.

- **First run seeds a guide instead of an empty board.** A new installation gets a real project,
  "Getting started with DEV", whose tasks are the setup steps — with dependencies, so the guide also
  demonstrates how work unlocks. It names no AI provider as required; a local model, a CLI agent, a
  hosted key and no AI at all are presented as equally valid. `dev welcome` creates it on demand and
  is idempotent.
- **Anthropic as a first-class API provider**, via its OpenAI-compatible endpoint. Ships disabled,
  like every paid provider.
- **The artifact zone renders what a run actually produced**: HTML and SVG in a sandboxed frame,
  images, PDFs and Markdown, with a source editor beside the preview and a pan/zoom canvas of every
  drawable artifact. Editing saves a new version and never overwrites the original file, so evidence
  citing an execution keeps pointing at what ran.
- Open-source release scaffolding: Apache-2.0 licence, security policy, contributing guide, code of
  conduct, issue and pull-request templates, and CI on Windows and Linux.
- `scripts/prepare-release.mjs` builds a publishable copy with a fresh history and refuses to
  proceed if anything private or secret-shaped is found in it.

### Fixed
- **`Origin: null` could drive the control plane.** Sandboxed iframes send that origin; the CSRF
  check skipped it. It is now refused like any other untrusted origin.
- **The control plane could be driven by any web page you had open.** It answered with
  `Access-Control-Allow-Origin: *` and no authentication, so a page in your browser could reach
  loopback and create or run tasks on your machine. It now refuses any request carrying a browser
  origin that is not DEV's own window, and any request whose `Host` is not loopback, which also
  closes DNS rebinding. Local clients such as the CLI send no origin and are unaffected.
- **Card dragging did not work in the desktop app.** Tauri enables an OS-level file-drop handler by
  default, and on Windows it swallows HTML5 drag events. Disabled on the main window.
- On a cold start the app fetched tasks for the project id remembered in browser storage before
  checking it still existed, producing failed requests after a project was deleted or `DEV_HOME`
  changed.
- The Markdown preview's code-fence parser never advanced its cursor and could exhaust memory on a
  fenced block.

[Unreleased]: https://github.com/LeightonMees/dev-os/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/LeightonMees/dev-os/releases/tag/v0.2.0
[0.1.0]: https://github.com/LeightonMees/dev-os/releases/tag/v0.1.0

# CLI

`dev --help` and `dev <command> --help` are the source of truth. Highlights:

```
dev doctor                                   environment checks with remediation
dev status                                   projects, running, blocked, review, workers

dev project list [--all] [--lifecycle active,next,planned] | add <path> | new <name> [--template node|python] [--dir ..]
dev project status [id] | set <field> <value> | remove <id> --yes
             fields: goal summary milestone name path lifecycle kind priority parent aliases
                     defaultWorker reviewRequired verification status

dev task list [--status ready,blocked] [--all]
dev task add "<title>" [--outcome ..] [--req ..] [--accept ..] [--command ..]
             [--verify "<cmd>"] [--verify-file <path>] [--manual-review]
             [--depends <id,id>] [--file <path>] [--worker <id>] [--effort low|medium|high]
             [--reasoning minimal|low|medium|high|xhigh|max] [--backlog]
dev task show <id> | context <id> [--full] | log <id> [--tail n]
dev task run <id> [--worker <id>] [--timeout <s>] [--force]
dev task retry <id> | cancel <id> | move <id> <status> | approve <id> | reject <id> --reason ..
dev task dep <id> <dependsOnId> | undep <id> <dependsOnId> | edit <id> --flag .. | rm <id> --yes

dev plan "<goal>" [--max 6] [--worker claude-code|codex|ollama] [--yes]
dev auto [--max n] [--worker <id>] [--stop-on-failure] [--detach]

dev workers | dev worker doctor [id]
dev resources search "<need>" | dev resources status

dev events [--follow] [--task <id>] [--type A,B]
dev artifacts [<taskId>] [--kind diff|log|report|test-result] [--json]   files runs produced
dev artifacts show <id>                                                path, size, task, version
dev flow list | show <id|name> | run <id|name> | runs <id|name>        flows drawn in the app, run headless
dev flow export <id|name> > flow.json | import flow.json [--name]      flows as files, fit for a repository
dev git status | diff [--stat] | log | branch [name] | commit "<msg>" [--task <id>]
dev decision list | add "<title>" --reason .. --tags a,b
dev approvals [approve|deny <id>]
dev approvals approve|deny <id> [note or answer]                        the words after the id travel with the decision

dev config [get key] | set <key> <value> | path | init
dev control-plane [status|start|stop]
dev ui
dev version
```

Global flags: `--json` (machine-readable, also for errors), `--project <id|name|path>`, `--home <dir>` (or `DEV_HOME`), `--help`.

`dev project list` shows ACTIVE, NEXT and MAINTENANCE projects as a tree (children indented under their parent). `--all` includes PLANNED, INCUBATOR, PARKED, ARCHIVED and CLOSED ones; `--lifecycle` filters explicitly. A project may have no directory yet (`no repository yet`): it can hold planning tasks, but nothing runs in it until `dev project set path <dir>` or `dev project new`. Project references accept an id, name, alias or path.

Task ids accept a unique prefix or the task's `#` number inside the current project. The current project is inferred from the working directory when it lies inside a registered project.

Exit codes: 0 success, 1 usage error, 2 failure (including a task that ended BLOCKED).

Repeat a flag for several values (`--req a --req b`). Only `--depends`, `--after`, `--tags`, `--status`, `--type` and `--file` split on commas.

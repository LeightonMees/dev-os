import { parseArgs, UsageError } from "./args.ts";
import { openContext, type CliContext } from "./context.ts";
import { planCommand } from "./commands/plan.ts";
import { projectCommand } from "./commands/project.ts";
import { autoCommand } from "./commands/run.ts";
import { flowCommand } from "./commands/flow.ts";
import { approvalsCommand, chatCommand, configCommand, controlPlaneCommand, decisionCommand, artifactsCommand, doctorCommand, eventsCommand, welcomeCommand, gitCommand, keysCommand, resourcesCommand, statusCommand, uiCommand, versionCommand, workersCommand } from "./commands/system.ts";
import { taskCommand } from "./commands/task.ts";
import { c, eprintln, println } from "./output.ts";

const HELP = `${c.bold("dev")} — DEV, a local development operating system

${c.dim("USAGE")}
  dev <command> [subcommand] [args] [--json] [--project <id|name>] [--home <dir>]

${c.dim("GETTING STARTED")}
  dev welcome                      set DEV up, as tasks you can work through (any AI, or none)
  dev doctor                       check database, git, node, workers, Nexus, shell
  dev project new <name>           create a project directory (--template node|python) and register it
  dev project add <path>           register an existing directory (defaults to the current directory)
  dev chat "<message>"             talk to DEV: it plans, creates tasks and launches work
  dev task add "<title>"           create a task (--command, --verify, --depends, --req, --accept)
  dev plan "<goal>"                goal → bounded plan → tasks (asks before persisting)
  dev task run <id>                execute one task with a real worker
  dev auto [--all] [--parallel n]  run every runnable task in dependency order (--promote-backlog); --all: every project; --parallel needs worktree isolation
  dev ui                           launch the desktop app (starts the control plane)

${c.dim("PROJECTS")}
  dev project list | new <name> | add <path> | status [id] | set <field> <value> | remove <id> --yes

${c.dim("TASKS")}
  dev task list [--status ready,blocked] [--all]
  dev task show <id> | context <id> [--full] | log <id> [--tail 50]
  dev task run <id> [--worker <id>] [--timeout <s>] [--force]
  dev task retry <id> | cancel <id> | move <id> <status> | approve <id> | reject <id> --reason ..
  dev task dep <id> <dependsOnId> | undep <id> <dependsOnId> | edit <id> --flag .. | rm <id> --yes

${c.dim("WORKERS & RESOURCES")}
  dev workers                      real workers on this machine with health and stats
  dev worker doctor [id]           probe workers now
  dev resources search "<need>"    ask Nexus for relevant skills, MCPs, APIs, workflows
  dev resources status | workflows
  dev keys                         which provider API keys are available (from Nexus secrets.env)

${c.dim("STATE")}
  dev status                       everything at a glance
  dev events [--follow] [--task <id>] [--type A,B]
  dev artifacts [<taskId>] [--kind diff|log|report|test-result]   files runs produced; dev artifacts show <id>
  dev flow list|show|run|runs <id|name>   flows drawn in the app, run headless from here
  dev git status|diff|log|branch [name]|commit "<msg>" [--task <id>]
  dev decision list | add "<title>" --reason .. --tags a,b
  dev approvals [approve|deny <id> [note]]

${c.dim("SYSTEM")}
  dev config [get key] | set <key> <value> | path | init
  dev control-plane [status|start|stop]
  dev version

${c.dim("FLAGS")}
  --json       machine-readable output        --project <ref>   choose the project explicitly
  --home <dir> state directory (DEV_HOME)     --help            help for any command
`;

const SUB_HELP: Record<string, string> = {
  task: `dev task <command>

  list [--status a,b] [--all]      tasks in the current project
  add "<title>" [flags]            --outcome "..", --req "..", --accept "..", --command "..",
                                   --verify "<cmd>", --verify-file <path>, --manual-review,
                                   --depends <id,id>, --file <path>, --worker <id>, --effort low|medium|high (size),
                                   --reasoning minimal|low|medium|high|xhigh|max (how hard the model thinks),
                                   --backlog (do not mark READY)
  show <id>                        everything about a task: deps, executions, evidence, artifacts, events
  context <id> [--full] [--budget n]   preview what a worker would receive
  log <id> [--tail n] [--execution <id>]
  run <id> [--worker <id>] [--timeout <seconds>] [--force] [--quiet]
  retry <id> [--no-run]            BLOCKED/REVIEW → READY (and run)
  cancel <id>                      stop a running execution or cancel the task
  move <id> <status> [--force]     backlog|ready|working|blocked|review|done|cancelled
  approve <id> [--reason ..]       REVIEW → DONE with human-approval evidence
  reject <id> --reason ..          REVIEW → BLOCKED
  dep <id> <dependsOnId>           add a dependency (cycles are rejected)
  undep <id> <dependsOnId>
  edit <id> --title .. --outcome .. --worker .. --command .. --effort .. --reasoning .. --req .. --accept .. --file .. --verify ..
  rm <id> --yes
  Ids accept a unique prefix or the task's # number inside a project.`,
  project: `dev project <command>

  list                             all projects with task counts
  new <name> [--dir <parent>] [--template empty|node|python] [--goal ..] [--no-git]
  add <path> [--name ..] [--goal ..]
  status [id|name]                 header, git state, blocked, review, runnable
  set <field> <value>              goal | summary | milestone | name | status | defaultWorker | reviewRequired | verification
  remove <id> --yes                unregister (files untouched)`,
  plan: `dev plan "<goal>" [--max 6] [--worker claude-code|codex|ollama] [--yes]

  Inspects the project, asks Nexus for capabilities, has one planning worker produce a small
  bounded task list for the next milestone, shows it, and only persists it after you confirm.`,
  auto: `dev auto [--all] [--parallel n] [--max n] [--worker <id>] [--stop-on-failure] [--detach] [--promote-backlog]

  Executes runnable tasks (READY with all dependencies DONE) one after another in dependency
  order. Each task receives the result summaries of its upstream tasks in its context.
  --promote-backlog (alias --autopilot) also pulls Backlog tasks whose dependencies are done.`,
};

export async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  const [command, sub, ...rest] = parsed.positionals;
  const wantsHelp = parsed.flags.help === true || parsed.flags.h === true;
  if (!command || command === "help") {
    println(HELP);
    return 0;
  }
  if (wantsHelp) {
    println(SUB_HELP[command] ?? HELP);
    return 0;
  }
  if (command === "version" || parsed.flags.version === true) return versionCommand();

  let ctx: CliContext | undefined;
  try {
    ctx = openContext(parsed);
    switch (command) {
      case "doctor":
        return await doctorCommand(ctx);
      case "welcome":
        return await welcomeCommand(ctx);
      case "status":
        return await statusCommand(ctx);
      case "project":
      case "projects":
        return await projectCommand(ctx, sub, rest);
      case "task":
      case "tasks":
        return await taskCommand(ctx, sub, rest);
      case "run":
        return await taskCommand(ctx, "run", [sub as string, ...rest]);
      case "auto":
        return await autoCommand(ctx);
      case "plan":
        return await planCommand(ctx, [sub, ...rest].filter(Boolean).join(" "));
      case "chat":
        return await chatCommand(ctx, [sub, ...rest].filter(Boolean).join(" "));
      case "keys":
        return keysCommand(ctx);
      case "workers":
      case "worker":
        return await workersCommand(ctx, sub, rest);
      case "resources":
      case "resource":
      case "nexus":
        return await resourcesCommand(ctx, sub, rest);
      case "events":
        return await eventsCommand(ctx);
      case "artifacts":
      case "artifact":
        return await artifactsCommand(ctx, sub, rest);
      case "flow":
      case "flows":
        return await flowCommand(ctx, sub, rest);
      case "git":
        return await gitCommand(ctx, sub, rest);
      case "decision":
      case "decisions":
        return decisionCommand(ctx, sub, rest);
      case "approvals":
      case "approval":
        return approvalsCommand(ctx, sub, rest);
      case "config":
        return await configCommand(ctx, sub, rest);
      case "control-plane":
      case "cp":
        return await controlPlaneCommand(ctx, sub);
      case "ui":
      case "app":
        return await uiCommand(ctx);
      default:
        throw new UsageError(`Unknown command "${command}". Run: dev --help`);
    }
  } catch (error) {
    if (parsed.flags.json === true) {
      println(JSON.stringify({ error: (error as Error).message }));
    } else {
      eprintln(`${c.red("error")} ${(error as Error).message}`);
      if (!(error instanceof UsageError) && parsed.flags.verbose === true && (error as Error).stack) eprintln(c.dim((error as Error).stack as string));
    }
    return error instanceof UsageError ? 1 : 2;
  } finally {
    ctx?.dev.close();
  }
}

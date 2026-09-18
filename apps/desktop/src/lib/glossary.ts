/** Short definitions shown on hover the first time a learner meets a term. Kept to one sentence each. */
export const GLOSSARY: Record<string, string> = {
  worker: "A replaceable execution capability: a coding agent, a local model or the shell. DEV picks one per task.",
  adapter: "The small piece of code that drives one worker's command line or API so the rest of DEV never sees provider details.",
  dependency: "A task that must be DONE before this one may start. Dependencies gate the Ready state.",
  "task graph": "Tasks and their dependencies, drawn as a directed graph. Runnable tasks are the Ready ones with every dependency Done.",
  verification: "A command, file check or human review DEV runs after the worker finishes. Exit code 0 passes.",
  evidence: "The record that justifies a Done task: a passed verification, a successful command exit or a human approval.",
  artifact: "A file DEV kept from an execution: the log, the diff, the worker's summary, test output.",
  "context budget": "The token ceiling for the brief a worker receives. Sections are cut in priority order to fit it.",
  brief: "The prompt DEV assembles for a worker: task, upstream outcomes, project summary, decisions, files, repo map.",
  "control plane": "The local service that owns the database and runs executions. The CLI and this app both talk to it.",
  execution: "One run of one task by one worker, with its command, log, changed files, duration and outcome.",
  PTY: "A pseudo-terminal: the operating system facility that gives a shell a real terminal to talk to. ConPTY on Windows.",
  MCP: "Model Context Protocol: a standard way for agents to reach tools and data. Nexus catalogues the servers on this machine.",
  Nexus: "The hub on this machine that catalogues skills, MCP servers, APIs and workflows. DEV asks it for capabilities.",
  milestone: "The next meaningful, shippable slice. Plans are bounded to one milestone at a time.",
  "auto-run": "Execute every runnable task in dependency order, handing each one the outcomes of its upstream tasks.",
  review: "A task that succeeded and waits for a human to approve it before it counts as Done.",
  blocked: "A task that stopped with a structured failure: the kind, the reason and the next action are recorded.",
  branch: "A named line of commits in git. DEV shows the current one and lets you switch or create branches.",
  commit: "A recorded snapshot of the repository with a message. DEV can commit all changes and link the commit to a task.",
  capability: "Something a task may use: a skill, an MCP server, an API or a workflow, discovered through Nexus.",
  "working tree": "The files on disk as they are now, compared with the last commit: changed, added, deleted, untracked.",
};

export function define(term: string): string | undefined {
  return GLOSSARY[term] ?? GLOSSARY[term.toLowerCase()];
}

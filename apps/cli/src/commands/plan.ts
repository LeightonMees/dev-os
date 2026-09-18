import { createInterface } from "node:readline/promises";

import { applyPlan, planGoal } from "@dev/core";

import { flagBool, flagNumber, flagString, UsageError } from "../args.ts";
import { currentProject, type CliContext } from "../context.ts";
import { c, eprintln, printJson, println, table, truncate } from "../output.ts";

export async function planCommand(ctx: CliContext, goal: string): Promise<number> {
  const project = currentProject(ctx);
  if (!project) throw new UsageError("No project");
  if (!goal.trim()) throw new UsageError('Usage: dev plan "<goal>" [--max 6] [--worker claude-code|codex|ollama] [--yes]');
  if (!ctx.json) eprintln(c.dim(`Planning "${truncate(goal, 70)}" for ${project.name}… (inspecting the repo, asking Nexus, then one planning worker)`));
  const proposal = await planGoal(ctx.dev, project, goal, { workerId: flagString(ctx.flags, "worker") ?? null, maxTasks: flagNumber(ctx.flags, "max") });
  if (ctx.json && !flagBool(ctx.flags, "yes")) {
    printJson(proposal);
    return 0;
  }
  if (!ctx.json) {
    println("");
    println(c.bold(`Milestone: ${proposal.milestone}`) + c.dim(`  (planned by ${proposal.workerId})`));
    if (proposal.summary) println(c.dim(proposal.summary));
    println("");
    println(table(proposal.tasks.map((t, i) => [String(i + 1), truncate(t.title, 50), t.dependsOn.length ? c.dim(`after ${t.dependsOn.map((d) => d + 1).join(",")}`) : "", t.effort, c.dim(t.verification.map((v) => v.command ?? v.path ?? v.kind).join("; ") || "no verification")]), { header: ["#", "TASK", "DEPS", "EFFORT", "VERIFY"] }));
    if (proposal.capabilities.length) println("\n" + c.dim("Capabilities via Nexus: ") + proposal.capabilities.map((x) => `${x.kind}:${x.name}`).join(", "));
    for (const note of proposal.notes) println(c.yellow(`! ${note}`));
  }
  let accept = flagBool(ctx.flags, "yes") || flagBool(ctx.flags, "y");
  if (!accept) {
    if (!process.stdin.isTTY) {
      println(c.dim("\nNot applied (no TTY). Re-run with --yes to persist this plan."));
      return 0;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question(`\nCreate these ${proposal.tasks.length} task(s)? [y/N] `)).trim().toLowerCase();
    rl.close();
    accept = answer === "y" || answer === "yes";
  }
  if (!accept) {
    println(c.dim("Plan discarded."));
    return 0;
  }
  const created = applyPlan(ctx.dev, project, proposal);
  if (ctx.json) {
    printJson({ proposal, created });
    return 0;
  }
  println(`${c.green("✓")} Created ${created.length} task(s). Ready now: ${created.filter((t) => ctx.dev.tasks.get(t.id)?.status === "READY").map((t) => t.id).join(", ") || "none"}`);
  println(c.dim(`  dev task list --project ${project.id}   ·   dev auto --project ${project.id}`));
  return 0;
}

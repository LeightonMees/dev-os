import { runFlow, type Flow } from "@dev/core";

import { flagBool, UsageError } from "../args.ts";
import { currentProject, type CliContext } from "../context.ts";
import { ago, c, kv, printJson, println, SYMBOL, table, truncate } from "../output.ts";

const USAGE = [
  "dev flow list                      flows in the current project",
  "dev flow show <id|name>            steps, arrows, problems and recent runs",
  "dev flow run <id|name>             run it now, printing each step as it finishes",
  "dev flow runs <id|name>            run history",
].join("\n");

/**
 * Flows from the terminal. The desktop draws them; this runs the same graph
 * headless, so a flow can sit in a script or a scheduler without the app open.
 */
export async function flowCommand(ctx: CliContext, sub: string | undefined, rest: string[]): Promise<number> {
  if (!sub || sub === "list") {
    const project = currentProject(ctx, { required: false });
    const flows = ctx.dev.flows.list(project?.id ?? null);
    if (ctx.json) {
      printJson(flows);
      return 0;
    }
    if (flows.length === 0) {
      println(c.dim(project ? `No flows in ${project.name}. Draw one in the app's Flows section.` : "No flows yet."));
      return 0;
    }
    println(
      table(
        flows.map((f) => {
          const last = ctx.dev.flows.runs(f.id)[0];
          const problems = ctx.dev.flows.problems(f.id).length;
          return [f.id, c.bold(f.name), `${f.nodes.length} step${f.nodes.length === 1 ? "" : "s"}`, problems ? c.yellow(`${problems} problem${problems === 1 ? "" : "s"}`) : c.green("ready"), last ? `${statusMark(last.status)} ${last.status.toLowerCase()} ${ago(last.startedAt)}` : c.dim("never run")];
        }),
        { header: ["ID", "NAME", "STEPS", "STATE", "LAST RUN"] },
      ),
    );
    return 0;
  }

  const target = rest[0];
  if (!target) throw new UsageError(USAGE);
  const flow = resolveFlow(ctx, target);

  if (sub === "show") {
    const problems = ctx.dev.flows.problems(flow.id);
    const runs = ctx.dev.flows.runs(flow.id).slice(0, 5);
    if (ctx.json) {
      printJson({ ...flow, problems, runs });
      return 0;
    }
    println(kv([["id", flow.id], ["name", flow.name], ["project", flow.projectId], ["steps", flow.nodes.length], ["arrows", flow.edges.length], ["updated", ago(flow.updatedAt)]]));
    println("");
    println(c.dim("  Steps"));
    for (const node of flow.nodes) {
      const what = node.kind === "shell" ? node.command : node.kind === "condition" ? node.expression : node.prompt;
      println(`    ${c.bold(node.label)}  ${c.dim(node.kind)}  ${truncate(what ?? "", 70)}`);
    }
    if (flow.edges.length > 0) {
      println("");
      println(c.dim("  Arrows"));
      const label = (id: string) => flow.nodes.find((n) => n.id === id)?.label ?? id;
      for (const edge of flow.edges) println(`    ${label(edge.from)} → ${label(edge.to)}${edge.when ? c.dim(`  when ${edge.when}`) : ""}`);
    }
    if (problems.length > 0) {
      println("");
      println(c.yellow("  Cannot run yet"));
      for (const p of problems) println(`    ${SYMBOL.warn} ${p.message}`);
    }
    if (runs.length > 0) {
      println("");
      println(c.dim("  Recent runs"));
      for (const r of runs) println(`    ${statusMark(r.status)} ${r.id}  ${r.status.toLowerCase()}  ${ago(r.startedAt)}${r.detail ? c.dim(`  ${truncate(r.detail, 60)}`) : ""}`);
    }
    return 0;
  }

  if (sub === "runs") {
    const runs = ctx.dev.flows.runs(flow.id);
    if (ctx.json) {
      printJson(runs.map((r) => ({ ...r, steps: ctx.dev.flows.nodeRuns(r.id) })));
      return 0;
    }
    if (runs.length === 0) {
      println(c.dim(`${flow.name} has never run.`));
      return 0;
    }
    println(table(runs.map((r) => [statusMark(r.status), r.id, r.status.toLowerCase(), ago(r.startedAt), truncate(r.detail ?? "", 60)]), { header: ["", "RUN", "STATUS", "STARTED", "DETAIL"] }));
    return 0;
  }

  if (sub === "run") {
    const quiet = flagBool(ctx.flags, "quiet");
    if (!ctx.json && !quiet) println(`${c.bold(flow.name)}  ${c.dim(`${flow.nodes.length} steps`)}`);
    const report = await runFlow(ctx.dev, {
      flowId: flow.id,
      onStep: (step) => {
        if (ctx.json || quiet) return;
        const mark = step.status === "PASSED" ? SYMBOL.ok : step.status === "SKIPPED" ? c.dim("·") : step.status === "RUNNING" ? "▶" : SYMBOL.fail;
        println(`  ${mark} ${step.label}  ${c.dim(step.status.toLowerCase())}${step.detail ? c.dim(`  ${truncate(step.detail, 80)}`) : ""}`);
      },
    });
    if (ctx.json) {
      printJson(report);
    } else {
      println("");
      println(report.status === "PASSED" ? c.green(`${SYMBOL.ok} ${flow.name} passed (${report.steps.length} steps)`) : report.status === "CANCELLED" ? c.yellow(`${flow.name} cancelled`) : c.red(`${SYMBOL.fail} ${flow.name} failed: ${report.detail ?? ""}`));
    }
    return report.status === "PASSED" ? 0 : 2;
  }

  throw new UsageError(USAGE);
}

/** Accept an id or a name; a name that matches several flows is an error, not a guess. */
function resolveFlow(ctx: CliContext, target: string): Flow {
  const byId = ctx.dev.flows.get(target);
  if (byId) return byId;
  const project = currentProject(ctx, { required: false });
  const candidates = ctx.dev.flows.list(project?.id ?? null).filter((f) => f.name.toLowerCase() === target.toLowerCase());
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length > 1) throw new UsageError(`"${target}" names ${candidates.length} flows; use the id: ${candidates.map((f) => f.id).join(", ")}`);
  throw new UsageError(`No flow "${target}". dev flow list shows what exists.`);
}

function statusMark(status: string): string {
  return status === "PASSED" ? SYMBOL.ok : status === "RUNNING" ? "▶" : status === "CANCELLED" ? c.dim("·") : SYMBOL.fail;
}

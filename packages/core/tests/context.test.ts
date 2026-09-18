import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { assembleContext, estimateTokens } from "../src/index.ts";
import { openTestDev } from "./helpers.ts";

test("context contains the task, upstream outcomes and relevant decisions, never the backlog", () => {
  const { dev, home, cleanup } = openTestDev();
  try {
    const project = dev.projects.add({ path: home, name: "ctx", goal: "Build a small API", summary: "Express app with SQLite." });
    writeFileSync(join(home, "server.js"), "console.log('hello');\n");
    for (let i = 0; i < 40; i++) dev.tasks.create({ projectId: project.id, title: `UNRELATED-BACKLOG-${i}` });
    const upstream = dev.tasks.create({ projectId: project.id, title: "Create schema", status: "READY" });
    dev.tasks.setStatus(upstream.id, "WORKING");
    dev.evidence.record({ taskId: upstream.id, kind: "verification", passed: true, summary: "ok" });
    dev.tasks.setStatus(upstream.id, "DONE", { resultSummary: "Added users table in db.sql" });
    dev.decisions.record({ projectId: project.id, title: "Use SQLite", decision: "SQLite for storage", reason: "local first", tags: ["storage", "schema"] });
    dev.decisions.record({ projectId: project.id, title: "Brand colour", decision: "Use teal", tags: ["design"] });
    const task = dev.tasks.create({ projectId: project.id, title: "Add users API endpoint using the schema", outcome: "GET /users works", requirements: ["return JSON"], acceptance: ["curl returns 200"], dependsOn: [upstream.id], files: ["server.js"], verification: [{ kind: "command", command: "npm test" }] });

    const assembled = assembleContext({ task, project, tasks: dev.tasks, decisions: dev.decisions, config: dev.config.context });
    assert.match(assembled.prompt, /# Task: Add users API endpoint/);
    assert.match(assembled.prompt, /Added users table in db\.sql/, "upstream result summary is passed on");
    assert.match(assembled.prompt, /Use SQLite/, "relevant decision included");
    assert.doesNotMatch(assembled.prompt, /Brand colour/, "irrelevant decision excluded");
    assert.doesNotMatch(assembled.prompt, /UNRELATED-BACKLOG/, "backlog never enters the prompt");
    assert.match(assembled.prompt, /console\.log\('hello'\)/, "task file content included");
    assert.match(assembled.prompt, /npm test/, "verification is announced to the worker");
    assert.ok(assembled.usedTokens <= assembled.budgetTokens);
    assert.ok(assembled.sections.find((s) => s.name === "task")?.included);
    assert.equal(estimateTokens(assembled.prompt), assembled.usedTokens);
  } finally {
    cleanup();
  }
});

test("a tight budget truncates optional sections and reports it", () => {
  const { dev, home, cleanup } = openTestDev();
  try {
    const project = dev.projects.add({ path: home, name: "tight", summary: "x".repeat(8000) });
    const task = dev.tasks.create({ projectId: project.id, title: "tiny", outcome: "y" });
    const assembled = assembleContext({ task, project, tasks: dev.tasks, decisions: dev.decisions, config: dev.config.context, budgetTokens: 400 });
    const projectSection = assembled.sections.find((s) => s.name === "project");
    assert.ok(projectSection, "project section is reported");
    assert.ok(projectSection.truncated || !projectSection.included, "project summary is cut or dropped under a tight budget");
    assert.ok(assembled.sections.find((s) => s.name === "task")?.included, "task is always sent");
    assert.ok(assembled.sections.find((s) => s.name === "instructions")?.included, "instructions are always sent");
  } finally {
    cleanup();
  }
});

test("one oversized document is cut to the per-file cap instead of owning the brief", () => {
  const { dev, home, cleanup } = openTestDev();
  try {
    const project = dev.projects.add({ path: home, name: "ctx-cap", goal: "Decide the next milestone", summary: "A small business workspace." });
    // The real case, 2026-09-18: a 17,160-character strategy document was attached to a task whose
    // whole job was to pick a milestone. At the old 2,000-token-per-file cap it entered the brief as
    // 8,000 characters -- roughly 2,000 of that task's 3,199 tokens, 62% of everything the worker
    // was told, to answer a question the one-line decisions section had already answered.
    const raw = "# Master plan\n" + "priority order and then a great deal of unrelated strategy. ".repeat(340);
    writeFileSync(join(home, "MASTER_PLAN.md"), raw);
    assert.ok(raw.length > 15_000, "the fixture has to be genuinely oversized to test the cap");
    const task = dev.tasks.create({
      projectId: project.id,
      title: "Decide the next milestone",
      outcome: "One named milestone with 3-7 bounded tickets",
      requirements: ["Respect the documented priority order"],
      acceptance: ["Milestone set on the project record"],
      files: ["MASTER_PLAN.md"],
    });

    const cap = dev.config.context.maxFileTokens;
    const assembled = assembleContext({ task, project, tasks: dev.tasks, decisions: dev.decisions, config: dev.config.context });
    const file = assembled.sections.find((s) => s.name === "file:MASTER_PLAN.md");
    assert.ok(file?.included, "the file is still sent; the point is how much of it");
    assert.ok(file.tokens <= cap + 40, `a file section must respect the per-file cap, got ~${file.tokens} against ${cap}`);
    // The regression this locks in: the document is cut to the cap rather than entering whole.
    assert.ok(file.tokens < estimateTokens(raw) / 3, `a ${estimateTokens(raw)}-token document entered the brief as ~${file.tokens} tokens`);
    assert.match(assembled.prompt, /truncated, \d+ more characters/, "the worker is told the file was cut, not given a silent fragment");
  } finally {
    cleanup();
  }
});

test("an edited brief is sent verbatim and replaces assembly", () => {
  const { dev, home, cleanup } = openTestDev();
  try {
    const project = dev.projects.add({ path: home, name: "ctx-override", goal: "g" });
    const task = dev.tasks.create({ projectId: project.id, title: "Do the thing" });
    assert.equal(task.promptOverride, null, "tasks assemble their brief by default");

    const edited = dev.tasks.update(task.id, { promptOverride: "Just do this one thing. Nothing else." });
    assert.equal(edited.promptOverride, "Just do this one thing. Nothing else.");
    assert.equal(dev.tasks.get(task.id)?.promptOverride, edited.promptOverride, "the edit survives a reload");

    const cleared = dev.tasks.update(task.id, { promptOverride: null });
    assert.equal(cleared.promptOverride, null, "clearing returns the task to assembled context");
  } finally {
    cleanup();
  }
});

test("a file is excerpted by relevance to the task, not by position in the file", () => {
  const { dev, home, cleanup } = openTestDev();
  try {
    const project = dev.projects.add({ path: home, name: "excerpt", goal: "g" });
    // The shape of the real document: the part the task asks about is NOT at the top.
    const doc = [
      "# Master plan",
      "An overview paragraph that orients the reader.",
      "",
      "## Weekly study timetable",
      "Monday algebra. ".repeat(220),
      "",
      "## Reselling and inventory",
      "List the cards you already hold. ".repeat(220),
      "",
      "## Priority order",
      "The milestone priority order is: deadlines, revenue, learning, then hobbies.",
      "",
      "## Travel notes",
      "Unrelated logistics. ".repeat(220),
    ].join("\n");
    writeFileSync(join(home, "PLAN.md"), doc);
    const task = dev.tasks.create({
      projectId: project.id,
      title: "Decide the next milestone",
      outcome: "One named milestone",
      requirements: ["Respect the documented priority order"],
      files: ["PLAN.md"],
    });

    const assembled = assembleContext({ task, project, tasks: dev.tasks, decisions: dev.decisions, config: dev.config.context });
    assert.match(assembled.prompt, /# Master plan/, "the opening section is always kept: a file that starts mid-sentence reads as corrupt");
    assert.match(assembled.prompt, /milestone priority order is/, "the section the task asks about survives even though it is near the end");
    assert.doesNotMatch(assembled.prompt, /Monday algebra/, "an irrelevant section near the top is dropped, which head truncation could never do");
    assert.doesNotMatch(assembled.prompt, /Unrelated logistics/, "and so is an irrelevant section near the end");
    assert.match(assembled.prompt, /sections? not relevant to this task omitted/, "the worker is told it holds an excerpt, not a whole file");
  } finally {
    cleanup();
  }
});

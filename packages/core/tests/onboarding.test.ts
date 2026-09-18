import assert from "node:assert/strict";
import { test } from "node:test";

import { GUIDE_PROJECT_NAME, seedGettingStarted, seedIfFirstRun } from "../src/index.ts";
import { openTestDev } from "./helpers.ts";

test("a first run gets a real, workable guide instead of an empty board", () => {
  const { dev, cleanup } = openTestDev();
  try {
    const result = seedIfFirstRun(dev);
    assert.ok(result, "an empty installation is seeded");
    assert.equal(result.existed, false);
    assert.equal(result.project.name, GUIDE_PROJECT_NAME);
    assert.equal(result.project.path, null, "the guide needs no repository to exist");
    assert.ok(result.tasks.length >= 5, "enough steps to actually teach the loop");

    // Exactly one step is actionable at the start; the rest unlock in order, so
    // the guide also demonstrates how dependencies gate work.
    const ready = result.tasks.filter((t) => t.status === "READY");
    assert.equal(ready.length, 1);
    assert.equal(ready[0]!.id, result.tasks[0]!.id);
    for (const task of result.tasks.slice(1)) {
      assert.equal(task.status, "BACKLOG");
      assert.equal(task.dependsOn.length, 1, `${task.title} waits for the step before it`);
    }

    // Every step must be judgeable, and honestly: these are finished by a
    // person, so the verification is their approval rather than an invented check.
    for (const task of result.tasks) {
      assert.ok(task.outcome.length > 20, `${task.title} states what "done" means`);
      assert.deepEqual(task.verification.map((v) => v.kind), ["manual"]);
    }
  } finally {
    cleanup();
  }
});

test("the guide names no AI provider as required", () => {
  const { dev, cleanup } = openTestDev();
  try {
    const { tasks } = seedGettingStarted(dev);
    const text = tasks.map((t) => [t.title, t.outcome, ...t.requirements].join(" ")).join(" ").toLowerCase();

    // DEV must not read as though one vendor is the way in. Naming Ollama is
    // allowed where it is the local-and-free option, and "OpenAI-compatible"
    // names a wire protocol rather than a required account — but no hosted
    // vendor should appear as something the user has to have.
    const withoutProtocol = text.replaceAll("openai-compatible", "");
    for (const vendor of ["openai", "anthropic", "claude", "gpt-", "gemini", "groq", "mistral"]) {
      assert.ok(!withoutProtocol.includes(vendor), `the guide must not require ${vendor}`);
    }
    // And it must say out loud that no AI at all is a valid setup.
    const choice = tasks.find((t) => t.title.toLowerCase().includes("choose the ai"));
    assert.ok(choice, "there is a step about choosing an AI");
    const choiceText = [choice.outcome, ...choice.requirements].join(" ").toLowerCase();
    assert.ok(choiceText.includes("no account") || choiceText.includes("local"), "a local, accountless option is offered");
    assert.ok(choiceText.includes("no ai"), "running without any AI is offered");
  } finally {
    cleanup();
  }
});

test("seeding twice never duplicates the guide or resets progress through it", () => {
  const { dev, cleanup } = openTestDev();
  try {
    const first = seedGettingStarted(dev);
    // Stand in for the user having worked on the guide. DONE is deliberately
    // unreachable by hand — it needs evidence — so move it somewhere legal.
    dev.tasks.setStatus(first.tasks[0]!.id, "CANCELLED");

    const second = seedGettingStarted(dev);
    assert.equal(second.existed, true);
    assert.equal(second.project.id, first.project.id);
    assert.equal(dev.projects.list().filter((p) => p.name === GUIDE_PROJECT_NAME).length, 1);
    assert.equal(second.tasks.find((t) => t.id === first.tasks[0]!.id)?.status, "CANCELLED", "the user's own changes survive");
  } finally {
    cleanup();
  }
});

test("an installation that already has a project is left alone", () => {
  const { dev, cleanup } = openTestDev();
  try {
    dev.projects.add({ path: null, name: "something the user made" });
    assert.equal(seedIfFirstRun(dev), null);
    assert.equal(dev.projects.list().length, 1);
  } finally {
    cleanup();
  }
});

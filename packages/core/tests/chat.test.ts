import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { chatTurn, type ChatFn, type ChatMessage } from "../src/index.ts";
import { openTestDev, tempRoot } from "./helpers.ts";

const brain = { id: "fake", model: "fake-1", baseUrl: "http://127.0.0.1:1", apiKey: null };

test("project creation scaffolds a template, git inits and registers the project", () => {
  const { dev, cleanup } = openTestDev();
  const parent = tempRoot();
  try {
    const project = dev.projects.create({ name: "demo-app", dir: parent, template: "node", goal: "a demo" });
    assert.equal(project.path, join(parent, "demo-app"));
    assert.ok(existsSync(join(project.path, "package.json")));
    assert.ok(existsSync(join(project.path, ".git")));
    assert.match(readFileSync(join(project.path, "README.md"), "utf8"), /a demo/);
    assert.deepEqual(project.config.verification, [{ kind: "command", command: "npm test" }]);
    assert.throws(() => dev.projects.create({ name: "demo-app", dir: parent }), /already exists/);
    assert.throws(() => dev.projects.create({ name: "bad name!", dir: parent }), /must be letters/);
  } finally {
    cleanup();
  }
});

test("chat: the brain creates a project and a task through DEV tools, and everything is stored", async () => {
  const { dev, cleanup } = openTestDev();
  const parent = tempRoot();
  try {
    let step = 0;
    const seen: ChatMessage[][] = [];
    // A scripted brain: first create a project, then create a task, then answer.
    const chatFn: ChatFn = async (messages) => {
      seen.push(messages);
      step++;
      if (step === 1) return { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "create_project", arguments: JSON.stringify({ name: "chat-app", template: "empty", dir: parent, goal: "an app from chat" }) } }] };
      if (step === 2) return { role: "assistant", content: null, tool_calls: [{ id: "c2", type: "function", function: { name: "create_task", arguments: JSON.stringify({ title: "Write the README", verify: "node -e \"process.exit(0)\"" }) } }] };
      return { role: "assistant", content: "Created chat-app and one task; run it when ready." };
    };
    const conversation = dev.chat.create({});
    const turn = await chatTurn(dev, conversation.id, "make me an app called chat-app", { chatFn, brain });
    assert.equal(turn.messages.filter((m) => m.role === "tool").length, 2);
    assert.match(turn.messages.at(-1)?.content ?? "", /Created chat-app/);
    const project = dev.projects.list()[0]!;
    assert.equal(project.name, "chat-app");
    assert.equal(dev.chat.get(conversation.id)?.projectId, project.id, "the conversation now points at the project");
    const task = dev.tasks.list({ projectId: project.id })[0]!;
    assert.equal(task.status, "READY");
    assert.equal(dev.chat.get(conversation.id)?.title, "make me an app called chat-app");
    const stored = dev.chat.messages(conversation.id);
    assert.deepEqual(stored.map((m) => m.role), ["user", "assistant", "tool", "assistant", "tool", "assistant"]);
    assert.ok(seen[0]![0]!.content?.includes("You are DEV"), "system prompt is sent");
    assert.ok(seen[1]!.some((m) => m.role === "tool" && m.content?.includes("chat-app")), "tool results feed the next turn");
    assert.ok(dev.events.list().some((e) => e.type === "CHAT_MESSAGE"));
  } finally {
    cleanup();
  }
});

test("chat: the tool-call budget stops runaway loops and unknown tools are reported", async () => {
  const { dev, cleanup } = openTestDev();
  try {
    const chatFn: ChatFn = async (messages) => {
      const last = messages.at(-1);
      if (last?.role === "tool" && last.content?.startsWith("refused")) return { role: "assistant", content: "budget spent" };
      // five unknown tools per turn: the 12-call budget is spent inside three turns
      return { role: "assistant", content: null, tool_calls: [1, 2, 3, 4, 5].map((i) => ({ id: `x${messages.length}-${i}`, type: "function" as const, function: { name: "nope", arguments: "{}" } })) };
    };
    const conversation = dev.chat.create({});
    const turn = await chatTurn(dev, conversation.id, "loop forever", { chatFn, brain });
    const tools = turn.messages.filter((m) => m.role === "tool");
    assert.ok(tools.some((m) => m.content?.startsWith("error: unknown tool")));
    assert.ok(tools.length <= dev.config.chat.maxToolCalls + 5);
    assert.equal(turn.messages.at(-1)?.content, "budget spent");
  } finally {
    cleanup();
  }
});

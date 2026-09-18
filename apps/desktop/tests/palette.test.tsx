import { describe, expect, it } from "vitest";

import { filterCommands, type Command } from "../src/components/CommandPalette.tsx";

const commands: Command[] = [
  { id: "go:work", group: "Go to", title: "Work", meta: "Ctrl+2", run: () => {} },
  { id: "go:git", group: "Go to", title: "Git", meta: "Ctrl+5", run: () => {} },
  { id: "run:1", group: "Run task", title: "Add login route", meta: "#3", keywords: "run start", run: () => {} },
  { id: "open:1", group: "Open task", title: "Add login route", meta: "◔ #3", keywords: "READY", run: () => {} },
  { id: "open:2", group: "Open task", title: "Write docs", meta: "○ #4", keywords: "BACKLOG", run: () => {} },
  { id: "doctor", group: "System", title: "Run doctor", run: () => {} },
];

describe("command palette filtering", () => {
  it("hides task-open entries until the user types, so the empty list stays short", () => {
    const shown = filterCommands(commands, "");
    expect(shown.map((c) => c.id)).toEqual(["go:work", "go:git", "run:1", "doctor"]);
  });

  it("matches every word and ranks title prefixes first", () => {
    const shown = filterCommands(commands, "login");
    expect(shown.map((c) => c.id)).toEqual(["run:1", "open:1"]);
    expect(filterCommands(commands, "run login").map((c) => c.id)).toEqual(["run:1"]);
    expect(filterCommands(commands, "docs backlog").map((c) => c.id)).toEqual(["open:2"]);
    expect(filterCommands(commands, "nothing here")).toEqual([]);
  });
});

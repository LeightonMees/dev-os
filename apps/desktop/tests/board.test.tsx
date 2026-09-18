import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Board } from "../src/components/Board.tsx";
import { Feed } from "../src/components/Feed.tsx";
import { describeEvent, MANUAL_MOVES } from "../src/lib/format.ts";
import type { Task } from "../src/lib/api.ts";

function task(patch: Partial<Task>): Task {
  return {
    id: "tsk_1",
    projectId: "prj_1",
    title: "Write tests",
    milestone: null,
    epic: null,
    kind: "ticket",
    risk: "normal",
    needsHuman: null,
    outcome: "",
    requirements: [],
    acceptance: [],
    status: "READY",
    dependsOn: [],
    workerId: null,
    capabilities: [],
    effort: "medium",
    reasoningEffort: null,
    command: null,
    promptOverride: null,
    files: [],
    verification: [],
    resultSummary: null,
    failure: null,
    retryCount: 0,
    ordinal: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...patch,
  };
}

describe("Board", () => {
  it("renders every column, places cards by status and exposes state-appropriate actions", () => {
    const onRun = vi.fn();
    const onRetry = vi.fn();
    const onSelect = vi.fn();
    const tasks = [
      task({ id: "a", title: "ready one", status: "READY" }),
      task({ id: "b", title: "blocked one", status: "BLOCKED", ordinal: 2, failure: { kind: "process-failed", reason: "exit 1", nextAction: "fix", at: "" } }),
      task({ id: "c", title: "done one", status: "DONE", ordinal: 3, resultSummary: "all good" }),
    ];
    render(<Board tasks={tasks} selectedId={null} onSelect={onSelect} onMove={vi.fn()} onRun={onRun} onRetry={onRetry} onCancel={vi.fn()} onApprove={vi.fn()} />);
    for (const label of ["Backlog", "Ready", "Working", "Blocked", "Review", "Done"]) expect(screen.getByText(label)).toBeTruthy();
    expect(screen.getByText("exit 1")).toBeTruthy();
    expect(screen.getByText("all good")).toBeTruthy();
    fireEvent.click(screen.getByText("Run"));
    expect(onRun).toHaveBeenCalledWith("a");
    fireEvent.click(screen.getByText("Retry"));
    expect(onRetry).toHaveBeenCalledWith("b");
    fireEvent.click(screen.getByText("ready one"));
    expect(onSelect).toHaveBeenCalledWith("a");
  });

  it("shows dependencies before the dependent task so the relationship reads left to right", () => {
    const tasks = [
      task({ id: "dependency", title: "dependency", ordinal: 6 }),
      task({ id: "dependent", title: "dependent", ordinal: 8, dependsOn: ["dependency"] }),
    ];

    render(<Board tasks={tasks} selectedId={null} onSelect={vi.fn()} onMove={vi.fn()} onRun={vi.fn()} onRetry={vi.fn()} onCancel={vi.fn()} onApprove={vi.fn()} />);

    expect(screen.getByText("#6 → #8")).toBeTruthy();
    expect(screen.queryByText("#8 ⇠ #6")).toBeNull();
  });

  it("dragging a card onto a legal column moves it", () => {
    const onMove = vi.fn();
    const noop = vi.fn();
    render(
      <Board tasks={[task({ id: "tsk_1", status: "BACKLOG" })]} selectedId={null} onSelect={noop} onMove={onMove} onRun={noop} onRetry={noop} onCancel={noop} onApprove={noop} />,
    );
    const card = screen.getByTestId("card-tsk_1");
    const column = screen.getByTestId("column-READY");
    // jsdom does not give a drag event a dataTransfer, so supply the one the handlers use.
    const dataTransfer = { setData: vi.fn(), getData: () => "tsk_1", effectAllowed: "", dropEffect: "" };
    fireEvent.dragStart(card, { dataTransfer });
    fireEvent.dragOver(column, { dataTransfer });
    fireEvent.drop(column, { dataTransfer });
    expect(onMove).toHaveBeenCalledWith("tsk_1", "READY");
  });

  it("dropping on a column the state machine forbids explains the refusal instead of moving", () => {
    const onMove = vi.fn();
    const onRefused = vi.fn();
    const noop = vi.fn();
    render(
      <Board tasks={[task({ id: "tsk_1", status: "BACKLOG" })]} selectedId={null} onSelect={noop} onMove={onMove} onRefused={onRefused} onRun={noop} onRetry={noop} onCancel={noop} onApprove={noop} />,
    );
    const dataTransfer = { setData: vi.fn(), getData: () => "tsk_1", effectAllowed: "", dropEffect: "" };
    fireEvent.dragStart(screen.getByTestId("card-tsk_1"), { dataTransfer });
    fireEvent.dragOver(screen.getByTestId("column-DONE"), { dataTransfer });
    fireEvent.drop(screen.getByTestId("column-DONE"), { dataTransfer });
    expect(onMove).not.toHaveBeenCalled();
    expect(onRefused).toHaveBeenCalled();
    expect(String(onRefused.mock.calls[0]?.[2])).toMatch(/evidence/i);
  });

  it("manual moves mirror the state machine", () => {
    expect(MANUAL_MOVES.BACKLOG).toContain("READY");
    expect(MANUAL_MOVES.BACKLOG).not.toContain("DONE");
    expect(MANUAL_MOVES.WORKING).toEqual(["CANCELLED"]);
  });
});

describe("Feed", () => {
  it("shows an empty state and then describes events", () => {
    const { rerender } = render(<Feed events={[]} />);
    expect(screen.getByText(/No events yet/)).toBeTruthy();
    rerender(<Feed events={[{ id: 1, ts: new Date().toISOString(), type: "TASK_STATUS_CHANGED", projectId: "p", taskId: "t", executionId: null, data: { from: "READY", to: "WORKING", reason: "worker shell" } }]} />);
    expect(screen.getByText("TASK_STATUS_CHANGED")).toBeTruthy();
    expect(screen.getByText("READY → WORKING (worker shell)")).toBeTruthy();
  });

  it("describeEvent keeps output short and specific", () => {
    expect(describeEvent("COMMAND_FINISHED", { exitCode: 0, durationMs: 1500 })).toBe("exit 0 in 1.5s");
    expect(describeEvent("FILE_CHANGED", { path: "src/a.ts" })).toBe("src/a.ts");
    expect(describeEvent("TASK_BLOCKED", { failure: { kind: "timeout", reason: "too slow" } })).toBe("timeout: too slow");
  });
});

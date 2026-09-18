import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TaskInspector } from "../src/components/TaskInspector.tsx";
import { StoreProvider } from "../src/lib/store.tsx";

/** The store boots against a fake control plane; the inspector must render evidence and failure state. */
describe("TaskInspector", () => {
  it("renders failure, result and evidence from the task detail endpoint", async () => {
    const detail = {
      id: "tsk_1",
      projectId: "prj_1",
      title: "Add endpoint",
      milestone: null,
      epic: null,
      kind: "ticket",
      risk: "normal",
      needsHuman: null,
      outcome: "GET /health responds",
      requirements: ["return JSON"],
      acceptance: ["200 OK"],
      status: "BLOCKED",
      dependsOn: [],
      workerId: "claude-code",
      capabilities: [{ kind: "skill", name: "api-design" }],
      effort: "medium",
      reasoningEffort: null,
      command: null,
      files: ["src/server.ts"],
      verification: [{ kind: "command", command: "npm test" }],
      resultSummary: null,
      failure: { kind: "verification-failed", reason: "tests failed: 1 of 3", nextAction: "fix the failing test then retry", at: "" },
      retryCount: 1,
      ordinal: 4,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      dependencies: [],
      dependents: [{ id: "tsk_2", title: "Frontend", status: "BACKLOG" }],
      executions: [{ id: "exe_1", taskId: "tsk_1", projectId: "prj_1", workerId: "claude-code", status: "failed", startedAt: new Date().toISOString(), finishedAt: null, exitCode: 1, command: "claude -p", cwd: "x", logPath: null, changedFiles: ["src/server.ts"], error: "verification failed", durationMs: 4200, contextSnapshotId: null, summary: null, cancelRequested: false, usage: null }],
      evidence: [{ id: "evd_1", taskId: "tsk_1", executionId: "exe_1", kind: "verification", passed: false, summary: "Failed (exit 1): npm test", data: {}, artifactId: null, createdAt: new Date().toISOString() }],
      artifacts: [{ id: "art_1", projectId: "prj_1", taskId: "tsk_1", executionId: "exe_1", kind: "log", name: "exe_1.log", path: "C:/x/exe_1.log", size: 1200, createdAt: new Date().toISOString(), meta: {} }],
      events: [],
      contextSnapshots: [],
      worker: null,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
      if (url.endsWith("/api/status")) return body({ home: "h", version: "1", projects: 1, tasks: {}, running: [], auto: [], workers: [], recentFailures: [], recentDone: [], pendingApprovals: 0, latestEventId: 0 });
      if (url.endsWith("/api/projects")) return body([]);
      if (url.includes("/api/tasks/tsk_1")) return body(detail);
      if (url.includes("/api/events")) return body([]);
      return new Response(JSON.stringify({ error: `unexpected ${url}` }), { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal(
      "EventSource",
      class {
        onopen: (() => void) | null = null;
        onerror: (() => void) | null = null;
        addEventListener() {}
        close() {}
      },
    );
    render(
      <StoreProvider initialBaseUrl="http://fake">
        <TaskInspector taskId="tsk_1" onClose={() => {}} />
      </StoreProvider>,
    );
    await waitFor(() => expect(screen.getByText("Add endpoint")).toBeTruthy());
    expect(screen.getByText("verification-failed")).toBeTruthy();
    expect(screen.getByText("tests failed: 1 of 3")).toBeTruthy();
    expect(screen.getByText(/fix the failing test/)).toBeTruthy();
    expect(screen.getByText("Retry")).toBeTruthy();
    expect(screen.getByText("Frontend")).toBeTruthy();
    expect(screen.getByText("skill:api-design")).toBeTruthy();
    vi.unstubAllGlobals();
  });
});

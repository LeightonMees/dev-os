// The complete loop, end to end, against a throwaway repository:
//   project → tasks with dependencies → auto-run → evidence/artifacts/events → DONE
// and the same state read back through a second, independent connection (what the CLI
// and the desktop each do).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { assembleContext, autoRun, openDev } from "@dev/core";

function tempRoot(prefix: string): string {
  const preferred = process.platform === "win32" && existsSync("F:\\tmp") ? "F:\\tmp\\dev-tests" : tmpdir();
  mkdirSync(preferred, { recursive: true });
  return mkdtempSync(join(preferred, prefix));
}

const node = process.execPath.includes(" ") ? `"${process.execPath}"` : process.execPath;

test("full loop: plan-shaped tasks run in order, verify, leave evidence, and are visible from a second connection", async () => {
  const home = tempRoot("loop-home-");
  const repo = tempRoot("loop-repo-");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "t@example.invalid"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "tiny", version: "0.0.0", scripts: { test: "node test.js" } }));
  writeFileSync(join(repo, "test.js"), "const m = require('./math'); if (m.add(2, 3) !== 5) { console.error('add failed'); process.exit(1); } console.log('math ok');\n");
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });

  const dev = openDev({ home, config: { nexus: { enabled: false, command: "node", args: [], timeoutMs: 1000 }, workers: { preferences: ["shell"], timeoutMs: 60_000, claudeCode: { command: "nope", model: null, effort: null, permissionMode: "acceptEdits" }, codex: { command: "nope", model: null }, ollama: { baseUrl: "http://127.0.0.1:1", model: "none" } } } });
  try {
    const project = dev.projects.add({ path: repo, name: "tiny", goal: "a math module with tests", config: { verification: [{ kind: "command", command: "npm test" }] } });
    dev.decisions.record({ projectId: project.id, title: "CommonJS modules", decision: "Use CommonJS, no build step", reason: "tiny project", tags: ["module", "math"] });

    // The "worker" for this deterministic test is the shell; a real agent would receive the same brief.
    const implement = dev.tasks.create({ projectId: project.id, title: "Implement math.add", outcome: "math.js exports add(a, b)", command: `${node} -e "require('fs').writeFileSync('math.js','module.exports={add:(a,b)=>a+b};'); console.log('wrote math.js')"`, files: ["test.js"], status: "READY" });
    const document = dev.tasks.create({ projectId: project.id, title: "Document math module", outcome: "README mentions add()", command: `${node} -e "require('fs').appendFileSync('README.md','\\n## math\\nadd(a, b) returns a + b\\n')"`, dependsOn: [implement.id], verification: [{ kind: "file-exists", path: "README.md" }] });

    // Context preview: the brief a worker would receive is small and relevant.
    const brief = assembleContext({ task: implement, project, tasks: dev.tasks, decisions: dev.decisions, config: dev.config.context });
    assert.match(brief.prompt, /Implement math\.add/);
    assert.match(brief.prompt, /Use CommonJS/, "relevant decision included");
    assert.match(brief.prompt, /npm test/, "project verification announced");
    assert.ok(brief.usedTokens < 2000, `brief is ${brief.usedTokens} tokens`);

    const report = await autoRun(dev, { projectId: project.id });
    const failures = report.ran.map((r) => dev.tasks.get(r.taskId)?.failure).filter(Boolean);
    assert.deepEqual(report.ran.map((r) => [r.title, r.status]), [["Implement math.add", "DONE"], ["Document math module", "DONE"]], JSON.stringify(failures, null, 2));

    const done = dev.tasks.get(document.id)!;
    assert.equal(done.status, "DONE");
    assert.match(done.resultSummary ?? "", /README\.md/);
    const evidence = dev.evidence.list(implement.id);
    assert.ok(evidence.some((e) => e.kind === "verification" && e.passed && /npm test/.test(e.summary)), "project-wide test suite ran and passed");
    const artifacts = dev.artifacts.list({ projectId: project.id });
    assert.ok(artifacts.some((a) => a.kind === "test-result"), "test output stored as an artifact");
    assert.ok(artifacts.some((a) => a.kind === "log" && existsSync(a.path)));
    const testLog = artifacts.find((a) => a.kind === "test-result")!;
    assert.match(readFileSync(testLog.path, "utf8"), /math ok/);
    const execution = dev.executions.list({ taskId: implement.id })[0]!;
    assert.deepEqual(execution.changedFiles, ["math.js"]);
    assert.ok(dev.contextSnapshots.forTask(implement.id).length === 0, "shell tasks send no prompt, so no snapshot");

    const types = dev.events.list({ projectId: project.id, limit: 500 }).map((e) => e.type);
    for (const t of ["TASK_CREATED", "WORKER_SELECTED", "TASK_STARTED", "COMMAND_STARTED", "COMMAND_FINISHED", "FILE_CHANGED", "VERIFICATION_PASSED", "EVIDENCE_RECORDED", "ARTIFACT_CREATED", "TASK_COMPLETED", "TASK_READY"]) {
      assert.ok(types.includes(t), `event ${t}`);
    }
  } finally {
    dev.close();
  }

  // A second connection (the desktop's control plane, or another CLI process) sees the same state.
  const again = openDev({ home });
  try {
    const project = again.projects.list()[0]!;
    assert.equal(project.name, "tiny");
    assert.equal(again.tasks.counts(project.id).DONE, 2);
    assert.equal(again.artifacts.list({ projectId: project.id }).length >= 4, true);
  } finally {
    again.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

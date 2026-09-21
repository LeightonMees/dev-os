import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { test } from "node:test";

import { start } from "../src/main.ts";

function tempRoot(): string {
  const preferred = process.platform === "win32" && existsSync("F:\\tmp") ? "F:\\tmp\\dev-tests" : tmpdir();
  mkdirSync(preferred, { recursive: true });
  return mkdtempSync(join(preferred, "cp-"));
}

async function api<T>(url: string, method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${url}${path}`, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const json = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(json.error ?? String(response.status));
  return json;
}

/** A GET with headers fetch will not let us set (Host). Returns the status code. */
function rawGet(baseUrl: string, path: string, headers: Record<string, string>): Promise<number> {
  const url = new URL(baseUrl);
  return new Promise((resolvePromise, reject) => {
    const req = request({ hostname: url.hostname, port: Number(url.port), path, method: "GET", headers, setHost: false }, (res) => {
      res.resume();
      resolvePromise(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

test("control plane serves shared state, runs a task and streams events", async () => {
  const home = tempRoot();
  const repo = tempRoot();
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "# t\n");
  const cp = await start({ home, port: 0 });
  try {
    const health = await api<{ ok: boolean }>(cp.url, "GET", "/health");
    assert.equal(health.ok, true);
    assert.ok(existsSync(join(home, "control-plane.json")), "lock file written");

    const project = await api<{ id: string }>(cp.url, "POST", "/api/projects", { path: repo, name: "cp" });
    const node = process.execPath.includes(" ") ? `"${process.execPath}"` : process.execPath;
    const task = await api<{ id: string; status: string }>(cp.url, "POST", "/api/tasks", { projectId: project.id, title: "via http", command: `${node} -e "console.log('hi')"`, status: "READY" });
    assert.equal(task.status, "READY");

    const received: string[] = [];
    const controller = new AbortController();
    const streaming = (async () => {
      const response = await fetch(`${cp.url}/api/events/stream?taskId=${task.id}&since=0`, { signal: controller.signal });
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let i: number;
        while ((i = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, i);
          buffer = buffer.slice(i + 2);
          const line = block.split("\n").find((l) => l.startsWith("event: "));
          if (line) received.push(line.slice(7));
          if (line === "event: TASK_COMPLETED") return;
        }
      }
    })();

    const run = await api<{ executionId: string; task: { status: string } }>(cp.url, "POST", `/api/tasks/${task.id}/run`, {});
    assert.ok(run.executionId.startsWith("exe_"));
    await Promise.race([streaming, new Promise((_, reject) => setTimeout(() => reject(new Error("stream timeout")), 15000))]);
    controller.abort();
    assert.ok(received.includes("COMMAND_OUTPUT"), "live output reaches SSE subscribers");
    assert.ok(received.includes("TASK_COMPLETED"));

    const detail = await api<{ status: string; evidence: unknown[]; executions: unknown[] }>(cp.url, "GET", `/api/tasks/${task.id}`);
    assert.equal(detail.status, "DONE");
    assert.equal(detail.executions.length, 1);
    const context = await api<{ sections: unknown[]; prompt: string }>(cp.url, "GET", `/api/tasks/${task.id}/context`);
    assert.ok(context.prompt.includes("via http"));
    const status = await api<{ tasks: { DONE: number } }>(cp.url, "GET", "/api/status");
    assert.equal(status.tasks.DONE, 1);
    const missing = await fetch(`${cp.url}/api/tasks/nope`);
    assert.equal(missing.status, 404);
    const bad = await fetch(`${cp.url}/api/tasks/${task.id}/status`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ to: "WORKING" }) });
    assert.equal(bad.status, 500);
    assert.match(((await bad.json()) as { error: string }).error, /Cannot move task/);
  } finally {
    await cp.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a flow is created, validated, run and read back over HTTP", async () => {
  const home = tempRoot();
  const repo = tempRoot();
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  const cp = await start({ home, port: 0 });
  // Quote it: this machine's node lives under a path with a space in it.
  const node = process.execPath.includes(" ") ? `"${process.execPath}"` : process.execPath;
  try {
    const project = await api<{ id: string }>(cp.url, "POST", "/api/projects", { path: repo, name: "flow-http" });

    // An empty flow is created, and says plainly that it cannot run yet rather than offering Run.
    const flow = await api<{ id: string }>(cp.url, "POST", "/api/flows", { projectId: project.id, name: "check then report" });
    const empty = await api<{ problems: { message: string }[] }>(cp.url, "GET", `/api/flows/${flow.id}`);
    assert.ok(empty.problems.some((p) => /at least one step/.test(p.message)));
    const refused = await fetch(`${cp.url}/api/flows/${flow.id}/run`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(refused.status, 400, "an unrunnable flow is refused, not started and failed");

    // Draw a real graph: run a command, branch on what it printed, act on the branch.
    const nodes = [
      { id: "probe", kind: "shell", label: "probe", x: 0, y: 0, command: `${node} -e "console.log('VERSION=2')"` },
      { id: "gate", kind: "condition", label: "is it v2?", x: 240, y: 0, expression: '{{probe.output}} contains "VERSION=2"' },
      { id: "yes", kind: "shell", label: "note it", x: 480, y: -60, command: `${node} -e "require('fs').writeFileSync('noted.txt','v2')"` },
      { id: "no", kind: "shell", label: "should not run", x: 480, y: 60, command: `${node} -e "require('fs').writeFileSync('wrong.txt','x')"` },
    ];
    const edges = [
      { id: "e1", from: "probe", to: "gate", when: null },
      { id: "e2", from: "gate", to: "yes", when: "true" },
      { id: "e3", from: "gate", to: "no", when: "false" },
    ];
    const saved = await api<{ problems: unknown[] }>(cp.url, "PATCH", `/api/flows/${flow.id}`, { nodes, edges });
    assert.deepEqual(saved.problems, [], "a complete graph has nothing wrong with it");

    const started = await api<{ started: boolean; steps: number }>(cp.url, "POST", `/api/flows/${flow.id}/run`, {});
    assert.equal(started.started, true);
    assert.equal(started.steps, 4);

    // A second run while the first is in flight is refused rather than racing it.
    const again = await fetch(`${cp.url}/api/flows/${flow.id}/run`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(again.status, 409);

    const deadline = Date.now() + 30_000;
    let runs: { id: string; status: string }[] = [];
    while (Date.now() < deadline) {
      runs = await api<{ id: string; status: string }[]>(cp.url, "GET", `/api/flows/${flow.id}/runs`);
      if (runs[0] && runs[0].status !== "RUNNING") break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.equal(runs[0]?.status, "PASSED", `the flow ran to completion: ${JSON.stringify(runs[0])}`);

    const detail = await api<{ steps: { nodeId: string; status: string; detail: string | null }[] }>(cp.url, "GET", `/api/flow-runs/${runs[0]!.id}`);
    const byNode = new Map(detail.steps.map((s) => [s.nodeId, s]));
    assert.equal(byNode.get("yes")?.status, "PASSED");
    assert.equal(byNode.get("no")?.status, "SKIPPED", "the branch not taken is skipped, not passed");
    assert.ok(existsSync(join(repo, "noted.txt")));
    assert.equal(existsSync(join(repo, "wrong.txt")), false);

    await api(cp.url, "DELETE", `/api/flows/${flow.id}`);
    assert.deepEqual(await api(cp.url, "GET", `/api/flows?projectId=${project.id}`), []);
  } finally {
    await cp.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("artifacts are served raw, edited into new versions, and binaries are refused as text", async () => {
  const home = tempRoot();
  const repo = tempRoot();
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  writeFileSync(join(repo, "page.html"), "<h1>worker output</h1>");
  writeFileSync(join(repo, "shot.png"), png);
  const cp = await start({ home, port: 0 });
  try {
    const project = await api<{ id: string }>(cp.url, "POST", "/api/projects", { path: repo, name: "art" });
    const page = cp.dev.artifacts.add({ projectId: project.id, kind: "report", name: "page", path: join(repo, "page.html") });
    const shot = cp.dev.artifacts.add({ projectId: project.id, kind: "screenshot", name: "shot", path: join(repo, "shot.png") });

    const head = await api<{ media: { form: string; text: boolean }; content: string; editable: boolean; language: string | null }>(cp.url, "GET", `/api/artifacts/${page.id}/content`);
    assert.equal(head.media.form, "html");
    assert.equal(head.language, "html");
    assert.equal(head.content, "<h1>worker output</h1>");
    assert.equal(head.editable, true);

    const rawPng = await fetch(`${cp.url}/api/artifacts/${shot.id}/raw`);
    assert.equal(rawPng.headers.get("content-type"), "image/png");
    assert.equal(rawPng.headers.get("x-content-type-options"), "nosniff");
    assert.ok((rawPng.headers.get("content-security-policy") ?? "").includes("default-src 'none'"), "preview bytes are locked down");
    assert.deepEqual(Buffer.from(await rawPng.arrayBuffer()), png, "binary survives the round trip byte for byte");

    const binHead = await api<{ content: string; editable: boolean }>(cp.url, "GET", `/api/artifacts/${shot.id}/content`);
    assert.equal(binHead.editable, false, "an image is not offered as editable text");
    assert.equal(binHead.content, "");

    const v2 = await api<{ id: string; path: string; meta: Record<string, unknown> }>(cp.url, "POST", `/api/artifacts/${page.id}/revise`, { content: "<h1>edited</h1>" });
    assert.equal(v2.meta.version, 2);
    const rawV2 = await fetch(`${cp.url}/api/artifacts/${v2.id}/raw`);
    assert.equal(await rawV2.text(), "<h1>edited</h1>");
    const original = await fetch(`${cp.url}/api/artifacts/${page.id}/raw`);
    assert.equal(await original.text(), "<h1>worker output</h1>", "the worker's file is untouched");

    const versions = await api<{ id: string }[]>(cp.url, "GET", `/api/artifacts/${v2.id}/versions`);
    assert.deepEqual(versions.map((a) => a.id), [page.id, v2.id]);

    await assert.rejects(api(cp.url, "POST", `/api/artifacts/${shot.id}/revise`, { content: "nope" }), /not a text artifact/);
    await assert.rejects(api(cp.url, "POST", `/api/artifacts/${page.id}/revise`, {}), /"content" is required/);
  } finally {
    await cp.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a web page cannot drive the control plane, while DEV's own window can", async () => {
  const home = tempRoot();
  const cp = await start({ home, port: 0 });
  try {
    // The threat: a page the user has open in a browser posting to loopback.
    // Without an Origin check this creates and could run a task on their machine.
    const attacker = await fetch(`${cp.url}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ path: home, name: "pwned" }),
    });
    assert.equal(attacker.status, 403);
    assert.equal(attacker.headers.get("access-control-allow-origin"), null, "no CORS grant is handed to an untrusted origin");
    assert.match(((await attacker.json()) as { error: string }).error, /not allowed/i);

    // A browser preflight from the same attacker is refused before the request is made.
    const preflight = await fetch(`${cp.url}/api/projects`, { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "POST" } });
    assert.equal(preflight.status, 403);

    // DEV's own window, however it is served, keeps working.
    for (const origin of ["tauri://localhost", "http://tauri.localhost", "http://localhost:1420", "http://127.0.0.1:1420"]) {
      const allowed = await fetch(`${cp.url}/health`, { headers: { origin } });
      assert.equal(allowed.status, 200, `${origin} must be allowed`);
      assert.equal(allowed.headers.get("access-control-allow-origin"), origin, `${origin} is echoed back, never a wildcard`);
      assert.equal(allowed.headers.get("vary"), "Origin");
    }

    // The CLI and other local tools send no Origin at all and are unaffected.
    const cli = await fetch(`${cp.url}/health`);
    assert.equal(cli.status, 200);
    assert.equal(cli.headers.get("access-control-allow-origin"), null);

    // DNS rebinding: a name that resolves to 127.0.0.1 still fails the Host
    // check. fetch refuses to set Host, so the request is made by hand.
    const rebound = await rawGet(cp.url, "/health", { host: "evil.example" });
    assert.equal(rebound, 403);
    assert.equal(await rawGet(cp.url, "/health", { host: "127.0.0.1" }), 200, "the real loopback host still works");

    // The event stream must not leak either: it is the whole activity of the machine.
    const stream = await fetch(`${cp.url}/api/events/stream?since=0`, { headers: { origin: "https://evil.example" } });
    assert.equal(stream.status, 403);
    await stream.body?.cancel();

    // Sandboxed iframes (worker HTML previews) send Origin: null. That used to skip the check.
    const opaque = await fetch(`${cp.url}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "null" },
      body: JSON.stringify({ path: home, name: "pwned-null" }),
    });
    assert.equal(opaque.status, 403);
  } finally {
    await cp.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("an autopilot limit of 0 means zero, not unlimited", async () => {
  const home = tempRoot();
  const repo = tempRoot();
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "# t");
  const cp = await start({ home, port: 0 });
  try {
    const project = await api<{ id: string }>(cp.url, "POST", "/api/projects", { path: repo, name: "limit" });
    const node = process.execPath.includes(" ") ? `"${process.execPath}"` : process.execPath;
    await api(cp.url, "POST", "/api/tasks", { projectId: project.id, title: "should not run", command: `${node} -e "console.log('ran')"`, status: "READY" });

    // A limit of zero used to be read as falsy and became an unbounded run,
    // which is the opposite of what someone asking for zero wants.
    await api(cp.url, "POST", `/api/projects/${project.id}/auto`, { promoteBacklog: true, maxTasks: 0 });
    await new Promise((r) => setTimeout(r, 1500));
    const tasks = await api<{ status: string }[]>(cp.url, "GET", `/api/tasks?projectId=${project.id}`);
    assert.equal(tasks[0]?.status, "READY", "the task must be untouched by a zero-task run");

    await assert.rejects(api(cp.url, "POST", `/api/projects/${project.id}/auto`, { maxTasks: "many" }), /must be a number/);
  } finally {
    await cp.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("autopilot promotes a backlog task over HTTP and records AUTO_RUN events", async () => {
  const home = tempRoot();
  const repo = tempRoot();
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "# t");
  const cp = await start({ home, port: 0 });
  const node = process.execPath.includes(" ") ? `"${process.execPath}"` : process.execPath;
  try {
    const project = await api<{ id: string }>(cp.url, "POST", "/api/projects", { path: repo, name: "promote-http" });
    const task = await api<{ id: string }>(cp.url, "POST", "/api/tasks", {
      projectId: project.id,
      title: "from backlog",
      command: `${node} -e "require('fs').writeFileSync('from-auto.txt','ok')"`,
      status: "BACKLOG",
    });
    await api(cp.url, "POST", `/api/projects/${project.id}/auto`, { promoteBacklog: true, maxTasks: 1 });
    const deadline = Date.now() + 15_000;
    let status = "BACKLOG";
    while (Date.now() < deadline) {
      const live = await api<{ status: string }>(cp.url, "GET", `/api/tasks/${task.id}`);
      status = live.status;
      if (status === "DONE" || status === "BLOCKED") break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.equal(status, "DONE");
    const events = await api<{ type: string }[]>(cp.url, "GET", `/api/events?projectId=${project.id}&types=AUTO_RUN_STARTED,AUTO_RUN_FINISHED&limit=20`);
    assert.ok(events.some((e) => e.type === "AUTO_RUN_STARTED"));
    assert.ok(events.some((e) => e.type === "AUTO_RUN_FINISHED"));
  } finally {
    await cp.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a project that requires approval files the commit as an approval, and approving it performs the commit", async () => {
  const home = tempRoot();
  const repo = tempRoot();
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "t@example.invalid"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "# t");
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });
  mkdirSync(join(repo, ".dev"), { recursive: true });
  writeFileSync(join(repo, ".dev", "config.json"), JSON.stringify({ approvals: { requireForCommit: true } }));
  const cp = await start({ home, port: 0 });
  try {
    const project = await api<{ id: string }>(cp.url, "POST", "/api/projects", { path: repo, name: "gated" });
    writeFileSync(join(repo, "notes.md"), "gated change");

    const response = await fetch(`${cp.url}/api/projects/${project.id}/git/commit`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "docs: add notes" }) });
    assert.equal(response.status, 202, "accepted for approval, not performed");
    const filed = (await response.json()) as { approvalRequired: boolean; approval: { id: string; action: string; reason: string; status: string } };
    assert.equal(filed.approvalRequired, true);
    assert.equal(filed.approval.action, "git.commit");
    assert.equal(filed.approval.reason, "docs: add notes");
    assert.equal(execFileSync("git", ["log", "--oneline"], { cwd: repo }).toString().trim().split("\n").length, 1, "nothing committed yet");

    const pending = await api<{ id: string }[]>(cp.url, "GET", "/api/approvals?status=pending");
    assert.ok(pending.some((a) => a.id === filed.approval.id), "the approval is visible where the user looks");

    const resolved = await api<{ status: string; performed?: { commit: { subject: string } } }>(cp.url, "POST", `/api/approvals/${filed.approval.id}/resolve`, { status: "approved", note: "fine" });
    assert.equal(resolved.status, "approved");
    assert.equal(resolved.performed?.commit.subject, "docs: add notes", "approving performed the commit with the filed message");
    assert.equal(execFileSync("git", ["log", "--oneline"], { cwd: repo }).toString().trim().split("\n").length, 2);

    // Denying a filed commit leaves the tree exactly as it was.
    writeFileSync(join(repo, "more.md"), "another");
    const second = (await (await fetch(`${cp.url}/api/projects/${project.id}/git/commit`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "docs: more" }) })).json()) as { approval: { id: string } };
    const denied = await api<{ status: string; performed?: unknown }>(cp.url, "POST", `/api/approvals/${second.approval.id}/resolve`, { status: "denied" });
    assert.equal(denied.status, "denied");
    assert.equal(denied.performed, undefined);
    assert.equal(execFileSync("git", ["log", "--oneline"], { cwd: repo }).toString().trim().split("\n").length, 2, "denied means not committed");
  } finally {
    await cp.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a push is filed for approval by default, approving it performs the push, and a project can turn the gate off", async () => {
  const home = tempRoot();
  const repo = tempRoot();
  const remote = tempRoot();
  execFileSync("git", ["init", "-q", "--bare", "-b", "main"], { cwd: remote });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "t@example.invalid"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "# t");
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });
  const cp = await start({ home, port: 0 });
  try {
    const project = await api<{ id: string }>(cp.url, "POST", "/api/projects", { path: repo, name: "pushy" });

    // Default: pushing leaves the machine, so it waits for the person.
    const response = await fetch(`${cp.url}/api/projects/${project.id}/git/push`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(response.status, 202);
    const filed = (await response.json()) as { approvalRequired: boolean; approval: { id: string; action: string; reason: string } };
    assert.equal(filed.approval.action, "git.push");
    assert.match(filed.approval.reason, /Push main to origin \(sets the upstream\)/);
    assert.throws(() => execFileSync("git", ["rev-parse", "--verify", "main"], { cwd: remote, stdio: "pipe" }), "nothing has reached the remote yet");

    const resolved = await api<{ status: string; performed?: { push: { branch: string; remote: string } } }>(cp.url, "POST", `/api/approvals/${filed.approval.id}/resolve`, { status: "approved" });
    assert.equal(resolved.performed?.push.branch, "main");
    assert.equal(execFileSync("git", ["rev-parse", "main"], { cwd: remote }).toString().trim(), execFileSync("git", ["rev-parse", "main"], { cwd: repo }).toString().trim(), "the remote now has the commit");

    // Only the global settings may waive the gate (a project can demand it, never drop it);
    // then the push happens directly.
    writeFileSync(join(home, "config.json"), JSON.stringify({ approvals: { requireForPush: false } }));
    writeFileSync(join(repo, "more.md"), "more");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-q", "-m", "more"], { cwd: repo });
    const direct = await api<{ branch: string; remote: string }>(cp.url, "POST", `/api/projects/${project.id}/git/push`, {});
    assert.equal(direct.remote, "origin");
    assert.equal(execFileSync("git", ["log", "--oneline", "main"], { cwd: remote }).toString().trim().split("\n").length, 2);
  } finally {
    await cp.close();
    for (const dir of [home, repo, remote]) rmSync(dir, { recursive: true, force: true });
  }
});

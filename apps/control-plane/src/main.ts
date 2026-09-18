import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { openDev, seedIfFirstRun, type Dev } from "@dev/core";

import { createControlPlane } from "./server.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const VERSION = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).version as string;

export interface StartOptions {
  home: string;
  host?: string;
  port?: number;
}

export async function start(options: StartOptions): Promise<{ url: string; close: () => Promise<void>; dev: Dev }> {
  const dev = openDev({ home: options.home });
  const host = options.host ?? dev.config.controlPlane.host;
  const port = options.port ?? dev.config.controlPlane.port;
  // Anything still "running" from a previous life of this process is gone. Fail the execution and
  // take its task out of WORKING with a reason, so nothing sits stuck with no explanation.
  // A brand-new installation gets the guide rather than an empty board. Only
  // ever on a truly empty database, and never again once anything exists.
  const seeded = seedIfFirstRun(dev);
  if (seeded) console.error(`[control-plane] first run: seeded "${seeded.project.name}" with ${seeded.tasks.length} steps`);
  const reaped = dev.executions.reapStale(0);
  for (const { executionId, taskId } of reaped) {
    const task = dev.tasks.get(taskId);
    if (!task || task.status !== "WORKING") continue;
    dev.tasks.block(taskId, {
      kind: "abandoned",
      reason: "The run was cut off because the control plane restarted while it was working. Its log up to that moment is kept, but it never finished, so no result or evidence was recorded.",
      nextAction: "Read the log on the Execution tab to see how far it got, check the repository for half-finished work, then run the task again.",
      executionId,
    });
  }
  const { server } = createControlPlane(dev, { version: VERSION });
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolvePromise());
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const url = `http://${host}:${actualPort}`;
  const infoPath = join(options.home, "control-plane.json");
  writeFileSync(infoPath, JSON.stringify({ pid: process.pid, host, port: actualPort, url, startedAt: new Date().toISOString(), version: VERSION }, null, 2));
  if (reaped.length > 0) console.error(`[control-plane] marked ${reaped.length} abandoned execution(s) as failed and unblocked their tasks`);
  // Probe workers once in the background so the UI shows real health without a manual check.
  void dev.workers.checkAll().catch(() => undefined);
  const close = () =>
    new Promise<void>((resolvePromise) => {
      server.close(() => {
        dev.close();
        if (existsSync(infoPath)) {
          try {
            const current = JSON.parse(readFileSync(infoPath, "utf8")) as { pid?: number };
            if (current.pid === process.pid) rmSync(infoPath);
          } catch {
            // ignore
          }
        }
        resolvePromise();
      });
    });
  return { url, close, dev };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const home = resolve(get("--home") ?? process.env.DEV_HOME ?? join(REPO_ROOT, ".dev-home"));
  const port = get("--port") ? Number(get("--port")) : undefined;
  start({ home, port })
    .then(({ url, close }) => {
      console.error(`[control-plane] DEV ${VERSION} listening on ${url} (home ${home})`);
      const shutdown = () => {
        close().finally(() => process.exit(0));
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      process.on("message", (m) => {
        if (m === "shutdown") shutdown();
      });
    })
    .catch((error: Error) => {
      console.error(`[control-plane] failed to start: ${error.message}`);
      process.exit(1);
    });
}

import { spawn, spawnSync, type ChildProcess } from "node:child_process";

export interface ProcessOptions {
  command: string;
  args?: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Called for every chunk. Keep it cheap; this is the live output path. */
  onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
  /** Run through the platform shell (cmd.exe / sh). Use for user-authored commands only. */
  shell?: boolean;
  maxCapturedBytes?: number;
}

export interface ProcessResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  launchError: string | null;
}

/**
 * Spawn a process with a timeout, cancellation and bounded capture.
 * On Windows the whole process tree is killed (taskkill /T), because agent
 * CLIs spawn children that would otherwise outlive the worker.
 */
export function runProcess(options: ProcessOptions): Promise<ProcessResult> {
  const started = Date.now();
  const cap = options.maxCapturedBytes ?? 2_000_000;
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let cancelled = false;

  return new Promise((resolvePromise) => {
    let child: ChildProcess;
    try {
      child = spawn(options.command, options.args ?? [], {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        shell: options.shell ? (process.platform === "win32" ? "cmd.exe" : "/bin/sh") : false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      resolvePromise({
        exitCode: null,
        signal: null,
        timedOut,
        cancelled,
        durationMs: Date.now() - started,
        stdout,
        stderr,
        launchError: (error as Error).message,
      });
      return;
    }

    let settled = false;
    const finish = (result: Omit<ProcessResult, "durationMs" | "stdout" | "stderr" | "timedOut" | "cancelled">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolvePromise({ ...result, timedOut, cancelled, durationMs: Date.now() - started, stdout, stderr });
    };

    const kill = () => killTree(child);
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          kill();
        }, options.timeoutMs)
      : undefined;
    const onAbort = () => {
      cancelled = true;
      kill();
    };
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }

    child.on("error", (error) => {
      finish({ exitCode: null, signal: null, launchError: error.message });
    });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < cap) stdout += chunk;
      options.onOutput?.(chunk, "stdout");
    });
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < cap) stderr += chunk;
      options.onOutput?.(chunk, "stderr");
    });
    child.on("close", (code, signal) => {
      finish({ exitCode: code, signal: signal ?? null, launchError: null });
    });

    if (options.stdin !== undefined) {
      child.stdin?.on("error", () => {});
      child.stdin?.end(options.stdin);
    } else {
      child.stdin?.end();
    }
  });
}

function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

/** Resolve a command on PATH. Returns the full path or null. */
export function which(command: string): string | null {
  const probe = process.platform === "win32" ? spawnSync("where.exe", [command], { encoding: "utf8", windowsHide: true }) : spawnSync("sh", ["-c", `command -v ${command}`], { encoding: "utf8" });
  if (probe.status !== 0) return null;
  const candidates = probe.stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  // Microsoft Store "app execution aliases" under WindowsApps are reparse points that ConPTY and
  // some spawners cannot launch; prefer a real binary when one exists.
  return candidates.find((c) => !/\\WindowsApps\\/i.test(c)) ?? candidates[0] ?? null;
}

/**
 * Resolve how to launch a CLI on this platform. Windows `.cmd`/`.bat` shims
 * (npm global installs) need cmd.exe; real executables are spawned directly,
 * which keeps arguments intact and avoids shell quoting entirely.
 */
export function launchSpec(command: string, args: string[]): { command: string; args: string[]; shell: boolean } {
  if (process.platform !== "win32") return { command, args, shell: false };
  const resolved = which(command) ?? command;
  if (/\.(cmd|bat)$/i.test(resolved)) {
    const quoted = [resolved, ...args].map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(" ");
    return { command: quoted, args: [], shell: true };
  }
  return { command: resolved, args, shell: false };
}

/** Run a short command synchronously for probes (`git --version`). */
export function probeCommand(command: string, args: string[], timeoutMs = 15_000): { ok: boolean; output: string } {
  const spec = launchSpec(command, args);
  const result = spawnSync(spec.command, spec.args, { encoding: "utf8", windowsHide: true, timeout: timeoutMs, shell: spec.shell });
  if (result.error) return { ok: false, output: result.error.message };
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return { ok: result.status === 0, output };
}

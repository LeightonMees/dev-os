import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDev, type Dev, type DevConfig } from "../src/index.ts";
import type { DeepPartial } from "../src/dev.ts";

/** Temp roots stay off the OS disk when F:\tmp exists (disk law for this machine). */
export function tempRoot(): string {
  const preferred = process.env.DEV_TEST_TMP ?? (process.platform === "win32" && existsSync("F:\\tmp") ? "F:\\tmp\\dev-tests" : tmpdir());
  mkdirSync(preferred, { recursive: true });
  return mkdtempSync(join(preferred, "t-"));
}

export interface TestDev {
  dev: Dev;
  home: string;
  cleanup: () => void;
}

/** Config overrides that keep tests off the real CLI agents, so probes fail fast. */
export function fastWorkerConfig(options: { nexus?: boolean } = {}): DeepPartial<DevConfig> {
  return {
    nexus: { enabled: options.nexus ?? false, command: "node", args: [], timeoutMs: 1000 },
    workers: {
      preferences: ["shell"],
      timeoutMs: 60_000,
      claudeCode: { command: "definitely-not-installed-claude", model: null, effort: null, permissionMode: "acceptEdits" },
      codex: { command: "definitely-not-installed-codex", model: null },
      ollama: { baseUrl: "http://127.0.0.1:1", model: "none" },
    },
  };
}

export function openTestDev(options: { nexus?: boolean } = {}): TestDev {
  const home = tempRoot();
  const dev = openDev({
    home,
    config: fastWorkerConfig(options),
  });
  return {
    dev,
    home,
    cleanup: () => {
      dev.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** A throwaway git repository with one committed file. */
export function tempRepo(): { path: string; cleanup: () => void } {
  const path = tempRoot();
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: path });
  execFileSync("git", ["config", "user.email", "dev-tests@example.invalid"], { cwd: path });
  execFileSync("git", ["config", "user.name", "DEV tests"], { cwd: path });
  writeFileSync(join(path, "README.md"), "# temp\n");
  execFileSync("git", ["add", "-A"], { cwd: path });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: path });
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

export const nodeExe = process.execPath.includes(" ") ? `"${process.execPath}"` : process.execPath;

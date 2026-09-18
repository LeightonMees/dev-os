import { accessSync, constants, existsSync } from "node:fs";
import { join } from "node:path";

import type { Dev } from "./dev.ts";
import { probeCommand, which } from "./execution/process.ts";
import type { DoctorCheck } from "./schemas.ts";

/** Environment health with remediation. Every check is a real probe. */
export async function doctor(dev: Dev, options: { desktop?: boolean } = {}): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  try {
    accessSync(dev.home, constants.W_OK);
    checks.push({ name: "home", status: "ok", detail: dev.home });
  } catch {
    checks.push({ name: "home", status: "failed", detail: `${dev.home} is not writable`, remediation: "Set DEV_HOME to a writable directory" });
  }

  try {
    const version = dev.db.version();
    const integrity = dev.db.get("PRAGMA integrity_check")?.integrity_check;
    checks.push({ name: "database", status: integrity === "ok" ? "ok" : "failed", detail: `${dev.db.path} (schema v${version}, integrity ${String(integrity)})` });
  } catch (error) {
    checks.push({ name: "database", status: "failed", detail: (error as Error).message, remediation: "Delete the database file to recreate it (all DEV state is lost) or restore from a copy" });
  }

  const configFile = join(dev.home, "config.json");
  if (dev.configWarnings.length === 0) {
    checks.push({ name: "config", status: "ok", detail: existsSync(configFile) ? configFile : `${configFile} (not written yet, defaults in use)` });
  } else {
    checks.push({
      name: "config",
      status: "warning",
      detail: dev.configWarnings.map((warning) => `${warning.key}: ${warning.message}`).join("; "),
      remediation: `Fix the listed keys in ${configFile} or remove them to keep the defaults`,
    });
  }

  const node = process.versions.node;
  const major = Number(node.split(".")[0]);
  checks.push({ name: "node", status: major >= 24 ? "ok" : "failed", detail: `v${node}`, remediation: major >= 24 ? undefined : "Install Node 24 or newer (node:sqlite and native TypeScript are required)" });

  const git = probeCommand("git", ["--version"]);
  checks.push({ name: "git", status: git.ok ? "ok" : "failed", detail: git.ok ? git.output : "git not found", remediation: git.ok ? undefined : "Install Git and make sure it is on PATH" });

  for (const worker of dev.workers.all()) {
    const health = await dev.workers.check(worker.id);
    checks.push({
      name: `worker:${worker.id}`,
      status: health.ok ? "ok" : worker.id === "shell" ? "failed" : "warning",
      detail: health.detail,
      remediation: health.ok ? undefined : remediationFor(worker.id),
    });
  }

  if (dev.config.nexus.enabled) {
    try {
      const status = await dev.nexus.status();
      checks.push({ name: "nexus", status: "ok", detail: `${status.skills} skills, ${status.mcps} MCPs, ${status.apis} APIs, ${status.workflows} workflows at ${status.root}` });
    } catch (error) {
      checks.push({ name: "nexus", status: "warning", detail: (error as Error).message, remediation: `Check nexus.command / nexus.args in ${join(dev.home, "config.json")} or set nexus.enabled=false` });
    }
  } else {
    checks.push({ name: "nexus", status: "warning", detail: "disabled in config", remediation: "dev config set nexus.enabled true" });
  }

  const shell = dev.config.terminal.shell ?? (process.platform === "win32" ? (which("pwsh") ? "pwsh" : "powershell") : process.env.SHELL ?? "/bin/sh");
  const shellPath = which(shell) ?? (existsSync(shell) ? shell : null);
  checks.push({ name: "shell", status: shellPath ? "ok" : "failed", detail: shellPath ? `${shell} at ${shellPath}` : `${shell} not found`, remediation: shellPath ? undefined : "Set terminal.shell to an installed shell" });

  for (const project of dev.projects.list({ lifecycle: ["ACTIVE", "NEXT"] })) {
    if (!project.path) {
      checks.push({ name: `project:${project.name}`, status: "warning", detail: "no repository yet", remediation: `dev project new ${project.name} or dev project set path <dir> --project ${project.id}` });
      continue;
    }
    const ok = existsSync(project.path);
    checks.push({ name: `project:${project.name}`, status: ok ? "ok" : "failed", detail: ok ? project.path : `${project.path} is missing`, remediation: ok ? undefined : `Restore the directory or remove the project: dev project remove ${project.id}` });
  }

  if (options.desktop) {
    const cargo = probeCommand("cargo", ["--version"]);
    checks.push({ name: "desktop:cargo", status: cargo.ok ? "ok" : "warning", detail: cargo.ok ? cargo.output : "cargo not found", remediation: cargo.ok ? undefined : "Install Rust (rustup) to build the desktop app" });
    if (process.platform === "win32") {
      const webview = ["C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\Application", "C:\\Program Files\\Microsoft\\EdgeWebView\\Application"].find((p) => existsSync(p));
      checks.push({ name: "desktop:webview2", status: webview ? "ok" : "warning", detail: webview ?? "WebView2 runtime not found", remediation: webview ? undefined : "Install the Microsoft Edge WebView2 runtime" });
    }
  }

  return checks;
}

function remediationFor(workerId: string): string {
  switch (workerId) {
    case "claude-code":
      return "Install Claude Code (winget install Anthropic.ClaudeCode) and log in, or set workers.claudeCode.command";
    case "codex":
      return "Install the Codex CLI (npm i -g @openai/codex) and log in, or set workers.codex.command";
    case "ollama":
      return "Start Ollama and pull the configured model (ollama pull <model>), or change workers.ollama.model";
    default:
      return "See the worker's configuration in config.json";
  }
}

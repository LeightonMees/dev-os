import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { test } from "node:test";

import {
  CONFIG_VERSION,
  doctor,
  loadConfigWithWarnings,
  openDev,
  DEFAULT_CONFIG,
  configPath,
  loadConfig,
  projectConfigPath,
  readConfigFile,
  CONFIG_MIGRATIONS,
  CONFIG_UNVERSIONED,
  inspectConfigFile,
  migrateConfigFile,
  resolveConfig,
  resolveConfigFor,
  saveConfig,
  validateConfigPatch,
  writeConfigFile,
} from "../src/index.ts";
import { fastWorkerConfig, tempRoot } from "./helpers.ts";

test("a saved config carries the schema version and reloads unchanged", () => {
  const home = tempRoot();
  try {
    const config = structuredClone(DEFAULT_CONFIG);
    config.chat.maxToolCalls = 4;
    saveConfig(home, config);
    assert.equal(readConfigFile(configPath(home)).version, CONFIG_VERSION);
    assert.equal(loadConfig(home).chat.maxToolCalls, 4);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a file with no version is read through the migrations and a newer version is refused", () => {
  const home = tempRoot();
  try {
    writeFileSync(configPath(home), JSON.stringify({ chat: { maxToolCalls: 3 } }));
    assert.equal(loadConfig(home).chat.maxToolCalls, 3);

    writeFileSync(configPath(home), JSON.stringify({ version: CONFIG_VERSION + 1 }));
    assert.throws(() => loadConfig(home), /newer than this build/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a v0 (unversioned) config is migrated up to the current version on load", () => {
  const home = tempRoot();
  try {
    // A pre-ADR-0001 file: settings, no "version".
    const file = configPath(home);
    writeFileSync(file, JSON.stringify({ chat: { maxToolCalls: 3 }, workers: { timeoutMs: 1234 } }));
    const before = readFileSync(file, "utf8");

    const report = inspectConfigFile(file);
    assert.equal(report.version, CONFIG_UNVERSIONED);
    assert.equal(report.status, "migrated");
    assert.deepEqual(report.applied, CONFIG_MIGRATIONS.map((m) => m.name));
    assert.equal(report.patch.version, CONFIG_VERSION);

    // The values survive the upgrade and the file is only rewritten when asked.
    const config = loadConfig(home);
    assert.equal(config.chat.maxToolCalls, 3);
    assert.equal(config.workers.timeoutMs, 1234);
    assert.equal(readFileSync(file, "utf8"), before);

    saveConfig(home, config);
    assert.equal(readConfigFile(file).version, CONFIG_VERSION);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("migrations walk one version at a time and never mutate their input", () => {
  const data = { chat: { maxToolCalls: 2 } };
  const result = migrateConfigFile(data, CONFIG_VERSION);
  assert.equal(result.fromVersion, CONFIG_UNVERSIONED);
  assert.equal(result.version, CONFIG_VERSION);
  assert.deepEqual(data, { chat: { maxToolCalls: 2 } });
  for (const [index, migration] of CONFIG_MIGRATIONS.entries()) {
    assert.equal(migration.from, index);
    assert.equal(migration.to, index + 1);
  }
  // A file already at the current version is not migrated again.
  assert.equal(migrateConfigFile({ version: CONFIG_VERSION }, CONFIG_VERSION).status, "current");
});

test("a config from a future version is reported and left untouched", () => {
  const home = tempRoot();
  try {
    const file = configPath(home);
    const future = JSON.stringify({ version: CONFIG_VERSION + 1, chat: { maxToolCalls: 9 } });
    writeFileSync(file, future);

    const report = inspectConfigFile(file);
    assert.equal(report.status, "future");
    assert.equal(report.version, CONFIG_VERSION + 1);
    assert.match(report.problem ?? "", /newer than this build/);
    assert.deepEqual(report.patch, {});

    assert.throws(() => loadConfig(home), /newer than this build/);
    // Nothing rewrites a file it cannot understand.
    assert.throws(() => saveConfig(home, structuredClone(DEFAULT_CONFIG)), /Refusing to overwrite/);
    assert.throws(() => writeConfigFile(file, { chat: { maxToolCalls: 1 } }), /Refusing to overwrite/);
    assert.equal(readFileSync(file, "utf8"), future);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("validation drops unknown keys and wrong types and keeps the rest", () => {
  const result = validateConfigPatch({
    chat: { maxToolCalls: "many" },
    workers: { timeoutMs: 1000, nope: 1 },
    ui: { theme: "neon" },
    privacy: { mode: "LOCAL_ONLY" },
    made: { up: true },
  });
  assert.deepEqual(result.patch, { chat: {}, workers: { timeoutMs: 1000 }, ui: {}, privacy: { mode: "LOCAL_ONLY" } });
  assert.equal(result.errors.length, 4);
  assert.ok(result.errors.some((e) => e.startsWith("chat.maxToolCalls:")));
  assert.ok(result.errors.some((e) => e.includes("workers.nope: unknown config key")));
  assert.ok(result.errors.some((e) => e.startsWith("ui.theme:")));
  assert.ok(result.errors.some((e) => e.includes("made: unknown config key")));
});

test("later scopes win and the effective config records where each value came from", () => {
  const resolved = resolveConfig([
    { scope: "global", patch: { context: { budgetTokens: 5000 }, ui: { theme: "dark" } } },
    { scope: "project", patch: { context: { budgetTokens: 6000 } } },
    { scope: "session", patch: { context: { maxFiles: 2 } } },
    { scope: "task", patch: { context: { budgetTokens: 7000 } } },
  ]);
  assert.deepEqual(resolved.refusals, []);
  assert.equal(resolved.errors.length, 0);
  assert.equal(resolved.config.context.budgetTokens, 7000);
  assert.equal(resolved.config.context.maxFiles, 2);
  assert.equal(resolved.config.ui.theme, "dark");
  assert.equal(resolved.sources["context.budgetTokens"], "task");
  assert.equal(resolved.sources["context.maxFiles"], "session");
  assert.equal(resolved.sources["ui.theme"], "global");
  assert.equal(resolved.sources["chat.maxToolCalls"], "default");
});

test("a lower scope may tighten a restricted key but never loosen it", () => {
  const tightened = resolveConfig([
    { scope: "global", patch: { privacy: { mode: "OPEN" }, workers: { timeoutMs: 600_000 } } },
    { scope: "project", patch: { privacy: { mode: "LOCAL_ONLY" }, workers: { timeoutMs: 1000 } } },
  ]);
  assert.deepEqual(tightened.refusals, []);
  assert.equal(tightened.config.privacy.mode, "LOCAL_ONLY");
  assert.equal(tightened.config.workers.timeoutMs, 1000);

  const loosened = resolveConfig([
    { scope: "global", patch: { privacy: { mode: "LOCAL_ONLY" }, nexus: { enabled: false } } },
    {
      scope: "project",
      source: "repo/.dev/config.json",
      patch: {
        privacy: { mode: "OPEN" },
        approvals: { requireForCommit: false },
        nexus: { enabled: true },
        chat: { maxToolCalls: 999 },
        projects: { defaultDir: "C:\\elsewhere" },
        context: { maxFiles: 3 },
      },
    },
  ]);
  assert.equal(loosened.config.privacy.mode, "LOCAL_ONLY");
  assert.equal(loosened.config.projects.defaultDir, DEFAULT_CONFIG.projects.defaultDir);
  assert.equal(loosened.config.chat.maxToolCalls, DEFAULT_CONFIG.chat.maxToolCalls);
  assert.equal(loosened.config.context.maxFiles, 3, "unrestricted keys in the same file still apply");
  const keys = loosened.refusals.map((r) => r.key).sort();
  assert.deepEqual(keys, ["chat.maxToolCalls", "nexus.enabled", "privacy.mode", "projects.defaultDir"]);
  assert.ok(loosened.refusals.every((r) => r.scope === "project" && r.source === "repo/.dev/config.json" && r.reason));
  assert.equal(loosened.sources["privacy.mode"], "global");
});

test("secrets.files may be narrowed but not extended, and global may set anything", () => {
  const base = { secrets: { files: ["a.env", "b.env"] }, approvals: { requireForCommit: true } };
  const narrowed = resolveConfig([
    { scope: "global", patch: base },
    { scope: "project", patch: { secrets: { files: ["a.env"] } } },
  ]);
  assert.deepEqual(narrowed.config.secrets.files, ["a.env"]);
  assert.deepEqual(narrowed.refusals, []);

  const extended = resolveConfig([
    { scope: "global", patch: base },
    { scope: "task", patch: { secrets: { files: ["a.env", "c.env"] }, approvals: { requireForCommit: false } } },
  ]);
  assert.deepEqual(extended.config.secrets.files, ["a.env", "b.env"]);
  assert.equal(extended.config.approvals.requireForCommit, true);
  assert.deepEqual(extended.refusals.map((r) => r.key).sort(), ["approvals.requireForCommit", "secrets.files"]);
});

test("resolveConfigFor reads the global and project files", () => {
  const home = tempRoot();
  const project = tempRoot();
  const empty = tempRoot();
  try {
    writeConfigFile(configPath(home), { context: { budgetTokens: 5000 }, privacy: { mode: "OPEN" } });
    writeConfigFile(projectConfigPath(project), { context: { maxFiles: 3 }, privacy: { mode: "LOCAL_ONLY" } });
    const resolved = resolveConfigFor({ home, projectDir: project, session: { context: { maxFileTokens: 500 } } });
    assert.equal(resolved.config.context.budgetTokens, 5000);
    assert.equal(resolved.config.context.maxFiles, 3);
    assert.equal(resolved.config.context.maxFileTokens, 500);
    assert.equal(resolved.config.privacy.mode, "LOCAL_ONLY");
    assert.equal(resolved.sources["context.maxFiles"], "project");

    const bare = resolveConfigFor({ home: empty });
    assert.deepEqual(bare.config, DEFAULT_CONFIG);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
    rmSync(empty, { recursive: true, force: true });
  }
});

test("a value of the wrong type falls back to the default and is warned about", () => {
  const home = tempRoot();
  try {
    writeFileSync(configPath(home), JSON.stringify({ chat: { maxToolCalls: "many" }, ui: { theme: "neon" }, context: { budgetTokens: 4321 } }));
    const { config, warnings } = loadConfigWithWarnings(home);
    assert.equal(config.chat.maxToolCalls, DEFAULT_CONFIG.chat.maxToolCalls);
    assert.equal(config.ui.theme, DEFAULT_CONFIG.ui.theme);
    // The valid keys of the same file still apply.
    assert.equal(config.context.budgetTokens, 4321);
    assert.deepEqual(warnings.map((w) => w.key).sort(), ["chat.maxToolCalls", "ui.theme"]);
    assert.ok(warnings.every((w) => w.source === configPath(home)));
    assert.ok(warnings.every((w) => w.message.includes("using the default")));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("unknown keys survive a load and save round trip and are warned about", () => {
  const home = tempRoot();
  try {
    writeFileSync(configPath(home), JSON.stringify({ fromLater: { enabled: true }, workers: { futureKey: 7, timeoutMs: 1234 } }));
    const { config, warnings } = loadConfigWithWarnings(home);
    saveConfig(home, config);

    const written = readConfigFile(configPath(home));
    assert.deepEqual(written.fromLater, { enabled: true });
    assert.equal((written.workers as Record<string, unknown>).futureKey, 7);
    assert.equal((written.workers as Record<string, unknown>).timeoutMs, 1234);
    assert.equal(loadConfig(home).workers.timeoutMs, 1234);
    assert.deepEqual(warnings.map((w) => w.key).sort(), ["fromLater", "workers.futureKey"]);
    assert.ok(warnings.every((w) => w.message.includes("unknown config key")));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("dev doctor reports config warnings and is ok when there are none", async () => {
  const home = tempRoot();
  writeFileSync(configPath(home), JSON.stringify({ chat: { maxToolCalls: "many" } }));
  const dev = openDev({ home, dbPath: ":memory:", config: fastWorkerConfig() });
  try {
    const check = (await doctor(dev)).find((entry) => entry.name === "config");
    assert.ok(check);
    assert.equal(check.status, "warning");
    assert.match(check.detail, /chat\.maxToolCalls/);
    assert.ok(check.remediation);
  } finally {
    dev.close();
    rmSync(home, { recursive: true, force: true });
  }

  const clean = tempRoot();
  const cleanDev = openDev({ home: clean, dbPath: ":memory:", config: fastWorkerConfig() });
  try {
    const check = (await doctor(cleanDev)).find((entry) => entry.name === "config");
    assert.equal(check?.status, "ok");
  } finally {
    cleanDev.close();
    rmSync(clean, { recursive: true, force: true });
  }
});

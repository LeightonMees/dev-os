import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  CONFIG_MIGRATIONS,
  migrateConfigFile,
  type ConfigMigration,
  type ConfigMigrationResult,
} from "./config/migrations.ts";
import {
  CONFIG_SCHEMA,
  CONFIG_SCHEMA_VERSION,
  CONFIG_WRITE_SCOPES,
  PRIVACY_MODES,
  buildDefaultConfig,
  checkConfigValue,
  configFieldFor,
  isConfigField,
  isConfigSection,
  type DevConfigShape,
  type PrivacyMode,
} from "./config/schema.ts";

export { PRIVACY_MODES, CONFIG_MIGRATIONS };
export type { PrivacyMode, ConfigMigration, ConfigMigrationResult };

/**
 * Every setting DEV has. Derived from `CONFIG_SCHEMA`, which also supplies the
 * defaults, the descriptions and the validator, so the four cannot drift apart.
 */
export type DevConfig = DevConfigShape;

export const DEFAULT_CONFIG: DevConfig = buildDefaultConfig();

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(patch)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch)) {
    const current = out[key];
    if (isPlainObject(current) && isPlainObject(value)) out[key] = deepMerge(current, value);
    else if (value !== undefined) out[key] = value;
  }
  return out as T;
}

export function configPath(home: string): string {
  return join(home, "config.json");
}

/** Something wrong with the config file that did not stop DEV from starting. */
export interface ConfigWarning {
  /** Dotted key the warning is about, or "config" when the whole file is at fault. */
  key: string;
  message: string;
  /** The file the value came from. */
  source: string;
}

/**
 * Load the global config, validated against the schema. A value of the wrong
 * type, out of range or not in an enum is dropped and the default stands; the
 * problem is returned as a warning rather than thrown, so a bad file never
 * stops DEV from starting. Unknown keys are kept as written and reported so a
 * typo is visible; `dev doctor` shows both.
 */
export function loadConfigWithWarnings(home: string): { config: DevConfig; warnings: ConfigWarning[] } {
  const source = configPath(home);
  // The global file is one layer of the scope cascade; here it is read on its own.
  const patch = readConfigFile(source);
  // Keys this build has no field for are kept, not dropped: they survive a
  // load/save round trip rather than disappearing from the user's file.
  const config = deepMerge(structuredClone(DEFAULT_CONFIG), unknownParts(patch, CONFIG_SCHEMA, ""));
  const validated = validateConfigPatch(patch);
  const warnings = validated.errors.map((error) => {
    const at = error.indexOf(": ");
    const key = at > 0 ? error.slice(0, at) : "config";
    const problem = at > 0 ? error.slice(at + 2) : error;
    return {
      key,
      message: problem === "unknown config key" ? "unknown config key; kept as written but not used by this build" : `${problem}; using the default`,
      source,
    };
  });
  return { config: deepMerge(config, validated.patch), warnings };
}

export function loadConfig(home: string): DevConfig {
  return loadConfigWithWarnings(home).config;
}

/** The parts of a patch the schema has no field for, keeping their nesting. */
function unknownParts(input: Record<string, unknown>, node: unknown, prefix: string): ConfigPatch {
  const out: ConfigPatch = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === "version" && prefix === "") continue;
    const child = isConfigSection(node) ? node[key] : undefined;
    if (!child) {
      out[key] = value;
      continue;
    }
    if (isConfigField(child) || !isPlainObject(value)) continue;
    const nested = unknownParts(value, child, prefix ? `${prefix}.${key}` : key);
    if (Object.keys(nested).length > 0) out[key] = nested;
  }
  return out;
}

export function saveConfig(home: string, config: DevConfig): void {
  mkdirSync(home, { recursive: true });
  writeConfigFile(configPath(home), config as unknown as ConfigPatch);
}

/** Set a dotted key ("workers.timeoutMs") to a JSON-ish value and persist. */
export function setConfigValue(home: string, key: string, raw: string): DevConfig {
  const config = loadConfig(home);
  const parts = key.split(".");
  let cursor: Record<string, unknown> = config as unknown as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) {
    const next = cursor[part];
    if (!isPlainObject(next)) throw new Error(`Unknown config section "${part}"`);
    cursor = next;
  }
  const last = parts[parts.length - 1] as string;
  if (!(last in cursor)) throw new Error(`Unknown config key "${key}"`);
  let value: unknown = raw;
  if (raw === "null") value = null;
  else if (raw === "true" || raw === "false") value = raw === "true";
  else if (raw.trim() !== "" && !Number.isNaN(Number(raw))) value = Number(raw);
  else if (raw.startsWith("[") || raw.startsWith("{")) value = JSON.parse(raw);
  cursor[last] = value;
  saveConfig(home, config);
  return config;
}

// ---------------------------------------------------------------------------
// Versioned, validated, multi-scope configuration (ADR 0001).
// ---------------------------------------------------------------------------

/** Schema version of a persisted config file. A missing version means 1. */
export const CONFIG_VERSION = CONFIG_SCHEMA_VERSION;

/** Ordered by precedence, lowest first. */
export const CONFIG_SCOPES = ["default", ...CONFIG_WRITE_SCOPES] as const;
export type ConfigScope = (typeof CONFIG_SCOPES)[number];

/** A sparse patch over `DevConfig`. Only keys the writer meant to change. */
export type ConfigPatch = Record<string, unknown>;

/** A restricted key a lower scope tried to loosen. Never silent, never fatal. */
export interface ConfigRefusal {
  scope: ConfigScope;
  key: string;
  value: unknown;
  reason: string;
  /** The file the value came from, when the scope is a file. */
  source?: string;
}

export interface ConfigLayer {
  scope: ConfigScope;
  patch: ConfigPatch;
  source?: string;
}

export interface EffectiveConfig {
  config: DevConfig;
  /** Which scope supplied the current value, by dotted key. */
  sources: Record<string, ConfigScope>;
  refusals: ConfigRefusal[];
  /** Validation problems. The offending key is dropped; the rest of the layer applies. */
  errors: string[];
}

/**
 * Keys a lower-precedence scope (project, session, task) may tighten but never
 * loosen. The global file is the user's own machine and may set any value. The
 * rule in words lives on the schema field; here is what enforces it.
 */
const RESTRICTED: Record<string, (current: unknown, next: unknown) => boolean> = {
  "privacy.mode": (current, next) =>
    PRIVACY_MODES.indexOf(next as PrivacyMode) >= 0 &&
    PRIVACY_MODES.indexOf(next as PrivacyMode) <= PRIVACY_MODES.indexOf(current as PrivacyMode),
  "secrets.files": (current, next) =>
    Array.isArray(next) && Array.isArray(current) && next.every((file) => current.includes(file)),
  "approvals.requireForCommit": (current, next) => next === true || next === current,
  "workers.timeoutMs": (current, next) => typeof next === "number" && typeof current === "number" && next <= current,
  "chat.maxToolCalls": (current, next) => typeof next === "number" && typeof current === "number" && next <= current,
  "nexus.enabled": (current, next) => next === false || next === current,
  "projects.defaultDir": () => false,
};

/** The restricted keys `resolveConfig` enforces. The schema declares the same set. */
export const RESTRICTED_KEYS: readonly string[] = Object.keys(RESTRICTED);

function restrictionReason(key: string): string {
  return configFieldFor(key)?.restricted ?? `${key} may not be loosened by a lower scope`;
}

function leafPaths(value: unknown, prefix = ""): string[] {
  if (!isPlainObject(value)) return prefix ? [prefix] : [];
  const out: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(child)) out.push(...leafPaths(child, path));
    else out.push(path);
  }
  return out;
}

function valueAtPath(root: unknown, path: string): unknown {
  let cursor: unknown = root;
  for (const part of path.split(".")) {
    if (!isPlainObject(cursor)) return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

function deleteAtPath(root: ConfigPatch, path: string): void {
  const parts = path.split(".");
  let cursor: Record<string, unknown> = root;
  for (const part of parts.slice(0, -1)) {
    const next = cursor[part];
    if (!isPlainObject(next)) return;
    cursor = next;
  }
  delete cursor[parts[parts.length - 1] as string];
}

/**
 * Check a sparse patch against the schema. Unknown keys and wrong types are
 * dropped with a readable error; the rest of the patch stands.
 */
export function validateConfigPatch(patch: unknown): { patch: ConfigPatch; errors: string[] } {
  const errors: string[] = [];
  if (!isPlainObject(patch)) return { patch: {}, errors: ["config: expected an object"] };
  const walk = (input: Record<string, unknown>, node: unknown, prefix: string): ConfigPatch => {
    const out: ConfigPatch = {};
    for (const [key, value] of Object.entries(input)) {
      if (key === "version" && prefix === "") continue;
      const path = prefix ? `${prefix}.${key}` : key;
      const child = isConfigSection(node) ? node[key] : undefined;
      if (!child) {
        errors.push(`${path}: unknown config key`);
        continue;
      }
      if (isConfigField(child)) {
        const problem = checkConfigValue(child, value);
        if (problem) errors.push(`${path}: ${problem}`);
        else out[key] = value;
      } else if (!isPlainObject(value)) {
        errors.push(`${path}: expected an object`);
      } else {
        out[key] = walk(value, child, path);
      }
    }
    return out;
  };
  return { patch: walk(patch, CONFIG_SCHEMA, ""), errors };
}

export function projectConfigPath(projectDir: string): string {
  return join(projectDir, ".dev", "config.json");
}

/** What one config file on disk is, and what loading it would do. Never throws. */
export interface ConfigFileReport {
  file: string;
  exists: boolean;
  /** The version the file declares, or null when it could not be parsed. */
  version: number | null;
  status: "absent" | "current" | "migrated" | "future" | "unsupported" | "unreadable";
  /** Names of the migrations that were applied, in order. */
  applied: string[];
  /** Why the file could not be used. When set, the file was left as written. */
  problem?: string;
  /** The migrated contents, or an empty patch when the file could not be used. */
  patch: ConfigPatch;
}

/**
 * Inspect one scope file: parse it, run the migrations up to this build's schema
 * version, and report what happened. A file from a later build, or one with no
 * migration for its version, is reported and left exactly as written - this
 * function never writes, and the writers refuse to overwrite such a file.
 */
export function inspectConfigFile(file: string): ConfigFileReport {
  const empty = { file, applied: [] as string[], patch: {} as ConfigPatch };
  if (!existsSync(file)) return { ...empty, exists: false, version: null, status: "absent" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return { ...empty, exists: true, version: null, status: "unreadable", problem: (error as Error).message };
  }
  if (!isPlainObject(parsed)) {
    return { ...empty, exists: true, version: null, status: "unreadable", problem: "expected a JSON object" };
  }
  let result: ConfigMigrationResult;
  try {
    result = migrateConfigFile(parsed, CONFIG_VERSION);
  } catch (error) {
    return { ...empty, exists: true, version: null, status: "unreadable", problem: (error as Error).message };
  }
  if (result.status === "future" || result.status === "unsupported") {
    return { ...empty, exists: true, version: result.fromVersion, status: result.status, problem: result.reason };
  }
  return {
    file,
    exists: true,
    version: result.fromVersion,
    status: result.status,
    applied: result.applied,
    patch: result.data,
  };
}

/**
 * Read one scope file, upgrading an older schema version through the migrations.
 * Returns an empty patch when the file is absent. Throws on unreadable JSON or a
 * version this build cannot migrate; the file itself is never touched.
 */
export function readConfigFile(file: string): ConfigPatch {
  const report = inspectConfigFile(file);
  if (report.problem) throw new Error(`Could not read ${file}: ${report.problem}`);
  return report.patch;
}

/** Write a sparse scope file with its version, never over a file we cannot read. */
export function writeConfigFile(file: string, patch: ConfigPatch): void {
  const report = inspectConfigFile(file);
  if (report.problem) throw new Error(`Refusing to overwrite ${file}: ${report.problem}`);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify({ version: CONFIG_VERSION, ...patch }, null, 2) + "\n");
}

/**
 * Merge the layers in precedence order over `DEFAULT_CONFIG`, enforcing the
 * restricted keys. Nothing here reads the disk: callers supply the layers.
 */
export function resolveConfig(layers: ConfigLayer[]): EffectiveConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  const sources: Record<string, ConfigScope> = {};
  for (const path of leafPaths(config)) sources[path] = "default";
  const refusals: ConfigRefusal[] = [];
  const errors: string[] = [];

  for (const layer of layers) {
    if (layer.scope === "default") continue;
    const validated = validateConfigPatch(layer.patch);
    for (const error of validated.errors) errors.push(`${layer.source ?? layer.scope}: ${error}`);
    const patch = validated.patch;

    if (layer.scope !== "global") {
      for (const [key, allows] of Object.entries(RESTRICTED)) {
        const next = valueAtPath(patch, key);
        if (next === undefined) continue;
        if (allows(valueAtPath(config, key), next)) continue;
        refusals.push({ scope: layer.scope, key, value: next, reason: restrictionReason(key), source: layer.source });
        deleteAtPath(patch, key);
      }
    }

    for (const path of leafPaths(patch)) sources[path] = layer.scope;
    Object.assign(config, deepMerge(config, patch));
  }

  return { config, sources, refusals, errors };
}

export interface ResolveOptions {
  home: string;
  projectDir?: string | null;
  session?: ConfigPatch | null;
  task?: ConfigPatch | null;
}

/** Read the global and project files, then resolve all four scopes. */
export function resolveConfigFor(options: ResolveOptions): EffectiveConfig {
  const layers: ConfigLayer[] = [
    { scope: "global", patch: readConfigFile(configPath(options.home)), source: configPath(options.home) },
  ];
  if (options.projectDir) {
    const file = projectConfigPath(options.projectDir);
    layers.push({ scope: "project", patch: readConfigFile(file), source: file });
  }
  if (options.session) layers.push({ scope: "session", patch: options.session });
  if (options.task) layers.push({ scope: "task", patch: options.task });
  return resolveConfig(layers);
}

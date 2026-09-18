/**
 * Forward-only migrations for persisted config files (config.json at any scope).
 *
 * A file declares the schema it was written for in `version`. A file with no
 * `version` is version 0: it predates ADR 0001, when config.json was the plain
 * settings object with no stamp. On load the file is walked up one migration at
 * a time until it reaches `CONFIG_SCHEMA_VERSION`.
 *
 * Rules:
 * - Never edit a shipped migration. Add a new one with the next `to`.
 * - A migration takes the whole file (including `version`) and returns the whole
 *   file. It must not read the disk and must not throw.
 * - A file this build cannot understand — a version from the future, or a gap
 *   with no migration for it — is left exactly as written. `migrateConfigFile`
 *   reports that instead of guessing, and the callers refuse to rewrite it.
 */

/** A parsed config file: the sparse settings patch plus its `version`. */
export type ConfigFileData = Record<string, unknown>;

export interface ConfigMigration {
  /** The version this migration reads. */
  readonly from: number;
  /** The version it produces. Always `from + 1`. */
  readonly to: number;
  /** Short name, used when reporting what was applied. */
  readonly name: string;
  readonly migrate: (data: ConfigFileData) => ConfigFileData;
}

/** The version of a file with no `version` key: pre-ADR-0001. */
export const CONFIG_UNVERSIONED = 0;

export const CONFIG_MIGRATIONS: readonly ConfigMigration[] = [
  {
    from: 0,
    to: 1,
    name: "stamp-version",
    // Version 0 is a pre-ADR-0001 file. Its key layout is the same as version 1;
    // the only change is that the file now declares which schema it was written
    // for. Nothing to move, so the upgrade is the stamp itself.
    migrate: (data) => ({ ...data }),
  },
];

export type ConfigMigrationStatus = "current" | "migrated" | "future" | "unsupported";

export interface ConfigMigrationResult {
  /** The upgraded file, or the file exactly as written when it was not upgraded. */
  data: ConfigFileData;
  /** The version `data` is now at. */
  version: number;
  /** The version the file declared before any migration ran. */
  fromVersion: number;
  status: ConfigMigrationStatus;
  /** Names of the migrations applied, in order. */
  applied: string[];
  /** Why the file was left alone. Set when status is "future" or "unsupported". */
  reason?: string;
}

/**
 * The version a parsed file declares. A missing `version` means 0. Throws only
 * when `version` is present and is not a non-negative integer, which means the
 * file is not a config file this build can reason about at all.
 */
export function configFileVersion(data: ConfigFileData): number {
  const raw = data.version;
  if (raw === undefined) return CONFIG_UNVERSIONED;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    throw new Error(`"version" must be a non-negative integer`);
  }
  return raw;
}

/**
 * Walk a parsed config file up to `target`. A file already at `target` is
 * returned unchanged; a file from a later build, or one with no migration for
 * its version, is returned unchanged with a reason. Never mutates its argument.
 */
export function migrateConfigFile(data: ConfigFileData, target: number): ConfigMigrationResult {
  const fromVersion = configFileVersion(data);
  if (fromVersion > target) {
    return {
      data,
      version: fromVersion,
      fromVersion,
      status: "future",
      applied: [],
      reason: `config version ${fromVersion} is newer than this build (${target})`,
    };
  }
  if (fromVersion === target) {
    return { data: { ...data, version: target }, version: target, fromVersion, status: "current", applied: [] };
  }

  let current: ConfigFileData = { ...data };
  let version = fromVersion;
  const applied: string[] = [];
  while (version < target) {
    const step = CONFIG_MIGRATIONS.find((migration) => migration.from === version);
    if (!step) {
      return {
        data,
        version: fromVersion,
        fromVersion,
        status: "unsupported",
        applied: [],
        reason: `no migration from config version ${version} to ${version + 1}`,
      };
    }
    current = { ...step.migrate(current), version: step.to };
    version = step.to;
    applied.push(step.name);
  }
  return { data: current, version, fromVersion, status: "migrated", applied };
}

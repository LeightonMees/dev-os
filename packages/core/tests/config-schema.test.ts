import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CONFIG_FIELDS,
  CONFIG_SCHEMA_VERSION,
  CONFIG_SECTIONS,
  CONFIG_VERSION,
  CONFIG_WRITE_SCOPES,
  DEFAULT_CONFIG,
  RESTRICTED_CONFIG_KEYS,
  RESTRICTED_KEYS,
  buildDefaultConfig,
  checkConfigValue,
  configFieldFor,
  validateConfigPatch,
  type ConfigFieldInfo,
} from "../src/index.ts";

function fieldOf(key: string): ConfigFieldInfo {
  const found = configFieldFor(key);
  if (!found) throw new Error(`the schema has no field "${key}"`);
  return found;
}

/** Every dotted path to a value in a config object. */
function leaves(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return prefix ? [prefix] : [];
  const entries = Object.entries(value);
  if (entries.length === 0) return prefix ? [prefix] : [];
  return entries.flatMap(([key, child]) => leaves(child, prefix ? `${prefix}.${key}` : key));
}

test("the defaults are built from the schema and validate against it", () => {
  const built = buildDefaultConfig();
  assert.deepEqual(built, DEFAULT_CONFIG, "DEFAULT_CONFIG is what the schema declares");
  assert.notEqual(built.workers.preferences, DEFAULT_CONFIG.workers.preferences, "each build is a fresh copy");

  const validated = validateConfigPatch(DEFAULT_CONFIG);
  assert.deepEqual(validated.errors, [], "the defaults have no validation errors");
  assert.deepEqual(validated.patch, DEFAULT_CONFIG, "and nothing in them is dropped");

  for (const field of CONFIG_FIELDS) {
    assert.equal(checkConfigValue(field, field.default), null, `${field.key} default fails its own check`);
  }
});

test("every field describes itself for the Settings UI", () => {
  assert.ok(CONFIG_FIELDS.length > 0);
  for (const field of CONFIG_FIELDS) {
    assert.match(field.key, /^[a-zA-Z]+(\.[a-zA-Z]+)+$/, `${field.key} is not a dotted key`);
    assert.ok(field.label.length > 0, `${field.key} has no label`);
    assert.ok(field.description.length > 10, `${field.key} has no usable description`);
    assert.ok(CONFIG_WRITE_SCOPES.includes(field.scope), `${field.key} has an unknown scope`);
    assert.equal(typeof field.restartRequired, "boolean", `${field.key} has no restart flag`);
    assert.equal(typeof field.active, "boolean", `${field.key} has no active flag`);
    if (field.type === "enum") {
      assert.ok(field.values && field.values.length > 1, `${field.key} is an enum with no values`);
      assert.ok(field.values?.includes(field.default as string), `${field.key} defaults outside its own values`);
    }
    if (field.type === "record") assert.ok(field.valueType, `${field.key} is a record with no value type`);
  }
  const keys = CONFIG_FIELDS.map((f) => f.key);
  assert.equal(new Set(keys).size, keys.length, "field keys are unique");
});

test("the field list and the defaults describe the same keys", () => {
  assert.deepEqual(
    CONFIG_FIELDS.map((f) => f.key).sort(),
    leaves(DEFAULT_CONFIG).sort(),
    "a key in one and not the other means the schema and the defaults have drifted",
  );
  for (const key of leaves(DEFAULT_CONFIG)) assert.ok(configFieldFor(key), `${key} has no field`);
  assert.equal(configFieldFor("workers.nope"), undefined);
});

test("the sections the spec anticipates all exist and carry a title", () => {
  const expected = [
    "user",
    "machine",
    "workers",
    "routing",
    "autonomy",
    "approvals",
    "testing",
    "git",
    "learning",
    "budget",
    "tools",
    "security",
    "notifications",
    "ui",
    "advanced",
  ];
  const names = CONFIG_SECTIONS.map((s) => s.name);
  for (const section of expected) assert.ok(names.includes(section), `no "${section}" section`);
  for (const section of CONFIG_SECTIONS) {
    assert.ok(section.title.length > 0, `${section.name} has no title`);
    assert.ok(section.description.length > 0, `${section.name} has no description`);
    assert.ok(section.fields.length > 0, `${section.name} has no fields`);
  }
  assert.equal(CONFIG_SECTIONS.flatMap((s) => s.fields).length, CONFIG_FIELDS.length, "every field is in one section");
});

test("settings nothing reads yet are marked inactive so the UI can say so", () => {
  const declaredOnly = new Set([
    "user",
    "machine",
    "routing",
    "autonomy",
    "testing",
    "git",
    "learning",
    "budget",
    "tools",
    "security",
    "notifications",
    "advanced",
  ]);
  // A section can be mostly declared-only while one of its settings is live:
  // git.isolation is read by the runner, its neighbours are not yet.
  const live = ["workers.timeoutMs", "workers.agentTimeoutMs", "workers.concurrency", "context.budgetTokens", "ui.theme", "privacy.mode", "nexus.enabled", "chat.worker", "git.isolation"];
  for (const field of CONFIG_FIELDS) {
    if (live.includes(field.key)) continue;
    if (declaredOnly.has(field.section)) assert.equal(field.active, false, `${field.key} claims to be read already`);
  }
  for (const key of live) assert.equal(configFieldFor(key)?.active, true, `${key} should be active`);
});

test("the restricted keys are declared once and enforced from that declaration", () => {
  assert.deepEqual([...RESTRICTED_CONFIG_KEYS].sort(), [...RESTRICTED_KEYS].sort());
  for (const key of RESTRICTED_CONFIG_KEYS) assert.ok(fieldOf(key).restricted, `${key} has no rule in words`);
});

test("the validator checks a value against its declared type, not a guessed one", () => {
  const nullableNumber = fieldOf("budget.dailyTokenLimit");
  assert.equal(checkConfigValue(nullableNumber, 50_000), null, "a nullable number accepts a number");
  assert.equal(checkConfigValue(nullableNumber, null), null);
  assert.match(String(checkConfigValue(nullableNumber, "lots")), /expected a number of 0 or more, or null/);

  assert.match(String(checkConfigValue(fieldOf("ui.theme"), "neon")), /expected one of system, dark, light/);
  assert.match(String(checkConfigValue(fieldOf("budget.warnAtPercent"), 200)), /between 1 and 100/);

  const byCapability = fieldOf("workers.preferencesByCapability");
  assert.equal(checkConfigValue(byCapability, { code: ["codex"] }), null);
  assert.match(String(checkConfigValue(byCapability, { code: "codex" })), /every entry must be an array of strings/);

  const patch = validateConfigPatch({ workers: { preferencesByCapability: { plan: ["ollama"] } } });
  assert.deepEqual(patch.errors, [], "a per-capability preference is a valid patch");
  assert.equal(CONFIG_VERSION, CONFIG_SCHEMA_VERSION, "one version constant, declared by the schema");
});

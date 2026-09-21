import assert from "node:assert/strict";
import { test } from "node:test";

import { NexusClient } from "../src/nexus/client.ts";
import { buildDefaultConfig } from "../src/index.ts";

test("a fresh install does not point at anyone's machine for Nexus", () => {
  const config = buildDefaultConfig();
  assert.deepEqual(config.nexus.args, [], "no default path: Nexus lives wherever the user put it");
  assert.equal(config.nexus.command, "node");
});

test("an unconfigured Nexus says what to do instead of spawning nothing", async () => {
  const client = new NexusClient({ command: "node", args: [], timeoutMs: 1000 });
  assert.equal(client.configured, false);
  await assert.rejects(client.status(), /not set up on this machine.*nexus\.args/s);
});

test("a configured Nexus is recognised however it is pointed at", () => {
  assert.equal(new NexusClient({ command: "node", args: ["C:/tools/nexus/mcp-server.ts"], timeoutMs: 1000 }).configured, true);
  assert.equal(new NexusClient({ command: "nexus-mcp", args: [], timeoutMs: 1000 }).configured, true);
});

test("no default setting points at a path that exists only on the maintainer's machine", () => {
  const config = buildDefaultConfig();
  // Walk the real values: JSON text doubles every backslash and would hide a match.
  const strings: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === "string") strings.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value as Record<string, unknown>).forEach(walk);
  };
  walk(config);
  // homedir()-derived defaults legitimately contain this machine's profile path,
  // so only the maintainer's projects drive is a tell here; the release scanner
  // checks source text for literal user paths.
  const leaked = strings.filter((s) => /^G:[\\/]Desktop/i.test(s));
  assert.deepEqual(leaked, [], "these defaults only exist on one machine");
  assert.ok(config.projects.defaultDir.length > 0, "there is still a sensible place to create projects");
});

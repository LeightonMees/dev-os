import { existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * Load dotenv-style secret files into process.env without clobbering values
 * that are already set. Nexus's secrets.env is the source of truth on this
 * machine; the legacy ~/.dev/keys.env is read as a fallback. Values are never
 * logged or returned, only the names that became available.
 */
export function loadSecretFiles(paths: string[]): { loaded: string[]; files: string[] } {
  const loaded: string[] = [];
  const files: string[] = [];
  for (const path of paths) {
    if (!path || !existsSync(path)) continue;
    files.push(path);
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
      let value = line.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      if (!key || !value) continue;
      if (process.env[key] === undefined || process.env[key] === "") {
        process.env[key] = value;
        loaded.push(key);
      }
    }
  }
  return { loaded, files };
}

/**
 * Write a secret into the first existing secret file (Nexus's secrets.env on this machine) and make
 * it available to this process straight away. Replaces an existing line for the same name rather
 * than appending a second one. The value is never returned, logged or echoed back.
 */
export function setSecret(paths: string[], name: string, value: string): { file: string; replaced: boolean } {
  const key = name.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(key)) throw new Error(`"${name}" is not a valid environment variable name`);
  const secret = value.trim();
  if (!secret) throw new Error("A value is required");
  if (/[\r\n]/.test(secret)) throw new Error("A secret cannot contain a line break");
  const file = paths.find((p) => p && existsSync(p)) ?? paths[0];
  if (!file) throw new Error("No secret file is configured (config.secrets.files)");
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  const lines = existing.split(/\r?\n/);
  const line = `${key}=${secret}`;
  let replaced = false;
  for (const [i, raw] of lines.entries()) {
    const trimmed = raw.trim().replace(/^export\s+/, "");
    if (trimmed.startsWith(`${key}=`)) {
      lines[i] = line;
      replaced = true;
      break;
    }
  }
  if (!replaced) {
    if (existing.length && !existing.endsWith("\n")) lines.push("");
    lines.push(line);
  }
  writeFileSync(file, lines.filter((l, i) => l !== "" || i !== lines.length - 1).join("\n") + "\n", "utf8");
  process.env[key] = secret;
  return { file, replaced };
}

export function hasSecret(name: string): boolean {
  const value = process.env[name];
  return typeof value === "string" && value.trim().length > 0;
}

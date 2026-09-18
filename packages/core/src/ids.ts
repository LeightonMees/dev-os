import { randomBytes } from "node:crypto";

const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

/** Short, typed, URL-safe ids: prj_k3x9..., tsk_..., exe_... */
export function newId(prefix: string, length = 10): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[(bytes[i] as number) % ALPHABET.length];
  return `${prefix}_${out}`;
}

export function now(): string {
  return new Date().toISOString();
}

// Reads .env files with dotenv. Writes go in place (same inode), so a file bind-mounted into Docker stays in sync.
// Adapted from totem's src/lib/env_file.ts (MIT, Brian Gao).
import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { parse } from "dotenv";

const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;
const BARE_UNSAFE = /[#'"`\\\r\n]/;

export function readEnvFile(path: string): Record<string, string> {
  return existsSync(path) ? parse(readFileSync(path, "utf8")) : {};
}

export function serializeValue(value: string): string {
  if (value !== "" && !BARE_UNSAFE.test(value) && value.trim() === value) return value;
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"') && !value.includes("\\")) return `"${value}"`;
  if (!value.includes("`")) return `\`${value}\``;
  throw new Error("A value can't contain all three of ' \" and `");
}

export function upsertEnvFile(path: string, updates: Record<string, string>): void {
  const raw = existsSync(path) ? readFileSync(path, "utf8") : "";
  const lines = raw.length > 0 ? raw.split("\n") : [];
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const pending = new Map(Object.entries(updates));
  const out: string[] = [];
  for (const line of lines) {
    const key = ASSIGNMENT.exec(line)?.[1];
    if (key !== undefined && key in updates) {
      const value = pending.get(key);
      if (value !== undefined) {
        out.push(`${key}=${serializeValue(value)}`);
        pending.delete(key);
      }
      continue;
    }
    out.push(line);
  }
  for (const [key, value] of pending) out.push(`${key}=${serializeValue(value)}`);

  writeFileSync(path, out.join("\n") + "\n", { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch {}
}

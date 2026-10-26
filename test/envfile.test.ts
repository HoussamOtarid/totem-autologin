import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "dotenv";
import { serializeValue, upsertEnvFile, readEnvFile } from "../src/envfile.ts";

test("values that need quotes read back unchanged", () => {
  for (const value of ["plain", "#hunter2", "abc#def", " spaced ", "it's", 'say "hi"', "back\\slash", ""]) {
    assert.equal(parse(`K=${serializeValue(value)}`).K, value);
  }
});

test("reads comments, export and quotes", () => {
  const env = parse("# comment\nexport A=1\nB='x # y'\nC=two # note\nD=\"q\"\n");
  assert.deepEqual(env, { A: "1", B: "x # y", C: "two", D: "q" });
});

test("upsert keeps other lines and the same file", () => {
  const dir = mkdtempSync(join(tmpdir(), "autologin-"));
  const path = join(dir, ".env");
  writeFileSync(path, "# top\nKEEP=1\nTOKEN=old\nTOKEN=dup\n");
  const inode = statSync(path).ino;
  upsertEnvFile(path, { TOKEN: "new#1", ADDED: "2" });
  assert.equal(readFileSync(path, "utf8"), "# top\nKEEP=1\nTOKEN='new#1'\nADDED=2\n");
  assert.equal(statSync(path).ino, inode);
  assert.deepEqual(readEnvFile(path), { KEEP: "1", TOKEN: "new#1", ADDED: "2" });
});

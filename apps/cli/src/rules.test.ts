import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

let directory: string;
beforeAll(() => { directory = mkdtempSync(join(tmpdir(), "bw-forge-rules-")); });
afterAll(() => { rmSync(directory, { recursive: true, force: true }); });

test("rules test exits zero and prints nginx-style success output", () => {
  const path = join(directory, "valid.bwbuild");
  writeFileSync(path, 'rule "Valid" { hatchery[2] around 2:30 }\n');
  const result = spawnSync(process.execPath, [resolve(import.meta.dir, "main.ts"), "rules", "test", path], { encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain(`bw-forge: rule file ${path} syntax is ok`);
  expect(result.stdout).toContain("bw-forge: 1 rules validated");
});

test("rules test exits nonzero and prints source diagnostics", () => {
  const path = join(directory, "invalid.bwbuild");
  writeFileSync(path, 'rule "Invalid" { hatcheryy[1] around 2:30 }\n');
  const result = spawnSync(process.execPath, [resolve(import.meta.dir, "main.ts"), "rules", "test", path], { encoding: "utf8" });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("error UNKNOWN_EVENT_KEY:");
  expect(result.stderr).toContain("Did you mean 'hatchery'?");
});

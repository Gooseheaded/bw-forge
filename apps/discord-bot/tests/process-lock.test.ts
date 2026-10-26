import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireProcessLock } from "../src/storage/process-lock.ts";

describe("process lock", () => {
  test("competing acquisition fails closed and release permits reacquisition", () => {
    const directory = mkdtempSync(join(tmpdir(), "bw-forge-lock-"));
    const db = join(directory, "nested", "bot.sqlite");
    const first = acquireProcessLock(db);
    expect(first.databasePath.toLowerCase().includes("nested")).toBe(true);
    expect(() => acquireProcessLock(db)).toThrow("process lock");
    first.release();
    const second = acquireProcessLock(db);
    second.release();
    rmSync(directory, { recursive: true, force: true });
  });

  test("rejects ephemeral databases", () => {
    expect(() => acquireProcessLock(":memory:")).toThrow("file-backed");
  });
});

import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverReplayPaths } from "../src/main/replay-discovery";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("replay discovery", () => {
  test("recurses, filters extensions case-insensitively, and de-duplicates", async () => {
    const root = await mkdtemp(join(tmpdir(), "bw-forge-desktop-discovery-"));
    temporaryRoots.push(root);
    const nested = join(root, "nested");
    await mkdir(nested);
    const first = join(root, "first.rep");
    const second = join(nested, "second.REP");
    await writeFile(first, "one");
    await writeFile(second, "two");
    await writeFile(join(root, "notes.txt"), "ignore");

    const result = await discoverReplayPaths([root, first]);
    expect(result.replayPaths).toHaveLength(2);
    expect(result.replayPaths.some((value) => value.endsWith("first.rep"))).toBe(true);
    expect(result.replayPaths.some((value) => value.endsWith("second.REP"))).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  test("retains valid results while reporting invalid selections", async () => {
    const root = await mkdtemp(join(tmpdir(), "bw-forge-desktop-discovery-"));
    temporaryRoots.push(root);
    const replay = join(root, "game.rep");
    await writeFile(replay, "game");
    const result = await discoverReplayPaths([replay, join(root, "missing.rep")]);
    expect(result.replayPaths).toHaveLength(1);
    expect(result.warnings[0]).toContain("could not be read");
  });
});

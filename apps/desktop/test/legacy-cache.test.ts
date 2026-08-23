import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  obsoleteReplayEngineCachePath,
  removeObsoleteReplayEngineCache
} from "../src/main/legacy-cache";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("obsolete replay-engine cache cleanup", () => {
  test("targets only the BW Forge-owned replay-engine cache", async () => {
    const localAppData = await mkdtemp(join(tmpdir(), "bwf-local-app-data-"));
    temporaryRoots.push(localAppData);
    const cachePath = obsoleteReplayEngineCachePath(localAppData);
    expect(cachePath).toBe(join(localAppData, "BW Forge", "runtime-cache", "replay-engine"));

    await mkdir(cachePath!, { recursive: true });
    await writeFile(join(cachePath!, "legacy.bin"), "obsolete", "utf8");
    const sibling = join(localAppData, "BW Forge", "keep.txt");
    await writeFile(sibling, "keep", "utf8");

    expect(await removeObsoleteReplayEngineCache(localAppData)).toBe(true);
    await expect(access(cachePath!)).rejects.toThrow();
    await expect(access(sibling)).resolves.toBeUndefined();
  });

  test("does nothing when LOCALAPPDATA is unavailable", async () => {
    expect(obsoleteReplayEngineCachePath("   ")).toBeNull();
    expect(await removeObsoleteReplayEngineCache("   ")).toBe(false);
  });
});

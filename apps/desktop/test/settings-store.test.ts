import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createDefaultSettings,
  SettingsStore
} from "../src/main/settings-store";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("settings persistence", () => {
  test("atomically saves and restores normalized settings", async () => {
    const userData = await mkdtemp(join(tmpdir(), "bw-forge-desktop-settings-"));
    temporaryRoots.push(userData);
    const defaults = await createDefaultSettings({
      documentsPath: join(userData, "Documents"),
      runtimeRoot: join(userData, "runtime")
    });
    const store = new SettingsStore(userData, defaults);
    const saved = await store.save({
      ...defaults,
      mcpPath: "custom",
      replayExportSpeed: 256
    });
    const loaded = await store.load();
    expect(saved.mcpPath).toBe("/custom");
    expect(loaded.settings).toEqual(saved);
    expect(loaded.warning).toBeUndefined();
  });

  test("recovers from corrupt settings with a warning", async () => {
    const userData = await mkdtemp(join(tmpdir(), "bw-forge-desktop-settings-"));
    temporaryRoots.push(userData);
    const defaults = await createDefaultSettings({
      documentsPath: join(userData, "Documents"),
      runtimeRoot: join(userData, "runtime")
    });
    const store = new SettingsStore(userData, defaults);
    await writeFile(store.filePath, "{not-json");
    const loaded = await store.load();
    expect(loaded.settings).toEqual(defaults);
    expect(loaded.warning).toContain("safe defaults");
  });
});

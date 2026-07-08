import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { normalizeSettings, createDefaultSettings } from "../src/main/settings-store";
import { validateDatabasePath, validateOutputRoot } from "../src/main/path-policy";

const tempRoots: string[] = [];

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("desktop settings and path policy", () => {
  test("creates user-managed defaults outside the runtime", async () => {
    const defaults = await createDefaultSettings({
      documentsPath: "C:\\Users\\tester\\Documents",
      runtimeRoot: "C:\\work\\bw-forge"
    });
    expect(defaults.outputRoot).toBe("C:\\Users\\tester\\Documents\\BW Forge\\Analysis");
    expect(defaults.databasePath).toBe("C:\\Users\\tester\\Documents\\BW Forge\\corpus.sqlite");
    expect(validateOutputRoot(defaults.outputRoot, defaults.runtimeRoot).valid).toBe(true);
    expect(defaults.bunExecutable.toLowerCase()).toMatch(/bun(?:\.exe)?$/u);
  });

  test("normalizes ports, MCP route, and invalid numeric values", async () => {
    const defaults = await createDefaultSettings({
      documentsPath: "C:\\Users\\tester\\Documents",
      runtimeRoot: "C:\\work\\bw-forge"
    });
    const normalized = normalizeSettings(
      {
        ...defaults,
        replayExportSpeed: -2,
        mcpPort: 70_000,
        mcpPath: "custom"
      },
      defaults
    );
    expect(normalized.replayExportSpeed).toBe(128);
    expect(normalized.mcpPort).toBe(8089);
    expect(normalized.mcpPath).toBe("/custom");
  });

  test("pins packaged runtime root instead of accepting a user override", async () => {
    const runtimeRoot = await createPackagedRuntimeFixture();
    const defaults = await createDefaultSettings({
      documentsPath: "C:\\Users\\tester\\Documents",
      runtimeRoot
    });

    const normalized = normalizeSettings(
      {
        ...defaults,
        runtimeRoot: "D:\\other-runtime"
      },
      defaults
    );

    expect(normalized.runtimeRoot).toBe(runtimeRoot);
  });

  test("rejects output and database paths inside protected source directories", () => {
    const runtimeRoot = "C:\\work\\bw-forge";
    expect(
      validateOutputRoot("C:\\work\\bw-forge\\packages\\generated", runtimeRoot).valid
    ).toBe(false);
    expect(
      validateDatabasePath("C:\\work\\bw-forge\\apps\\desktop\\corpus.sqlite", runtimeRoot).valid
    ).toBe(false);
  });
});

async function createPackagedRuntimeFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bwf-settings-runtime-"));
  tempRoots.push(root);
  await writeRuntimeFile(root, "manifest.json", "{}\n");
  await writeRuntimeFile(root, "apps/cli/src/main.js", "console.log('bw-forge')\n");
  return root;
}

async function writeRuntimeFile(root: string, relativePath: string, contents: string): Promise<void> {
  const fullPath = join(root, ...relativePath.split("/"));
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, contents, "utf8");
}

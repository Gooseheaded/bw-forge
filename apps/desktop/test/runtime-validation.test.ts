import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import { validateRuntime, type ExecutableProbe } from "../src/main/runtime-validation";
import { createDefaultSettings } from "../src/main/settings-store";

const tempRoots: string[] = [];

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("runtime validation", () => {
  test("validates packaged runtime without developer tools", async () => {
    const runtimeRoot = await createPackagedRuntimeFixture();
    const starcraftPath = await createStarcraftFixture();
    const settings = {
      ...await createDefaultSettings({
        documentsPath: "C:\\Users\\tester\\Documents",
        runtimeRoot
      }),
      runtimeRoot,
      starcraftPath
    };

    const validation = await validateRuntime(settings, async (probe: ExecutableProbe) => {
      if (probe.executable === process.execPath) {
        return "bw-forge help";
      }
      if (probe.executable.endsWith("python.exe")) {
        return "Python 3.14.6";
      }
      throw new Error(`unexpected probe: ${probe.executable}`);
    });

    expect(validation.canAnalyze).toBe(true);
    expect(validation.canIngest).toBe(true);
    expect(validation.checks.some((check) => check.id === "packaged-cli-self-check" && check.status === "pass")).toBe(true);
    expect(validation.checks.some((check) => check.id === "python" && check.status === "pass")).toBe(true);
    expect(validation.checks.some((check) => check.id === "starcraft-install" && check.status === "pass")).toBe(true);
    expect(validation.checks.some((check) => check.id === "bun")).toBe(false);
    expect(validation.checks.some((check) => check.id === "pnpm")).toBe(false);
    expect(validation.checks.some((check) => check.label === "Built-in app files")).toBe(true);
  });

  test("blocks replay analysis when no StarCraft installation is configured", async () => {
    const runtimeRoot = await createPackagedRuntimeFixture();
    const settings = {
      ...await createDefaultSettings({
        documentsPath: "C:\\Users\\tester\\Documents",
        runtimeRoot
      }),
      runtimeRoot,
      starcraftPath: ""
    };

    const validation = await validateRuntime(settings, async (probe: ExecutableProbe) => {
      if (probe.executable === process.execPath) {
        return "bw-forge help";
      }
      if (probe.executable.endsWith("python.exe")) {
        return "Python 3.14.6";
      }
      throw new Error(`unexpected probe: ${probe.executable}`);
    });

    expect(validation.canAnalyze).toBe(false);
    expect(validation.canIngest).toBe(true);
    expect(validation.checks.find((check) => check.id === "starcraft-install")?.status).toBe("fail");
  });
});

async function createPackagedRuntimeFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bwf-desktop-runtime-"));
  tempRoots.push(root);

  await writeRuntimeFile(root, "manifest.json", "{}\n");
  await writeRuntimeFile(root, "apps/cli/src/main.js", "console.log('bw-forge')\n");
  await writeRuntimeFile(root, "packages/corpus-query/dist/cli.cjs", "module.exports = {}\n");
  await writeRuntimeFile(root, "packages/corpus-query/dist/mcp/server.cjs", "module.exports = {}\n");
  await writeRuntimeFile(root, "packages/legacy-replay-analysis/replay_analysis.py", "print('ok')\n");
  await writeRuntimeFile(root, "apps/sc-forge/dist/build-order.single-file.html", "<html></html>\n");
  await writeRuntimeFile(root, "python/cpython-3.14.6-embed-amd64/python.exe", "");
  await writeRuntimeFile(
    root,
    "third_party/shieldbattery/dist/bw-forge-replay-engine/win-unpacked/BW Forge Replay Engine.exe",
    ""
  );
  return root;
}

async function createStarcraftFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bwf-starcraft-runtime-"));
  tempRoots.push(root);
  await writeRuntimeFile(root, "x86/StarCraft.exe", "");
  await writeRuntimeFile(root, "x86/clientsdk.dll", "");
  return root;
}

async function writeRuntimeFile(root: string, relativePath: string, contents: string): Promise<void> {
  const fullPath = join(root, ...relativePath.split("/"));
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, contents, "utf8");
}

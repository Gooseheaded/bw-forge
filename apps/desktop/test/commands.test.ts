import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { buildAnalyzeCommand, buildIngestCommand, buildMcpCommand, mcpEndpoint } from "../src/main/commands";
import { createDefaultSettings } from "../src/main/settings-store";

const tempRoots: string[] = [];

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function createSettings() {
  return {
    ...await createDefaultSettings({
      documentsPath: "C:\\Users\\tester\\Documents",
      runtimeRoot: "C:\\runtime\\bw-forge"
    }),
    starcraftPath: "C:\\Program Files (x86)\\StarCraft",
    outputRoot: "C:\\Users\\tester\\BW Forge\\Analysis",
    databasePath: "C:\\Users\\tester\\BW Forge\\corpus.sqlite",
    bunExecutable: "C:\\tools\\bun.exe",
    keepSnapshots: true,
    replayExportSpeed: 64,
    mcpPort: 9090,
    mcpPath: "/replays"
  };
}

describe("desktop CLI command construction", () => {
  test("constructs analyze without shell syntax", async () => {
    const settings = await createSettings();
    const command = buildAnalyzeCommand(settings, "C:\\Replays\\game one.rep");
    expect(command.command).toBe("C:\\tools\\bun.exe");
    expect(command.cwd).toBe("C:\\runtime\\bw-forge");
    expect(command.args).toEqual([
      "C:\\runtime\\bw-forge\\apps\\cli\\src\\main.ts",
      "analyze",
      "C:\\Replays\\game one.rep",
      "--out",
      "C:\\Users\\tester\\BW Forge\\Analysis",
      "--replay-export-speed",
      "64",
      "--keep-snapshots"
    ]);
  });

  test("constructs ingest against the shared output and database", async () => {
    const settings = await createSettings();
    expect(buildIngestCommand(settings).args).toEqual([
      "C:\\runtime\\bw-forge\\apps\\cli\\src\\main.ts",
      "ingest",
      "C:\\Users\\tester\\BW Forge\\Analysis",
      "--db",
      "C:\\Users\\tester\\BW Forge\\corpus.sqlite"
    ]);
  });

  test("constructs HTTP MCP and connection endpoint", async () => {
    const settings = await createSettings();
    expect(buildMcpCommand(settings).args).toEqual([
      "C:\\runtime\\bw-forge\\apps\\cli\\src\\main.ts",
      "mcp",
      "--db",
      "C:\\Users\\tester\\BW Forge\\corpus.sqlite",
      "--transport",
      "http",
      "--host",
      "127.0.0.1",
      "--port",
      "9090",
      "--path",
      "/replays"
    ]);
    expect(mcpEndpoint(settings)).toBe("http://127.0.0.1:9090/replays");
  });

  test("constructs packaged runtime commands without Bun or pnpm", async () => {
    const settings = await createSettings();
    const runtimeRoot = await createPackagedRuntimeFixture();
    const packagedSettings = {
      ...settings,
      runtimeRoot,
      bunExecutable: "",
      pnpmExecutable: "",
      nodeExecutable: "C:\\Program Files\\BW Forge\\BW Forge.exe"
    };
    const command = buildAnalyzeCommand(packagedSettings, "C:\\Replays\\game one.rep");
    expect(command.command).toBe(process.execPath);
    expect(command.args).toEqual([
      join(runtimeRoot, "apps", "cli", "src", "main.js"),
      "analyze",
      "C:\\Replays\\game one.rep",
      "--out",
      "C:\\Users\\tester\\BW Forge\\Analysis",
      "--replay-export-speed",
      "64",
      "--keep-snapshots"
    ]);
    expect(command.env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(command.env.BW_FORGE_RUNTIME_KIND).toBe("packaged");
    expect(command.env.BW_FORGE_PYTHON).toContain(
      join("python", "cpython-3.14.6-embed-amd64", "python.exe")
    );
    expect(command.env.BW_FORGE_STARCRAFT_PATH).toBe("C:\\Program Files (x86)\\StarCraft");
    expect(command.env.BW_FORGE_REPLAY_ENGINE_EXE).toContain(
      join("third_party", "shieldbattery", "dist", "bw-forge-replay-engine", "win-unpacked", "BW Forge Replay Engine.exe")
    );
    expect(command.env.BW_FORGE_PNPM).toBeUndefined();
  });
});

async function createPackagedRuntimeFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bwf-commands-runtime-"));
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

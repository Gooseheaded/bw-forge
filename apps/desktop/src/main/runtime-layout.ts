import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export type RuntimeLayoutKind = "development" | "packaged";

export interface RuntimeLayout {
  kind: RuntimeLayoutKind;
  runtimeRoot: string;
  cliEntrypoint: string;
  corpusCliEntrypoint: string;
  corpusMcpEntrypoint: string;
  pythonExecutable: string;
  replayReducerScript: string;
  reportTemplate: string;
  replayEngineExecutable: string;
  replayEngineWorkingDirectory: string;
  manifestPath: string;
}

export function resolveRuntimeLayout(runtimeRoot: string): RuntimeLayout {
  const resolvedRoot = resolve(runtimeRoot);
  const packagedManifest = join(resolvedRoot, "manifest.json");
  const packagedCli = join(resolvedRoot, "apps", "cli", "src", "main.js");
  const isPackaged =
    existsSync(packagedManifest) &&
    existsSync(packagedCli);

  return {
    kind: isPackaged ? "packaged" : "development",
    runtimeRoot: resolvedRoot,
    cliEntrypoint: isPackaged
      ? packagedCli
      : join(resolvedRoot, "apps", "cli", "src", "main.ts"),
    corpusCliEntrypoint: isPackaged
      ? join(resolvedRoot, "packages", "corpus-query", "dist", "cli.cjs")
      : join(resolvedRoot, "packages", "corpus-query", "src", "cli.ts"),
    corpusMcpEntrypoint: isPackaged
      ? join(resolvedRoot, "packages", "corpus-query", "dist", "mcp", "server.cjs")
      : join(resolvedRoot, "packages", "corpus-query", "src", "mcp", "server.ts"),
    pythonExecutable: isPackaged
      ? join(
          resolvedRoot,
          "python",
          "cpython-3.14.6-embed-amd64",
          process.platform === "win32" ? "python.exe" : "python"
        )
      : "",
    replayReducerScript: join(
      resolvedRoot,
      "packages",
      "legacy-replay-analysis",
      "replay_analysis.py"
    ),
    reportTemplate: join(
      resolvedRoot,
      "apps",
      "sc-forge",
      "dist",
      "build-order.single-file.html"
    ),
    replayEngineExecutable: join(
      resolvedRoot,
      "third_party",
      "shieldbattery",
      "dist",
      "bw-forge-replay-engine",
      "win-unpacked",
      "BW Forge Replay Engine.exe"
    ),
    replayEngineWorkingDirectory: join(
      resolvedRoot,
      "third_party",
      "shieldbattery",
      "dist",
      "bw-forge-replay-engine",
      "win-unpacked"
    ),
    manifestPath: packagedManifest
  };
}

import { join, resolve } from "node:path";
import type { AppSettings } from "../shared/contracts";
import { resolveRuntimeLayout } from "./runtime-layout";

export interface ChildCommand {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export function buildAnalyzeCommand(
  settings: AppSettings,
  replayPath: string
): ChildCommand {
  const args = [
    cliEntrypoint(settings),
    "analyze",
    resolve(replayPath),
    "--out",
    resolve(settings.outputRoot),
    "--replay-export-speed",
    String(settings.replayExportSpeed)
  ];
  if (settings.keepSnapshots) {
    args.push("--keep-snapshots");
  }
  return baseCommand(settings, args);
}

export function buildIngestCommand(settings: AppSettings): ChildCommand {
  return baseCommand(settings, [
    cliEntrypoint(settings),
    "ingest",
    resolve(settings.outputRoot),
    "--db",
    resolve(settings.databasePath)
  ]);
}

export function buildMcpCommand(settings: AppSettings): ChildCommand {
  return baseCommand(settings, [
    cliEntrypoint(settings),
    "mcp",
    "--db",
    resolve(settings.databasePath),
    "--transport",
    "http",
    "--host",
    settings.mcpHost,
    "--port",
    String(settings.mcpPort),
    "--path",
    settings.mcpPath
  ]);
}

export function mcpEndpoint(settings: AppSettings): string {
  const host = settings.mcpHost === "0.0.0.0" ? "127.0.0.1" : settings.mcpHost;
  return `http://${host}:${settings.mcpPort}${settings.mcpPath}`;
}

function baseCommand(settings: AppSettings, args: string[]): ChildCommand {
  const layout = resolveRuntimeLayout(settings.runtimeRoot);
  const productionNodeCommand = process.execPath;
  return {
    command: layout.kind === "packaged" ? productionNodeCommand : settings.bunExecutable,
    args:
      layout.kind === "packaged"
        ? [layout.cliEntrypoint, ...args.slice(1)]
        : args,
    cwd: resolve(settings.runtimeRoot),
    env: {
      ...process.env,
      ...(layout.kind === "packaged"
        ? {
            ELECTRON_RUN_AS_NODE: "1",
            BW_FORGE_RUNTIME_KIND: "packaged",
            BW_FORGE_NODE: productionNodeCommand,
            BW_FORGE_PYTHON: layout.pythonExecutable,
            BW_FORGE_STARCRAFT_PATH: settings.starcraftPath,
            BW_FORGE_REPLAY_ENGINE_EXE: layout.replayEngineExecutable,
            BW_FORGE_REPLAY_ENGINE_CWD: layout.replayEngineWorkingDirectory
          }
        : {
            BW_FORGE_RUNTIME_KIND: "development",
            BW_FORGE_NODE: settings.nodeExecutable,
            BW_FORGE_PNPM: settings.pnpmExecutable,
            ...(settings.starcraftPath
              ? { BW_FORGE_STARCRAFT_PATH: settings.starcraftPath }
              : {}),
            ...(settings.pythonExecutable
              ? { BW_FORGE_PYTHON: settings.pythonExecutable }
              : {})
          }),
      BW_REPLAY_DB_PATH: resolve(settings.databasePath)
    }
  };
}

function cliEntrypoint(settings: AppSettings): string {
  return resolveRuntimeLayout(settings.runtimeRoot).cliEntrypoint;
}

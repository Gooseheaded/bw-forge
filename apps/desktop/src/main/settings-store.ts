import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { delimiter, dirname, extname, isAbsolute, join, resolve } from "node:path";
import {
  SETTINGS_VERSION,
  type AppSettings
} from "../shared/contracts";
import { detectStarcraftInstallPath } from "./starcraft-install";
import { resolveRuntimeLayout } from "./runtime-layout";

export interface SettingsDefaultsInput {
  documentsPath: string;
  runtimeRoot: string;
}

export interface LoadedSettings {
  settings: AppSettings;
  warning?: string;
}

export async function createDefaultSettings(input: SettingsDefaultsInput): Promise<AppSettings> {
  const managedRoot = join(input.documentsPath, "BW Forge");
  const outputRoot = join(managedRoot, "Analysis");
  const isPackagedRuntime = existsSync(join(resolve(input.runtimeRoot), "manifest.json"));
  const starcraftPath = await detectStarcraftInstallPath();
  return {
    version: SETTINGS_VERSION,
    runtimeRoot: resolve(input.runtimeRoot),
    starcraftPath,
    outputRoot,
    databasePath: join(managedRoot, "corpus.sqlite"),
    bunExecutable: isPackagedRuntime ? "" : resolveBunExecutable("bun"),
    nodeExecutable: isPackagedRuntime ? process.execPath : "node",
    pnpmExecutable: isPackagedRuntime ? "" : process.platform === "win32" ? "pnpm.cmd" : "pnpm",
    pythonExecutable: "",
    replayExportSpeed: 128,
    keepSnapshots: false,
    mcpHost: "127.0.0.1",
    mcpPort: 8089,
    mcpPath: "/mcp"
  };
}

export function normalizeSettings(
  value: Partial<AppSettings> | null | undefined,
  defaults: AppSettings
): AppSettings {
  const replayExportSpeed = Number(value?.replayExportSpeed);
  const mcpPort = Number(value?.mcpPort);
  const isPackagedRuntime = resolveRuntimeLayout(defaults.runtimeRoot).kind === "packaged";
  return {
    version: SETTINGS_VERSION,
    runtimeRoot: isPackagedRuntime
      ? defaults.runtimeRoot
      : normalizeString(value?.runtimeRoot, defaults.runtimeRoot),
    starcraftPath:
      typeof value?.starcraftPath === "string"
        ? value.starcraftPath.trim()
        : defaults.starcraftPath,
    outputRoot: normalizeString(value?.outputRoot, defaults.outputRoot),
    databasePath: normalizeString(value?.databasePath, defaults.databasePath),
    bunExecutable: isPackagedRuntime
      ? ""
      : resolveBunExecutable(
          normalizeString(value?.bunExecutable, defaults.bunExecutable)
        ),
    nodeExecutable: isPackagedRuntime
      ? process.execPath
      : normalizeString(value?.nodeExecutable, defaults.nodeExecutable),
    pnpmExecutable: isPackagedRuntime
      ? ""
      : normalizeString(value?.pnpmExecutable, defaults.pnpmExecutable),
    pythonExecutable:
      typeof value?.pythonExecutable === "string"
        ? value.pythonExecutable.trim()
        : defaults.pythonExecutable,
    replayExportSpeed:
      Number.isInteger(replayExportSpeed) && replayExportSpeed > 0
        ? replayExportSpeed
        : defaults.replayExportSpeed,
    keepSnapshots:
      typeof value?.keepSnapshots === "boolean"
        ? value.keepSnapshots
        : defaults.keepSnapshots,
    mcpHost: normalizeString(value?.mcpHost, defaults.mcpHost),
    mcpPort:
      Number.isInteger(mcpPort) && mcpPort > 0 && mcpPort <= 65_535
        ? mcpPort
        : defaults.mcpPort,
    mcpPath: normalizeMcpPath(value?.mcpPath, defaults.mcpPath)
  };
}

export function resolveBunExecutable(value: string): string {
  if (process.platform !== "win32") {
    return value;
  }
  const directCandidate = resolveWindowsBunCandidate(value);
  if (directCandidate) {
    return directCandidate;
  }
  if (isAbsolute(value)) {
    return value;
  }

  const pathEntries = (process.env.PATH ?? process.env.Path ?? "")
    .split(delimiter)
    .filter(Boolean);
  for (const pathEntry of pathEntries) {
    for (const commandName of commandCandidates(value)) {
      const candidate = join(pathEntry, commandName);
      const resolved = resolveWindowsBunCandidate(candidate);
      if (resolved) {
        return resolved;
      }
    }
  }
  return value;
}

function commandCandidates(value: string): string[] {
  return extname(value)
    ? [value]
    : [value, `${value}.exe`, `${value}.cmd`, `${value}.bat`];
}

function resolveWindowsBunCandidate(candidate: string): string | null {
  if (!existsSync(candidate)) {
    return null;
  }
  if (extname(candidate).toLowerCase() === ".exe") {
    return resolve(candidate);
  }
  if (/(?:^|[\\/])bun\.cmd$/iu.test(candidate)) {
    const bunExecutable = join(dirname(candidate), "node_modules", "bun", "bin", "bun.exe");
    if (existsSync(bunExecutable)) {
      return resolve(bunExecutable);
    }
  }
  return null;
}

function normalizeString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function normalizeMcpPath(value: unknown, fallback: string): string {
  const pathValue = normalizeString(value, fallback);
  return pathValue.startsWith("/") ? pathValue : `/${pathValue}`;
}

export class SettingsStore {
  readonly filePath: string;

  constructor(
    userDataPath: string,
    private readonly defaults: AppSettings
  ) {
    this.filePath = join(userDataPath, "settings.json");
  }

  async load(): Promise<LoadedSettings> {
    try {
      const value = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<AppSettings>;
      return { settings: normalizeSettings(value, this.defaults) };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return { settings: this.defaults };
      }
      return {
        settings: this.defaults,
        warning: `Settings could not be loaded; safe defaults are active. ${formatError(error)}`
      };
    }
  }

  async save(value: AppSettings): Promise<AppSettings> {
    const settings = normalizeSettings(value, this.defaults);
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.filePath);
    return settings;
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

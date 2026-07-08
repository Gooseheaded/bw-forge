#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { assertSafeAnalyzeOutputRoot } from "./analyze-output-path.js";
import type {
  BwForgeCorpusManifest,
  BwForgeReplayManifest,
  LegacyReplayAnalysisManifest
} from "../../../packages/schemas/src/index.js";

const THIS_FILE = fileURLToPath(import.meta.url);
const CLI_DIR = dirname(THIS_FILE);
const REPO_ROOT = resolve(CLI_DIR, "..", "..", "..");
const PATHS = {
  repoRoot: REPO_ROOT,
  legacyReplayAnalysisDir: resolve(REPO_ROOT, "packages", "legacy-replay-analysis"),
  legacyReplayAnalysisScript: resolve(REPO_ROOT, "packages", "legacy-replay-analysis", "replay_analysis.py"),
  scForgeDir: resolve(REPO_ROOT, "apps", "sc-forge"),
  scForgeTemplateSource: resolve(REPO_ROOT, "apps", "sc-forge", "build-order.html"),
  scForgeTemplateOverride: resolve(REPO_ROOT, "apps", "sc-forge", "build-order.override.js"),
  scForgeTemplateBuilder: resolve(REPO_ROOT, "apps", "sc-forge", "build_single_file.js"),
  scForgeTemplateBuilt: resolve(REPO_ROOT, "apps", "sc-forge", "dist", "build-order.single-file.html"),
  shieldbatteryDir: resolve(REPO_ROOT, "third_party", "shieldbattery"),
  corpusQueryDir: resolve(REPO_ROOT, "packages", "corpus-query"),
  corpusQueryCliDist: resolve(REPO_ROOT, "packages", "corpus-query", "dist", "cli.cjs"),
  corpusQueryMcpDist: resolve(REPO_ROOT, "packages", "corpus-query", "dist", "mcp", "server.cjs"),
  corpusQueryCli: resolve(REPO_ROOT, "packages", "corpus-query", "src", "cli.ts"),
  corpusQueryMcp: resolve(REPO_ROOT, "packages", "corpus-query", "src", "mcp", "server.ts"),
  corpusQueryTsx: resolve(REPO_ROOT, "packages", "corpus-query", "node_modules", "tsx", "dist", "cli.mjs"),
  packagedReplayEngineExecutable: resolve(
    REPO_ROOT,
    "third_party",
    "shieldbattery",
    "dist",
    "bw-forge-replay-engine",
    "win-unpacked",
    "BW Forge Replay Engine.exe"
  ),
  packagedReplayEngineRoot: resolve(
    REPO_ROOT,
    "third_party",
    "shieldbattery",
    "dist",
    "bw-forge-replay-engine",
    "win-unpacked"
  ),
  runtimeManifest: resolve(REPO_ROOT, "manifest.json")
} as const;

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;
  switch (command) {
    case "analyze":
      await analyzeCommand(args);
      return;
    case "ingest":
      await ingestCommand(args);
      return;
    case "mcp":
      await mcpCommand(args);
      return;
    case undefined:
    case "-h":
    case "--help":
      printHelp();
      return;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

async function analyzeCommand(argv: string[]): Promise<void> {
  const options = parseAnalyzeArgs(argv);
  const inputPath = resolveOptionPath(options.input);
  const outputRoot = resolveOptionPath(options.out);
  assertSafeAnalyzeOutputRoot(outputRoot, PATHS.repoRoot);
  const replays = await collectReplayFiles(inputPath);
  if (replays.length === 0) {
    throw new Error(`No .rep files found at ${inputPath}`);
  }

  await mkdir(join(outputRoot, "replays"), { recursive: true });
  for (const replayPath of replays) {
    await analyzeReplay({
      replayPath,
      outputRoot,
      keepSnapshots: options.keepSnapshots,
      snapshotDir: options.snapshotDir ? resolveOptionPath(options.snapshotDir) : undefined,
      shieldbatteryDir: options.shieldbatteryDir ? resolveOptionPath(options.shieldbatteryDir) : PATHS.shieldbatteryDir,
      replayExportSpeed: options.replayExportSpeed
    });
  }

  await writeCorpusManifest(outputRoot);
}

async function ingestCommand(argv: string[]): Promise<void> {
  const options = parseIngestArgs(argv);
  await mkdir(dirname(resolveOptionPath(options.db)), { recursive: true });
  await runCorpusQuerySubcommand({
    entrypointName: "CLI",
    distEntrypoint: PATHS.corpusQueryCliDist,
    sourceEntrypoint: PATHS.corpusQueryCli,
    args: ["ingest", resolveOptionPath(options.analysisDir), "--db", resolveOptionPath(options.db)],
    preferSource: shouldPreferSourceRuntime()
  });
}

async function mcpCommand(argv: string[]): Promise<void> {
  const options = parseMcpArgs(argv);
  const env = {
    ...process.env,
    BW_REPLAY_DB_PATH: resolveOptionPath(options.db)
  };
  await runCorpusQuerySubcommand({
    entrypointName: "MCP server",
    distEntrypoint: PATHS.corpusQueryMcpDist,
    sourceEntrypoint: PATHS.corpusQueryMcp,
    args: [
      "--db",
      resolveOptionPath(options.db),
      "--transport",
      options.transport,
      ...(options.transport === "http"
        ? ["--host", options.host, "--port", String(options.port), "--path", options.path]
        : [])
    ],
    preferSource: shouldPreferSourceRuntime(),
    env
  });
}

async function analyzeReplay(params: {
  replayPath: string;
  outputRoot: string;
  keepSnapshots: boolean;
  snapshotDir?: string;
  shieldbatteryDir: string;
  replayExportSpeed: number;
}): Promise<void> {
  const replayId = await computeReplayId(params.replayPath);
  const replayDir = join(params.outputRoot, "replays", replayId);
  const rawDir = join(replayDir, "raw");
  const legacyDir = join(replayDir, "legacy");
  await mkdir(rawDir, { recursive: true });
  await mkdir(legacyDir, { recursive: true });

  const copiedReplayPath = join(rawDir, basename(params.replayPath));
  await copyFile(params.replayPath, copiedReplayPath);

  let snapshotPath: string | undefined;
  if (params.keepSnapshots) {
    const snapshotBaseDir = params.snapshotDir
      ? resolve(params.snapshotDir)
      : join(replayDir, "debug");
    await mkdir(snapshotBaseDir, { recursive: true });
    snapshotPath = join(snapshotBaseDir, `${replayId}.sbtl`);
    await exportReplaySnapshot({
      replayPath: params.replayPath,
      snapshotPath,
      shieldbatteryDir: params.shieldbatteryDir,
      replayExportSpeed: params.replayExportSpeed
    });
  }

  await runLegacyReplayAnalysis({
    analysisInput: snapshotPath ?? params.replayPath,
    legacyDir,
    shieldbatteryDir: params.shieldbatteryDir,
    embeddedReplayInput: snapshotPath ? params.replayPath : undefined
  });

  const legacyManifestPath = join(legacyDir, "manifest.json");
  const legacyManifest = await readJsonFile<LegacyReplayAnalysisManifest>(legacyManifestPath);
  const replayManifest = await buildReplayManifest({
    replayId,
    replayDir,
    replayPath: params.replayPath,
    copiedReplayPath,
    legacyManifest,
    snapshotPath
  });
  await writeJsonFile(join(replayDir, "replay-manifest.json"), replayManifest);
}

async function exportReplaySnapshot(params: {
  replayPath: string;
  snapshotPath: string;
  shieldbatteryDir: string;
  replayExportSpeed: number;
}): Promise<void> {
  await ensureReplayEngineStarcraftPath();
  const env: NodeJS.ProcessEnv = {
    ...withoutElectronRunAsNode(process.env),
    SB_UNIT_TIMELINE: "1",
    SB_UNIT_TIMELINE_FORMAT: "msgpack",
    SB_UNIT_TIMELINE_OUT: params.snapshotPath,
    SB_UNIT_TIMELINE_TIME_UNIT: "frames",
    SB_UNIT_TIMELINE_STRIDE: "1",
    ...(await resolveReplayEngineLaunchEnv())
  };
  const packagedReplayEngine = env.BW_FORGE_REPLAY_ENGINE_EXE;
  if (packagedReplayEngine) {
    await runCommand({
      command: packagedReplayEngine,
      args: [
        "--replay-export",
        params.replayPath,
        "--replay-export-speed",
        String(params.replayExportSpeed),
        "--replay-export-disable-render",
        "1"
      ],
      cwd: env.BW_FORGE_REPLAY_ENGINE_CWD ?? dirname(packagedReplayEngine),
      env
    });
    return;
  }
  await runCommand({
    command: resolvePnpmCommand(),
    args: ["run", "replay-export", "--", params.replayPath, "--replay-export-speed", String(params.replayExportSpeed)],
    cwd: params.shieldbatteryDir,
    env
  });
}

async function runLegacyReplayAnalysis(params: {
  analysisInput: string;
  legacyDir: string;
  shieldbatteryDir: string;
  embeddedReplayInput?: string;
}): Promise<void> {
  const replayEngineEnv = await resolveReplayEngineLaunchEnv()
  const templatePath = await ensureScForgeTemplate();
  const args = [
    PATHS.legacyReplayAnalysisScript,
    params.analysisInput,
    params.legacyDir,
    "--shieldbattery-dir",
    params.shieldbatteryDir,
    "--build-order-template",
    templatePath
  ];
  if (params.embeddedReplayInput) {
    args.push("--embedded-replay-input", params.embeddedReplayInput);
  }

  const commands = buildPythonCommandFallbacks(args);
  for (const command of commands) {
    command.env = {
      ...command.env,
      ...replayEngineEnv,
    }
  }
  await runCommandWithFallbacks(commands);
}

async function ensureScForgeTemplate(): Promise<string> {
  const [builtStats, sourceStats, overrideStats] = await Promise.all([
    safeStat(PATHS.scForgeTemplateBuilt),
    safeStat(PATHS.scForgeTemplateSource),
    safeStat(PATHS.scForgeTemplateOverride)
  ]);

  if (builtStats && (!sourceStats || !overrideStats)) {
    return PATHS.scForgeTemplateBuilt;
  }

  const needsBuild =
    !builtStats ||
    !sourceStats ||
    !overrideStats ||
    builtStats.mtimeMs < sourceStats.mtimeMs ||
    builtStats.mtimeMs < overrideStats.mtimeMs;

  if (needsBuild) {
    await runCommand({
      command: resolveNodeCommand(),
      args: [PATHS.scForgeTemplateBuilder],
      cwd: PATHS.scForgeDir,
      env: process.env
    });
  }

  await assertFileExists(
    PATHS.scForgeTemplateBuilt,
    `Missing sc-forge built template at ${PATHS.scForgeTemplateBuilt}`
  );
  return PATHS.scForgeTemplateBuilt;
}

async function buildReplayManifest(params: {
  replayId: string;
  replayDir: string;
  replayPath: string;
  copiedReplayPath: string;
  legacyManifest: LegacyReplayAnalysisManifest;
  snapshotPath?: string;
}): Promise<BwForgeReplayManifest> {
  const htmlFiles = (await readdir(join(params.replayDir, "legacy")))
    .filter((name) => name.toLowerCase().endsWith(".html"))
    .sort();

  return {
    schema_version: "bw-forge-replay-manifest-v1",
    replay_id: params.replayId,
    source: {
      filename: basename(params.replayPath),
      original_path: params.replayPath,
      copied_path: normalizeRelative(params.replayDir, params.copiedReplayPath)
    },
    legacy: {
      manifest_path: "legacy/manifest.json",
      html_files: htmlFiles.map((name) => `legacy/${name}`)
    },
    replay_analysis: {
      replay_id: params.legacyManifest.replay_id,
      matchup: params.legacyManifest.matchup,
      map: params.legacyManifest.map,
      duration_seconds: params.legacyManifest.duration_seconds
    },
    players: params.legacyManifest.players.map((player) => ({
      owner: player.owner,
      name: player.name,
      race: player.race,
      legacy_zip_filename: player.zip_filename,
      legacy_zip_path: `legacy/${player.zip_filename}`
    })),
    debug: params.snapshotPath
      ? {
          snapshot_path: normalizeRelative(params.replayDir, params.snapshotPath)
        }
      : undefined
  };
}

async function writeCorpusManifest(outputRoot: string): Promise<void> {
  const replayManifests = await discoverReplayManifests(join(outputRoot, "replays"));
  const manifest: BwForgeCorpusManifest = {
    schema_version: "bw-forge-corpus-manifest-v1",
    generated_at: new Date().toISOString(),
    replay_count: replayManifests.length,
    replays: replayManifests
      .map(({ path, manifest: replayManifest }) => ({
        replay_id: replayManifest.replay_id,
        replay_manifest_path: normalizeRelative(outputRoot, path),
        replay_dir: normalizeRelative(outputRoot, dirname(path)),
        source_filename: replayManifest.source.filename,
        matchup: replayManifest.replay_analysis.matchup,
        duration_seconds: replayManifest.replay_analysis.duration_seconds
      }))
      .sort((left, right) => left.replay_id.localeCompare(right.replay_id))
  };

  await writeJsonFile(join(outputRoot, "corpus-manifest.json"), manifest);
}

async function discoverReplayManifests(replaysRoot: string): Promise<Array<{ path: string; manifest: BwForgeReplayManifest }>> {
  const results: Array<{ path: string; manifest: BwForgeReplayManifest }> = [];
  try {
    const entries = await readdir(replaysRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const manifestPath = join(replaysRoot, entry.name, "replay-manifest.json");
      try {
        const manifest = await readJsonFile<BwForgeReplayManifest>(manifestPath);
        results.push({ path: manifestPath, manifest });
      } catch {
        continue;
      }
    }
  } catch {
    return [];
  }
  return results;
}

async function collectReplayFiles(inputPath: string): Promise<string[]> {
  const inputStats = await stat(inputPath);
  if (inputStats.isFile()) {
    if (extname(inputPath).toLowerCase() !== ".rep") {
      throw new Error(`Expected a .rep file, got ${inputPath}`);
    }
    return [inputPath];
  }
  if (!inputStats.isDirectory()) {
    throw new Error(`Input is neither a file nor a directory: ${inputPath}`);
  }

  const results: string[] = [];
  await walkDirectory(inputPath, async (filePath) => {
    if (extname(filePath).toLowerCase() === ".rep") {
      results.push(filePath);
    }
  });
  results.sort((left, right) => left.localeCompare(right));
  return results;
}

async function walkDirectory(root: string, onFile: (filePath: string) => Promise<void>): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = join(root, entry.name);
    if (entry.isDirectory()) {
      await walkDirectory(entryPath, onFile);
      continue;
    }
    if (entry.isFile()) {
      await onFile(entryPath);
    }
  }
}

async function computeReplayId(replayPath: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await readFile(replayPath));
  return hash.digest("hex");
}

function parseAnalyzeArgs(argv: string[]): {
  input: string;
  out: string;
  keepSnapshots: boolean;
  snapshotDir?: string;
  shieldbatteryDir?: string;
  replayExportSpeed: number;
} {
  if (argv.length === 0) {
    throw new Error("Missing analyze input path.");
  }
  const input = argv[0];
  const out = requireOption(argv.slice(1), "--out");
  const keepSnapshots = hasFlag(argv.slice(1), "--keep-snapshots");
  const snapshotDir = optionalOption(argv.slice(1), "--snapshot-dir");
  const shieldbatteryDir = optionalOption(argv.slice(1), "--shieldbattery-dir");
  const replayExportSpeed = Number(optionalOption(argv.slice(1), "--replay-export-speed") ?? "128");
  if (!Number.isInteger(replayExportSpeed) || replayExportSpeed <= 0) {
    throw new Error(`Invalid --replay-export-speed value: ${replayExportSpeed}`);
  }
  if (snapshotDir && !keepSnapshots) {
    throw new Error("--snapshot-dir requires --keep-snapshots.");
  }
  return { input, out, keepSnapshots, snapshotDir, shieldbatteryDir, replayExportSpeed };
}

function parseIngestArgs(argv: string[]): { analysisDir: string; db: string } {
  if (argv.length === 0) {
    throw new Error("Missing analysis directory.");
  }
  return {
    analysisDir: argv[0],
    db: requireOption(argv.slice(1), "--db")
  };
}

function parseMcpArgs(argv: string[]): {
  db: string;
  transport: "stdio" | "http";
  host: string;
  port: number;
  path: string;
} {
  const transportValue = (optionalOption(argv, "--transport") ?? "stdio").toLowerCase();
  if (transportValue !== "stdio" && transportValue !== "http") {
    throw new Error(`Invalid --transport value: ${transportValue}`);
  }

  const portValue = Number(optionalOption(argv, "--port") ?? "8089");
  if (!Number.isInteger(portValue) || portValue <= 0 || portValue > 65535) {
    throw new Error(`Invalid --port value: ${portValue}`);
  }

  const pathValue = optionalOption(argv, "--path") ?? "/mcp";
  return {
    db: requireOption(argv, "--db"),
    transport: transportValue,
    host: optionalOption(argv, "--host") ?? "127.0.0.1",
    port: portValue,
    path: pathValue.startsWith("/") ? pathValue : `/${pathValue}`
  };
}

function requireOption(argv: string[], name: string): string {
  const value = optionalOption(argv, name);
  if (!value) {
    throw new Error(`Missing required option ${name}`);
  }
  return value;
}

function optionalOption(argv: string[], name: string): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === name) {
      return argv[index + 1];
    }
    if (arg.startsWith(`${name}=`)) {
      return arg.slice(name.length + 1);
    }
  }
  return undefined;
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

function resolveOptionPath(pathValue: string): string {
  return isAbsolute(pathValue) ? pathValue : resolve(process.cwd(), pathValue);
}

function resolvePnpmCommand(): string {
  if (process.env.BW_FORGE_PNPM) {
    return process.env.BW_FORGE_PNPM;
  }
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

function resolveNodeCommand(): string {
  return process.env.BW_FORGE_NODE ?? "node";
}

function resolvePackagedReplayEngineExecutable(): string | undefined {
  const explicitPath = process.env.BW_FORGE_REPLAY_ENGINE_EXE?.trim();
  if (explicitPath && existsSync(explicitPath)) {
    return explicitPath;
  }
  return existsSync(PATHS.packagedReplayEngineExecutable)
    ? PATHS.packagedReplayEngineExecutable
    : undefined;
}

async function ensureReplayEngineStarcraftPath(): Promise<void> {
  const starcraftPath = process.env.BW_FORGE_STARCRAFT_PATH?.trim();
  if (!starcraftPath) {
    return;
  }

  const userDataDir = resolveReplayEngineUserDataDirectory();
  const settingsPath = join(
    userDataDir,
    process.env.SB_SESSION?.trim()
      ? `settings-${process.env.SB_SESSION.trim()}.json`
      : "settings.json"
  );

  await mkdir(userDataDir, { recursive: true });
  const current = await readJsonFileIfExists<Record<string, unknown>>(settingsPath);
  const nextSettings = {
    ...defaultReplayEngineLocalSettings(),
    ...(current ?? {}),
    starcraftPath,
    version: 15
  };
  await writeFile(settingsPath, `${JSON.stringify(nextSettings, null, 2)}\n`, "utf8");
}

function resolveReplayEngineUserDataDirectory(): string {
  const explicitExe = process.env.BW_FORGE_REPLAY_ENGINE_EXE?.trim();
  const appName = explicitExe ? basename(explicitExe, extname(explicitExe)) : "BW Forge Replay Engine";
  const appDataRoot = process.env.APPDATA
    ? resolve(process.env.APPDATA)
    : join(homedir(), "AppData", "Roaming");
  return join(appDataRoot, appName);
}

function defaultReplayEngineLocalSettings(): Record<string, unknown> {
  return {
    version: 15,
    winX: -1,
    winY: -1,
    winWidth: -1,
    winHeight: -1,
    winMaximized: false,
    runAppAtSystemStart: false,
    runAppAtSystemStartMinimized: false,
    starcraftPath: "",
    masterVolume: 50,
    quickOpenReplays: false,
    startingFog: "transparent",
    legacyCursorSizing: false,
    useCustomCursorSize: false,
    customCursorSize: 0.25
  };
}

async function resolveReplayEngineLaunchEnv(): Promise<NodeJS.ProcessEnv> {
  const packagedReplayEngine = resolvePackagedReplayEngineExecutable();
  if (!packagedReplayEngine) {
    return {};
  }

  const sourceRoot = (
    process.env.BW_FORGE_REPLAY_ENGINE_CWD?.trim()
      ? resolve(process.env.BW_FORGE_REPLAY_ENGINE_CWD)
      : dirname(packagedReplayEngine)
  );
  const stagedRoot = await stageReplayEngineRuntime(sourceRoot);
  return {
    BW_FORGE_REPLAY_ENGINE_EXE: join(stagedRoot, "BW Forge Replay Engine.exe"),
    BW_FORGE_REPLAY_ENGINE_CWD: stagedRoot,
  };
}

async function stageReplayEngineRuntime(sourceRoot: string): Promise<string> {
  const runtimeKey = await replayEngineRuntimeKey(sourceRoot);
  const cacheBase = process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, "BW Forge", "runtime-cache", "replay-engine")
    : join(homedir(), "AppData", "Local", "BW Forge", "runtime-cache", "replay-engine");
  const stagedRoot = join(cacheBase, runtimeKey);
  const stagedExecutable = join(stagedRoot, "BW Forge Replay Engine.exe");
  const stagedGameDist = join(stagedRoot, "resources", "game", "dist");

  if (existsSync(stagedExecutable) && existsSync(join(stagedGameDist, "shieldbattery.dll"))) {
    validateReplayEngineStagePath(stagedExecutable);
    return stagedRoot;
  }

  await mkdir(dirname(stagedRoot), { recursive: true });
  await rm(stagedRoot, { recursive: true, force: true });
  await mkdir(stagedRoot, { recursive: true });
  if (process.platform === "win32") {
    await runCommand({
      command: "powershell",
      args: [
        "-NoProfile",
        "-Command",
        `Copy-Item -Path ${toPowerShellLiteral(join(sourceRoot, "*"))} -Destination ${toPowerShellLiteral(stagedRoot)} -Recurse -Force`
      ],
      cwd: PATHS.repoRoot,
      env: process.env
    });
  } else {
    await cp(sourceRoot, stagedRoot, { recursive: true });
  }
  validateReplayEngineStagePath(stagedExecutable);
  return stagedRoot;
}

async function replayEngineRuntimeKey(sourceRoot: string): Promise<string> {
  const hash = createHash("sha256");
  const manifestPath = PATHS.runtimeManifest;
  if (existsSync(manifestPath)) {
    hash.update(await readFile(manifestPath));
  } else {
    hash.update(sourceRoot);
    hash.update(String((await stat(join(sourceRoot, "BW Forge Replay Engine.exe"))).mtimeMs));
  }
  return hash.digest("hex").slice(0, 12);
}

function validateReplayEngineStagePath(executablePath: string): void {
  if (executablePath.length > 120) {
    throw new Error(
      `Staged replay engine path is still too long (${executablePath.length} chars): ${executablePath}`
    );
  }
}

function toPowerShellLiteral(value: string): string {
  return `'${value.replace(/'/gu, "''")}'`;
}

function buildPythonCommandFallbacks(args: string[]): Array<{
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}> {
  const fallbacks: Array<{ command: string; args: string[] }> = [];
  if (process.env.BW_FORGE_PYTHON) {
    fallbacks.push({ command: process.env.BW_FORGE_PYTHON, args });
  } else if (process.platform === "win32") {
    fallbacks.push({ command: "py", args: ["-3", ...args] });
    fallbacks.push({ command: "python", args });
    fallbacks.push({ command: "python3", args });
    fallbacks.push({
      command: join(homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", "python.exe"),
      args
    });
  } else {
    fallbacks.push({ command: "python3", args });
    fallbacks.push({ command: "python", args });
  }

  return fallbacks.map((entry) => ({
    ...entry,
    cwd: PATHS.legacyReplayAnalysisDir,
    env: withoutElectronRunAsNode(process.env)
  }));
}

async function runCommandWithFallbacks(commands: Array<{
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}>): Promise<void> {
  let lastError: unknown;
  for (const command of commands) {
    try {
      await runCommand(command);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function runCorpusQuerySubcommand(params: {
  entrypointName: string;
  distEntrypoint: string;
  sourceEntrypoint: string;
  args: string[];
  preferSource?: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const env = {
    ...process.env,
    ...(params.env ?? {}),
    NODE_NO_WARNINGS: (params.env ?? process.env).NODE_NO_WARNINGS ?? "1"
  };
  if (!params.preferSource && (await fileExists(params.distEntrypoint))) {
    await runCommand({
      command: resolveNodeCommand(),
      args: [params.distEntrypoint, ...params.args],
      cwd: PATHS.corpusQueryDir,
      env
    });
    return;
  }

  await assertFileExists(
    PATHS.corpusQueryTsx,
    `Missing imported corpus-query ${params.entrypointName} runtime. Expected either dist output or tsx under packages/corpus-query/node_modules.`
  );
  await runCommand({
    command: resolveNodeCommand(),
    args: [PATHS.corpusQueryTsx, params.sourceEntrypoint, ...params.args],
    cwd: PATHS.corpusQueryDir,
    env
  });
}

function shouldPreferSourceRuntime(): boolean {
  return process.env.BW_FORGE_RUNTIME_KIND !== "packaged";
}

function withoutElectronRunAsNode(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const nextEnv = { ...env };
  delete nextEnv.ELECTRON_RUN_AS_NODE;
  return nextEnv;
}

async function runCommand(params: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(params.command, params.args, {
      cwd: params.cwd,
      env: params.env,
      stdio: "inherit",
      shell: false
    });

    child.on("error", rejectPromise);
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(new Error(`Command failed (${code}): ${params.command} ${params.args.join(" ")}`));
    });
  });
}

async function assertFileExists(pathValue: string, message: string): Promise<void> {
  if (!(await fileExists(pathValue))) {
    throw new Error(message || `Expected file at ${pathValue}`);
  }
}

async function fileExists(pathValue: string): Promise<boolean> {
  return (await safeStat(pathValue))?.isFile() ?? false;
}

async function safeStat(pathValue: string): Promise<Awaited<ReturnType<typeof stat>> | undefined> {
  try {
    return await stat(pathValue);
  } catch {
    return undefined;
  }
}

async function readJsonFileIfExists<T>(pathValue: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(pathValue, "utf8")) as T;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function readJsonFile<T>(pathValue: string): Promise<T> {
  return JSON.parse(await readFile(pathValue, "utf8")) as T;
}

async function writeJsonFile(pathValue: string, value: unknown): Promise<void> {
  await writeFile(pathValue, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function normalizeRelative(basePath: string, targetPath: string): string {
  return relative(basePath, targetPath).replace(/\\/gu, "/");
}

function printHelp(): void {
  console.log(`bw-forge

Commands:
  bw-forge analyze <replay-or-dir> --out <dir> [--keep-snapshots] [--snapshot-dir <path>] [--shieldbattery-dir <path>] [--replay-export-speed <n>]
  bw-forge ingest <analysis-dir> --db <path>
  bw-forge mcp --db <path> [--transport stdio|http] [--host <host>] [--port <port>] [--path <path>]

Environment overrides:
  BW_FORGE_PYTHON
  BW_FORGE_NODE
  BW_FORGE_PNPM
`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

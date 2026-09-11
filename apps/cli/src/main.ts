#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";
import { ingestReplayAnalysis, applyIdentities, exportIdentities } from "../../../packages/corpus-store/src/index.js";
import { analyzeAndPublishReplay } from "../../../packages/corpus-store/src/publication.js";
import { createAnalysisWorker, createWorkerId, enqueueReplay, listAnalysisJobs, retryAnalysisJob,
  showAnalysisJob, type JobStatus } from "../../../packages/corpus-store/src/jobs.js";
import { createReplayWatcher } from "../../../packages/corpus-store/src/watcher.js";
import { backfillReplayPlayedAt } from "../../../packages/corpus-store/src/chronology.js";
import { assertSafeAnalyzeOutputRoot } from "./analyze-output-path.js";
import { buildCommandSpawnOptions } from "./child-process.js";
import { corpusQueryRuntimeArgs } from "./corpus-query-runtime.js";
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
  bwsimDir: resolve(REPO_ROOT, "third_party", "bwsim"),
  bwsimExporterSource: resolve(REPO_ROOT, "apps", "cli", "src", "bwsim-exporter.ts"),
  bwsimExporterBuilt: resolve(REPO_ROOT, "apps", "cli", "src", "bwsim-exporter.js"),
  corpusQueryDir: resolve(REPO_ROOT, "packages", "corpus-query")
} as const;

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;
  switch (command) {
    case "watch": {
      const operation=args[0],rest=args.slice(1);
      if(operation!=="once"&&operation!=="run")throw new Error("Usage: bw-forge watch once|run --path <dir> [--path <dir> ...] --corpus-root <root> --db <path>");
      const paths=optionValues(rest,"--path").map(resolveOptionPath);
      if(!paths.length)throw new Error("At least one --path is required");
      const stabilityMs=integerOption(rest,"--stability-ms",1500);
      const reconcileSeconds=integerOption(rest,"--reconcile-seconds",60);
      const options={paths,corpusRoot:resolveOptionPath(requireOption(rest,"--corpus-root")),dbPath:resolveOptionPath(requireOption(rest,"--db")),
        recursive:hasFlag(rest,"--recursive"),stabilityMs,reconcileMs:reconcileSeconds*1000};
      const watcher=createReplayWatcher();
      if(operation==="once")console.log(JSON.stringify(await watcher.once(options),null,2));
      else{
        const controller=new AbortController();
        const stop=()=>controller.abort();process.once("SIGINT",stop);process.once("SIGTERM",stop);
        try{console.log(JSON.stringify(await watcher.run({...options,signal:controller.signal}),null,2));}
        finally{process.removeListener("SIGINT",stop);process.removeListener("SIGTERM",stop);}
      }
      return;
    }
    case "jobs": {
      const operation=args[0], rest=args.slice(1), db=resolveOptionPath(requireOption(rest,"--db"));
      if(operation==="enqueue"){
        if(!rest[0]||rest[0].startsWith("--"))throw new Error("Missing replay path.");
        console.log(JSON.stringify(await enqueueReplay({replayPath:resolveOptionPath(rest[0]),
          corpusRoot:resolveOptionPath(requireOption(rest,"--corpus-root")),dbPath:db,
          priority:integerOption(rest,"--priority",0),force:hasFlag(rest,"--force")}),null,2));
      }else if(operation==="list"){
        const status=optionalOption(rest,"--status");
        if(status&&!(["queued","running","succeeded","failed"] as string[]).includes(status))throw new Error(`Invalid --status: ${status}`);
        console.log(JSON.stringify(await listAnalysisJobs(db,{...(status?{status:status as JobStatus}:{}),limit:integerOption(rest,"--limit",100)}),null,2));
      }else if(operation==="show"&&rest[0]&&!rest[0].startsWith("--"))console.log(JSON.stringify(await showAnalysisJob(db,rest[0]),null,2));
      else if(operation==="retry"&&rest[0]&&!rest[0].startsWith("--"))console.log(JSON.stringify(await retryAnalysisJob(db,rest[0]),null,2));
      else throw new Error("Usage: bw-forge jobs enqueue|list|show|retry ...");
      return;
    }
    case "worker": {
      const operation=args[0],rest=args.slice(1);
      if(operation!=="once"&&operation!=="run")throw new Error("Usage: bw-forge worker once|run --corpus-root <root> --db <path>");
      const options={corpusRoot:resolveOptionPath(requireOption(rest,"--corpus-root")),dbPath:resolveOptionPath(requireOption(rest,"--db")),
        workerId:optionalOption(rest,"--worker-id")??createWorkerId()};
      const worker=createAnalysisWorker();
      if(operation==="once")console.log(JSON.stringify(await worker.once(options),null,2));
      else{
        const controller=new AbortController();
        const stop=()=>controller.abort();process.once("SIGINT",stop);process.once("SIGTERM",stop);
        try{console.log(JSON.stringify(await worker.run({...options,pollMs:integerOption(rest,"--poll-ms",1000),signal:controller.signal}),null,2));}
        finally{process.removeListener("SIGINT",stop);process.removeListener("SIGTERM",stop);}
      }
      return;
    }
    case "identities": {
      const db = requireOption(args, "--db");
      if (args[0] === "apply" && args[1] && !args[1].startsWith("--")) {
        console.log(JSON.stringify(await applyIdentities(db, args[1]), null, 2));
      } else if (args[0] === "export") {
        console.log(JSON.stringify(await exportIdentities(db), null, 2));
      } else throw new Error("Usage: bw-forge identities apply <config.json> --db <path> | identities export --db <path>");
      return;
    }
    case "replays": {
      if(args[0]!=="backfill-played-at")throw new Error("Usage: bw-forge replays backfill-played-at --corpus-root <root> --db <path>");
      console.log(JSON.stringify(await backfillReplayPlayedAt({corpusRoot:resolveOptionPath(requireOption(args,"--corpus-root")),
        dbPath:resolveOptionPath(requireOption(args,"--db"))}),null,2));
      return;
    }
    case "reports": {
      if(args[0]!=="index")throw new Error("Usage: bw-forge reports index --db <path> --analyses-root <root>");
      await runCorpusQuerySubcommand({entrypointName:"corpus-query CLI",entrypoint:"cli",args:["reports","index",
        "--db",resolveOptionPath(requireOption(args,"--db")),"--analyses-root",resolveOptionPath(requireOption(args,"--analyses-root"))]});
      return;
    }
    case "analyze":
      await analyzeCommand(args);
      return;
    case "analyze-v2": {
      if (!args[0] || args[0].startsWith("--")) throw new Error("Missing replay path.");
      console.log(JSON.stringify(await analyzeAndPublishReplay({
        replayPath: args[0], corpusRoot: requireOption(args.slice(1), "--corpus-root"),
        dbPath: optionalOption(args.slice(1), "--db"), keepFailedWork: hasFlag(args.slice(1), "--keep-failed-work")
      }), null, 2));
      return;
    }
    case "ingest":
      await ingestCommand(args);
      return;
    case "ingest-v2": {
      if (!args[0] || args[0].startsWith("--")) throw new Error("Missing replay manifest path.");
      console.log(JSON.stringify(await ingestReplayAnalysis({
        replayManifestPath: args[0], dbPath: requireOption(args.slice(1), "--db")
      }), null, 2));
      return;
    }
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
      bwsimDir: options.bwsimDir ? resolveOptionPath(options.bwsimDir) : PATHS.bwsimDir
    });
  }

  await writeCorpusManifest(outputRoot);
}

async function ingestCommand(argv: string[]): Promise<void> {
  const options = parseIngestArgs(argv);
  await mkdir(dirname(resolveOptionPath(options.db)), { recursive: true });
  await runCorpusQuerySubcommand({
    entrypointName: "CLI",
    entrypoint: "cli",
    args: ["ingest", resolveOptionPath(options.analysisDir), "--db", resolveOptionPath(options.db)]
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
    entrypoint: "mcp/server",
    args: [
      "--db",
      resolveOptionPath(options.db),
      "--transport",
      options.transport,
      ...(options.transport === "http"
        ? ["--host", options.host, "--port", String(options.port), "--path", options.path]
        : [])
    ],
    env
  });
}

async function analyzeReplay(params: {
  replayPath: string;
  outputRoot: string;
  keepSnapshots: boolean;
  snapshotDir?: string;
  bwsimDir: string;
}): Promise<void> {
  const replayId = await computeReplayId(params.replayPath);
  const replayDir = join(params.outputRoot, "replays", replayId);
  const rawDir = join(replayDir, "raw");
  const legacyDir = join(replayDir, "legacy");
  await mkdir(rawDir, { recursive: true });
  await mkdir(legacyDir, { recursive: true });

  const copiedReplayPath = join(rawDir, basename(params.replayPath));
  await copyFile(params.replayPath, copiedReplayPath);

  const snapshotBaseDir = params.snapshotDir
    ? resolve(params.snapshotDir)
    : params.keepSnapshots
      ? join(replayDir, "debug")
      : await mkdtemp(join(tmpdir(), "bw-forge-bwsim-"));
  const temporarySnapshotDir = params.keepSnapshots ? undefined : snapshotBaseDir;
  const snapshotPath = join(snapshotBaseDir, `${replayId}.jsonl`);
  const retainedSnapshotPath = params.keepSnapshots ? snapshotPath : undefined;
  await mkdir(snapshotBaseDir, { recursive: true });

  try {
    const extractionStartedAt = performance.now();
    await runBwsimExporter({
      replayPath: params.replayPath,
      snapshotPath,
      bwsimDir: params.bwsimDir
    });
    console.log(
      `[bwsim] extraction completed in ${((performance.now() - extractionStartedAt) / 1000).toFixed(2)}s`
    );

    await runLegacyReplayAnalysis({
      analysisInput: snapshotPath,
      legacyDir,
      embeddedReplayInput: params.replayPath
    });

    const legacyManifestPath = join(legacyDir, "manifest.json");
    const legacyManifest = await readJsonFile<LegacyReplayAnalysisManifest>(legacyManifestPath);
    const replayManifest = await buildReplayManifest({
      replayId,
      replayDir,
      replayPath: params.replayPath,
      copiedReplayPath,
      legacyManifest,
      snapshotPath: retainedSnapshotPath
    });
    await writeJsonFile(join(replayDir, "replay-manifest.json"), replayManifest);
  } finally {
    if (temporarySnapshotDir) {
      await rm(temporarySnapshotDir, { recursive: true, force: true });
    }
  }
}

async function runBwsimExporter(params: {
  replayPath: string;
  snapshotPath: string;
  bwsimDir: string;
}): Promise<void> {
  const exporterPath = existsSync(PATHS.bwsimExporterBuilt)
    ? PATHS.bwsimExporterBuilt
    : PATHS.bwsimExporterSource;
  await runCommand({
    command: resolveNodeCommand(),
    args: [
      ...(exporterPath.endsWith(".ts") ? ["--experimental-strip-types"] : []),
      exporterPath,
      "--replay",
      params.replayPath,
      "--out",
      params.snapshotPath,
      "--wasm",
      join(params.bwsimDir, "bwsim_wasm.bwforge.wasm"),
      "--asset-pack",
      join(params.bwsimDir, "sim.pack.gz")
    ],
    cwd: PATHS.repoRoot,
    env: process.env
  });
}

async function runLegacyReplayAnalysis(params: {
  analysisInput: string;
  legacyDir: string;
  embeddedReplayInput: string;
}): Promise<void> {
  const templatePath = await ensureScForgeTemplate();
  const args = [
    PATHS.legacyReplayAnalysisScript,
    params.analysisInput,
    params.legacyDir,
    "--build-order-template",
    templatePath,
    "--embedded-replay-input",
    params.embeddedReplayInput
  ];
  await runCommandWithFallbacks(buildPythonCommandFallbacks(args));
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
  bwsimDir?: string;
} {
  if (argv.length === 0) {
    throw new Error("Missing analyze input path.");
  }
  const input = argv[0];
  const out = requireOption(argv.slice(1), "--out");
  const keepSnapshots = hasFlag(argv.slice(1), "--keep-snapshots");
  const snapshotDir = optionalOption(argv.slice(1), "--snapshot-dir");
  for (const removedOption of ["--backend", "--shieldbattery-dir", "--replay-export-speed"]) {
    if (optionalOption(argv.slice(1), removedOption) !== undefined || hasFlag(argv.slice(1), removedOption)) {
      throw new Error(`${removedOption} was removed; replay analysis always uses the bundled bwsim backend.`);
    }
  }
  const bwsimDir = optionalOption(argv.slice(1), "--bwsim-dir");
  if (snapshotDir && !keepSnapshots) {
    throw new Error("--snapshot-dir requires --keep-snapshots.");
  }
  return { input, out, keepSnapshots, snapshotDir, bwsimDir };
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

function optionValues(argv:string[],name:string):string[]{
  const values:string[]=[];
  for(let index=0;index<argv.length;index++){
    if(argv[index]===name&&argv[index+1]&&!argv[index+1]!.startsWith("--"))values.push(argv[++index]!);
    else if(argv[index]?.startsWith(`${name}=`))values.push(argv[index]!.slice(name.length+1));
  }
  return values;
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

function integerOption(argv:string[],name:string,fallback:number):number{
  const value=Number(optionalOption(argv,name)??fallback);
  if(!Number.isSafeInteger(value))throw new Error(`${name} must be an integer`);return value;
}

function resolveOptionPath(pathValue: string): string {
  return isAbsolute(pathValue) ? pathValue : resolve(process.cwd(), pathValue);
}

function resolveNodeCommand(): string {
  return process.env.BW_FORGE_NODE ?? "node";
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
  entrypoint: "cli" | "mcp/server";
  args: string[];
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const env = {
    ...process.env,
    ...(params.env ?? {}),
    NODE_NO_WARNINGS: (params.env ?? process.env).NODE_NO_WARNINGS ?? "1"
  };
  await runCommand({
    command: resolveNodeCommand(),
    args: [...await corpusQueryRuntimeArgs(PATHS.corpusQueryDir, params.entrypoint, params.entrypointName), ...params.args],
    cwd: PATHS.corpusQueryDir,
    env
  });
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
    const child = spawn(
      params.command,
      params.args,
      buildCommandSpawnOptions({ cwd: params.cwd, env: params.env })
    );

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
  bw-forge analyze <replay-or-dir> --out <dir> [--keep-snapshots] [--snapshot-dir <path>] [--bwsim-dir <path>]
  bw-forge ingest <analysis-dir> --db <path>
  bw-forge ingest-v2 <replay-manifest.json> --db <path>
  bw-forge analyze-v2 <replay.rep> --corpus-root <dir> [--db <path>] [--keep-failed-work]
  bw-forge identities apply <config.json> --db <path>
  bw-forge identities export --db <path>
  bw-forge replays backfill-played-at --corpus-root <root> --db <path>
  bw-forge reports index --db <path> --analyses-root <root>
  bw-forge jobs enqueue <replay.rep> --corpus-root <root> --db <path> [--priority <n>] [--force]
  bw-forge jobs list --db <path> [--status queued|running|succeeded|failed] [--limit <n>]
  bw-forge jobs show <job-key> --db <path>
  bw-forge jobs retry <job-key> --db <path>
  bw-forge worker once --corpus-root <root> --db <path> [--worker-id <id>]
  bw-forge worker run --corpus-root <root> --db <path> [--worker-id <id>] [--poll-ms <ms>]
  bw-forge watch once --path <dir> [--path <dir> ...] --corpus-root <root> --db <path> [--recursive] [--stability-ms <n>]
  bw-forge watch run --path <dir> [--path <dir> ...] --corpus-root <root> --db <path> [--recursive] [--stability-ms <n>] [--reconcile-seconds <n>]
  bw-forge mcp --db <path> [--transport stdio|http] [--host <host>] [--port <port>] [--path <path>]

Environment overrides:
  BW_FORGE_PYTHON
  BW_FORGE_NODE
`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { readReplayMetadata } from "./replay-metadata.js";

export interface IngestReplayAnalysisOptions {
  dbPath: string;
  replayManifestPath: string;
  jobAttempt?: {
    jobKey: string;
    workerId: string;
    attemptNumber: number;
  };
}

export interface IngestReplayAnalysisResult {
  status: "indexed" | "no-op";
  analysisId: number;
  analysisKey: string;
  replaySha256: string;
  participations?: number;
  validation?: Record<string, number>;
  integrity?: "ok";
  foreignKeyViolations?: number;
}

export interface PreparedReplayAnalysis {
  replaySha256: string;
  analysisKey: string;
  specificationFingerprint: string;
  artifacts: Array<[string, string, number]>;
}

/** Validate source artifacts and obtain the exact ingest identity without opening a database. */
export async function prepareReplayAnalysis(replayManifestPath: string): Promise<PreparedReplayAnalysis> {
  return runStore([resolve(replayManifestPath), "--prepare"]);
}

/** Ingest exactly one existing replay manifest; never discover or migrate a v1 corpus.
 * Requires Python >=3.11 with SQLite >=3.37. BW_FORGE_PYTHON selects the runtime.
 */
export async function ingestReplayAnalysis(options: IngestReplayAnalysisOptions): Promise<IngestReplayAnalysisResult> {
  const manifestPath = resolve(options.replayManifestPath);
  let playedAtUnixSeconds: number | null = null;
  let mapName: string | null = null;
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { source?: { copied_path?: unknown } };
    if (typeof manifest.source?.copied_path === "string") {
      const metadata = await readReplayMetadata(resolve(dirname(manifestPath), manifest.source.copied_path));
      playedAtUnixSeconds = metadata.playedAtUnixSeconds;
      mapName = metadata.mapName;
    }
  } catch {
    // Valid analytical artifacts may reference a replay whose header metadata is unavailable.
  }
  const attempt = options.jobAttempt;
  if (attempt && (!attempt.jobKey || !attempt.workerId || !Number.isSafeInteger(attempt.attemptNumber) || attempt.attemptNumber < 1)) {
    throw new Error("Invalid analysis job attempt fence");
  }
  return runStore([manifestPath, "--db", resolve(options.dbPath),
    ...(attempt ? ["--job-key", attempt.jobKey, "--worker-id", attempt.workerId,
      "--attempt-number", String(attempt.attemptNumber)] : []),
    ...(playedAtUnixSeconds === null ? [] : ["--played-at-unix-s", String(playedAtUnixSeconds)]),
    ...(mapName === null ? [] : [`--map-name=${mapName}`])]);
}

export async function runStore<T>(args: string[]): Promise<T> {
  const script = fileURLToPath(new URL("../python/store.py", import.meta.url));
  const configured = process.env.BW_FORGE_PYTHON;
  const candidates = configured ? [[configured]] : process.platform === "win32"
    ? [["py", "-3"], ["python"], ["python3"]] : [["python3"], ["python"]];
  for (const [index, candidate] of candidates.entries()) {
    try {
      return await new Promise<T>((resolvePromise, reject) => {
        const env = { ...process.env };
        delete env.ELECTRON_RUN_AS_NODE;
        const child = spawn(candidate[0], [...candidate.slice(1), script, ...args], {
          windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
        child.stderr.setEncoding("utf8").on("data", chunk => { stderr = (stderr + chunk).slice(-16384); });
        child.on("error", reject);
        child.on("close", code => {
          if (code !== 0) {
            reject(new Error(`Corpus v2 ingestion failed (${code}): ${stderr.trim()}`));
            return;
          }
          try { resolvePromise(JSON.parse(stdout) as T); }
          catch { reject(new Error(`Invalid corpus-store response: ${stdout.slice(0, 500)}`)); }
        });
      });
    } catch (error) {
      // Retry only a missing executable; never rerun an importer that actually failed.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || index === candidates.length - 1) throw error;
    }
  }
  throw new Error("No Python runtime available; set BW_FORGE_PYTHON.");
}

/** Replace the user-curated catalog atomically; raw participation/analysis rows are untouched. */
export async function applyIdentities(dbPath: string, configPath: string): Promise<{ status: "applied" | "no-op" }> {
  return runStore(["identities", "--db", resolve(dbPath), "--config", resolve(configPath)]);
}

export async function exportIdentities(dbPath: string): Promise<Record<string, unknown>> {
  return runStore(["identities", "--db", resolve(dbPath)]);
}

export interface ImportIdentitiesOptions {
  inputPath:string;
  basePath:string;
  outputPath:string;
  format?:"csv"|"json";
  dryRun?:boolean;
}

export interface ImportIdentitiesResult {
  status:"dry-run"|"conflict"|"no-op"|"written";
  playersAdded:number;
  aliasesAdded:number;
  aliasesUnchanged:number;
  conflicts:number;
  outputWouldChange:boolean;
  conflictDetails:Array<Record<string,unknown>>;
  output:string;
}

/** Merge community alias rows into a complete catalog file without opening a database. */
export async function importIdentities(options:ImportIdentitiesOptions):Promise<ImportIdentitiesResult> {
  return runStore(["identities-import",resolve(options.inputPath),"--base",resolve(options.basePath),
    "--output",resolve(options.outputPath),...(options.format?["--format",options.format]:[]),...(options.dryRun?["--dry-run"]:[])]);
}

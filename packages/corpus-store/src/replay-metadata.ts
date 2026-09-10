import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export interface ReplayMetadata {
  playedAtUnixSeconds: number | null;
}

export interface ReplayMetadataResult extends ReplayMetadata {
  path: string;
  error: string | null;
}

const metadataByPath = new Map<string, Promise<ReplayMetadata>>();

/** Read replay-declared chronology through headless-bwsim's decoded DRPL header.
 * No simulation frames are executed and no filesystem timestamp is consulted.
 */
export async function readReplayMetadata(replayPath: string): Promise<ReplayMetadata> {
  const path = resolve(replayPath);
  const existing = metadataByPath.get(path);
  if (existing) return existing;
  const pending = readReplayMetadataBatch([path]).then(([result]) => {
    if (!result || result.error) throw new Error(`Replay metadata extraction failed for ${result?.path ?? path}: ${result?.error ?? "missing result"}`);
    return { playedAtUnixSeconds: result.playedAtUnixSeconds };
  });
  metadataByPath.set(path, pending);
  pending.catch(() => metadataByPath.delete(path));
  return pending;
}

/** A batch shares one bwsim instance, which keeps corpus backfills cheap. */
export async function readReplayMetadataBatch(replayPaths: string[]): Promise<ReplayMetadataResult[]> {
  if (!replayPaths.length) return [];
  const paths = replayPaths.map(path => resolve(path));
  const entry = fileURLToPath(new URL("./replay-metadata-runtime.mjs", import.meta.url));
  const runtime = process.env.BW_FORGE_NODE || "node";
  return new Promise((resolvePromise, reject) => {
    const child = spawn(runtime, [entry], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: process.env });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr = (stderr + chunk).slice(-16384); });
    child.on("error", reject);
    child.on("close", code => {
      if (code !== 0) return reject(new Error(`Replay metadata runtime failed (${code}): ${stderr.trim()}`));
      try {
        const result = JSON.parse(stdout) as ReplayMetadataResult[];
        if (!Array.isArray(result) || result.length !== paths.length || result.some((row, index) => row.path !== paths[index] ||
          (row.playedAtUnixSeconds !== null && (!Number.isSafeInteger(row.playedAtUnixSeconds) || row.playedAtUnixSeconds <= 0)) ||
          (row.error !== null && typeof row.error !== "string"))) throw new Error("invalid metadata result shape");
        resolvePromise(result);
      } catch (error) { reject(new Error(`Invalid replay metadata response: ${error instanceof Error ? error.message : String(error)}`)); }
    });
    child.stdin.end(JSON.stringify(paths));
  });
}

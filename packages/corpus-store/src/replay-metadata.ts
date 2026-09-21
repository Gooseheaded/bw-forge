import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export interface ReplayMetadata {
  playedAtUnixSeconds: number | null;
  mapName: string | null;
}

export interface ReplayMetadataResult extends ReplayMetadata {
  path: string;
  error: string | null;
}

export const SCREP_RUNTIME = {
  version: "v1.13.4",
  platforms: {
    "linux-x64": {
      relativePath: "third_party/screp/linux-amd64/screp",
      sha256: "53027490e86a672237464fb4fa903528d17f9e449303b0de3f922be2bc4b7da9"
    },
    "win32-x64": {
      relativePath: "third_party/screp/windows-amd64/screp.exe",
      sha256: "9195a82e7cc39de750a97dbeb387d8b53d3ab6b00b5ef2dbcbaedaeb7f73f6e4"
    }
  }
} as const;

type ScrepRuntimeKey = keyof typeof SCREP_RUNTIME.platforms;
type ScrepDocument = {
  Header?: { StartTime?: unknown; Map?: unknown } | null;
  MapData?: { Name?: unknown } | null;
};

const metadataByPath = new Map<string, Promise<ReplayMetadata>>();
let verifiedRuntime: Promise<string> | undefined;

/** Read replay-declared chronology and observed map name through the pinned screp parser.
 * No bwsim/WASM simulation is initialized and no filesystem timestamp is consulted.
 */
export async function readReplayMetadata(replayPath: string): Promise<ReplayMetadata> {
  const path = resolve(replayPath);
  const existing = metadataByPath.get(path);
  if (existing) return existing;
  const pending = readReplayMetadataBatch([path]).then(([result]) => {
    if (!result || result.error) throw new Error(`Replay metadata extraction failed for ${result?.path ?? path}: ${result?.error ?? "missing result"}`);
    return { playedAtUnixSeconds: result.playedAtUnixSeconds, mapName: result.mapName };
  });
  metadataByPath.set(path, pending);
  pending.catch(() => metadataByPath.delete(path));
  return pending;
}

/** Parse each replay in deterministic input order with one short-lived screp process.
 * A malformed replay cannot affect its neighbors and subprocess creation is bounded to one at a time.
 */
export async function readReplayMetadataBatch(replayPaths: string[]): Promise<ReplayMetadataResult[]> {
  const results: ReplayMetadataResult[] = [];
  for (const replayPath of replayPaths.map(path => resolve(path))) {
    try {
      const document = await runScrep(replayPath);
      results.push({ path: replayPath, ...metadataFromScrepDocument(document), error: null });
    } catch (error) {
      results.push({ path: replayPath, playedAtUnixSeconds: null, mapName: null,
        error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

/** Convert screp's stable JSON fields into BW Forge's parser-independent metadata contract. */
export function metadataFromScrepDocument(value: unknown): ReplayMetadata {
  if (!value || typeof value !== "object") throw new Error("screp returned a non-object JSON document");
  const document = value as ScrepDocument;
  if (!document.Header || typeof document.Header !== "object") throw new Error("screp JSON is missing Header");
  const playedAtUnixSeconds = decodedStartTime(document.Header.StartTime);
  const mapName = decodedMapName(document.MapData?.Name) ?? decodedMapName(document.Header.Map);
  return { playedAtUnixSeconds, mapName };
}

async function runScrep(replayPath: string): Promise<unknown> {
  const executable = await resolveVerifiedScrepRuntime();
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, ["-map=true", "-maptiles=false", "-mapres=false", "-mapgfx=false",
      "-cmds=false", "-computed=false", "-indent=false", replayPath], {
      windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "", stderr = "", settled = false;
    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error(`screp metadata extraction timed out for ${replayPath}`));
    }, 30_000);
    child.stdout.setEncoding("utf8").on("data", chunk => {
      stdout += chunk;
      if (stdout.length > 4 * 1024 * 1024) {
        child.kill();
        finish(new Error(`screp metadata response exceeded 4 MiB for ${replayPath}`));
      }
    });
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr = (stderr + chunk).slice(-16384); });
    child.once("error", finish);
    child.once("close", code => {
      if (code !== 0) return finish(new Error(`screp metadata extraction failed (${code}) for ${replayPath}: ${(stderr || stdout).trim()}`));
      try { finish(undefined, JSON.parse(stdout)); }
      catch (error) { finish(new Error(`Invalid screp JSON for ${replayPath}: ${error instanceof Error ? error.message : String(error)}`)); }
    });
    function finish(error?: Error, result?: unknown) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) rejectPromise(error); else resolvePromise(result);
    }
  });
}

async function resolveVerifiedScrepRuntime(): Promise<string> {
  verifiedRuntime ??= verifyScrepRuntime();
  return verifiedRuntime;
}

async function verifyScrepRuntime(): Promise<string> {
  const key = `${process.platform}-${process.arch}` as ScrepRuntimeKey;
  const pinned = SCREP_RUNTIME.platforms[key];
  if (!pinned) throw new Error(`screp ${SCREP_RUNTIME.version} is not bundled for ${process.platform}/${process.arch}`);
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const executable = resolve(root, pinned.relativePath);
  const entry = await lstat(executable);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`Pinned screp runtime is not a regular file: ${executable}`);
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(executable)) digest.update(chunk);
  const actual = digest.digest("hex");
  if (actual !== pinned.sha256) throw new Error(`Pinned screp runtime checksum mismatch: expected ${pinned.sha256}, got ${actual}`);
  return executable;
}

function decodedStartTime(value: unknown): number | null {
  if (typeof value !== "string" || value === "") return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || milliseconds % 1000 !== 0) {
    if (value.startsWith("0001-01-01T")) return null;
    throw new Error(`screp returned an invalid replay start timestamp: ${value}`);
  }
  const seconds = milliseconds / 1000;
  if (seconds <= 0) return null;
  if (!Number.isSafeInteger(seconds)) throw new Error(`screp replay timestamp is outside the safe integer range: ${value}`);
  return seconds;
}

function decodedMapName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // screp decodes legacy replay text and retains in-band StarCraft formatting
  // controls. Removing those nonprinting bytes preserves BW Forge's established
  // visible-name behavior; all other decoded text is retained verbatim.
  const visible = value.replace(/[\x00-\x1f\x7f]/gu, "");
  return visible.trim() === "" ? null : visible;
}

import { createHash, randomUUID } from "node:crypto";
import { createReadStream, constants } from "node:fs";
import { copyFile, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ingestReplayAnalysis, prepareReplayAnalysis, type IngestReplayAnalysisOptions,
  type IngestReplayAnalysisResult } from "./index.js";
import { existingAnalyzerSpecification, runExistingAnalyzer, type StagedAnalysisOptions } from "./analyzer.js";
import type { BwForgeReplayManifest } from "../../schemas/src/index.js";

export interface AnalyzeAndPublishReplayOptions {
  replayPath: string;
  corpusRoot: string;
  dbPath?: string;
  keepFailedWork?: boolean;
}

export interface PublishedReplayAnalysisResult {
  replaySha256: string;
  analysisKey: string;
  rawReplayPath: string;
  replayManifestPath: string;
  analysisDirectory: string;
  rawReused: boolean;
  artifactsReused: boolean;
  ingest: IngestReplayAnalysisResult;
}

interface FileChecksum { path: string; sha256: string; byteSize: number }
interface PublicationReceipt {
  format: "bw-forge-publication-receipt-v1";
  replaySha256: string;
  analysisKey: string;
  files: FileChecksum[];
}
type PublishedManifest = BwForgeReplayManifest & {
  analysis_spec?: Record<string, unknown>;
  publication?: { format: "bw-forge-publication-v1" };
};

export interface PublicationDependencies {
  analyze: (options: StagedAnalysisOptions) => Promise<void>;
  specification: () => Promise<Record<string, unknown>>;
  ingest: (options: IngestReplayAnalysisOptions) => Promise<IngestReplayAnalysisResult>;
}

function contained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

async function info(path: string) {
  try { return await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

async function directory(root: string, rel: string): Promise<string> {
  let path = root;
  for (const part of rel.split("/")) {
    if (!part || part === "." || part === "..") throw new Error("Invalid managed directory");
    path = join(path, part);
    await mkdir(path, { recursive: true });
    const entry = await lstat(path);
    if (!entry.isDirectory() || entry.isSymbolicLink() || !contained(root, await realpath(path))) {
      throw new Error(`Managed directory must not be a link: ${path}`);
    }
  }
  return path;
}

async function checksum(path: string): Promise<{ sha256: string; byteSize: number }> {
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`Expected a regular artifact file: ${path}`);
  const digest = createHash("sha256");
  let byteSize = 0;
  for await (const chunk of createReadStream(path)) { digest.update(chunk); byteSize += chunk.length; }
  return { sha256: digest.digest("hex"), byteSize };
}

export interface RegisteredCanonicalReplay {
  replaySha256: string;
  byteSize: number;
  canonicalReplayPath: string;
  canonicalRelativePath: string;
  reused: boolean;
}

/** Register raw bytes without trusting the source filename. A verified temp file
 * is atomically linked into place, providing stronger no-replace behavior than
 * rename on platforms where rename replaces an existing destination.
 */
export async function registerCanonicalReplay(options: {
  replayPath: string; corpusRoot: string; dbPath?: string;
}): Promise<RegisteredCanonicalReplay> {
  const requestedRoot=resolve(options.corpusRoot);
  await mkdir(requestedRoot,{recursive:true});
  const root=await realpath(requestedRoot);
  await directory(root,"work");await directory(root,"analyses");await directory(root,"replays");await directory(root,"db");
  const dbPath=resolve(options.dbPath??join(root,"db","corpus.sqlite"));
  for(const name of ["analyses","replays","work"]){const reserved=join(root,name);
    if(dbPath===reserved||contained(reserved,dbPath))throw new Error("Database path overlaps managed artifacts/work");}
  const input=resolve(options.replayPath), inputHash=await checksum(input);
  const rawDir=await directory(root,`replays/${inputHash.sha256.slice(0,2)}`);
  const target=join(rawDir,`${inputHash.sha256}.rep`);
  if(await info(target)){
    if(JSON.stringify(await checksum(target))!==JSON.stringify(inputHash))throw new Error("Canonical replay content mismatch");
    return {replaySha256:inputHash.sha256,byteSize:inputHash.byteSize,canonicalReplayPath:target,
      canonicalRelativePath:relative(root,target).split(sep).join("/"),reused:true};
  }
  const temporary=join(rawDir,`.${inputHash.sha256}.${randomUUID()}.tmp`);
  let reused=false;
  try {
    await copyFile(input,temporary,constants.COPYFILE_EXCL);
    if(JSON.stringify(await checksum(temporary))!==JSON.stringify(inputHash))throw new Error("Replay changed while copying");
    try{await link(temporary,target);}catch(error){
      if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;reused=true;
    }
    if(JSON.stringify(await checksum(target))!==JSON.stringify(inputHash))throw new Error("Canonical replay content mismatch");
  } finally {
    try{await unlink(temporary);}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  }
  return {replaySha256:inputHash.sha256,byteSize:inputHash.byteSize,canonicalReplayPath:target,
    canonicalRelativePath:relative(root,target).split(sep).join("/"),reused};
}

async function fileInventory(root: string): Promise<FileChecksum[]> {
  const files: FileChecksum[] = [];
  async function walk(path: string) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Artifact links are not publishable: ${full}`);
      if (entry.isDirectory()) await walk(full);
      else if (full !== join(root, "publication.json")) {
        files.push({ path: relative(root, full).split(sep).join("/"), ...await checksum(full) });
      }
    }
  }
  await walk(root);
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

async function verifyPublished(path: string, replaySha256: string, analysisKey: string): Promise<void> {
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`Invalid immutable analysis directory: ${path}`);
  await checksum(join(path, "publication.json")); // Reject receipt links as well.
  const receipt = JSON.parse(await readFile(join(path, "publication.json"), "utf8")) as PublicationReceipt;
  if (receipt.format !== "bw-forge-publication-receipt-v1" || receipt.replaySha256 !== replaySha256 ||
      receipt.analysisKey !== analysisKey || JSON.stringify(receipt.files) !== JSON.stringify(await fileInventory(path))) {
    throw new Error(`Immutable artifact content mismatch: ${path}`);
  }
  const prepared = await prepareReplayAnalysis(join(path, "replay-manifest.json"));
  if (prepared.analysisKey !== analysisKey || prepared.replaySha256 !== replaySha256) {
    throw new Error(`Immutable analysis identity mismatch: ${path}`);
  }
}

/** Dependency injection keeps failure/recovery tests on the real publication and database code. */
export function createReplayPublisher(dependencies: PublicationDependencies) {
  return async function publish(options: AnalyzeAndPublishReplayOptions): Promise<PublishedReplayAnalysisResult> {
    const requestedRoot = resolve(options.corpusRoot);
    await mkdir(requestedRoot, { recursive: true });
    const root = await realpath(requestedRoot);
    const workRoot = await directory(root, "work");
    await directory(root, "analyses");
    await directory(root, "replays");
    await directory(root, "db");
    const dbPath = resolve(options.dbPath ?? join(root, "db", "corpus.sqlite"));
    // A caller-supplied DB can be external, but never mixed into managed artifacts/work.
    for (const name of ["analyses", "replays", "work"]) {
      const reserved = join(root, name);
      if (dbPath === reserved || contained(reserved, dbPath)) throw new Error("Database path overlaps managed artifacts/work");
    }
    const work = await mkdtemp(join(workRoot, "analysis-"));
    let succeeded = false;
    try {
      const snapshot = join(work, "input.rep");
      const inputHash = await checksum(resolve(options.replayPath));
      await copyFile(resolve(options.replayPath), snapshot, constants.COPYFILE_EXCL);
      if (JSON.stringify(await checksum(snapshot)) !== JSON.stringify(inputHash)) throw new Error("Replay changed while copying");
      const replaySha256 = inputHash.sha256;
      const rawDir = await directory(root, `replays/${replaySha256.slice(0, 2)}`);
      const rawReplayPath = join(rawDir, `${replaySha256}.rep`);
      let rawReused = false;
      try {
        // Hard-link creation is an atomic no-replace operation on our shared filesystem.
        await link(snapshot, rawReplayPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        rawReused = true;
      }
      if (JSON.stringify(await checksum(rawReplayPath)) !== JSON.stringify(inputHash)) throw new Error("Canonical replay content mismatch");
      await unlink(snapshot);
      const outputRoot = await directory(work, "output");
      const specification = await dependencies.specification();
      await dependencies.analyze({ replayPath: rawReplayPath, outputRoot, workDirectory: work });
      if (JSON.stringify(await dependencies.specification()) !== JSON.stringify(specification)) {
        throw new Error("Analyzer inputs changed during analysis");
      }
      const staged = join(outputRoot, "replays", replaySha256);
      if (!contained(work, await realpath(staged))) throw new Error("Analyzer output escaped staging");
      await fileInventory(staged); // Reject symlinks before reading referenced outputs.
      const stagedManifest = join(staged, "replay-manifest.json");
      const manifest = JSON.parse(await readFile(stagedManifest, "utf8")) as PublishedManifest;
      if (manifest.replay_id !== replaySha256) throw new Error("Analyzer replay identity mismatch");
      if (!manifest.legacy.html_files.length) throw new Error("Analyzer produced no HTML report");
      for (const name of manifest.legacy.html_files) {
        const path = resolve(staged, name);
        if (!contained(staged, path) || (await checksum(path)).byteSize === 0) throw new Error("Missing or invalid HTML report");
      }
      manifest.analysis_spec = specification;
      // Retained diagnostic snapshots live in work/, never in the immutable publication.
      delete manifest.debug;
      await writeFile(stagedManifest, `${JSON.stringify(manifest, null, 2)}\n`);
      const prepared = await prepareReplayAnalysis(stagedManifest);
      const analysisKey = prepared.analysisKey;
      const parent = await directory(root, `analyses/${replaySha256}`);
      const analysisDirectory = join(parent, analysisKey);
      const replayManifestPath = join(analysisDirectory, "replay-manifest.json");
      const stagedRaw = resolve(staged, manifest.source.copied_path);
      if (!contained(staged, stagedRaw) || (await checksum(stagedRaw)).sha256 !== replaySha256) throw new Error("Invalid staged replay copy");
      manifest.source.original_path = rawReplayPath;
      manifest.source.copied_path = relative(analysisDirectory, rawReplayPath).split(sep).join("/");
      manifest.publication = { format: "bw-forge-publication-v1" };
      await writeFile(stagedManifest, `${JSON.stringify(manifest, null, 2)}\n`);
      await unlink(stagedRaw); // Keep only the canonical managed replay copy.
      if (dirname(stagedRaw) !== staged && (await readdir(dirname(stagedRaw))).length === 0) await rmdir(dirname(stagedRaw));
      const receipt: PublicationReceipt = { format: "bw-forge-publication-receipt-v1", replaySha256, analysisKey,
        files: await fileInventory(staged) };
      await writeFile(join(staged, "publication.json"), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
      let artifactsReused = false;
      if (await info(analysisDirectory)) {
        await verifyPublished(analysisDirectory, replaySha256, analysisKey);
        artifactsReused = true;
      } else {
        // Local/single-process contract: never replace any pre-existing directory, even an empty one.
        await rename(staged, analysisDirectory);
        await verifyPublished(analysisDirectory, replaySha256, analysisKey);
      }
      const ingest = await dependencies.ingest({ dbPath, replayManifestPath });
      if (ingest.analysisKey !== analysisKey) throw new Error("Ingest returned a different analysis identity");
      succeeded = true;
      return { replaySha256, analysisKey, rawReplayPath, replayManifestPath, analysisDirectory, rawReused, artifactsReused, ingest };
    } catch (error) {
      if (options.keepFailedWork) {
        throw new Error(`${error instanceof Error ? error.message : String(error)}; failed work retained at ${work}`, { cause: error });
      }
      throw error;
    } finally {
      if (succeeded || !options.keepFailedWork) {
        // Only this invocation's mkdtemp path can be removed; resolve/check before recursive deletion.
        const actual = await realpath(work);
        if (dirname(actual) !== await realpath(workRoot) || !contained(root, actual)) throw new Error("Unsafe staging cleanup path");
        await rm(actual, { recursive: true, force: true });
      }
    }
  };
}

export const analyzeAndPublishReplay = createReplayPublisher({
  analyze: runExistingAnalyzer, specification: existingAnalyzerSpecification, ingest: ingestReplayAnalysis
});

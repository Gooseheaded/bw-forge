import { readFile, lstat, realpath } from "node:fs/promises";
import { Database } from "bun:sqlite";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { enqueueReplay, type AnalysisJob } from "../../../../packages/corpus-store/src/jobs.ts";
import type { CorpusRegistry, CorpusReplayRef } from "./registry.ts";

export type RegisteredReplay = CorpusReplayRef & { jobKey: string; canonicalReplayPath: string; rawReused: boolean };
const jobSelect = `SELECT j.*,r.sha256,a.analysis_key FROM analysis_jobs j JOIN replays r USING(replay_id)
  LEFT JOIN analysis_runs a ON a.analysis_id=j.result_analysis_id`;
function job(row: any): AnalysisJob {
  return { jobKey: row.job_key, replaySha256: row.sha256, status: row.status, priority: row.priority,
    createdAtMs: row.created_at_ms, availableAtMs: row.available_at_ms, startedAtMs: row.started_at_ms,
    finishedAtMs: row.finished_at_ms, attemptCount: row.attempt_count, maxAttempts: row.max_attempts,
    workerId: row.worker_id, leaseExpiresAtMs: row.lease_expires_at_ms, lastHeartbeatAtMs: row.last_heartbeat_at_ms,
    resultAnalysisId: row.result_analysis_id, resultAnalysisKey: row.analysis_key,
    lastError: row.last_error_json ? JSON.parse(row.last_error_json) : null,
    canonicalRelativePath: `replays/${row.sha256.slice(0, 2)}/${row.sha256}.rep` };
}
function contains(root: string, target: string) {
  const rel = relative(root, target);
  return !!rel && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}
function samePath(a: string, b: string) { return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b; }
async function regularContained(root: string, candidate: string) {
  if (!contains(root, candidate)) throw new Error("Published artifact escaped corpus artifact root");
  const actual = await realpath(candidate);
  if (!samePath(actual, candidate)) throw new Error("Published artifact contains a symlink");
  const info = await lstat(candidate);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Published artifact is not a regular file");
  return actual;
}

/** Registration delegates to Corpus v2. All observation uses SQLite read-only handles,
 * because the core jobs CLI initializes schemas even for its inspection commands. */
export class CorpusCore {
  constructor(private readonly registry: CorpusRegistry) {}
  private read<T>(corpusId: string, fn: (db: Database) => T): T {
    const corpus = this.registry.get(corpusId);
    const db = new Database(corpus.database, { readonly: true, strict: true });
    try { db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000;"); return fn(db); }
    finally { db.close(); }
  }
  async registerAndEnqueue(input: { corpusId?: string; replayPath: string; sourceRef?: string }): Promise<RegisteredReplay> {
    const corpusId = input.corpusId ?? this.registry.defaultUploadCorpus;
    const corpus = this.registry.requireWritable(corpusId);
    const result = await enqueueReplay({ replayPath: input.replayPath, corpusRoot: corpus.corpusRoot,
      dbPath: corpus.database, sourceKind: "discord", sourceRef: input.sourceRef });
    const jobKey = result.job?.jobKey ?? (result.status === "already-indexed" && typeof result.currentAnalysisId === "number"
      ? `completed_${result.currentAnalysisId}` : undefined);
    if (!jobKey) throw new Error("Corpus registration returned no analysis reference");
    return { corpusId: corpusId!, replaySha256: result.replaySha256, jobKey, canonicalReplayPath: result.canonicalReplayPath, rawReused: result.rawReused };
  }
  async list(ref: CorpusReplayRef, status?: AnalysisJob["status"]): Promise<{ jobs: AnalysisJob[] }> {
    this.registry.ref(ref.corpusId, ref.replaySha256);
    return this.read(ref.corpusId, db => ({ jobs: (db.query(`${jobSelect} WHERE r.sha256=? ${status ? "AND j.status=?" : ""} ORDER BY j.created_at_ms DESC LIMIT 100`)
      .all(...(status ? [ref.replaySha256, status] : [ref.replaySha256])) as any[]).map(job) }));
  }
  describeReplay(ref: CorpusReplayRef): { mapName: string | null; matchup: string | null } {
    this.registry.ref(ref.corpusId, ref.replaySha256);
    return this.read(ref.corpusId, db => {
      const replay = db.query("SELECT replay_id,map_name FROM replays WHERE sha256=?").get(ref.replaySha256) as { replay_id: number; map_name: string | null } | null;
      if (!replay) return { mapName: null, matchup: null };
      const races = (db.query("SELECT race FROM participations WHERE replay_id=? ORDER BY owner LIMIT 2").all(replay.replay_id) as Array<{ race: string }>).map(row => row.race);
      const short = (race: string) => ({ zerg: "Z", terran: "T", protoss: "P", unknown: "?" }[race] ?? "?");
      return { mapName: replay.map_name, matchup: races.length === 2 ? `${short(races[0]!)}v${short(races[1]!)}` : null };
    });
  }
  async show(corpusId: string, jobKey: string): Promise<{ job: AnalysisJob }> {
    return this.read(corpusId, db => {
      if (/^completed_[1-9]\d*$/.test(jobKey)) {
        const id = Number(jobKey.slice(10));
        if (!Number.isSafeInteger(id)) throw new Error("Invalid completed analysis reference");
        const row = db.query(`SELECT a.*,r.sha256 FROM analysis_runs a JOIN replays r USING(replay_id)
          WHERE a.analysis_id=? AND a.status='indexed'`).get(id) as any;
        if (!row) throw new Error("Completed analysis not found");
        return { job: job({ ...row, job_key: jobKey, status: "succeeded", priority: 0,
          created_at_ms: row.queued_at_ms ?? 0, available_at_ms: row.queued_at_ms ?? 0,
          started_at_ms: null, finished_at_ms: row.indexed_at_ms ?? null, attempt_count: 0, max_attempts: 0,
          worker_id: null, lease_expires_at_ms: null, last_heartbeat_at_ms: null, result_analysis_id: id }) };
      }
      const row = db.query(`${jobSelect} WHERE j.job_key=?`).get(jobKey);
      if (!row) throw new Error("Corpus analysis job not found");
      return { job: job(row) };
    });
  }
  async reportPath(input: { corpusId: string; replaySha256: string; jobKey: string }): Promise<string> {
    this.registry.ref(input.corpusId, input.replaySha256);
    const completed = (await this.show(input.corpusId, input.jobKey)).job;
    if (completed.status !== "succeeded" || completed.replaySha256 !== input.replaySha256 || !completed.resultAnalysisId) {
      throw new Error("Analysis has no successful publication");
    }
    // The immutable publication record is authoritative; do not reconstruct paths from names or keys.
    const publication = this.read(input.corpusId, db => db.query(`SELECT p.replay_manifest_path FROM analysis_publications p
      JOIN analysis_runs a USING(analysis_id) JOIN replays r USING(replay_id)
      WHERE p.analysis_id=? AND a.status='indexed' AND r.sha256=?`).get(completed.resultAnalysisId!, input.replaySha256)) as { replay_manifest_path: string } | null;
    if (!publication) throw new Error("Published report metadata is unavailable");
    const root = await realpath(this.registry.get(input.corpusId).corpusRoot);
    const artifactRoot = resolve(root, "analyses");
    if (!samePath(await realpath(artifactRoot), artifactRoot)) throw new Error("Published artifact root contains a symlink");
    const manifestPath = await regularContained(artifactRoot, resolve(publication.replay_manifest_path));
    const directory = dirname(manifestPath);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { replay_id?: unknown; legacy?: { html_files?: unknown } };
    if (manifest.replay_id !== input.replaySha256 || !Array.isArray(manifest.legacy?.html_files)) throw new Error("Invalid published report manifest");
    const name = manifest.legacy.html_files.find((entry): entry is string => typeof entry === "string" && /\.html?$/i.test(entry));
    if (!name) throw new Error("Publication has no standalone HTML report");
    return regularContained(directory, resolve(directory, name));
  }
}

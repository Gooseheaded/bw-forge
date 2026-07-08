import type { Database } from "../db/sqlite.js";
import type { IngestedReplayData } from "../domain/contracts.js";
import { withTransaction } from "../db/sqlite.js";
import { discoverManifestPaths } from "./discovery.js";
import { loadReplayFromManifest } from "./manifest.js";

export const DEFAULT_INGEST_BATCH_SIZE = 10;

export interface IngestBatchSummary {
  batch_number: number;
  manifest_count: number;
  replay_ids: string[];
  manifests_completed: number;
  manifests_remaining: number;
}

export interface IngestProgressUpdate extends IngestBatchSummary {
  manifests_discovered: number;
}

export interface IngestResult {
  manifestsDiscovered: number;
  replaysIngested: number;
  playersInserted: number;
  batchSize: number;
  batches: IngestBatchSummary[];
  warnings: string[];
  errors: string[];
}

export interface IngestOptions {
  batchSize?: number;
  onBatchComplete?: (update: IngestProgressUpdate) => void | Promise<void>;
  onBatchPersist?: (update: IngestProgressUpdate) => void | Promise<void>;
}

export async function ingestAnalysisRoot(db: Database, analysisRoot: string, options: IngestOptions = {}): Promise<IngestResult> {
  const manifestPaths = await discoverManifestPaths(analysisRoot);
  const batchSize = normalizeBatchSize(options.batchSize);
  let playersInserted = 0;
  const batches: IngestBatchSummary[] = [];

  for (let start = 0; start < manifestPaths.length; start += batchSize) {
    const batchPaths = manifestPaths.slice(start, start + batchSize);
    const replayIds: string[] = [];

    for (const manifestPath of batchPaths) {
      const replayData = await loadReplayFromManifest(manifestPath);
      replaceReplayData(db, replayData);
      playersInserted += replayData.players.length;
      replayIds.push(replayData.replay.replay_id);
    }

    const batchSummary: IngestBatchSummary = {
      batch_number: batches.length + 1,
      manifest_count: batchPaths.length,
      replay_ids: replayIds,
      manifests_completed: start + batchPaths.length,
      manifests_remaining: manifestPaths.length - (start + batchPaths.length)
    };

    batches.push(batchSummary);
    const progressUpdate: IngestProgressUpdate = {
      manifests_discovered: manifestPaths.length,
      ...batchSummary
    };
    await options.onBatchComplete?.(progressUpdate);
    await options.onBatchPersist?.(progressUpdate);

    if (start + batchPaths.length < manifestPaths.length) {
      await yieldToEventLoop();
    }
  }

  return {
    manifestsDiscovered: manifestPaths.length,
    replaysIngested: manifestPaths.length,
    playersInserted,
    batchSize,
    batches,
    warnings: [],
    errors: []
  };
}

function normalizeBatchSize(batchSize: number | undefined): number {
  if (batchSize === undefined) {
    return DEFAULT_INGEST_BATCH_SIZE;
  }
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error(`Invalid ingest batch size: ${batchSize}`);
  }
  return batchSize;
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

function replaceReplayData(db: Database, replayData: IngestedReplayData): void {
  withTransaction(db, () => {
    deleteReplayData(db, replayData.replay.replay_id);

    db.run(
      `INSERT INTO replays (
        replay_id,
        source_replay_filename,
        source_replay_path,
        matchup,
        map,
        duration_seconds,
        manifest_path
      ) VALUES (?, ?, ?, ?, ?, ?, ?);`,
      [
        replayData.replay.replay_id,
        replayData.replay.source_replay_filename,
        replayData.replay.source_replay_path,
        replayData.replay.matchup,
        replayData.replay.map,
        replayData.replay.duration_seconds,
        replayData.replay.manifest_path
      ]
    );

    for (const player of replayData.players) {
      db.run(
        "INSERT INTO players (replay_id, owner, name, race, zip_path) VALUES (?, ?, ?, ?, ?);",
        [player.replay_id, player.owner, player.name, player.race, player.zip_path]
      );
    }

    for (const event of replayData.buildOrderEvents) {
      db.run(
        `INSERT INTO build_order_events (
          replay_id, owner, time_seconds, supply_used, supply_max, item, raw_line
        ) VALUES (?, ?, ?, ?, ?, ?, ?);`,
        [
          event.replay_id,
          event.owner,
          event.time_seconds,
          event.supply_used,
          event.supply_max,
          event.item,
          event.raw_line
        ]
      );
    }

    for (const sample of replayData.economySamples) {
      db.run(
        `INSERT INTO economy_samples (
          replay_id, owner, time_seconds, minerals, gas, gathered_minerals, gathered_gas, workers
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
        [
          sample.replay_id,
          sample.owner,
          sample.time_seconds,
          sample.minerals,
          sample.gas,
          sample.gathered_minerals,
          sample.gathered_gas,
          sample.workers
        ]
      );
    }

    for (const sample of replayData.supplySamples) {
      db.run(
        "INSERT INTO supply_samples (replay_id, owner, time_seconds, current, max) VALUES (?, ?, ?, ?, ?);",
        [sample.replay_id, sample.owner, sample.time_seconds, sample.current, sample.max]
      );
    }

    for (const sample of replayData.unitCountSamples) {
      db.run(
        `INSERT INTO unit_count_samples (
          replay_id, owner, time_seconds, unit_type, count
        ) VALUES (?, ?, ?, ?, ?);`,
        [sample.replay_id, sample.owner, sample.time_seconds, sample.unit_type, sample.count]
      );
    }

    for (const event of replayData.deathEvents) {
      db.run(
        `INSERT INTO death_events (
          replay_id, owner, frame, time_seconds, dead_owner, unit_type, category
        ) VALUES (?, ?, ?, ?, ?, ?, ?);`,
        [
          event.replay_id,
          event.owner,
          event.frame,
          event.time_seconds,
          event.dead_owner,
          event.unit_type,
          event.category
        ]
      );
    }
  });
}

function deleteReplayData(db: Database, replayId: string): void {
  // Be resilient to partially written or legacy databases that may contain
  // orphaned child rows. We still keep the FK cascade on replays, but we do
  // not rely on it as the only cleanup path during replay replacement.
  db.run("DELETE FROM build_order_events WHERE replay_id = ?;", [replayId]);
  db.run("DELETE FROM economy_samples WHERE replay_id = ?;", [replayId]);
  db.run("DELETE FROM supply_samples WHERE replay_id = ?;", [replayId]);
  db.run("DELETE FROM unit_count_samples WHERE replay_id = ?;", [replayId]);
  db.run("DELETE FROM death_events WHERE replay_id = ?;", [replayId]);
  db.run("DELETE FROM players WHERE replay_id = ?;", [replayId]);
  db.run("DELETE FROM replays WHERE replay_id = ?;", [replayId]);
}

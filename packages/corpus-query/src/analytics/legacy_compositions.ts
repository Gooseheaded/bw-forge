import type { Database } from "../db/sqlite.js";
import { buildReplayScope, clampExampleLimit, firstRow, normalizeCorpusFilters, queryAll, replayScopeFiltersPayload } from "./filters.js";
import { summarizeNumbers } from "./stats.js";
import { formatSecondsClock } from "./time.js";

interface CompositionInput {
  player?: string;
  opponent?: string;
  race?: string;
  opponentRace?: string;
  matchup?: string;
  map?: string;
  replayIds?: string[];
  timeSeconds: number;
  units?: string[];
  limitExamples?: number;
}

interface EconomyInput {
  player?: string;
  opponent?: string;
  race?: string;
  opponentRace?: string;
  matchup?: string;
  map?: string;
  replayIds?: string[];
  timeSeconds: number;
  limitExamples?: number;
}

export function getCompositionSnapshot(db: Database, input: CompositionInput): {
  filters: Record<string, string | string[] | number | null>;
  sampleSize: number;
  units: Record<string, { min: number; p25: number; median: number; p75: number; max: number; mean: number }>;
  examples: Array<{
    replayId: string;
    filename: string | null;
    player: string;
    opponent: string | null;
    time: string;
    units: Record<string, number>;
  }>;
} {
  const filters = normalizeCorpusFilters(input);
  const scope = buildReplayScope(db, filters);
  const limitExamples = clampExampleLimit(input.limitExamples);
  const explicitUnits = input.units?.map((unit) => unit.trim()).filter(Boolean);
  const units = explicitUnits && explicitUnits.length > 0 ? explicitUnits : discoverUnitsForSnapshot(db, scope, input.timeSeconds).slice(0, 8);
  const statement = db.prepare(
    `SELECT count, time_seconds
     FROM unit_count_samples
     WHERE replay_id = ? AND owner = ? AND unit_type = ? COLLATE NOCASE AND time_seconds <= ?
     ORDER BY time_seconds DESC
     LIMIT 1;`
  );

  try {
    const perReplayExamples: Array<{
      replayId: string;
      filename: string | null;
      player: string;
      opponent: string | null;
      units: Record<string, number>;
    }> = [];
    const byUnit = new Map<string, number[]>();
    for (const unit of units) {
      byUnit.set(unit, []);
    }

    for (const row of scope) {
      const unitSnapshot: Record<string, number> = {};
      let hasAny = false;
      for (const unit of units) {
        const sample = firstRow(statement, [row.replay_id, row.self_owner, unit, input.timeSeconds], (sampleRow) => ({
          count: Number(sampleRow.count)
        }));
        if (!sample) {
          continue;
        }
        unitSnapshot[unit] = sample.count;
        byUnit.get(unit)?.push(sample.count);
        hasAny = true;
      }

      if (hasAny) {
        perReplayExamples.push({
          replayId: row.replay_id,
          filename: row.source_replay_filename,
          player: row.player_name,
          opponent: row.opponent_name,
          units: unitSnapshot
        });
      }
    }

    return {
      filters: {
        ...replayScopeFiltersPayload(filters),
        timeSeconds: input.timeSeconds,
        time: formatSecondsClock(input.timeSeconds)
      },
      sampleSize: perReplayExamples.length,
      units: Object.fromEntries(
        [...byUnit.entries()]
          .map(([unit, values]) => [unit, summarizeNumbers(values)])
          .filter((entry): entry is [string, NonNullable<ReturnType<typeof summarizeNumbers>>] => entry[1] !== null)
      ),
      examples: perReplayExamples.slice(0, limitExamples).map((row) => ({
        replayId: row.replayId,
        filename: row.filename,
        player: row.player,
        opponent: row.opponent,
        time: formatSecondsClock(input.timeSeconds),
        units: row.units
      }))
    };
  } finally {
    statement.free();
  }
}

export function getEconomyDistribution(db: Database, input: EconomyInput): {
  filters: Record<string, string | string[] | number | null>;
  sampleSize: number;
  workers: { min: number; p25: number; median: number; p75: number; max: number; mean: number } | null;
  minerals: { min: number; p25: number; median: number; p75: number; max: number; mean: number } | null;
  gas: { min: number; p25: number; median: number; p75: number; max: number; mean: number } | null;
  examples: Array<{
    replayId: string;
    filename: string | null;
    player: string;
    opponent: string | null;
    workers: number | null;
    minerals: number;
    gas: number;
  }>;
} {
  const filters = normalizeCorpusFilters(input);
  const scope = buildReplayScope(db, filters);
  const limitExamples = clampExampleLimit(input.limitExamples);
  const statement = db.prepare(
    `SELECT time_seconds, minerals, gas, workers
     FROM economy_samples
     WHERE replay_id = ? AND owner = ? AND time_seconds <= ?
     ORDER BY time_seconds DESC
     LIMIT 1;`
  );

  try {
    const examples: Array<{
      replayId: string;
      filename: string | null;
      player: string;
      opponent: string | null;
      workers: number | null;
      minerals: number;
      gas: number;
    }> = [];
    const workerValues: number[] = [];
    const mineralValues: number[] = [];
    const gasValues: number[] = [];

    for (const row of scope) {
      const sample = firstRow(statement, [row.replay_id, row.self_owner, input.timeSeconds], (sampleRow) => ({
        workers: sampleRow.workers === null ? null : Number(sampleRow.workers),
        minerals: Number(sampleRow.minerals),
        gas: Number(sampleRow.gas)
      }));
      if (!sample) {
        continue;
      }

      if (sample.workers !== null) {
        workerValues.push(sample.workers);
      }
      mineralValues.push(sample.minerals);
      gasValues.push(sample.gas);
      examples.push({
        replayId: row.replay_id,
        filename: row.source_replay_filename,
        player: row.player_name,
        opponent: row.opponent_name,
        workers: sample.workers,
        minerals: sample.minerals,
        gas: sample.gas
      });
    }

    return {
      filters: {
        ...replayScopeFiltersPayload(filters),
        timeSeconds: input.timeSeconds,
        time: formatSecondsClock(input.timeSeconds)
      },
      sampleSize: examples.length,
      workers: summarizeNumbers(workerValues),
      minerals: summarizeNumbers(mineralValues),
      gas: summarizeNumbers(gasValues),
      examples: examples.slice(0, limitExamples)
    };
  } finally {
    statement.free();
  }
}

function discoverUnitsForSnapshot(
  db: Database,
  scope: Array<{ replay_id: string; self_owner: number }>,
  timeSeconds: number
): string[] {
  if (scope.length === 0) {
    return [];
  }

  const params: unknown[] = [timeSeconds];
  const conditions = scope.map((row) => {
    params.push(row.replay_id, row.self_owner);
    return "(replay_id = ? AND owner = ?)";
  });

  return queryAll(
    db,
    `SELECT unit_type, COUNT(*) AS row_count
     FROM unit_count_samples
     WHERE time_seconds <= ? AND (${conditions.join(" OR ")})
     GROUP BY unit_type
     ORDER BY row_count DESC, unit_type COLLATE NOCASE ASC;`,
    params
  ).map((row) => String(row.unit_type));
}

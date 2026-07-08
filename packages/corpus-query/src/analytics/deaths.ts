import type { Database } from "../db/sqlite.js";
import { buildReplayScope, clampExampleLimit, normalizeCorpusFilters, replayScopeFiltersPayload } from "./filters.js";
import { formatSecondsClock } from "./time.js";

interface DeathSummaryInput {
  player?: string;
  opponent?: string;
  race?: string;
  opponentRace?: string;
  matchup?: string;
  map?: string;
  replayIds?: string[];
  startSeconds: number;
  endSeconds: number;
  limitExamples?: number;
}

export function getDeathSummary(db: Database, input: DeathSummaryInput): {
  filters: Record<string, string | string[] | number | null>;
  sampleSize: number;
  lost: Array<{ unit: string; count: number; perReplayMean: number }>;
  killed: Array<{ unit: string; count: number; perReplayMean: number }>;
  examples: Array<{
    replayId: string;
    filename: string | null;
    player: string;
    opponent: string | null;
    lost: Record<string, number>;
    killed: Record<string, number>;
  }>;
} {
  const filters = normalizeCorpusFilters(input);
  const scope = buildReplayScope(db, filters);
  const limitExamples = clampExampleLimit(input.limitExamples);

  const lostByReplay = new Map<string, Record<string, number>>();
  const killedByReplay = new Map<string, Record<string, number>>();
  const lostTotals = new Map<string, number>();
  const killedTotals = new Map<string, number>();

  for (const row of scope) {
    const selfDeaths = selectDeaths(db, row.replay_id, row.self_owner, input.startSeconds, input.endSeconds);
    const opponentDeaths = row.opponent_owner === null
      ? []
      : selectDeaths(db, row.replay_id, row.opponent_owner, input.startSeconds, input.endSeconds);

    const lost = summarizeUnitCounts(selfDeaths);
    const killed = summarizeUnitCounts(opponentDeaths);
    lostByReplay.set(`${row.replay_id}:${row.self_owner}`, lost);
    killedByReplay.set(`${row.replay_id}:${row.self_owner}`, killed);

    mergeCounts(lostTotals, lost);
    mergeCounts(killedTotals, killed);
  }

  return {
    filters: {
      ...replayScopeFiltersPayload(filters),
      startSeconds: input.startSeconds,
      endSeconds: input.endSeconds,
      start: formatSecondsClock(input.startSeconds),
      end: formatSecondsClock(input.endSeconds)
    },
    sampleSize: scope.length,
    lost: summarizeAggregateCounts(lostTotals, scope.length),
    killed: summarizeAggregateCounts(killedTotals, scope.length),
    examples: scope.slice(0, limitExamples).map((row) => {
      const key = `${row.replay_id}:${row.self_owner}`;
      return {
        replayId: row.replay_id,
        filename: row.source_replay_filename,
        player: row.player_name,
        opponent: row.opponent_name,
        lost: lostByReplay.get(key) ?? {},
        killed: killedByReplay.get(key) ?? {}
      };
    })
  };
}

function selectDeaths(
  db: Database,
  replayId: string,
  owner: number,
  startSeconds: number,
  endSeconds: number
): Array<{ unit_type: string }> {
  const statement = db.prepare(
    `SELECT unit_type
     FROM death_events
     WHERE replay_id = ? AND owner = ? AND time_seconds >= ? AND time_seconds <= ?
     ORDER BY time_seconds ASC, frame ASC;`
  );
  try {
    statement.bind([replayId, owner, startSeconds, endSeconds]);
    const rows: Array<{ unit_type: string }> = [];
    while (statement.step()) {
      rows.push({ unit_type: String(statement.getAsObject().unit_type) });
    }
    statement.reset();
    return rows;
  } finally {
    statement.free();
  }
}

function summarizeUnitCounts(rows: Array<{ unit_type: string }>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    counts[row.unit_type] = (counts[row.unit_type] ?? 0) + 1;
  }
  return counts;
}

function mergeCounts(target: Map<string, number>, source: Record<string, number>): void {
  for (const [unit, count] of Object.entries(source)) {
    target.set(unit, (target.get(unit) ?? 0) + count);
  }
}

function summarizeAggregateCounts(
  counts: Map<string, number>,
  replayCount: number
): Array<{ unit: string; count: number; perReplayMean: number }> {
  return [...counts.entries()]
    .map(([unit, count]) => ({
      unit,
      count,
      perReplayMean: replayCount === 0 ? 0 : Number((count / replayCount).toFixed(2))
    }))
    .sort((left, right) => right.count - left.count || left.unit.localeCompare(right.unit));
}

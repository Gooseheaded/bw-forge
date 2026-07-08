import type { Database } from "../db/sqlite.js";
import { buildReplayScope, firstRow, normalizeCorpusFilters } from "./filters.js";
import { formatSecondsClock } from "./time.js";

const DEFAULT_BUILD_ANCHORS: Record<string, string[]> = {
  zerg: ["Hatchery", "Spawning Pool", "Extractor", "Lair", "Spire", "Hydralisk Den", "Evolution Chamber", "Hive"],
  terran: ["Supply Depot", "Barracks", "Refinery", "Factory", "Academy", "Engineering Bay", "Starport", "Science Facility"],
  protoss: ["Pylon", "Gateway", "Forge", "Assimilator", "Cybernetics Core", "Citadel of Adun", "Stargate", "Robotics Facility"]
};

interface ReplayCardInput {
  replayId?: string;
  filenameContains?: string;
  player: string;
  includeBuildAnchors?: boolean;
  includeEconomyBenchmarks?: boolean;
  includeCombatSummary?: boolean;
}

export function getPlayerReplayCard(db: Database, input: ReplayCardInput): {
  replayId: string;
  filename: string | null;
  map: string | null;
  duration: string;
  player: { name: string; race: string };
  opponent: { name: string | null; race: string | null };
  matchup: string | null;
  buildAnchors?: Array<{ item: string; n: number; time: string }>;
  economyBenchmarks?: Array<{ time: string; workers: number | null }>;
  combatSummary?: Array<{ window: string; lost: Record<string, number>; killed: Record<string, number> }>;
} {
  const filters = normalizeCorpusFilters({
    player: input.player
  });
  const scope = buildReplayScope(db, filters).filter((row) => {
    if (input.replayId && row.replay_id !== input.replayId) {
      return false;
    }
    if (input.filenameContains) {
      return row.source_replay_filename?.toLowerCase().includes(input.filenameContains.toLowerCase()) ?? false;
    }
    return true;
  });

  const row = scope[0];
  if (!row) {
    throw new Error(`No replay/player row found for player "${input.player}".`);
  }

  const duration = row.duration_seconds === null ? "unknown" : formatSecondsClock(row.duration_seconds);
  return {
    replayId: row.replay_id,
    filename: row.source_replay_filename,
    map: row.map ?? "unknown",
    duration,
    player: {
      name: row.player_name,
      race: row.player_race
    },
    opponent: {
      name: row.opponent_name,
      race: row.opponent_race
    },
    matchup: row.matchup,
    ...(input.includeBuildAnchors !== false
      ? {
          buildAnchors: collectBuildAnchors(db, row.replay_id, row.self_owner, row.player_race)
        }
      : {}),
    ...(input.includeEconomyBenchmarks !== false
      ? {
          economyBenchmarks: collectEconomyBenchmarks(db, row.replay_id, row.self_owner)
        }
      : {}),
    ...(input.includeCombatSummary !== false
      ? {
          combatSummary: collectCombatSummary(db, row.replay_id, row.self_owner, row.opponent_owner)
        }
      : {})
  };
}

function collectBuildAnchors(db: Database, replayId: string, owner: number, race: string): Array<{ item: string; n: number; time: string }> {
  const anchors = DEFAULT_BUILD_ANCHORS[race.toLowerCase()] ?? [];
  const statement = db.prepare(
    `SELECT time_seconds
     FROM build_order_events
     WHERE replay_id = ? AND owner = ? AND item = ? COLLATE NOCASE
     ORDER BY time_seconds ASC, rowid ASC
     LIMIT 1;`
  );
  try {
    return anchors.flatMap((item) => {
      const event = firstRow(statement, [replayId, owner, item], (row) => Number(row.time_seconds));
      if (event === null) {
        return [];
      }
      return [{ item, n: 1, time: formatSecondsClock(event) }];
    });
  } finally {
    statement.free();
  }
}

function collectEconomyBenchmarks(db: Database, replayId: string, owner: number): Array<{ time: string; workers: number | null }> {
  const times = [300, 420];
  const statement = db.prepare(
    `SELECT workers
     FROM economy_samples
     WHERE replay_id = ? AND owner = ? AND time_seconds <= ?
     ORDER BY time_seconds DESC
     LIMIT 1;`
  );
  try {
    return times.map((timeSeconds) => ({
      time: formatSecondsClock(timeSeconds),
      workers: firstRow(statement, [replayId, owner, timeSeconds], (row) => (row.workers === null ? null : Number(row.workers)))
    }));
  } finally {
    statement.free();
  }
}

function collectCombatSummary(
  db: Database,
  replayId: string,
  owner: number,
  opponentOwner: number | null
): Array<{ window: string; lost: Record<string, number>; killed: Record<string, number> }> {
  const windows = [{ start: 420, end: 540 }];
  const statement = db.prepare(
    `SELECT unit_type
     FROM death_events
     WHERE replay_id = ? AND owner = ? AND time_seconds >= ? AND time_seconds <= ?;`
  );
  try {
    return windows.map((window) => ({
      window: `${formatSecondsClock(window.start)}-${formatSecondsClock(window.end)}`,
      lost: collectWindowCounts(statement, replayId, owner, window.start, window.end),
      killed: opponentOwner === null ? {} : collectWindowCounts(statement, replayId, opponentOwner, window.start, window.end)
    }));
  } finally {
    statement.free();
  }
}

function collectWindowCounts(
  statement: ReturnType<Database["prepare"]>,
  replayId: string,
  owner: number,
  startSeconds: number,
  endSeconds: number
): Record<string, number> {
  statement.bind([replayId, owner, startSeconds, endSeconds]);
  const counts: Record<string, number> = {};
  while (statement.step()) {
    const row = statement.getAsObject();
    const unit = String(row.unit_type);
    counts[unit] = (counts[unit] ?? 0) + 1;
  }
  statement.reset();
  return counts;
}

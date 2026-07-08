import type { Database } from "../db/sqlite.js";
import { buildReplayScope, clampExampleLimit, firstRow, normalizeCorpusFilters, replayScopeFiltersPayload } from "./filters.js";
import { summarizeNumbers } from "./stats.js";
import { formatSecondsClock } from "./time.js";

interface TimingInput {
  player?: string;
  opponent?: string;
  race?: string;
  opponentRace?: string;
  matchup?: string;
  map?: string;
  replayIds?: string[];
  item: string;
  n?: number;
  startSeconds?: number;
  endSeconds?: number;
  limitExamples?: number;
}

interface EventComparisonInput {
  player?: string;
  opponent?: string;
  race?: string;
  opponentRace?: string;
  matchup?: string;
  map?: string;
  replayIds?: string[];
  firstItem: string;
  firstN?: number;
  secondItem: string;
  secondN?: number;
  limitExamples?: number;
}

type EventTimingRow = {
  replayId: string;
  filename: string | null;
  player: string;
  opponent: string | null;
  race: string;
  matchup: string | null;
  timeSeconds: number;
};

export function getEventTimingDistribution(db: Database, input: TimingInput): {
  filters: Record<string, string | string[] | number | null>;
  sampleSize: number;
  seconds: { min: number; p25: number; median: number; p75: number; max: number; mean: number } | null;
  times: { min: string; p25: string; median: string; p75: string; max: string } | null;
  examples: Array<{
    replayId: string;
    filename: string | null;
    player: string;
    opponent: string | null;
    race: string;
    matchup: string | null;
    timeSeconds: number;
    time: string;
  }>;
  hints?: string[];
} {
  const filters = normalizeCorpusFilters(input);
  const n = input.n ?? 1;
  const limitExamples = clampExampleLimit(input.limitExamples);
  const scope = buildReplayScope(db, filters);
  const statement = db.prepare(
    `SELECT time_seconds
     FROM build_order_events
     WHERE replay_id = ? AND owner = ? AND item = ? COLLATE NOCASE
     ORDER BY time_seconds ASC, rowid ASC
     LIMIT 1 OFFSET ?;`
  );

  try {
    const rows: EventTimingRow[] = [];
    for (const row of scope) {
      const event = firstRow(statement, [row.replay_id, row.self_owner, input.item, n - 1], (eventRow) => ({
        timeSeconds: Number(eventRow.time_seconds)
      }));
      if (!event) {
        continue;
      }
      if (input.startSeconds !== undefined && event.timeSeconds < input.startSeconds) {
        continue;
      }
      if (input.endSeconds !== undefined && event.timeSeconds > input.endSeconds) {
        continue;
      }
      rows.push({
        replayId: row.replay_id,
        filename: row.source_replay_filename,
        player: row.player_name,
        opponent: row.opponent_name,
        race: row.player_race,
        matchup: row.matchup,
        timeSeconds: event.timeSeconds
      });
    }

    const summary = summarizeNumbers(rows.map((row) => row.timeSeconds));
    return {
      filters: {
        ...replayScopeFiltersPayload(filters),
        item: input.item,
        n
      },
      sampleSize: rows.length,
      seconds: summary,
      times: summary
        ? {
            min: formatSecondsClock(summary.min),
            p25: formatSecondsClock(summary.p25),
            median: formatSecondsClock(summary.median),
            p75: formatSecondsClock(summary.p75),
            max: formatSecondsClock(summary.max)
          }
        : null,
      examples: rows
        .sort((left, right) => left.timeSeconds - right.timeSeconds || left.replayId.localeCompare(right.replayId))
        .slice(0, limitExamples)
        .map((row) => ({
          ...row,
          time: formatSecondsClock(row.timeSeconds)
        })),
      ...(rows.length === 0
        ? {
            hints: [
              `No samples found for item "${input.item}" with the current filters.`,
              `Call search_build_items with query="${input.item.toLowerCase()}" to find valid item names.`
            ]
          }
        : {})
    };
  } finally {
    statement.free();
  }
}

export function countReplaysWithEventBeforeEvent(db: Database, input: EventComparisonInput): {
  filters: Record<string, string | string[] | null>;
  condition: {
    first: { item: string; n: number };
    second: { item: string; n: number };
  };
  sampleSize: number;
  matchCount: number;
  percentage: number;
  missingFirstCount: number;
  missingSecondCount: number;
  examples: Array<{
    replayId: string;
    filename: string | null;
    player: string;
    opponent: string | null;
    firstTimeSeconds: number;
    firstTime: string;
    secondTimeSeconds: number;
    secondTime: string;
    deltaSeconds: number;
  }>;
  nonMatches: Array<{
    replayId: string;
    filename: string | null;
    player: string;
    opponent: string | null;
    firstTimeSeconds: number;
    firstTime: string;
    secondTimeSeconds: number;
    secondTime: string;
    deltaSeconds: number;
  }>;
} {
  const filters = normalizeCorpusFilters(input);
  const firstN = input.firstN ?? 1;
  const secondN = input.secondN ?? 1;
  const limitExamples = clampExampleLimit(input.limitExamples);
  const scope = buildReplayScope(db, filters);
  const statement = db.prepare(
    `SELECT time_seconds
     FROM build_order_events
     WHERE replay_id = ? AND owner = ? AND item = ? COLLATE NOCASE
     ORDER BY time_seconds ASC, rowid ASC
     LIMIT 1 OFFSET ?;`
  );

  try {
    const matches: Array<{
      replayId: string;
      filename: string | null;
      player: string;
      opponent: string | null;
      firstTimeSeconds: number;
      secondTimeSeconds: number;
      deltaSeconds: number;
    }> = [];
    const nonMatches: Array<{
      replayId: string;
      filename: string | null;
      player: string;
      opponent: string | null;
      firstTimeSeconds: number;
      secondTimeSeconds: number;
      deltaSeconds: number;
    }> = [];

    let missingFirstCount = 0;
    let missingSecondCount = 0;

    for (const row of scope) {
      const firstEvent = firstRow(statement, [row.replay_id, row.self_owner, input.firstItem, firstN - 1], (eventRow) =>
        Number(eventRow.time_seconds)
      );
      const secondEvent = firstRow(statement, [row.replay_id, row.self_owner, input.secondItem, secondN - 1], (eventRow) =>
        Number(eventRow.time_seconds)
      );

      if (firstEvent === null) {
        missingFirstCount += 1;
      }
      if (secondEvent === null) {
        missingSecondCount += 1;
      }
      if (firstEvent === null || secondEvent === null) {
        continue;
      }

      const eventPair = {
        replayId: row.replay_id,
        filename: row.source_replay_filename,
        player: row.player_name,
        opponent: row.opponent_name,
        firstTimeSeconds: firstEvent,
        secondTimeSeconds: secondEvent,
        deltaSeconds: secondEvent - firstEvent
      };

      if (firstEvent < secondEvent) {
        matches.push(eventPair);
      } else {
        nonMatches.push(eventPair);
      }
    }

    const sampleSize = matches.length + nonMatches.length;
    return {
      filters: replayScopeFiltersPayload(filters),
      condition: {
        first: { item: input.firstItem, n: firstN },
        second: { item: input.secondItem, n: secondN }
      },
      sampleSize,
      matchCount: matches.length,
      percentage: sampleSize === 0 ? 0 : Number(((matches.length / sampleSize) * 100).toFixed(1)),
      missingFirstCount,
      missingSecondCount,
      examples: matches
        .slice(0, limitExamples)
        .map((row) => ({
          ...row,
          firstTime: formatSecondsClock(row.firstTimeSeconds),
          secondTime: formatSecondsClock(row.secondTimeSeconds)
        })),
      nonMatches: nonMatches
        .slice(0, limitExamples)
        .map((row) => ({
          ...row,
          firstTime: formatSecondsClock(row.firstTimeSeconds),
          secondTime: formatSecondsClock(row.secondTimeSeconds)
        }))
    };
  } finally {
    statement.free();
  }
}

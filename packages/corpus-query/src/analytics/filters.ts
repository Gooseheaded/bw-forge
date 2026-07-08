import type { Database, Statement } from "../db/sqlite.js";

export interface CorpusFilterInput {
  player?: string;
  opponent?: string;
  race?: string;
  opponentRace?: string;
  matchup?: string;
  map?: string;
  replayIds?: string[];
}

export interface NormalizedCorpusFilters {
  player?: string;
  opponent?: string;
  race?: string;
  opponentRace?: string;
  matchup?: string;
  map?: string;
  replayIds?: string[];
}

export interface ReplayScopeRow {
  replay_id: string;
  matchup: string | null;
  map: string | null;
  source_replay_filename: string | null;
  source_replay_path: string | null;
  duration_seconds: number | null;
  self_owner: number;
  player_name: string;
  player_race: string;
  opponent_owner: number | null;
  opponent_name: string | null;
  opponent_race: string | null;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const DEFAULT_EXAMPLE_LIMIT = 5;
const MAX_EXAMPLE_LIMIT = 25;

export function normalizeCorpusFilters(input: CorpusFilterInput): NormalizedCorpusFilters {
  const normalized: NormalizedCorpusFilters = {};
  const player = normalizeOptional(input.player);
  const opponent = normalizeOptional(input.opponent);
  const race = normalizeOptional(input.race);
  const opponentRace = normalizeOptional(input.opponentRace);
  const matchup = normalizeOptional(input.matchup);
  const map = normalizeOptional(input.map);

  if (player) {
    normalized.player = player;
  }
  if (opponent) {
    normalized.opponent = opponent;
  }
  if (race) {
    normalized.race = race;
  }
  if (opponentRace) {
    normalized.opponentRace = opponentRace;
  }
  if (matchup) {
    normalized.matchup = matchup;
  }
  if (map) {
    normalized.map = map;
  }
  if (input.replayIds && input.replayIds.length > 0) {
    normalized.replayIds = [...new Set(input.replayIds.map((value) => value.trim()).filter(Boolean))];
  }
  return normalized;
}

export function clampListLimit(value: number | undefined): number {
  return clampPositiveInteger(value, DEFAULT_LIMIT, MAX_LIMIT);
}

export function clampExampleLimit(value: number | undefined): number {
  return clampPositiveInteger(value, DEFAULT_EXAMPLE_LIMIT, MAX_EXAMPLE_LIMIT);
}

export function replayScopeFiltersPayload(filters: NormalizedCorpusFilters): Record<string, string | string[] | null> {
  return {
    player: filters.player ?? null,
    opponent: filters.opponent ?? null,
    race: filters.race ?? null,
    opponentRace: filters.opponentRace ?? null,
    matchup: filters.matchup ?? null,
    map: filters.map ?? null,
    replayIds: filters.replayIds ?? null
  };
}

export function buildReplayScope(
  db: Database,
  filters: NormalizedCorpusFilters
): ReplayScopeRow[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.replayIds && filters.replayIds.length > 0) {
    conditions.push(`r.replay_id IN (${filters.replayIds.map(() => "?").join(", ")})`);
    params.push(...filters.replayIds);
  }
  if (filters.matchup) {
    conditions.push("r.matchup = ?");
    params.push(filters.matchup);
  }
  if (filters.map) {
    if (filters.map.toLowerCase() === "unknown") {
      conditions.push("(r.map IS NULL OR TRIM(r.map) = '')");
    } else {
      conditions.push("r.map = ? COLLATE NOCASE");
      params.push(filters.map);
    }
  }
  if (filters.player) {
    conditions.push("self_player.name = ? COLLATE NOCASE");
    params.push(filters.player);
  }
  if (filters.race) {
    conditions.push("self_player.race = ? COLLATE NOCASE");
    params.push(filters.race);
  }
  if (filters.opponent) {
    conditions.push("opponent.name = ? COLLATE NOCASE");
    params.push(filters.opponent);
  }
  if (filters.opponentRace) {
    conditions.push("opponent.race = ? COLLATE NOCASE");
    params.push(filters.opponentRace);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return queryAll(
    db,
    `SELECT
      r.replay_id,
      r.matchup,
      r.map,
      r.source_replay_filename,
      r.source_replay_path,
      r.duration_seconds,
      self_player.owner AS self_owner,
      self_player.name AS player_name,
      self_player.race AS player_race,
      opponent.owner AS opponent_owner,
      opponent.name AS opponent_name,
      opponent.race AS opponent_race
    FROM replays r
    INNER JOIN players self_player ON self_player.replay_id = r.replay_id
    LEFT JOIN players opponent
      ON opponent.replay_id = r.replay_id
      AND opponent.owner <> self_player.owner
    ${whereClause}
    ORDER BY r.replay_id, self_player.owner, opponent.owner;`,
    params
  ).map((row) => ({
    replay_id: String(row.replay_id),
    matchup: toNullableString(row.matchup),
    map: toNullableString(row.map),
    source_replay_filename: toNullableString(row.source_replay_filename),
    source_replay_path: toNullableString(row.source_replay_path),
    duration_seconds: toNullableNumber(row.duration_seconds),
    self_owner: Number(row.self_owner),
    player_name: String(row.player_name),
    player_race: String(row.player_race),
    opponent_owner: row.opponent_owner === null ? null : Number(row.opponent_owner),
    opponent_name: toNullableString(row.opponent_name),
    opponent_race: toNullableString(row.opponent_race)
  }));
}

export function queryAll(db: Database, sql: string, params: unknown[]): Array<Record<string, unknown>> {
  const statement = db.prepare(sql);
  try {
    return allRows(statement, params, (row) => row);
  } finally {
    statement.free();
  }
}

export function allRows<T>(statement: Statement, params: unknown[], mapper: (row: Record<string, unknown>) => T): T[] {
  const rows: T[] = [];
  statement.bind(params);
  while (statement.step()) {
    rows.push(mapper(statement.getAsObject()));
  }
  statement.reset();
  return rows;
}

export function firstRow<T>(
  statement: Statement,
  params: unknown[],
  mapper: (row: Record<string, unknown>) => T
): T | null {
  statement.bind(params);
  const row = statement.step() ? mapper(statement.getAsObject()) : null;
  statement.reset();
  return row;
}

export function toNullableString(value: unknown): string | null {
  return value === null ? null : String(value);
}

export function toNullableNumber(value: unknown): number | null {
  return value === null ? null : Number(value);
}

function normalizeOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function clampPositiveInteger(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) {
    return fallback;
  }
  const normalized = Number.isFinite(value) ? Math.floor(value) : fallback;
  if (normalized <= 0) {
    return fallback;
  }
  return Math.min(normalized, max);
}

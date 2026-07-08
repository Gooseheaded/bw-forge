import type { Database } from "../db/sqlite.js";
import {
  buildReplayScope,
  clampListLimit,
  normalizeCorpusFilters,
  queryAll,
  replayScopeFiltersPayload,
  type CorpusFilterInput,
  type NormalizedCorpusFilters
} from "./filters.js";

export interface CorpusSummaryResult {
  filters: Record<string, string | string[] | null>;
  replayCount: number;
  playerCount: number;
  matchups: Array<{ matchup: string; replayCount: number }>;
  races: Array<{ race: string; playerRows: number }>;
  maps: Array<{ map: string; replayCount: number }>;
  dataAvailability: {
    buildOrderEvents: boolean;
    economySamples: boolean;
    supplySamples: boolean;
    unitCountSamples: boolean;
    deathEvents: boolean;
  };
}

export interface PlayerListResult {
  filters: Record<string, string | string[] | null>;
  players: Array<{
    name: string;
    races: string[];
    replayCount: number;
    matchups: Array<{ matchup: string; replayCount: number }>;
  }>;
}

export interface MatchupListResult {
  filters: Record<string, string | string[] | null>;
  matchups: Array<{
    matchup: string;
    replayCount: number;
    playerRows: number;
  }>;
}

export interface BuildItemListResult {
  filters: Record<string, string | string[] | null>;
  items: Array<{
    name: string;
    count: number;
    replayCount: number;
  }>;
}

export interface BuildItemSearchResult {
  query: string;
  filters: Record<string, string | string[] | null>;
  matches: Array<{
    name: string;
    count: number;
    replayCount: number;
  }>;
}

export interface UnitTypeListResult {
  source: "unit_counts" | "deaths" | "both";
  filters: Record<string, string | string[] | null>;
  units: Array<{
    name: string;
    unitCountSampleCount: number;
    deathEventCount: number;
  }>;
}

export function getCorpusSummary(db: Database, input: CorpusFilterInput): CorpusSummaryResult {
  const filters = normalizeCorpusFilters(input);
  const scopedRows = buildReplayScope(db, filters);
  const replayIds = uniqueReplayIds(scopedRows);
  const replayCount = replayIds.length;
  const playerRows = dedupePlayerRows(scopedRows);
  const playerCount = new Set(playerRows.map((row) => row.player_name.toLowerCase())).size;

  const matchupMap = new Map<string, Set<string>>();
  const mapMap = new Map<string, Set<string>>();
  const raceMap = new Map<string, number>();

  for (const row of playerRows) {
    const matchupKey = row.matchup ?? "unknown";
    addToReplaySet(matchupMap, matchupKey, row.replay_id);

    const mapKey = row.map?.trim() ? row.map : "unknown";
    addToReplaySet(mapMap, mapKey, row.replay_id);

    raceMap.set(row.player_race, (raceMap.get(row.player_race) ?? 0) + 1);
  }

  return {
    filters: replayScopeFiltersPayload(filters),
    replayCount,
    playerCount,
    matchups: [...matchupMap.entries()]
      .map(([matchup, replays]) => ({ matchup, replayCount: replays.size }))
      .sort((left, right) => right.replayCount - left.replayCount || left.matchup.localeCompare(right.matchup)),
    races: [...raceMap.entries()]
      .map(([race, playerRowsForRace]) => ({ race, playerRows: playerRowsForRace }))
      .sort((left, right) => right.playerRows - left.playerRows || left.race.localeCompare(right.race)),
    maps: [...mapMap.entries()]
      .map(([map, replays]) => ({ map, replayCount: replays.size }))
      .sort((left, right) => right.replayCount - left.replayCount || left.map.localeCompare(right.map)),
    dataAvailability: {
      buildOrderEvents: tableHasRows(db, "build_order_events", replayIds),
      economySamples: tableHasRows(db, "economy_samples", replayIds),
      supplySamples: tableHasRows(db, "supply_samples", replayIds),
      unitCountSamples: tableHasRows(db, "unit_count_samples", replayIds),
      deathEvents: tableHasRows(db, "death_events", replayIds)
    }
  };
}

export function listPlayers(
  db: Database,
  input: CorpusFilterInput & { limit?: number }
): PlayerListResult {
  const filters = normalizeCorpusFilters(input);
  const limit = clampListLimit(input.limit);
  const rows = dedupePlayerRows(buildReplayScope(db, filters));

  const playerMap = new Map<
    string,
    {
      name: string;
      races: Set<string>;
      replayIds: Set<string>;
      matchupReplayIds: Map<string, Set<string>>;
    }
  >();

  for (const row of rows) {
    const key = row.player_name.toLowerCase();
    const existing = playerMap.get(key) ?? {
      name: row.player_name,
      races: new Set<string>(),
      replayIds: new Set<string>(),
      matchupReplayIds: new Map<string, Set<string>>()
    };
    existing.races.add(row.player_race);
    existing.replayIds.add(row.replay_id);
    const matchupKey = row.matchup ?? "unknown";
    addToReplaySet(existing.matchupReplayIds, matchupKey, row.replay_id);
    playerMap.set(key, existing);
  }

  return {
    filters: replayScopeFiltersPayload(filters),
    players: [...playerMap.values()]
      .map((player) => ({
        name: player.name,
        races: [...player.races].sort((left, right) => left.localeCompare(right)),
        replayCount: player.replayIds.size,
        matchups: [...player.matchupReplayIds.entries()]
          .map(([matchup, replayIds]) => ({ matchup, replayCount: replayIds.size }))
          .sort((left, right) => right.replayCount - left.replayCount || left.matchup.localeCompare(right.matchup))
      }))
      .sort((left, right) => right.replayCount - left.replayCount || left.name.localeCompare(right.name))
      .slice(0, limit)
  };
}

export function listMatchups(
  db: Database,
  input: CorpusFilterInput & { limit?: number }
): MatchupListResult {
  const filters = normalizeCorpusFilters(input);
  const limit = clampListLimit(input.limit);
  const rows = dedupePlayerRows(buildReplayScope(db, filters));

  const matchupMap = new Map<string, { replayIds: Set<string>; playerRows: number }>();
  for (const row of rows) {
    const key = row.matchup ?? "unknown";
    const existing = matchupMap.get(key) ?? { replayIds: new Set<string>(), playerRows: 0 };
    existing.replayIds.add(row.replay_id);
    existing.playerRows += 1;
    matchupMap.set(key, existing);
  }

  return {
    filters: replayScopeFiltersPayload(filters),
    matchups: [...matchupMap.entries()]
      .map(([matchup, value]) => ({
        matchup,
        replayCount: value.replayIds.size,
        playerRows: value.playerRows
      }))
      .sort((left, right) => right.replayCount - left.replayCount || left.matchup.localeCompare(right.matchup))
      .slice(0, limit)
  };
}

export function listBuildItems(
  db: Database,
  input: CorpusFilterInput & { limit?: number }
): BuildItemListResult {
  const filters = normalizeCorpusFilters(input);
  const limit = clampListLimit(input.limit);
  const replayScope = dedupePlayerRows(buildReplayScope(db, filters));
  const rows = queryBuildItems(db, replayScope);
  return {
    filters: replayScopeFiltersPayload(filters),
    items: rows.slice(0, limit)
  };
}

export function searchBuildItems(
  db: Database,
  input: CorpusFilterInput & { query: string; limit?: number }
): BuildItemSearchResult {
  const filters = normalizeCorpusFilters(input);
  const limit = clampListLimit(input.limit);
  const replayScope = dedupePlayerRows(buildReplayScope(db, filters));
  const normalizedQuery = input.query.trim().toLowerCase();
  const matches = queryBuildItems(db, replayScope).filter((item) => item.name.toLowerCase().includes(normalizedQuery));
  return {
    query: input.query,
    filters: replayScopeFiltersPayload(filters),
    matches: matches.slice(0, limit)
  };
}

export function listUnitTypes(
  db: Database,
  input: CorpusFilterInput & {
    source?: "unit_counts" | "deaths" | "both";
    limit?: number;
  }
): UnitTypeListResult {
  const filters = normalizeCorpusFilters(input);
  const limit = clampListLimit(input.limit);
  const source = input.source ?? "both";
  const replayScope = dedupePlayerRows(buildReplayScope(db, filters));
  const scopeKeys = replayScope.map((row) => `${row.replay_id}:${row.self_owner}`);

  const unitCountMap =
    source === "deaths" ? new Map<string, number>() : queryUnitTable(db, "unit_count_samples", "unit_type", scopeKeys);
  const deathMap =
    source === "unit_counts" ? new Map<string, number>() : queryUnitTable(db, "death_events", "unit_type", scopeKeys);
  const unitNames = [...new Set([...unitCountMap.keys(), ...deathMap.keys()])];

  return {
    source,
    filters: replayScopeFiltersPayload(filters),
    units: unitNames
      .map((name) => ({
        name,
        unitCountSampleCount: unitCountMap.get(name) ?? 0,
        deathEventCount: deathMap.get(name) ?? 0
      }))
      .sort((left, right) => {
        const leftTotal = left.unitCountSampleCount + left.deathEventCount;
        const rightTotal = right.unitCountSampleCount + right.deathEventCount;
        return rightTotal - leftTotal || left.name.localeCompare(right.name);
      })
      .slice(0, limit)
  };
}

function queryBuildItems(
  db: Database,
  replayScope: Array<{ replay_id: string; self_owner: number }>
): Array<{ name: string; count: number; replayCount: number }> {
  if (replayScope.length === 0) {
    return [];
  }

  const conditions = replayScope.map(() => "(replay_id = ? AND owner = ?)").join(" OR ");
  const params = replayScope.flatMap((row) => [row.replay_id, row.self_owner]);
  return queryAll(
    db,
    `SELECT item, COUNT(*) AS item_count, COUNT(DISTINCT replay_id) AS replay_count
     FROM build_order_events
     WHERE ${conditions}
     GROUP BY item
     ORDER BY replay_count DESC, item COLLATE NOCASE ASC;`,
    params
  ).map((row) => ({
    name: String(row.item),
    count: Number(row.item_count),
    replayCount: Number(row.replay_count)
  }));
}

function queryUnitTable(
  db: Database,
  tableName: "unit_count_samples" | "death_events",
  unitColumn: "unit_type",
  scopeKeys: string[]
): Map<string, number> {
  if (scopeKeys.length === 0) {
    return new Map<string, number>();
  }

  const params: unknown[] = [];
  const conditions = scopeKeys.map((scopeKey) => {
    const [replayId, owner] = scopeKey.split(":");
    params.push(replayId, Number(owner));
    return "(replay_id = ? AND owner = ?)";
  });

  const rows = queryAll(
    db,
    `SELECT ${unitColumn} AS unit_name, COUNT(*) AS row_count
     FROM ${tableName}
     WHERE ${conditions.join(" OR ")}
     GROUP BY ${unitColumn}
     ORDER BY row_count DESC, ${unitColumn} COLLATE NOCASE ASC;`,
    params
  );
  return new Map(rows.map((row) => [String(row.unit_name), Number(row.row_count)]));
}

function dedupePlayerRows<T extends { replay_id: string; self_owner: number }>(rows: T[]): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];
  for (const row of rows) {
    const key = `${row.replay_id}:${row.self_owner}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(row);
  }
  return deduped;
}

function uniqueReplayIds(rows: Array<{ replay_id: string }>): string[] {
  return [...new Set(rows.map((row) => row.replay_id))];
}

function addToReplaySet(map: Map<string, Set<string>>, key: string, replayId: string): void {
  const set = map.get(key) ?? new Set<string>();
  set.add(replayId);
  map.set(key, set);
}

function tableHasRows(db: Database, tableName: string, replayIds: string[]): boolean {
  if (replayIds.length === 0) {
    return false;
  }
  const placeholders = replayIds.map(() => "?").join(", ");
  const rows = queryAll(
    db,
    `SELECT 1 AS present FROM ${tableName} WHERE replay_id IN (${placeholders}) LIMIT 1;`,
    replayIds
  );
  return rows.length > 0;
}

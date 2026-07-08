import type { Database, Statement } from "../db/sqlite.js";

export interface ReplayFilters {
  matchup?: string;
  player?: string;
  race?: string;
  replay_ids?: string[];
}

export interface PerspectiveFilters {
  player: string;
  matchup?: string;
  race?: string;
  replay_ids?: string[];
  as?: "self" | "enemy";
}

export interface BuildEventFilters extends PerspectiveFilters {
  item?: string;
  from?: number;
  to?: number;
}

export interface MutaVesselCandidateFilters {
  player: string;
  matchup?: string;
  race?: string;
  replay_ids?: string[];
  mutaBefore: number;
  vesselBefore: number;
  mutaCountAt: number;
  economyAt: number;
  deathsFrom: number;
  deathsTo: number;
}

interface TargetPlayer {
  replay_id: string;
  owner: number;
  target_owner: number;
  player_name: string;
  target_name: string;
  target_race: string;
  matchup: string | null;
  source_replay_filename: string | null;
  source_replay_path: string | null;
}

export function findReplays(
  db: Database,
  filters: ReplayFilters
): Array<{
  replay_id: string;
  source_replay_filename: string | null;
  source_replay_path: string | null;
  matchup: string | null;
  map: string | null;
  duration_seconds: number | null;
  manifest_path: string;
  players: Array<{ owner: number; name: string; race: string; zip_path: string }>;
}> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.replay_ids && filters.replay_ids.length > 0) {
    conditions.push(`r.replay_id IN (${filters.replay_ids.map(() => "?").join(", ")})`);
    params.push(...filters.replay_ids);
  }

  if (filters.matchup) {
    conditions.push("r.matchup = ?");
    params.push(filters.matchup);
  }
  if (filters.player) {
    conditions.push(
      "EXISTS (SELECT 1 FROM players p1 WHERE p1.replay_id = r.replay_id AND p1.name = ? COLLATE NOCASE" +
        (filters.race ? " AND p1.race = ? COLLATE NOCASE" : "") +
        ")"
    );
    params.push(filters.player);
    if (filters.race) {
      params.push(filters.race);
    }
  } else if (filters.race) {
    conditions.push("EXISTS (SELECT 1 FROM players p1 WHERE p1.replay_id = r.replay_id AND p1.race = ? COLLATE NOCASE)");
    params.push(filters.race);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const replayRows = queryAll(
    db,
    `SELECT
      r.replay_id,
      r.source_replay_filename,
      r.source_replay_path,
      r.matchup,
      r.map,
      r.duration_seconds,
      r.manifest_path
    FROM replays r
    ${whereClause}
    ORDER BY r.manifest_path, r.replay_id;`,
    params
  );

  return replayRows.map((replay) => ({
    replay_id: String(replay.replay_id),
    source_replay_filename: toNullableString(replay.source_replay_filename),
    source_replay_path: toNullableString(replay.source_replay_path),
    matchup: toNullableString(replay.matchup),
    map: toNullableString(replay.map),
    duration_seconds: toNullableNumber(replay.duration_seconds),
    manifest_path: String(replay.manifest_path),
    players: queryAll(
      db,
      `SELECT owner, name, race, zip_path
       FROM players
       WHERE replay_id = ?
       ORDER BY owner;`,
      [String(replay.replay_id)]
    ).map((player) => ({
      owner: Number(player.owner),
      name: String(player.name),
      race: String(player.race),
      zip_path: String(player.zip_path)
    }))
  }));
}

export function findFirstEvent(
  db: Database,
  filters: PerspectiveFilters & { item: string }
): Array<{
  replay_id: string;
  source_replay_filename: string | null;
  source_replay_path: string | null;
  self_owner: number;
  target_owner: number;
  player_name: string;
  target_name: string;
  matchup: string | null;
  event: {
    time_seconds: number;
    supply_used: number | null;
    supply_max: number | null;
    item: string;
    raw_line: string;
  } | null;
}> {
  const targets = resolveTargets(db, filters);
  const statement = db.prepare(
    `SELECT time_seconds, supply_used, supply_max, item, raw_line
     FROM build_order_events
     WHERE replay_id = ? AND owner = ? AND item = ? COLLATE NOCASE
     ORDER BY time_seconds ASC
     LIMIT 1;`
  );

  try {
    return targets.map((target) => ({
      replay_id: target.replay_id,
      source_replay_filename: target.source_replay_filename,
      source_replay_path: target.source_replay_path,
      self_owner: target.owner,
      target_owner: target.target_owner,
      player_name: target.player_name,
      target_name: target.target_name,
      matchup: target.matchup,
      event: firstRow(statement, [target.replay_id, target.target_owner, filters.item], (row) => ({
        time_seconds: Number(row.time_seconds),
        supply_used: toNullableNumber(row.supply_used),
        supply_max: toNullableNumber(row.supply_max),
        item: String(row.item),
        raw_line: String(row.raw_line)
      }))
    }));
  } finally {
    statement.free();
  }
}

export function listBuildEvents(
  db: Database,
  filters: BuildEventFilters
): Array<{
  replay_id: string;
  source_replay_filename: string | null;
  source_replay_path: string | null;
  self_owner: number;
  target_owner: number;
  player_name: string;
  target_name: string;
  matchup: string | null;
  event: {
    time_seconds: number;
    supply_used: number | null;
    supply_max: number | null;
    item: string;
    raw_line: string;
  };
}> {
  const targets = resolveTargets(db, filters);
  const conditions = ["replay_id = ?", "owner = ?"];
  const bindTail: unknown[] = [];
  if (filters.item) {
    conditions.push("item = ? COLLATE NOCASE");
    bindTail.push(filters.item);
  }
  if (filters.from !== undefined) {
    conditions.push("time_seconds >= ?");
    bindTail.push(filters.from);
  }
  if (filters.to !== undefined) {
    conditions.push("time_seconds <= ?");
    bindTail.push(filters.to);
  }
  const statement = db.prepare(
    `SELECT time_seconds, supply_used, supply_max, item, raw_line
     FROM build_order_events
     WHERE ${conditions.join(" AND ")}
     ORDER BY time_seconds ASC, rowid ASC;`
  );

  try {
    return targets.flatMap((target) =>
      allRows(statement, [target.replay_id, target.target_owner, ...bindTail], (row) => ({
        replay_id: target.replay_id,
        source_replay_filename: target.source_replay_filename,
        source_replay_path: target.source_replay_path,
        self_owner: target.owner,
        target_owner: target.target_owner,
        player_name: target.player_name,
        target_name: target.target_name,
        matchup: target.matchup,
        event: {
          time_seconds: Number(row.time_seconds),
          supply_used: toNullableNumber(row.supply_used),
          supply_max: toNullableNumber(row.supply_max),
          item: String(row.item),
          raw_line: String(row.raw_line)
        }
      }))
    );
  } finally {
    statement.free();
  }
}

export function findNthEvent(
  db: Database,
  filters: PerspectiveFilters & { item: string; n: number }
): Array<{
  replay_id: string;
  source_replay_filename: string | null;
  source_replay_path: string | null;
  self_owner: number;
  target_owner: number;
  player_name: string;
  target_name: string;
  matchup: string | null;
  n: number;
  event: {
    time_seconds: number;
    supply_used: number | null;
    supply_max: number | null;
    item: string;
    raw_line: string;
  } | null;
}> {
  const targets = resolveTargets(db, filters);
  const statement = db.prepare(
    `SELECT time_seconds, supply_used, supply_max, item, raw_line
     FROM build_order_events
     WHERE replay_id = ? AND owner = ? AND item = ? COLLATE NOCASE
     ORDER BY time_seconds ASC, rowid ASC
     LIMIT 1 OFFSET ?;`
  );

  try {
    return targets.map((target) => ({
      replay_id: target.replay_id,
      source_replay_filename: target.source_replay_filename,
      source_replay_path: target.source_replay_path,
      self_owner: target.owner,
      target_owner: target.target_owner,
      player_name: target.player_name,
      target_name: target.target_name,
      matchup: target.matchup,
      n: filters.n,
      event: firstRow(statement, [target.replay_id, target.target_owner, filters.item, filters.n - 1], (row) => ({
        time_seconds: Number(row.time_seconds),
        supply_used: toNullableNumber(row.supply_used),
        supply_max: toNullableNumber(row.supply_max),
        item: String(row.item),
        raw_line: String(row.raw_line)
      }))
    }));
  } finally {
    statement.free();
  }
}

export function getUnitCountAtOrBefore(
  db: Database,
  filters: PerspectiveFilters & { unit: string; at: number }
): Array<{
  replay_id: string;
  source_replay_filename: string | null;
  source_replay_path: string | null;
  self_owner: number;
  target_owner: number;
  player_name: string;
  target_name: string;
  matchup: string | null;
  sample: { time_seconds: number; unit_type: string; count: number } | null;
}> {
  const targets = resolveTargets(db, filters);
  const statement = db.prepare(
    `SELECT time_seconds, unit_type, count
     FROM unit_count_samples
     WHERE replay_id = ? AND owner = ? AND unit_type = ? COLLATE NOCASE AND time_seconds <= ?
     ORDER BY time_seconds DESC
     LIMIT 1;`
  );

  try {
    return targets.map((target) => ({
      replay_id: target.replay_id,
      source_replay_filename: target.source_replay_filename,
      source_replay_path: target.source_replay_path,
      self_owner: target.owner,
      target_owner: target.target_owner,
      player_name: target.player_name,
      target_name: target.target_name,
      matchup: target.matchup,
      sample: firstRow(statement, [target.replay_id, target.target_owner, filters.unit, filters.at], (row) => ({
        time_seconds: Number(row.time_seconds),
        unit_type: String(row.unit_type),
        count: Number(row.count)
      }))
    }));
  } finally {
    statement.free();
  }
}

export function getEconomyAtOrBefore(
  db: Database,
  filters: PerspectiveFilters & { at: number }
): Array<{
  replay_id: string;
  source_replay_filename: string | null;
  source_replay_path: string | null;
  self_owner: number;
  target_owner: number;
  player_name: string;
  target_name: string;
  matchup: string | null;
  sample: {
    time_seconds: number;
    minerals: number;
    gas: number;
    gathered_minerals: number | null;
    gathered_gas: number | null;
    workers: number | null;
  } | null;
}> {
  const targets = resolveTargets(db, filters);
  const statement = db.prepare(
    `SELECT time_seconds, minerals, gas, gathered_minerals, gathered_gas, workers
     FROM economy_samples
     WHERE replay_id = ? AND owner = ? AND time_seconds <= ?
     ORDER BY time_seconds DESC
     LIMIT 1;`
  );

  try {
    return targets.map((target) => ({
      replay_id: target.replay_id,
      source_replay_filename: target.source_replay_filename,
      source_replay_path: target.source_replay_path,
      self_owner: target.owner,
      target_owner: target.target_owner,
      player_name: target.player_name,
      target_name: target.target_name,
      matchup: target.matchup,
      sample: firstRow(statement, [target.replay_id, target.target_owner, filters.at], (row) => ({
        time_seconds: Number(row.time_seconds),
        minerals: Number(row.minerals),
        gas: Number(row.gas),
        gathered_minerals: toNullableNumber(row.gathered_minerals),
        gathered_gas: toNullableNumber(row.gathered_gas),
        workers: toNullableNumber(row.workers)
      }))
    }));
  } finally {
    statement.free();
  }
}

export function getDeathsBetween(
  db: Database,
  filters: PerspectiveFilters & { from: number; to: number }
): Array<{
  replay_id: string;
  source_replay_filename: string | null;
  source_replay_path: string | null;
  self_owner: number;
  target_owner: number;
  player_name: string;
  target_name: string;
  matchup: string | null;
  deaths: Array<{
    frame: number;
    time_seconds: number;
    dead_owner: number;
    unit_type: string;
    category: string;
  }>;
}> {
  const targets = resolveTargets(db, filters);
  const statement = db.prepare(
    `SELECT frame, time_seconds, dead_owner, unit_type, category
     FROM death_events
     WHERE replay_id = ? AND owner = ? AND time_seconds >= ? AND time_seconds <= ?
     ORDER BY time_seconds ASC, frame ASC;`
  );

  try {
    return targets.map((target) => ({
      replay_id: target.replay_id,
      source_replay_filename: target.source_replay_filename,
      source_replay_path: target.source_replay_path,
      self_owner: target.owner,
      target_owner: target.target_owner,
      player_name: target.player_name,
      target_name: target.target_name,
      matchup: target.matchup,
      deaths: allRows(statement, [target.replay_id, target.target_owner, filters.from, filters.to], (row) => ({
        frame: Number(row.frame),
        time_seconds: Number(row.time_seconds),
        dead_owner: Number(row.dead_owner),
        unit_type: String(row.unit_type),
        category: String(row.category)
      }))
    }));
  } finally {
    statement.free();
  }
}

export function findMutaVesselCandidates(
  db: Database,
  filters: MutaVesselCandidateFilters
): Array<{
  replay_id: string;
  source_replay_filename: string | null;
  source_replay_path: string | null;
  matchup: string | null;
  player_name: string;
  player_owner: number;
  enemy_name: string;
  enemy_owner: number;
  first_mutalisk: {
    time_seconds: number;
    supply_used: number | null;
    supply_max: number | null;
    item: string;
    raw_line: string;
  };
  first_enemy_science_vessel: {
    time_seconds: number;
    supply_used: number | null;
    supply_max: number | null;
    item: string;
    raw_line: string;
  };
  mutalisk_count_at: { time_seconds: number; unit_type: string; count: number } | null;
  economy_at: {
    time_seconds: number;
    minerals: number;
    gas: number;
    gathered_minerals: number | null;
    gathered_gas: number | null;
    workers: number | null;
  } | null;
  self_deaths_between: Array<{
    frame: number;
    time_seconds: number;
    dead_owner: number;
    unit_type: string;
    category: string;
  }>;
  self_deaths_summary: {
    total_deaths: number;
    deaths_by_unit_type: Record<string, number>;
    deaths_by_category: Record<string, number>;
  };
  enemy_deaths_between: Array<{
    frame: number;
    time_seconds: number;
    dead_owner: number;
    unit_type: string;
    category: string;
  }>;
  enemy_deaths_summary: {
    total_deaths: number;
    deaths_by_unit_type: Record<string, number>;
    deaths_by_category: Record<string, number>;
  };
  deaths_between: Array<{
    frame: number;
    time_seconds: number;
    dead_owner: number;
    unit_type: string;
    category: string;
  }>;
  deaths_summary: {
    total_deaths: number;
    deaths_by_unit_type: Record<string, number>;
    deaths_by_category: Record<string, number>;
  };
}> {
  const baseFilters = {
    player: filters.player,
    ...(filters.matchup ? { matchup: filters.matchup } : {}),
    ...(filters.race ? { race: filters.race } : {}),
    ...(filters.replay_ids ? { replay_ids: filters.replay_ids } : {})
  };
  const firstMutalisks = findFirstEvent(db, {
    ...baseFilters,
    item: "Mutalisk"
  });
  const firstEnemyVessels = findFirstEvent(db, {
    ...baseFilters,
    as: "enemy",
    item: "Science Vessel"
  });
  const mutaliskCounts = getUnitCountAtOrBefore(db, {
    ...baseFilters,
    unit: "Mutalisk",
    at: filters.mutaCountAt
  });
  const economySamples = getEconomyAtOrBefore(db, {
    ...baseFilters,
    at: filters.economyAt
  });
  const selfDeathsByReplay = getDeathsBetween(db, {
    ...baseFilters,
    from: filters.deathsFrom,
    to: filters.deathsTo
  });
  const enemyDeathsByReplay = getDeathsBetween(db, {
    ...baseFilters,
    as: "enemy",
    from: filters.deathsFrom,
    to: filters.deathsTo
  });

  const vesselByReplay = new Map(firstEnemyVessels.map((row) => [row.replay_id, row] as const));
  const mutaliskCountByReplay = new Map(mutaliskCounts.map((row) => [row.replay_id, row] as const));
  const economyByReplay = new Map(economySamples.map((row) => [row.replay_id, row] as const));
  const selfDeathsByReplayId = new Map(selfDeathsByReplay.map((row) => [row.replay_id, row] as const));
  const enemyDeathsByReplayId = new Map(enemyDeathsByReplay.map((row) => [row.replay_id, row] as const));

  return firstMutalisks
    .filter(
      (row) =>
        row.event !== null &&
        row.event.time_seconds < filters.mutaBefore &&
        vesselByReplay.get(row.replay_id)?.event !== null &&
        (vesselByReplay.get(row.replay_id)?.event?.time_seconds ?? Number.POSITIVE_INFINITY) < filters.vesselBefore
    )
    .map((row) => {
      const vessel = vesselByReplay.get(row.replay_id);
      const mutaliskCount = mutaliskCountByReplay.get(row.replay_id);
      const economy = economyByReplay.get(row.replay_id);
      const selfDeaths = selfDeathsByReplayId.get(row.replay_id);
      const enemyDeaths = enemyDeathsByReplayId.get(row.replay_id);
      const selfDeathList = selfDeaths?.deaths ?? [];
      const enemyDeathList = enemyDeaths?.deaths ?? [];

      return {
        replay_id: row.replay_id,
        source_replay_filename: row.source_replay_filename,
        source_replay_path: row.source_replay_path,
        matchup: row.matchup,
        player_name: row.player_name,
        player_owner: row.self_owner,
        enemy_name: vessel?.target_name ?? "",
        enemy_owner: vessel?.target_owner ?? -1,
        first_mutalisk: row.event!,
        first_enemy_science_vessel: vessel!.event!,
        mutalisk_count_at: mutaliskCount?.sample ?? null,
        economy_at: economy?.sample ?? null,
        self_deaths_between: selfDeathList,
        self_deaths_summary: summarizeDeaths(selfDeathList),
        enemy_deaths_between: enemyDeathList,
        enemy_deaths_summary: summarizeDeaths(enemyDeathList),
        deaths_between: selfDeathList,
        deaths_summary: summarizeDeaths(selfDeathList)
      };
    })
    .sort((left, right) => left.replay_id.localeCompare(right.replay_id));
}

function resolveTargets(db: Database, filters: PerspectiveFilters): TargetPlayer[] {
  const asPerspective = filters.as ?? "self";
  const params: unknown[] = [filters.player];
  const clauses: string[] = [];
  if (filters.replay_ids && filters.replay_ids.length > 0) {
    clauses.push(`self_player.replay_id IN (${filters.replay_ids.map(() => "?").join(", ")})`);
    params.push(...filters.replay_ids);
  }
  if (filters.matchup) {
    clauses.push("r.matchup = ?");
    params.push(filters.matchup);
  }
  if (filters.race) {
    clauses.push("self_player.race = ? COLLATE NOCASE");
    params.push(filters.race);
  }
  const whereSuffix = clauses.length > 0 ? ` AND ${clauses.join(" AND ")}` : "";

  if (asPerspective === "self") {
    return queryAll(
      db,
      `SELECT
        self_player.replay_id,
        self_player.owner,
        self_player.owner AS target_owner,
        self_player.name AS player_name,
        self_player.name AS target_name,
        self_player.race AS target_race,
        r.matchup,
        r.source_replay_filename,
        r.source_replay_path
      FROM players self_player
      INNER JOIN replays r ON r.replay_id = self_player.replay_id
      WHERE self_player.name = ? COLLATE NOCASE
      ${whereSuffix}
      ORDER BY self_player.replay_id, self_player.owner;`,
      params
    ).map((row) => mapTargetPlayer(row));
  }

  return queryAll(
    db,
      `SELECT
        self_player.replay_id,
        self_player.owner,
        enemy.owner AS target_owner,
        self_player.name AS player_name,
        enemy.name AS target_name,
        enemy.race AS target_race,
        r.matchup,
        r.source_replay_filename,
        r.source_replay_path
      FROM players self_player
      INNER JOIN replays r ON r.replay_id = self_player.replay_id
      INNER JOIN players enemy
        ON enemy.replay_id = self_player.replay_id
        AND enemy.owner <> self_player.owner
    WHERE self_player.name = ? COLLATE NOCASE
    ${whereSuffix}
    ORDER BY self_player.replay_id, self_player.owner, enemy.owner;`,
    params
  ).map((row) => mapTargetPlayer(row));
}

function mapTargetPlayer(row: Record<string, unknown>): TargetPlayer {
  return {
    replay_id: String(row.replay_id),
    owner: Number(row.owner),
    target_owner: Number(row.target_owner),
    player_name: String(row.player_name),
    target_name: String(row.target_name),
    target_race: String(row.target_race),
    matchup: toNullableString(row.matchup),
    source_replay_filename: toNullableString(row.source_replay_filename),
    source_replay_path: toNullableString(row.source_replay_path)
  };
}

function queryAll(db: Database, sql: string, params: unknown[]): Array<Record<string, unknown>> {
  const statement = db.prepare(sql);
  try {
    return allRows(statement, params, (row) => row);
  } finally {
    statement.free();
  }
}

function allRows<T>(statement: Statement, params: unknown[], mapper: (row: Record<string, unknown>) => T): T[] {
  const rows: T[] = [];
  statement.bind(params);
  while (statement.step()) {
    rows.push(mapper(statement.getAsObject()));
  }
  statement.reset();
  return rows;
}

function firstRow<T>(
  statement: Statement,
  params: unknown[],
  mapper: (row: Record<string, unknown>) => T
): T | null {
  statement.bind(params);
  const row = statement.step() ? mapper(statement.getAsObject()) : null;
  statement.reset();
  return row;
}

function toNullableString(value: unknown): string | null {
  return value === null ? null : String(value);
}

function toNullableNumber(value: unknown): number | null {
  return value === null ? null : Number(value);
}

function summarizeDeaths(
  deaths: Array<{ frame: number; time_seconds: number; dead_owner: number; unit_type: string; category: string }>
): {
  total_deaths: number;
  deaths_by_unit_type: Record<string, number>;
  deaths_by_category: Record<string, number>;
} {
  const deathsByUnitType: Record<string, number> = {};
  const deathsByCategory: Record<string, number> = {};
  for (const death of deaths) {
    deathsByUnitType[death.unit_type] = (deathsByUnitType[death.unit_type] ?? 0) + 1;
    deathsByCategory[death.category] = (deathsByCategory[death.category] ?? 0) + 1;
  }
  return {
    total_deaths: deaths.length,
    deaths_by_unit_type: deathsByUnitType,
    deaths_by_category: deathsByCategory
  };
}

import type { Database } from "./sqlite.js";

export const SCHEMA_VERSION = 1;

const REQUIRED_TABLES = [
  "schema_metadata",
  "replays",
  "players",
  "build_order_events",
  "economy_samples",
  "supply_samples",
  "unit_count_samples",
  "death_events"
] as const;

export function ensureSchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS schema_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS replays (
      replay_id TEXT PRIMARY KEY,
      source_replay_filename TEXT,
      source_replay_path TEXT,
      matchup TEXT,
      map TEXT,
      duration_seconds REAL,
      manifest_path TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS players (
      replay_id TEXT NOT NULL,
      owner INTEGER NOT NULL,
      name TEXT NOT NULL COLLATE NOCASE,
      race TEXT NOT NULL COLLATE NOCASE,
      zip_path TEXT NOT NULL,
      PRIMARY KEY (replay_id, owner),
      FOREIGN KEY (replay_id) REFERENCES replays(replay_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS build_order_events (
      replay_id TEXT NOT NULL,
      owner INTEGER NOT NULL,
      time_seconds REAL NOT NULL,
      supply_used INTEGER,
      supply_max INTEGER,
      item TEXT NOT NULL COLLATE NOCASE,
      raw_line TEXT NOT NULL,
      FOREIGN KEY (replay_id, owner) REFERENCES players(replay_id, owner) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS economy_samples (
      replay_id TEXT NOT NULL,
      owner INTEGER NOT NULL,
      time_seconds REAL NOT NULL,
      minerals INTEGER NOT NULL,
      gas INTEGER NOT NULL,
      gathered_minerals INTEGER,
      gathered_gas INTEGER,
      workers INTEGER,
      FOREIGN KEY (replay_id, owner) REFERENCES players(replay_id, owner) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS supply_samples (
      replay_id TEXT NOT NULL,
      owner INTEGER NOT NULL,
      time_seconds REAL NOT NULL,
      current INTEGER NOT NULL,
      max INTEGER NOT NULL,
      FOREIGN KEY (replay_id, owner) REFERENCES players(replay_id, owner) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS unit_count_samples (
      replay_id TEXT NOT NULL,
      owner INTEGER NOT NULL,
      time_seconds REAL NOT NULL,
      unit_type TEXT NOT NULL COLLATE NOCASE,
      count INTEGER NOT NULL,
      FOREIGN KEY (replay_id, owner) REFERENCES players(replay_id, owner) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS death_events (
      replay_id TEXT NOT NULL,
      owner INTEGER NOT NULL,
      frame INTEGER NOT NULL,
      time_seconds REAL NOT NULL,
      dead_owner INTEGER NOT NULL,
      unit_type TEXT NOT NULL COLLATE NOCASE,
      category TEXT NOT NULL COLLATE NOCASE,
      FOREIGN KEY (replay_id, owner) REFERENCES players(replay_id, owner) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_players_name ON players(name);
    CREATE INDEX IF NOT EXISTS idx_players_race ON players(race);
    CREATE INDEX IF NOT EXISTS idx_replays_matchup ON replays(matchup);
    CREATE INDEX IF NOT EXISTS idx_build_order_events_lookup
      ON build_order_events(replay_id, owner, item, time_seconds);
    CREATE INDEX IF NOT EXISTS idx_economy_samples_lookup
      ON economy_samples(replay_id, owner, time_seconds);
    CREATE INDEX IF NOT EXISTS idx_supply_samples_lookup
      ON supply_samples(replay_id, owner, time_seconds);
    CREATE INDEX IF NOT EXISTS idx_unit_count_samples_lookup
      ON unit_count_samples(replay_id, owner, unit_type, time_seconds);
    CREATE INDEX IF NOT EXISTS idx_death_events_lookup
      ON death_events(replay_id, owner, time_seconds);
  `);

  db.run(
    "INSERT INTO schema_metadata(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
    ["schema_version", String(SCHEMA_VERSION)]
  );
}

export function assertCorpusSchema(db: Database): void {
  const statement = db.prepare(
    `SELECT name
     FROM sqlite_master
     WHERE type = 'table'
       AND name = ?;`
  );

  try {
    for (const tableName of REQUIRED_TABLES) {
      statement.bind([tableName]);
      const exists = statement.step();
      statement.reset();
      if (!exists) {
        throw new Error(
          `Corpus schema is missing required table "${tableName}". Ingest the corpus or initialize the database before running read-only analytics queries.`
        );
      }
    }
  } finally {
    statement.free();
  }
}

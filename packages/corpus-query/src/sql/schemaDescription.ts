import type { Database } from "../db/sqlite.js";

export type SchemaColumnDescription = {
  name: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
  defaultValue: string | null;
};

export type SchemaIndexDescription = {
  name: string;
  unique: boolean;
  columns: string[];
};

export type SchemaTableDescription = {
  name: string;
  type: string;
  purpose: string | null;
  columns: SchemaColumnDescription[];
  indexes?: SchemaIndexDescription[];
  sampleRows?: Array<Record<string, unknown>>;
};

export type SchemaJoinHint = {
  left: string;
  right: string;
  on: string[];
};

export type DescribeSchemaResult = {
  tables: SchemaTableDescription[];
  joinHints: SchemaJoinHint[];
};

export type SchemaNotesTopic =
  | "all"
  | "joins"
  | "deaths"
  | "timings"
  | "unit_counts"
  | "economy"
  | "build_order"
  | "paths";

export type SchemaNotesResult = {
  topic: SchemaNotesTopic;
  notes: Array<{
    topic: Exclude<SchemaNotesTopic, "all">;
    title: string;
    bullets: string[];
  }>;
};

const TABLE_PURPOSES: Record<string, string> = {
  schema_metadata: "Database metadata such as the schema version written by ingest.",
  replays: "One row per replay, including filename, source path, matchup, map, and duration.",
  players: "One row per player perspective in a replay. The stable key is (replay_id, owner).",
  build_order_events: "Ordered build events for each replay/player perspective.",
  economy_samples: "Economy samples over time for each replay/player perspective.",
  supply_samples: "Supply samples over time for each replay/player perspective.",
  unit_count_samples: "Unit-count samples over time for each replay/player perspective.",
  death_events: "Death events recorded from a player perspective's own losses."
};

const JOIN_HINTS: SchemaJoinHint[] = [
  { left: "players", right: "replays", on: ["replay_id"] },
  { left: "build_order_events", right: "players", on: ["replay_id", "owner"] },
  { left: "economy_samples", right: "players", on: ["replay_id", "owner"] },
  { left: "supply_samples", right: "players", on: ["replay_id", "owner"] },
  { left: "unit_count_samples", right: "players", on: ["replay_id", "owner"] },
  { left: "death_events", right: "players", on: ["replay_id", "owner"] }
];

const ALL_SCHEMA_NOTES: Array<SchemaNotesResult["notes"][number]> = [
  {
    topic: "joins",
    title: "Common identity and joins",
    bullets: [
      "replay_id identifies a replay.",
      "owner identifies a player perspective within a replay.",
      "The globally unique player-perspective key is (replay_id, owner).",
      "Join players to replays on replay_id.",
      "Join build_order_events, economy_samples, supply_samples, unit_count_samples, and death_events to players on replay_id + owner."
    ]
  },
  {
    topic: "deaths",
    title: "Death semantics",
    bullets: [
      "Each player bundle's death events represent that player's own losses.",
      "To infer kills from a player's perspective, inspect the opponent bundle for the same replay.",
      "Be conservative when labeling killed or lost unless the query explicitly joins both player perspectives."
    ]
  },
  {
    topic: "timings",
    title: "Timing semantics",
    bullets: [
      "time_seconds is game time in seconds.",
      "Build-order events are ordered by time_seconds.",
      "For nth-event analysis, use ROW_NUMBER() partitioned by replay_id and owner ordered by time_seconds."
    ]
  },
  {
    topic: "unit_counts",
    title: "Unit-count semantics",
    bullets: [
      "unit_count_samples stores one row per replay, owner, timestamp, and unit_type.",
      "For 'state at time T', use the latest sample at or before T for each replay, owner, and unit_type."
    ]
  },
  {
    topic: "economy",
    title: "Economy semantics",
    bullets: [
      "economy_samples stores one row per replay, owner, and timestamp.",
      "workers may be null in some rows; do not assume every replay has worker counts at every timestamp.",
      "For 'economy at time T', use the latest sample at or before T."
    ]
  },
  {
    topic: "build_order",
    title: "Build-order semantics",
    bullets: [
      "build_order_events.item is the canonical item name used by existing analytics tools.",
      "raw_line preserves the original text line parsed from the legacy artifact.",
      "Multiple occurrences of the same item are common; use ROW_NUMBER() or COUNT() carefully."
    ]
  },
  {
    topic: "paths",
    title: "Path and source fields",
    bullets: [
      "replays.source_replay_filename is the original replay filename when known.",
      "replays.source_replay_path and players.zip_path are legacy artifact paths and may be absolute machine-local paths.",
      "manifest_path and zip_path are useful for provenance, not for logical joins."
    ]
  }
];

export function describeSchema(
  db: Database,
  options: { includeIndexes?: boolean; includeSampleRows?: boolean; includeJoinHints?: boolean } = {}
): DescribeSchemaResult {
  const tables = queryAll(
    db,
    `SELECT name, type
     FROM sqlite_master
     WHERE type IN ('table')
       AND name NOT LIKE 'sqlite_%'
     ORDER BY name;`
  ).map((tableRow) => {
    const tableName = String(tableRow.name);
    const columns = queryAll(db, `PRAGMA table_info(${quoteIdentifier(tableName)});`).map((columnRow) => ({
      name: String(columnRow.name),
      type: String(columnRow.type ?? ""),
      nullable: Number(columnRow.notnull ?? 0) === 0,
      primaryKey: Number(columnRow.pk ?? 0) > 0,
      defaultValue: columnRow.dflt_value === null || columnRow.dflt_value === undefined ? null : String(columnRow.dflt_value)
    }));

    const table: SchemaTableDescription = {
      name: tableName,
      type: String(tableRow.type),
      purpose: TABLE_PURPOSES[tableName] ?? null,
      columns
    };

    if (options.includeIndexes) {
      table.indexes = queryAll(db, `PRAGMA index_list(${quoteIdentifier(tableName)});`).map((indexRow) => {
        const indexName = String(indexRow.name);
        const columnsForIndex = queryAll(db, `PRAGMA index_info(${quoteIdentifier(indexName)});`)
          .map((column) => String(column.name));
        return {
          name: indexName,
          unique: Number(indexRow.unique ?? 0) === 1,
          columns: columnsForIndex
        };
      });
    }

    if (options.includeSampleRows) {
      table.sampleRows = queryAll(db, `SELECT * FROM ${quoteIdentifier(tableName)} LIMIT 1;`);
    }

    return table;
  });

  return {
    tables,
    joinHints: options.includeJoinHints === false ? [] : JOIN_HINTS
  };
}

export function getSchemaNotes(topic: SchemaNotesTopic = "all"): SchemaNotesResult {
  return {
    topic,
    notes:
      topic === "all"
        ? ALL_SCHEMA_NOTES
        : ALL_SCHEMA_NOTES.filter((note) => note.topic === topic)
  };
}

function queryAll(db: Database, sql: string, params?: unknown[]): Array<Record<string, unknown>> {
  const statement = db.prepare(sql);
  try {
    statement.bind(params);
    const rows: Array<Record<string, unknown>> = [];
    while (statement.step()) {
      rows.push(statement.getAsObject());
    }
    return rows;
  } finally {
    statement.free();
  }
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll("\"", "\"\"")}"`;
}

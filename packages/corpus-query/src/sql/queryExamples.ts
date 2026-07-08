export type QueryExampleTopic =
  | "all"
  | "players"
  | "matchups"
  | "build_timings"
  | "event_sequences"
  | "economy"
  | "composition"
  | "deaths"
  | "replay_cards";

export type QueryExample = {
  title: string;
  topic: Exclude<QueryExampleTopic, "all">;
  sql: string;
  notes: string[];
};

const ALL_EXAMPLES: QueryExample[] = [
  {
    title: "List players by replay count",
    topic: "players",
    sql: `SELECT
  p.name,
  p.race,
  COUNT(*) AS player_rows
FROM players p
GROUP BY p.name, p.race
ORDER BY player_rows DESC, p.name ASC
LIMIT 50`,
    notes: ["Useful first query for corpus discovery."]
  },
  {
    title: "List matchups by replay count",
    topic: "matchups",
    sql: `SELECT
  matchup,
  COUNT(*) AS replay_count
FROM replays
GROUP BY matchup
ORDER BY replay_count DESC, matchup ASC
LIMIT 50`,
    notes: ["Counts one row per replay."]
  },
  {
    title: "List build items by replay count",
    topic: "build_timings",
    sql: `SELECT
  p.race,
  b.item,
  COUNT(*) AS event_count,
  COUNT(DISTINCT b.replay_id || ':' || b.owner) AS player_replay_count
FROM build_order_events b
JOIN players p
  ON p.replay_id = b.replay_id
 AND p.owner = b.owner
GROUP BY p.race, b.item
ORDER BY player_replay_count DESC, event_count DESC, b.item ASC
LIMIT 50`,
    notes: ["Useful for discovering valid item names before timing analysis."]
  },
  {
    title: "First occurrence timing of an item",
    topic: "build_timings",
    sql: `WITH ranked_events AS (
  SELECT
    r.source_replay_filename,
    r.matchup,
    p.name,
    p.race,
    p.owner,
    b.replay_id,
    b.time_seconds,
    ROW_NUMBER() OVER (
      PARTITION BY b.replay_id, b.owner
      ORDER BY b.time_seconds ASC
    ) AS n
  FROM build_order_events b
  JOIN players p
    ON p.replay_id = b.replay_id
   AND p.owner = b.owner
  JOIN replays r
    ON r.replay_id = b.replay_id
  WHERE p.race = 'zerg'
    AND r.matchup = 'ZvT'
    AND b.item = 'Spire'
)
SELECT *
FROM ranked_events
WHERE n = 1
ORDER BY time_seconds ASC
LIMIT 50`,
    notes: ["Adapt the race, matchup, and item filters to your question."]
  },
  {
    title: "Nth occurrence timing of an item",
    topic: "build_timings",
    sql: `WITH ranked_events AS (
  SELECT
    r.source_replay_filename,
    p.name,
    b.replay_id,
    b.owner,
    b.item,
    b.time_seconds,
    ROW_NUMBER() OVER (
      PARTITION BY b.replay_id, b.owner, b.item
      ORDER BY b.time_seconds ASC
    ) AS n
  FROM build_order_events b
  JOIN players p
    ON p.replay_id = b.replay_id
   AND p.owner = b.owner
  JOIN replays r
    ON r.replay_id = b.replay_id
  WHERE b.item = 'Hatchery'
)
SELECT *
FROM ranked_events
WHERE n = 3
ORDER BY time_seconds ASC
LIMIT 50`,
    notes: ["Useful for 2 Hatch / 2.5 Hatch style questions."]
  },
  {
    title: "Event A before event B",
    topic: "event_sequences",
    sql: `WITH hatch3 AS (
  SELECT replay_id, owner, time_seconds
  FROM (
    SELECT
      replay_id,
      owner,
      time_seconds,
      ROW_NUMBER() OVER (
        PARTITION BY replay_id, owner
        ORDER BY time_seconds ASC
      ) AS n
    FROM build_order_events
    WHERE item = 'Hatchery'
  )
  WHERE n = 3
),
spire1 AS (
  SELECT replay_id, owner, time_seconds
  FROM (
    SELECT
      replay_id,
      owner,
      time_seconds,
      ROW_NUMBER() OVER (
        PARTITION BY replay_id, owner
        ORDER BY time_seconds ASC
      ) AS n
    FROM build_order_events
    WHERE item = 'Spire'
  )
  WHERE n = 1
)
SELECT
  p.name,
  r.source_replay_filename,
  hatch3.time_seconds AS third_hatch_seconds,
  spire1.time_seconds AS first_spire_seconds,
  spire1.time_seconds - hatch3.time_seconds AS delta_seconds
FROM hatch3
JOIN spire1
  ON spire1.replay_id = hatch3.replay_id
 AND spire1.owner = hatch3.owner
JOIN players p
  ON p.replay_id = hatch3.replay_id
 AND p.owner = hatch3.owner
JOIN replays r
  ON r.replay_id = hatch3.replay_id
WHERE hatch3.time_seconds < spire1.time_seconds
ORDER BY delta_seconds ASC
LIMIT 50`,
    notes: ["Remove the final WHERE clause to see both matches and non-matches."]
  },
  {
    title: "Economy at or before a timestamp",
    topic: "economy",
    sql: `WITH ranked_economy AS (
  SELECT
    e.replay_id,
    e.owner,
    e.time_seconds,
    e.workers,
    e.minerals,
    e.gas,
    ROW_NUMBER() OVER (
      PARTITION BY e.replay_id, e.owner
      ORDER BY e.time_seconds DESC
    ) AS rn
  FROM economy_samples e
  WHERE e.time_seconds <= 300
)
SELECT
  p.name,
  r.source_replay_filename,
  ranked_economy.time_seconds,
  ranked_economy.workers,
  ranked_economy.minerals,
  ranked_economy.gas
FROM ranked_economy
JOIN players p
  ON p.replay_id = ranked_economy.replay_id
 AND p.owner = ranked_economy.owner
JOIN replays r
  ON r.replay_id = ranked_economy.replay_id
WHERE ranked_economy.rn = 1
ORDER BY p.name ASC, r.source_replay_filename ASC
LIMIT 50`,
    notes: ["This is the canonical latest-sample-at-or-before pattern."]
  },
  {
    title: "Unit count at or before a timestamp",
    topic: "composition",
    sql: `WITH ranked_counts AS (
  SELECT
    u.replay_id,
    u.owner,
    u.unit_type,
    u.time_seconds,
    u.count,
    ROW_NUMBER() OVER (
      PARTITION BY u.replay_id, u.owner, u.unit_type
      ORDER BY u.time_seconds DESC
    ) AS rn
  FROM unit_count_samples u
  WHERE u.time_seconds <= 420
    AND u.unit_type IN ('Mutalisk', 'Drone', 'Zergling')
)
SELECT
  p.name,
  r.source_replay_filename,
  ranked_counts.unit_type,
  ranked_counts.count
FROM ranked_counts
JOIN players p
  ON p.replay_id = ranked_counts.replay_id
 AND p.owner = ranked_counts.owner
JOIN replays r
  ON r.replay_id = ranked_counts.replay_id
WHERE ranked_counts.rn = 1
ORDER BY p.name ASC, r.source_replay_filename ASC, ranked_counts.unit_type ASC
LIMIT 100`,
    notes: ["Expand the unit list or drop it to analyze all unit types."]
  },
  {
    title: "Deaths in a time window",
    topic: "deaths",
    sql: `SELECT
  p.name,
  p.race,
  r.matchup,
  d.unit_type,
  COUNT(*) AS death_count
FROM death_events d
JOIN players p
  ON p.replay_id = d.replay_id
 AND p.owner = d.owner
JOIN replays r
  ON r.replay_id = d.replay_id
WHERE d.time_seconds BETWEEN 420 AND 540
GROUP BY p.name, p.race, r.matchup, d.unit_type
ORDER BY death_count DESC, d.unit_type ASC
LIMIT 50`,
    notes: ["These rows are losses for the player perspective in players."]
  },
  {
    title: "Compact replay-player card query",
    topic: "replay_cards",
    sql: `SELECT
  r.replay_id,
  r.source_replay_filename,
  r.matchup,
  r.map,
  r.duration_seconds,
  p.owner,
  p.name,
  p.race
FROM replays r
JOIN players p
  ON p.replay_id = r.replay_id
WHERE r.source_replay_filename LIKE '%KnockOut%'
ORDER BY r.source_replay_filename ASC, p.owner ASC
LIMIT 20`,
    notes: ["Use this as a starting point before joining anchor events or economy snapshots."]
  }
];

export function listQueryExamples(topic: QueryExampleTopic = "all", limit = 10): { topic: QueryExampleTopic; examples: QueryExample[] } {
  const examples =
    topic === "all"
      ? ALL_EXAMPLES
      : ALL_EXAMPLES.filter((example) => example.topic === topic);

  return {
    topic,
    examples: examples.slice(0, Math.max(1, Math.min(limit, 50)))
  };
}

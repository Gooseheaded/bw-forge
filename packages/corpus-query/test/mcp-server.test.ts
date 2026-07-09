import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ensureSchema } from "../src/db/schema.js";
import { openDatabase, saveDatabase } from "../src/db/sqlite.js";
import { ingestAnalysisRoot } from "../src/ingest/ingest.js";
import { createReplayCorpusMcpServer } from "../src/mcp/tools.js";
import { ZipFile } from "yazl";
import * as yauzl from "yauzl";

void dirname(fileURLToPath(import.meta.url));

test("MCP server exposes generic tools and returns structured replay query results", async () => {
  await using fixture = await createFixtureRoot();
  await writeReplayFixture(fixture.root, "batch/game-one", {
    schema_version: "replay-analysis-manifest-v1",
    replay_id: "replay-1",
    source: {
      filename: "game-one.rep",
      path: "C:\\replays\\game-one.rep"
    },
    matchup: "ZvT",
    map: null,
    duration_seconds: 900,
    players: [
      { owner: 3, name: "pbjt", race: "zerg", zip_filename: "player_3.zip" },
      { owner: 5, name: "Scan", race: "terran", zip_filename: "player_5.zip" }
    ]
  }, {
    "player_3.zip": await buildPlayerZip({
      owner: 3,
      name: "pbjt",
      race: "zerg",
      buildOrder: "03:20 Hatchery\n03:55 Spire\n05:45 Mutalisk\n06:20 Hatchery\n",
      economySamples: [
        { frame: 5594, time_seconds: 234.948, minerals: 180, gas: 120, gathered_minerals: 1800, gathered_gas: 240, workers: 18 },
        { frame: 7142, time_seconds: 299.964, minerals: 240, gas: 300, gathered_minerals: 2800, gathered_gas: 500, workers: 24 }
      ],
      supplySamples: [{ frame: 7100, time_seconds: 298.2, current: 58, max: 66 }],
      unitCountSamples: [{ frame: 10000, time_seconds: 420, counts: { mutalisk: 9 } }],
      deathSamples: [{ frame: 7600, time_seconds: 319.2, death: { id: 1, owner: 3, unit_type: "zergling", category: "unit" } }]
    }),
    "player_5.zip": await buildPlayerZip({
      owner: 5,
      name: "Scan",
      race: "terran",
      buildOrder: "11:20 Science Vessel\n",
      economySamples: [{ frame: 100, time_seconds: 4.2, minerals: 50, gas: 0 }],
      supplySamples: [{ frame: 100, time_seconds: 4.2, current: 9, max: 18 }]
    })
  });

  const databasePath = join(fixture.root, "corpus.sqlite");
  const { db } = await openDatabase(databasePath);
  ensureSchema(db);
  await ingestAnalysisRoot(db, fixture.root);
  await saveDatabase(db, databasePath);
  db.close();

  const server = createReplayCorpusMcpServer();
  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name).sort(),
      [
        "count_replays_with_event_before_event",
        "describe_schema",
        "execute_query_plan",
        "execute_readonly_sql",
        "export_query_plan_zip",
        "find_first_event",
        "find_nth_event",
        "find_replays",
        "get_composition_snapshot",
        "get_corpus_summary",
        "get_death_summary",
        "get_deaths",
        "get_economy",
        "get_economy_distribution",
        "get_event_timing_distribution",
        "get_player_replay_card",
        "get_schema_notes",
        "get_unit_count",
        "ingest_corpus",
        "list_build_events",
        "list_build_items",
        "list_matchups",
        "list_players",
        "list_query_examples",
        "list_unit_types",
        "search_build_items",
        "server_info",
        "validate_readonly_sql"
      ]
    );

    const infoResult = await client.callTool({
      name: "server_info",
      arguments: {}
    });
    assert.equal(infoResult.isError, undefined);
    assert.equal((infoResult.structuredContent as { package_name: string }).package_name, "bw-replay-corpus-query");
    assert.equal((infoResult.structuredContent as { package_version: string }).package_version, "0.2.0");
    assert.deepEqual(
      (infoResult.structuredContent as { supported_tools: string[] }).supported_tools,
      [
        "server_info",
        "ingest_corpus",
        "describe_schema",
        "get_schema_notes",
        "list_query_examples",
        "validate_readonly_sql",
        "execute_readonly_sql",
        "get_corpus_summary",
        "list_players",
        "list_matchups",
        "list_build_items",
        "search_build_items",
        "list_unit_types",
        "get_event_timing_distribution",
        "count_replays_with_event_before_event",
        "get_composition_snapshot",
        "get_economy_distribution",
        "get_death_summary",
        "get_player_replay_card",
        "find_replays",
        "find_first_event",
        "list_build_events",
        "find_nth_event",
        "get_unit_count",
        "get_economy",
        "get_deaths",
        "execute_query_plan",
        "export_query_plan_zip"
      ]
    );

    const describeSchemaResult = await client.callTool({
      name: "describe_schema",
      arguments: {
        db_path: databasePath
      }
    });
    assert.equal(describeSchemaResult.isError, undefined);
    assert.match(getToolText(describeSchemaResult), /replays/i);
    assert.match(getToolText(describeSchemaResult), /players joins replays on replay_id/i);
    assert.ok(
      ((describeSchemaResult.structuredContent as { tables: Array<{ name: string }> }).tables ?? []).some(
        (table) => table.name === "players"
      )
    );

    const schemaNotesResult = await client.callTool({
      name: "get_schema_notes",
      arguments: {
        topic: "deaths"
      }
    });
    assert.equal(schemaNotesResult.isError, undefined);
    assert.match(getToolText(schemaNotesResult), /own losses/i);

    const queryExamplesResult = await client.callTool({
      name: "list_query_examples",
      arguments: {
        topic: "build_timings",
        limit: 2
      }
    });
    assert.equal(queryExamplesResult.isError, undefined);
    assert.match(getToolText(queryExamplesResult), /First occurrence timing of an item/i);
    assert.match(getToolText(queryExamplesResult), /source_replay_filename/i);

    const validateSqlResult = await client.callTool({
      name: "validate_readonly_sql",
      arguments: {
        sql: "SELECT name, race FROM players ORDER BY name ASC LIMIT 10;"
      }
    });
    assert.equal(validateSqlResult.isError, undefined);
    assert.equal((validateSqlResult.structuredContent as { allowed: boolean }).allowed, true);
    assert.match(getToolText(validateSqlResult), /validation passed/i);

    const rejectSqlResult = await client.callTool({
      name: "validate_readonly_sql",
      arguments: {
        sql: "DELETE FROM players;"
      }
    });
    assert.equal(rejectSqlResult.isError, undefined);
    assert.equal((rejectSqlResult.structuredContent as { allowed: boolean }).allowed, false);
    assert.match(getToolText(rejectSqlResult), /validation failed/i);

    const executeSqlResult = await client.callTool({
      name: "execute_readonly_sql",
      arguments: {
        db_path: databasePath,
        sql: "SELECT name, race FROM players ORDER BY name ASC LIMIT 10;",
        includeSchema: true
      }
    });
    assert.equal(executeSqlResult.isError, undefined);
    assert.match(getToolText(executeSqlResult), /pbjt/i);
    assert.match(getToolText(executeSqlResult), /Columns:/i);
    assert.deepEqual((executeSqlResult.structuredContent as { columns: string[] }).columns, ["name", "race"]);
    assert.deepEqual((executeSqlResult.structuredContent as { rows: unknown[][] }).rows, [
      ["pbjt", "zerg"],
      ["Scan", "terran"]
    ]);

    const replayResult = await client.callTool({
      name: "find_replays",
      arguments: {
        db_path: databasePath,
        matchup: "ZvT",
        player: "pbjt",
        race: "zerg"
      }
    });
    assert.equal(replayResult.isError, undefined);
    assert.match(getToolText(replayResult), /game-one\.rep/i);
    assert.match(getToolText(replayResult), /pbjt/i);
    assert.deepEqual(replayResult.structuredContent, {
      count: 1,
      results: [
        {
          replay_id: "replay-1",
          source_replay_filename: "game-one.rep",
          source_replay_path: "C:\\replays\\game-one.rep",
          matchup: "ZvT",
          map: null,
          duration_seconds: 900,
          manifest_path: resolve(fixture.root, "batch/game-one/manifest.json"),
          players: [
            {
              owner: 3,
              name: "pbjt",
              race: "zerg",
              zip_path: resolve(fixture.root, "batch/game-one/player_3.zip")
            },
            {
              owner: 5,
              name: "Scan",
              race: "terran",
              zip_path: resolve(fixture.root, "batch/game-one/player_5.zip")
            }
          ]
        }
      ]
    });

    const replayScopedResult = await client.callTool({
      name: "find_replays",
      arguments: {
        db_path: databasePath,
        replay_ids: ["replay-1"]
      }
    });
    assert.equal(replayScopedResult.isError, undefined);
    assert.equal((replayScopedResult.structuredContent as { count: number }).count, 1);

    const eventResult = await client.callTool({
      name: "find_first_event",
      arguments: {
        db_path: databasePath,
        player: "pbjt",
        item: "Science Vessel",
        matchup: "ZvT",
        race: "zerg",
        as: "enemy"
      }
    });
    assert.equal(eventResult.isError, undefined);
    assert.match(getToolText(eventResult), /Science Vessel/i);
    assert.match(getToolText(eventResult), /11:20/i);
    assert.deepEqual(eventResult.structuredContent, {
      count: 1,
      results: [
        {
          replay_id: "replay-1",
          source_replay_filename: "game-one.rep",
          source_replay_path: "C:\\replays\\game-one.rep",
          self_owner: 3,
          target_owner: 5,
          player_name: "pbjt",
          target_name: "Scan",
          matchup: "ZvT",
          event: {
            time_seconds: 680,
            supply_used: null,
            supply_max: null,
            item: "Science Vessel",
            raw_line: "11:20 Science Vessel"
          }
        }
      ]
    });

    const buildEventsResult = await client.callTool({
      name: "list_build_events",
      arguments: {
        db_path: databasePath,
        player: "pbjt",
        item: "Hatchery"
      }
    });
    assert.equal(buildEventsResult.isError, undefined);
    assert.match(getToolText(buildEventsResult), /Hatchery/i);
    assert.match(getToolText(buildEventsResult), /3:20/i);
    assert.equal((buildEventsResult.structuredContent as { count: number }).count, 2);

    const nthEventResult = await client.callTool({
      name: "find_nth_event",
      arguments: {
        db_path: databasePath,
        player: "pbjt",
        item: "Hatchery",
        n: 2
      }
    });
    assert.equal(nthEventResult.isError, undefined);
    assert.match(getToolText(nthEventResult), /Hatchery/i);
    assert.match(getToolText(nthEventResult), /6:20/i);
    assert.deepEqual(nthEventResult.structuredContent, {
      count: 1,
      results: [
        {
          replay_id: "replay-1",
          source_replay_filename: "game-one.rep",
          source_replay_path: "C:\\replays\\game-one.rep",
          self_owner: 3,
          target_owner: 3,
          player_name: "pbjt",
          target_name: "pbjt",
          matchup: "ZvT",
          n: 2,
          event: {
            time_seconds: 380,
            supply_used: null,
            supply_max: null,
            item: "Hatchery",
            raw_line: "06:20 Hatchery"
          }
        }
      ]
    });

    const replayScopedEconomy = await client.callTool({
      name: "get_economy",
      arguments: {
        db_path: databasePath,
        player: "pbjt",
        at_seconds: 300,
        replay_ids: ["replay-1"]
      }
    });
    assert.equal(replayScopedEconomy.isError, undefined);
    assert.match(getToolText(replayScopedEconomy), /workers 24/i);
    assert.match(getToolText(replayScopedEconomy), /minerals 240/i);
    assert.equal((replayScopedEconomy.structuredContent as { count: number }).count, 1);
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP server exposes read-only compatibility resources for local-model clients", async () => {
  await using fixture = await createFixtureRoot();
  await writeReplayFixture(fixture.root, "batch/game-one", {
    schema_version: "replay-analysis-manifest-v1",
    replay_id: "replay-1",
    source: {
      filename: "game-one.rep",
      path: "C:\\replays\\game-one.rep"
    },
    matchup: "ZvT",
    map: null,
    duration_seconds: 900,
    players: [
      { owner: 3, name: "pbjt", race: "zerg", zip_filename: "player_3.zip" },
      { owner: 5, name: "Scan", race: "terran", zip_filename: "player_5.zip" }
    ]
  }, {
    "player_3.zip": await buildPlayerZip({
      owner: 3,
      name: "pbjt",
      race: "zerg",
      buildOrder: "03:20 Hatchery\n03:55 Spire\n05:45 Mutalisk\n06:20 Hatchery\n",
      economySamples: [
        { frame: 5594, time_seconds: 234.948, minerals: 180, gas: 120, gathered_minerals: 1800, gathered_gas: 240, workers: 18 },
        { frame: 7142, time_seconds: 299.964, minerals: 240, gas: 300, gathered_minerals: 2800, gathered_gas: 500, workers: 24 }
      ],
      supplySamples: [{ frame: 7100, time_seconds: 298.2, current: 58, max: 66 }],
      unitCountSamples: [{ frame: 10000, time_seconds: 420, counts: { mutalisk: 9 } }],
      deathSamples: [{ frame: 7600, time_seconds: 319.2, death: { id: 1, owner: 3, unit_type: "zergling", category: "unit" } }]
    }),
    "player_5.zip": await buildPlayerZip({
      owner: 5,
      name: "Scan",
      race: "terran",
      buildOrder: "11:20 Science Vessel\n",
      economySamples: [{ frame: 100, time_seconds: 4.2, minerals: 50, gas: 0 }],
      supplySamples: [{ frame: 100, time_seconds: 4.2, current: 9, max: 18 }]
    })
  });

  const databasePath = join(fixture.root, "corpus.sqlite");
  const { db } = await openDatabase(databasePath);
  ensureSchema(db);
  await ingestAnalysisRoot(db, fixture.root);
  await saveDatabase(db, databasePath);
  db.close();

  const server = createReplayCorpusMcpServer();
  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const resources = await client.listResources();
    assert.ok(resources.resources.some((resource) => resource.uri === "bw_replay://server_info"));

    const resourceTemplates = await client.listResourceTemplates();
    assert.ok(
      resourceTemplates.resourceTemplates.some(
        (template) => template.uriTemplate === "bw_replay://find_replays{?db_path,player,matchup,race,replay,replay_id,replay_ids}"
      )
    );

    const infoToolResult = await client.callTool({
      name: "server_info",
      arguments: {}
    });
    const infoResourceResult = await client.readResource({
      uri: "bw_replay://server_info"
    });
    assert.deepEqual(parseJsonResource(infoResourceResult), infoToolResult.structuredContent);

    const replaysResourceResult = await client.readResource({
      uri: `bw_replay://find_replays?db_path=${encodeURIComponent(databasePath)}&player=pbjt`
    });
    assert.deepEqual(parseJsonResource(replaysResourceResult), {
      count: 1,
      results: [
        {
          replay_id: "replay-1",
          source_replay_filename: "game-one.rep",
          source_replay_path: "C:\\replays\\game-one.rep",
          matchup: "ZvT",
          map: null,
          duration_seconds: 900,
          manifest_path: resolve(fixture.root, "batch/game-one/manifest.json"),
          players: [
            {
              owner: 3,
              name: "pbjt",
              race: "zerg",
              zip_path: resolve(fixture.root, "batch/game-one/player_3.zip")
            },
            {
              owner: 5,
              name: "Scan",
              race: "terran",
              zip_path: resolve(fixture.root, "batch/game-one/player_5.zip")
            }
          ]
        }
      ]
    });

    await assert.rejects(
      client.readResource({
        uri: `bw_replay://economy?db_path=${encodeURIComponent(databasePath)}`
      }),
      /Missing required query parameter: player/
    );

    const replayResult = await client.callTool({
      name: "find_replays",
      arguments: {
        db_path: databasePath,
        matchup: "ZvT",
        player: "pbjt",
        race: "zerg"
      }
    });
    assert.equal(replayResult.isError, undefined);
    assert.equal((replayResult.structuredContent as { count: number }).count, 1);
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP server exposes corpus discovery tools for local-model analytics", async () => {
  await using fixture = await createFixtureRoot();
  await writeReplayFixture(fixture.root, "batch/game-one", {
    schema_version: "replay-analysis-manifest-v1",
    replay_id: "replay-1",
    source: {
      filename: "game-one.rep",
      path: "C:\\replays\\game-one.rep"
    },
    matchup: "ZvT",
    map: null,
    duration_seconds: 900,
    players: [
      { owner: 3, name: "pbjt", race: "zerg", zip_filename: "player_3.zip" },
      { owner: 5, name: "Scan", race: "terran", zip_filename: "player_5.zip" }
    ]
  }, {
    "player_3.zip": await buildPlayerZip({
      owner: 3,
      name: "pbjt",
      race: "zerg",
      buildOrder: "03:20 Hatchery\n03:55 Spire\n05:45 Mutalisk\n06:20 Hatchery\n",
      economySamples: [
        { frame: 5594, time_seconds: 234.948, minerals: 180, gas: 120, gathered_minerals: 1800, gathered_gas: 240, workers: 18 }
      ],
      supplySamples: [{ frame: 7100, time_seconds: 298.2, current: 58, max: 66 }],
      unitCountSamples: [{ frame: 10000, time_seconds: 420, counts: { mutalisk: 9, drone: 24 } }],
      deathSamples: [{ frame: 7600, time_seconds: 319.2, death: { id: 1, owner: 3, unit_type: "zergling", category: "unit" } }]
    }),
    "player_5.zip": await buildPlayerZip({
      owner: 5,
      name: "Scan",
      race: "terran",
      buildOrder: "10:40 Starport\n11:20 Science Vessel\n",
      economySamples: [{ frame: 100, time_seconds: 4.2, minerals: 50, gas: 0 }],
      supplySamples: [{ frame: 100, time_seconds: 4.2, current: 9, max: 18 }],
      unitCountSamples: [{ frame: 10000, time_seconds: 420, counts: { marine: 12 } }],
      deathSamples: [{ frame: 8000, time_seconds: 336, death: { id: 2, owner: 5, unit_type: "marine", category: "unit" } }]
    })
  });

  const databasePath = join(fixture.root, "corpus.sqlite");
  const { db } = await openDatabase(databasePath);
  ensureSchema(db);
  await ingestAnalysisRoot(db, fixture.root);
  await saveDatabase(db, databasePath);
  db.close();

  const server = createReplayCorpusMcpServer();
  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const summary = await client.callTool({
      name: "get_corpus_summary",
      arguments: {
        db_path: databasePath
      }
    });
    assert.equal(summary.isError, undefined);
    assert.match(getToolText(summary), /Replays: 1/i);
    assert.match(getToolText(summary), /Distinct players: 2/i);
    assert.match(getToolText(summary), /ZvT/i);
    assert.deepEqual(summary.structuredContent, {
      filters: {
        player: null,
        opponent: null,
        race: null,
        opponentRace: null,
        matchup: null,
        map: null,
        replayIds: null
      },
      replayCount: 1,
      playerCount: 2,
      matchups: [{ matchup: "ZvT", replayCount: 1 }],
      races: [
        { race: "terran", playerRows: 1 },
        { race: "zerg", playerRows: 1 }
      ],
      maps: [{ map: "unknown", replayCount: 1 }],
      dataAvailability: {
        buildOrderEvents: true,
        economySamples: true,
        supplySamples: true,
        unitCountSamples: true,
        deathEvents: true
      }
    });

    const players = await client.callTool({
      name: "list_players",
      arguments: {
        db_path: databasePath,
        matchup: "ZvT"
      }
    });
    assert.equal(players.isError, undefined);
    assert.match(getToolText(players), /pbjt/i);
    assert.match(getToolText(players), /Scan/i);
    assert.deepEqual(players.structuredContent, {
      filters: {
        player: null,
        opponent: null,
        race: null,
        opponentRace: null,
        matchup: "ZvT",
        map: null,
        replayIds: null
      },
      players: [
        {
          name: "pbjt",
          races: ["zerg"],
          replayCount: 1,
          matchups: [{ matchup: "ZvT", replayCount: 1 }]
        },
        {
          name: "Scan",
          races: ["terran"],
          replayCount: 1,
          matchups: [{ matchup: "ZvT", replayCount: 1 }]
        }
      ]
    });

    const matchups = await client.callTool({
      name: "list_matchups",
      arguments: {
        db_path: databasePath,
        player: "pbjt"
      }
    });
    assert.equal(matchups.isError, undefined);
    assert.match(getToolText(matchups), /ZvT/i);
    assert.deepEqual(matchups.structuredContent, {
      filters: {
        player: "pbjt",
        opponent: null,
        race: null,
        opponentRace: null,
        matchup: null,
        map: null,
        replayIds: null
      },
      matchups: [
        {
          matchup: "ZvT",
          replayCount: 1,
          playerRows: 1
        }
      ]
    });

    const buildItems = await client.callTool({
      name: "list_build_items",
      arguments: {
        db_path: databasePath,
        player: "pbjt"
      }
    });
    assert.equal(buildItems.isError, undefined);
    assert.match(getToolText(buildItems), /Hatchery/i);
    assert.match(getToolText(buildItems), /Spire/i);
    assert.deepEqual(buildItems.structuredContent, {
      filters: {
        player: "pbjt",
        opponent: null,
        race: null,
        opponentRace: null,
        matchup: null,
        map: null,
        replayIds: null
      },
      items: [
        { name: "Hatchery", count: 2, replayCount: 1 },
        { name: "Mutalisk", count: 1, replayCount: 1 },
        { name: "Spire", count: 1, replayCount: 1 }
      ]
    });

    const searchItems = await client.callTool({
      name: "search_build_items",
      arguments: {
        db_path: databasePath,
        query: "spire"
      }
    });
    assert.equal(searchItems.isError, undefined);
    assert.match(getToolText(searchItems), /Spire/i);
    assert.deepEqual(searchItems.structuredContent, {
      query: "spire",
      filters: {
        player: null,
        opponent: null,
        race: null,
        opponentRace: null,
        matchup: null,
        map: null,
        replayIds: null
      },
      matches: [{ name: "Spire", count: 1, replayCount: 1 }]
    });

    const units = await client.callTool({
      name: "list_unit_types",
      arguments: {
        db_path: databasePath,
        source: "both"
      }
    });
    assert.equal(units.isError, undefined);
    assert.match(getToolText(units), /marine/i);
    assert.match(getToolText(units), /zergling/i);
    assert.deepEqual(units.structuredContent, {
      source: "both",
      filters: {
        player: null,
        opponent: null,
        race: null,
        opponentRace: null,
        matchup: null,
        map: null,
        replayIds: null
      },
      units: [
        { name: "marine", unitCountSampleCount: 1, deathEventCount: 1 },
        { name: "drone", unitCountSampleCount: 1, deathEventCount: 0 },
        { name: "mutalisk", unitCountSampleCount: 1, deathEventCount: 0 },
        { name: "zergling", unitCountSampleCount: 0, deathEventCount: 1 }
      ]
    });
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP read-only tools can resolve db_path from BW_REPLAY_DB_PATH", async () => {
  await using fixture = await createFixtureRoot();
  await writeReplayFixture(fixture.root, "batch/game-one", {
    schema_version: "replay-analysis-manifest-v1",
    replay_id: "replay-1",
    source: {
      filename: "game-one.rep",
      path: "C:\\replays\\game-one.rep"
    },
    matchup: "ZvT",
    map: null,
    duration_seconds: 900,
    players: [
      { owner: 3, name: "pbjt", race: "zerg", zip_filename: "player_3.zip" },
      { owner: 5, name: "Scan", race: "terran", zip_filename: "player_5.zip" }
    ]
  }, {
    "player_3.zip": await buildPlayerZip({
      owner: 3,
      name: "pbjt",
      race: "zerg",
      buildOrder: "03:20 Hatchery\n03:55 Spire\n",
      economySamples: [{ frame: 5594, time_seconds: 234.948, minerals: 180, gas: 120, gathered_minerals: 1800, gathered_gas: 240, workers: 18 }],
      supplySamples: [{ frame: 7100, time_seconds: 298.2, current: 58, max: 66 }]
    }),
    "player_5.zip": await buildPlayerZip({
      owner: 5,
      name: "Scan",
      race: "terran",
      buildOrder: "11:20 Science Vessel\n",
      economySamples: [{ frame: 100, time_seconds: 4.2, minerals: 50, gas: 0 }],
      supplySamples: [{ frame: 100, time_seconds: 4.2, current: 9, max: 18 }]
    })
  });

  const databasePath = join(fixture.root, "corpus.sqlite");
  const { db } = await openDatabase(databasePath);
  ensureSchema(db);
  await ingestAnalysisRoot(db, fixture.root);
  await saveDatabase(db, databasePath);
  db.close();

  const previousEnvDbPath = process.env.BW_REPLAY_DB_PATH;
  process.env.BW_REPLAY_DB_PATH = databasePath;

  const server = createReplayCorpusMcpServer();
  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const players = await client.callTool({
      name: "list_players",
      arguments: {
        matchup: "ZvT"
      }
    });
    assert.equal(players.isError, undefined);
    assert.match(getToolText(players), /pbjt/i);

    const replays = await client.callTool({
      name: "find_replays",
      arguments: {
        player: "pbjt",
        matchup: "ZvT",
        race: "zerg"
      }
    });
    assert.equal(replays.isError, undefined);
    assert.equal((replays.structuredContent as { count: number }).count, 1);
    assert.match(getToolText(replays), /game-one\.rep/i);
  } finally {
    if (previousEnvDbPath === undefined) {
      delete process.env.BW_REPLAY_DB_PATH;
    } else {
      process.env.BW_REPLAY_DB_PATH = previousEnvDbPath;
    }
    await client.close();
    await server.close();
  }
});

test("MCP server exposes timing, snapshot, death, and replay-card analytics tools", async () => {
  await using fixture = await createFixtureRoot();
  await writeReplayFixture(fixture.root, "batch/game-one", {
    schema_version: "replay-analysis-manifest-v1",
    replay_id: "replay-1",
    source: {
      filename: "game-one.rep",
      path: "C:\\replays\\game-one.rep"
    },
    matchup: "ZvT",
    map: null,
    duration_seconds: 900,
    players: [
      { owner: 3, name: "pbjt", race: "zerg", zip_filename: "player_3.zip" },
      { owner: 5, name: "Scan", race: "terran", zip_filename: "player_5.zip" }
    ]
  }, {
    "player_3.zip": await buildPlayerZip({
      owner: 3,
      name: "pbjt",
      race: "zerg",
      buildOrder: "01:58 Hatchery\n02:18 Spawning Pool\n03:36 Lair\n04:15 Spire\n",
      economySamples: [
        { frame: 7142, time_seconds: 299.964, minerals: 240, gas: 300, gathered_minerals: 2800, gathered_gas: 500, workers: 24 },
        { frame: 10000, time_seconds: 420, minerals: 150, gas: 80, gathered_minerals: 4200, gathered_gas: 900, workers: 31 }
      ],
      supplySamples: [{ frame: 7100, time_seconds: 298.2, current: 58, max: 66 }],
      unitCountSamples: [
        { frame: 7142, time_seconds: 299.964, counts: { drone: 24 } },
        { frame: 10000, time_seconds: 420, counts: { mutalisk: 8, drone: 31, zergling: 12 } }
      ],
      deathSamples: [
        { frame: 10200, time_seconds: 430, death: { id: 1, owner: 3, unit_type: "mutalisk", category: "unit" } },
        { frame: 10300, time_seconds: 440, death: { id: 2, owner: 3, unit_type: "zergling", category: "unit" } }
      ]
    }),
    "player_5.zip": await buildPlayerZip({
      owner: 5,
      name: "Scan",
      race: "terran",
      buildOrder: "01:35 Supply Depot\n01:55 Barracks\n03:45 Factory\n",
      economySamples: [{ frame: 7142, time_seconds: 299.964, minerals: 180, gas: 96, gathered_minerals: 2500, gathered_gas: 350, workers: 29 }],
      supplySamples: [{ frame: 100, time_seconds: 4.2, current: 9, max: 18 }],
      unitCountSamples: [{ frame: 10000, time_seconds: 420, counts: { marine: 14, medic: 2 } }],
      deathSamples: [
        { frame: 10400, time_seconds: 450, death: { id: 3, owner: 5, unit_type: "marine", category: "unit" } },
        { frame: 10500, time_seconds: 460, death: { id: 4, owner: 5, unit_type: "marine", category: "unit" } },
        { frame: 10600, time_seconds: 470, death: { id: 5, owner: 5, unit_type: "medic", category: "unit" } }
      ]
    })
  });

  const databasePath = join(fixture.root, "corpus.sqlite");
  const { db } = await openDatabase(databasePath);
  ensureSchema(db);
  await ingestAnalysisRoot(db, fixture.root);
  await saveDatabase(db, databasePath);
  db.close();

  const server = createReplayCorpusMcpServer();
  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const timing = await client.callTool({
      name: "get_event_timing_distribution",
      arguments: {
        db_path: databasePath,
        player: "pbjt",
        item: "Spire"
      }
    });
    assert.equal(timing.isError, undefined);
    assert.match(getToolText(timing), /Spire #1 timing/i);
    assert.match(getToolText(timing), /Median: 4:15/i);
    assert.deepEqual(timing.structuredContent, {
      filters: {
        player: "pbjt",
        opponent: null,
        race: null,
        opponentRace: null,
        matchup: null,
        map: null,
        replayIds: null,
        item: "Spire",
        n: 1
      },
      sampleSize: 1,
      seconds: {
        min: 255,
        p25: 255,
        median: 255,
        p75: 255,
        max: 255,
        mean: 255
      },
      times: {
        min: "4:15",
        p25: "4:15",
        median: "4:15",
        p75: "4:15",
        max: "4:15"
      },
      examples: [
        {
          replayId: "replay-1",
          filename: "game-one.rep",
          player: "pbjt",
          opponent: "Scan",
          race: "zerg",
          matchup: "ZvT",
          timeSeconds: 255,
          time: "4:15"
        }
      ]
    });

    const beforeAfter = await client.callTool({
      name: "count_replays_with_event_before_event",
      arguments: {
        db_path: databasePath,
        player: "pbjt",
        firstItem: "Lair",
        secondItem: "Spire"
      }
    });
    assert.equal(beforeAfter.isError, undefined);
    assert.match(getToolText(beforeAfter), /Lair #1 before Spire #1/i);
    assert.match(getToolText(beforeAfter), /Percentage: 100%/i);
    assert.deepEqual(beforeAfter.structuredContent, {
      filters: {
        player: "pbjt",
        opponent: null,
        race: null,
        opponentRace: null,
        matchup: null,
        map: null,
        replayIds: null
      },
      condition: {
        first: { item: "Lair", n: 1 },
        second: { item: "Spire", n: 1 }
      },
      sampleSize: 1,
      matchCount: 1,
      percentage: 100,
      missingFirstCount: 0,
      missingSecondCount: 0,
      examples: [
        {
          replayId: "replay-1",
          filename: "game-one.rep",
          player: "pbjt",
          opponent: "Scan",
          firstTimeSeconds: 216,
          firstTime: "3:36",
          secondTimeSeconds: 255,
          secondTime: "4:15",
          deltaSeconds: 39
        }
      ],
      nonMatches: []
    });

    const composition = await client.callTool({
      name: "get_composition_snapshot",
      arguments: {
        db_path: databasePath,
        player: "pbjt",
        timeSeconds: 420,
        units: ["Mutalisk", "Drone"]
      }
    });
    assert.equal(composition.isError, undefined);
    assert.match(getToolText(composition), /Mutalisk: median 8/i);
    assert.match(getToolText(composition), /Drone: median 31/i);
    assert.deepEqual(composition.structuredContent, {
      filters: {
        player: "pbjt",
        opponent: null,
        race: null,
        opponentRace: null,
        matchup: null,
        map: null,
        replayIds: null,
        timeSeconds: 420,
        time: "7:00"
      },
      sampleSize: 1,
      units: {
        Mutalisk: { min: 8, p25: 8, median: 8, p75: 8, max: 8, mean: 8 },
        Drone: { min: 31, p25: 31, median: 31, p75: 31, max: 31, mean: 31 }
      },
      examples: [
        {
          replayId: "replay-1",
          filename: "game-one.rep",
          player: "pbjt",
          opponent: "Scan",
          time: "7:00",
          units: {
            Mutalisk: 8,
            Drone: 31
          }
        }
      ]
    });

    const economy = await client.callTool({
      name: "get_economy_distribution",
      arguments: {
        db_path: databasePath,
        player: "pbjt",
        timeSeconds: 420
      }
    });
    assert.equal(economy.isError, undefined);
    assert.match(getToolText(economy), /Workers: median 31/i);
    assert.match(getToolText(economy), /Minerals: median 150/i);
    assert.deepEqual(economy.structuredContent, {
      filters: {
        player: "pbjt",
        opponent: null,
        race: null,
        opponentRace: null,
        matchup: null,
        map: null,
        replayIds: null,
        timeSeconds: 420,
        time: "7:00"
      },
      sampleSize: 1,
      workers: { min: 31, p25: 31, median: 31, p75: 31, max: 31, mean: 31 },
      minerals: { min: 150, p25: 150, median: 150, p75: 150, max: 150, mean: 150 },
      gas: { min: 80, p25: 80, median: 80, p75: 80, max: 80, mean: 80 },
      examples: [
        {
          replayId: "replay-1",
          filename: "game-one.rep",
          player: "pbjt",
          opponent: "Scan",
          workers: 31,
          minerals: 150,
          gas: 80
        }
      ]
    });

    const deaths = await client.callTool({
      name: "get_death_summary",
      arguments: {
        db_path: databasePath,
        player: "pbjt",
        startSeconds: 420,
        endSeconds: 540
      }
    });
    assert.equal(deaths.isError, undefined);
    assert.match(getToolText(deaths), /mutalisk: 1 total/i);
    assert.match(getToolText(deaths), /marine: 2 total/i);
    assert.deepEqual(deaths.structuredContent, {
      filters: {
        player: "pbjt",
        opponent: null,
        race: null,
        opponentRace: null,
        matchup: null,
        map: null,
        replayIds: null,
        startSeconds: 420,
        endSeconds: 540,
        start: "7:00",
        end: "9:00"
      },
      sampleSize: 1,
      lost: [
        { unit: "mutalisk", count: 1, perReplayMean: 1 },
        { unit: "zergling", count: 1, perReplayMean: 1 }
      ],
      killed: [
        { unit: "marine", count: 2, perReplayMean: 2 },
        { unit: "medic", count: 1, perReplayMean: 1 }
      ],
      examples: [
        {
          replayId: "replay-1",
          filename: "game-one.rep",
          player: "pbjt",
          opponent: "Scan",
          lost: {
            mutalisk: 1,
            zergling: 1
          },
          killed: {
            marine: 2,
            medic: 1
          }
        }
      ]
    });

    const replayCard = await client.callTool({
      name: "get_player_replay_card",
      arguments: {
        db_path: databasePath,
        replayId: "replay-1",
        player: "pbjt"
      }
    });
    assert.equal(replayCard.isError, undefined);
    assert.match(getToolText(replayCard), /Replay card: game-one\.rep/i);
    assert.match(getToolText(replayCard), /Spire #1 — 4:15/i);
    assert.match(getToolText(replayCard), /7:00-9:00/i);
    assert.deepEqual(replayCard.structuredContent, {
      replayId: "replay-1",
      filename: "game-one.rep",
      map: "unknown",
      duration: "15:00",
      player: { name: "pbjt", race: "zerg" },
      opponent: { name: "Scan", race: "terran" },
      matchup: "ZvT",
      buildAnchors: [
        { item: "Hatchery", n: 1, time: "1:58" },
        { item: "Spawning Pool", n: 1, time: "2:18" },
        { item: "Lair", n: 1, time: "3:36" },
        { item: "Spire", n: 1, time: "4:15" }
      ],
      economyBenchmarks: [
        { time: "5:00", workers: 24 },
        { time: "7:00", workers: 31 }
      ],
      combatSummary: [
        {
          window: "7:00-9:00",
          lost: {
            mutalisk: 1,
            zergling: 1
          },
          killed: {
            marine: 2,
            medic: 1
          }
        }
      ]
    });
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP ingest_corpus writes a SQLite corpus explicitly and returns an ingest summary", async () => {
  await using fixture = await createFixtureRoot();
  await writeReplayFixture(fixture.root, "batch/game-one", {
    schema_version: "replay-analysis-manifest-v1",
    replay_id: "replay-1",
    source: {
      filename: "game-one.rep",
      path: "C:\\replays\\game-one.rep"
    },
    matchup: "ZvT",
    map: null,
    duration_seconds: 900,
    players: [
      { owner: 3, name: "pbjt", race: "zerg", zip_filename: "player_3.zip" },
      { owner: 5, name: "Scan", race: "terran", zip_filename: "player_5.zip" }
    ]
  }, {
    "player_3.zip": await buildPlayerZip({
      owner: 3,
      name: "pbjt",
      race: "zerg",
      buildOrder: "05:45 Mutalisk\n",
      economySamples: [{ frame: 7142, time_seconds: 299.964, minerals: 240, gas: 300, gathered_minerals: 2800, gathered_gas: 500, workers: 24 }],
      supplySamples: [{ frame: 7100, time_seconds: 298.2, current: 58, max: 66 }],
      unitCountSamples: [{ frame: 10000, time_seconds: 420, counts: { mutalisk: 9 } }],
      deathSamples: [{ frame: 7600, time_seconds: 319.2, death: { id: 1, owner: 3, unit_type: "zergling", category: "unit" } }]
    }),
    "player_5.zip": await buildPlayerZip({
      owner: 5,
      name: "Scan",
      race: "terran",
      buildOrder: "09:00 Science Vessel\n",
      economySamples: [{ frame: 100, time_seconds: 4.2, minerals: 50, gas: 0 }],
      supplySamples: [{ frame: 100, time_seconds: 4.2, current: 9, max: 18 }]
    })
  });

  const server = createReplayCorpusMcpServer();
  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const databasePath = join(fixture.root, "corpus.sqlite");
    const ingestResult = await client.callTool({
      name: "ingest_corpus",
      arguments: {
        analysis_output_root: fixture.root,
        db_path: databasePath
      }
    });
    assert.equal(ingestResult.isError, undefined);
    assert.deepEqual(ingestResult.structuredContent, {
      db_path: resolve(databasePath),
      analysis_output_root: resolve(fixture.root),
      manifests_discovered: 1,
      replays_ingested: 1,
      players_inserted: 2,
      batch_size: 10,
      batches: [
        {
          batch_number: 1,
          manifest_count: 1,
          replay_ids: ["replay-1"],
          manifests_completed: 1,
          manifests_remaining: 0
        }
      ],
      warnings: [],
      errors: []
    });

    const replayResult = await client.callTool({
      name: "find_replays",
      arguments: {
        db_path: databasePath,
        matchup: "ZvT",
        player: "pbjt",
        race: "zerg"
      }
    });
    assert.equal(replayResult.isError, undefined);
    assert.equal((replayResult.structuredContent as { count: number }).count, 1);
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP execute_query_plan runs a replay-centric plan against a fixture corpus", async () => {
  await using fixture = await createFixtureRoot();
  await writeReplayFixture(fixture.root, "batch/game-one", {
    schema_version: "replay-analysis-manifest-v1",
    replay_id: "replay-1",
    source: {
      filename: "game-one.rep",
      path: "C:\\replays\\game-one.rep"
    },
    matchup: "ZvT",
    map: null,
    duration_seconds: 900,
    players: [
      { owner: 3, name: "pbjt", race: "zerg", zip_filename: "player_3.zip" },
      { owner: 5, name: "Scan", race: "terran", zip_filename: "player_5.zip" }
    ]
  }, {
    "player_3.zip": await buildPlayerZip({
      owner: 3,
      name: "pbjt",
      race: "zerg",
      buildOrder: "05:45 Mutalisk\n",
      economySamples: [{ frame: 7142, time_seconds: 299.964, minerals: 240, gas: 300, gathered_minerals: 2800, gathered_gas: 500, workers: 24 }],
      supplySamples: [{ frame: 7100, time_seconds: 298.2, current: 58, max: 66 }],
      unitCountSamples: [{ frame: 10000, time_seconds: 420, counts: { mutalisk: 9 } }],
      deathSamples: [{ frame: 7600, time_seconds: 319.2, death: { id: 1, owner: 3, unit_type: "zergling", category: "unit" } }]
    }),
    "player_5.zip": await buildPlayerZip({
      owner: 5,
      name: "Scan",
      race: "terran",
      buildOrder: "11:20 Science Vessel\n",
      economySamples: [{ frame: 100, time_seconds: 4.2, minerals: 50, gas: 0 }],
      supplySamples: [{ frame: 100, time_seconds: 4.2, current: 9, max: 18 }]
    })
  });

  const databasePath = join(fixture.root, "corpus.sqlite");
  const { db } = await openDatabase(databasePath);
  ensureSchema(db);
  await ingestAnalysisRoot(db, fixture.root);
  await saveDatabase(db, databasePath);
  db.close();

  const server = createReplayCorpusMcpServer();
  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const result = await client.callTool({
      name: "execute_query_plan",
      arguments: {
        db_path: databasePath,
        plan: {
          planner_schema: "query-planner-v1",
          query: {
            original_text: "Which pbjt ZvT games have early Mutalisks before enemy Science Vessels are out?",
            intent: "find_replays_matching_pattern"
          },
          replay_set: {
            matchup: "ZvT",
            player: "pbjt",
            race: "zerg"
          },
          constraints: [
            {
              id: "self_first_mutalisk_before_6m",
              type: "first_event_before",
              perspective: "self",
              item: "Mutalisk",
              before_seconds: 360
            }
          ],
          evidence_requests: [
            {
              id: "self_mutalisk_count_at_7m",
              type: "unit_count_at",
              perspective: "self",
              unit: "Mutalisk",
              at_seconds: 420
            }
          ],
          assumptions: [],
          unsupported_or_approximate: []
        }
      }
    });
    assert.equal(result.isError, undefined);
    assert.equal((result.structuredContent as { result_schema: string }).result_schema, "query-executor-result-v1");
    const replayResults = (result.structuredContent as { replay_results: Array<{ replay_id: string; matched: boolean }> }).replay_results;
    assert.equal(replayResults.length, 1);
    assert.equal(replayResults[0]?.replay_id, "replay-1");
    assert.equal(replayResults[0]?.matched, true);
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP export_query_plan_zip packages matched replay HTML and metadata", async () => {
  await using fixture = await createFixtureRoot();
  await writeReplayFixture(fixture.root, "batch/game-one", {
    schema_version: "replay-analysis-manifest-v1",
    replay_id: "replay-1",
    source: {
      filename: "game-one.rep",
      path: "C:\\replays\\game-one.rep"
    },
    matchup: "ZvT",
    map: null,
    duration_seconds: 900,
    players: [
      { owner: 3, name: "pbjt", race: "zerg", zip_filename: "player_3.zip" },
      { owner: 5, name: "Scan", race: "terran", zip_filename: "player_5.zip" }
    ]
  }, {
    "player_3.zip": await buildPlayerZip({
      owner: 3,
      name: "pbjt",
      race: "zerg",
      buildOrder: "05:45 Mutalisk\n",
      economySamples: [{ frame: 7142, time_seconds: 299.964, minerals: 240, gas: 300, gathered_minerals: 2800, gathered_gas: 500, workers: 24 }],
      supplySamples: [{ frame: 7100, time_seconds: 298.2, current: 58, max: 66 }],
      unitCountSamples: [{ frame: 10000, time_seconds: 420, counts: { mutalisk: 9 } }],
      deathSamples: [{ frame: 7600, time_seconds: 319.2, death: { id: 1, owner: 3, unit_type: "zergling", category: "unit" } }]
    }),
    "player_5.zip": await buildPlayerZip({
      owner: 5,
      name: "Scan",
      race: "terran",
      buildOrder: "09:00 Science Vessel\n",
      economySamples: [{ frame: 100, time_seconds: 4.2, minerals: 50, gas: 0 }],
      supplySamples: [{ frame: 100, time_seconds: 4.2, current: 9, max: 18 }]
    })
  }, "<html><body>match report</body></html>");

  const databasePath = join(fixture.root, "corpus.sqlite");
  const { db } = await openDatabase(databasePath);
  ensureSchema(db);
  await ingestAnalysisRoot(db, fixture.root);
  await saveDatabase(db, databasePath);
  db.close();

  const server = createReplayCorpusMcpServer();
  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const zipPath = join(fixture.root, "result.zip");
    const result = await client.callTool({
      name: "export_query_plan_zip",
      arguments: {
        db_path: databasePath,
        html_root: fixture.root,
        out_path: zipPath,
        plan: {
          planner_schema: "query-planner-v1",
          query: {
            original_text: "Which pbjt ZvT games have early Mutalisks before enemy Science Vessels are out?",
            intent: "find_replays_matching_pattern"
          },
          replay_set: {
            matchup: "ZvT",
            player: "pbjt",
            race: "zerg"
          },
          constraints: [
            {
              id: "self_first_mutalisk_before_6m",
              type: "first_event_before",
              perspective: "self",
              item: "Mutalisk",
              before_seconds: 360
            }
          ],
          evidence_requests: [],
          assumptions: [],
          unsupported_or_approximate: []
        }
      }
    });
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, {
      out_path: resolve(zipPath),
      coarse_count: 1,
      matched_count: 1,
      html_files_added: 1,
      warning_count: 0,
      warnings: []
    });

    const zipEntries = await readZipEntries(zipPath);
    assert.ok(zipEntries.has("README.md"));
    assert.ok(zipEntries.has("query-plan.json"));
    assert.ok(zipEntries.has("query-result.json"));
    assert.ok(zipEntries.has("matched-replays.csv"));
    assert.ok([...zipEntries.keys()].some((name) => name.startsWith("replays/")));
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP execute_query_plan returns validation errors clearly", async () => {
  const server = createReplayCorpusMcpServer();
  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const result = await client.callTool({
      name: "execute_query_plan",
      arguments: {
        db_path: "./corpus.sqlite",
        plan: {
          planner_schema: "query-planner-v1",
          query: {
            original_text: "invalid",
            intent: "find_replays_matching_pattern"
          },
          replay_set: {},
          constraints: [],
          evidence_requests: [],
          assumptions: [],
          unsupported_or_approximate: [],
          extra: "invalid"
        }
      }
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /unrecognized key/i);
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP export_query_plan_zip accepts a stringified JSON plan", async () => {
  await using fixture = await createFixtureRoot();
  await writeReplayFixture(fixture.root, "batch/game-one", {
    schema_version: "replay-analysis-manifest-v1",
    replay_id: "replay-1",
    source: {
      filename: "game-one.rep",
      path: "C:\\replays\\game-one.rep"
    },
    matchup: "ZvT",
    map: null,
    duration_seconds: 900,
    players: [
      { owner: 3, name: "pbjt", race: "zerg", zip_filename: "player_3.zip" },
      { owner: 5, name: "Scan", race: "terran", zip_filename: "player_5.zip" }
    ]
  }, {
    "player_3.zip": await buildPlayerZip({
      owner: 3,
      name: "pbjt",
      race: "zerg",
      buildOrder: "05:45 Mutalisk\n",
      economySamples: [{ frame: 7142, time_seconds: 299.964, minerals: 240, gas: 300, gathered_minerals: 2800, gathered_gas: 500, workers: 24 }],
      supplySamples: [{ frame: 7100, time_seconds: 298.2, current: 58, max: 66 }],
      unitCountSamples: [{ frame: 10000, time_seconds: 420, counts: { mutalisk: 9 } }],
      deathSamples: [{ frame: 7600, time_seconds: 319.2, death: { id: 1, owner: 3, unit_type: "zergling", category: "unit" } }]
    }),
    "player_5.zip": await buildPlayerZip({
      owner: 5,
      name: "Scan",
      race: "terran",
      buildOrder: "09:00 Science Vessel\n",
      economySamples: [{ frame: 100, time_seconds: 4.2, minerals: 50, gas: 0 }],
      supplySamples: [{ frame: 100, time_seconds: 4.2, current: 9, max: 18 }]
    })
  });
  await writeFile(join(fixture.root, "batch/game-one/game-one.html"), "<html><body>Replay</body></html>\n", "utf8");

  const databasePath = join(fixture.root, "corpus.sqlite");
  const { db } = await openDatabase(databasePath);
  ensureSchema(db);
  await ingestAnalysisRoot(db, fixture.root);
  await saveDatabase(db, databasePath);
  db.close();

  const server = createReplayCorpusMcpServer();
  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const zipPath = join(fixture.root, "string-plan-result.zip");
    const result = await client.callTool({
      name: "export_query_plan_zip",
      arguments: {
        db_path: databasePath,
        html_root: fixture.root,
        out_path: zipPath,
        plan: JSON.stringify({
          planner_schema: "query-planner-v1",
          query: {
            original_text: "Which pbjt ZvT games have early Mutalisks before enemy Science Vessels are out?",
            intent: "find_replays_matching_pattern"
          },
          replay_set: {
            matchup: "ZvT",
            player: "pbjt",
            race: "zerg"
          },
          constraints: [],
          evidence_requests: [
            {
              id: "self_first_mutalisk",
              type: "first_event",
              perspective: "self",
              item: "Mutalisk"
            }
          ],
          assumptions: [],
          unsupported_or_approximate: []
        })
      }
    });

    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, {
      out_path: resolve(zipPath),
      coarse_count: 1,
      matched_count: 1,
      html_files_added: 1,
      warning_count: 0,
      warnings: []
    });
    const zipEntries = await readZipEntries(zipPath);
    assert.ok(zipEntries.has("query-result.json"));
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP export_query_plan_zip returns validation errors clearly", async () => {
  const server = createReplayCorpusMcpServer();
  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const result = await client.callTool({
      name: "export_query_plan_zip",
      arguments: {
        db_path: "./corpus.sqlite",
        html_root: ".",
        out_path: "./result.zip",
        plan: {
          planner_schema: "query-planner-v1",
          query: {
            original_text: "invalid",
            intent: "find_replays_matching_pattern"
          },
          replay_set: {},
          constraints: [],
          evidence_requests: [],
          assumptions: [],
          unsupported_or_approximate: [],
          extra: "invalid"
        }
      }
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /unrecognized key/i);
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP ingest_corpus returns missing-root errors clearly", async () => {
  const server = createReplayCorpusMcpServer();
  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const result = await client.callTool({
      name: "ingest_corpus",
      arguments: {
        analysis_output_root: "C:\\missing\\analysis-root",
        db_path: "./corpus.sqlite"
      }
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /Analysis output root not found/i);
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP export_query_plan_zip reports missing HTML as a warning", async () => {
  await using fixture = await createFixtureRoot();
  await writeReplayFixture(fixture.root, "batch/game-one", {
    schema_version: "replay-analysis-manifest-v1",
    replay_id: "replay-1",
    source: {
      filename: "game-one.rep",
      path: "C:\\replays\\game-one.rep"
    },
    matchup: "ZvT",
    map: null,
    duration_seconds: 900,
    players: [
      { owner: 3, name: "pbjt", race: "zerg", zip_filename: "player_3.zip" },
      { owner: 5, name: "Scan", race: "terran", zip_filename: "player_5.zip" }
    ]
  }, {
    "player_3.zip": await buildPlayerZip({
      owner: 3,
      name: "pbjt",
      race: "zerg",
      buildOrder: "05:45 Mutalisk\n",
      economySamples: [{ frame: 7142, time_seconds: 299.964, minerals: 240, gas: 300, gathered_minerals: 2800, gathered_gas: 500, workers: 24 }],
      supplySamples: [{ frame: 7100, time_seconds: 298.2, current: 58, max: 66 }],
      unitCountSamples: [{ frame: 10000, time_seconds: 420, counts: { mutalisk: 9 } }],
      deathSamples: [{ frame: 7600, time_seconds: 319.2, death: { id: 1, owner: 3, unit_type: "zergling", category: "unit" } }]
    }),
    "player_5.zip": await buildPlayerZip({
      owner: 5,
      name: "Scan",
      race: "terran",
      buildOrder: "09:00 Science Vessel\n",
      economySamples: [{ frame: 100, time_seconds: 4.2, minerals: 50, gas: 0 }],
      supplySamples: [{ frame: 100, time_seconds: 4.2, current: 9, max: 18 }]
    })
  });

  const databasePath = join(fixture.root, "corpus.sqlite");
  const { db } = await openDatabase(databasePath);
  ensureSchema(db);
  await ingestAnalysisRoot(db, fixture.root);
  await saveDatabase(db, databasePath);
  db.close();

  const server = createReplayCorpusMcpServer();
  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const zipPath = join(fixture.root, "result.zip");
    const result = await client.callTool({
      name: "export_query_plan_zip",
      arguments: {
        db_path: databasePath,
        html_root: fixture.root,
        out_path: zipPath,
        plan: {
          planner_schema: "query-planner-v1",
          query: {
            original_text: "Which pbjt ZvT games have early Mutalisks before enemy Science Vessels are out?",
            intent: "find_replays_matching_pattern"
          },
          replay_set: {
            matchup: "ZvT",
            player: "pbjt",
            race: "zerg"
          },
          constraints: [
            {
              id: "self_first_mutalisk_before_6m",
              type: "first_event_before",
              perspective: "self",
              item: "Mutalisk",
              before_seconds: 360
            }
          ],
          evidence_requests: [],
          assumptions: [],
          unsupported_or_approximate: []
        }
      }
    });
    assert.equal(result.isError, undefined);
    assert.equal((result.structuredContent as { html_files_added: number }).html_files_added, 0);
    assert.equal((result.structuredContent as { warning_count: number }).warning_count, 1);
    assert.equal((result.structuredContent as { warnings: Array<{ kind: string }> }).warnings[0]?.kind, "missing_html");
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP server rejects invalid death windows through tool input validation", async () => {
  const server = createReplayCorpusMcpServer();
  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const result = await client.callTool({
      name: "get_deaths",
      arguments: {
        db_path: "C:\\missing\\corpus.sqlite",
        player: "pbjt",
        from_seconds: 480,
        to_seconds: 300
      }
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /from_seconds/i);
  } finally {
    await client.close();
    await server.close();
  }
});

class FixtureRoot implements AsyncDisposable {
  constructor(readonly root: string) {}

  async [Symbol.asyncDispose](): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }
}

async function createFixtureRoot(): Promise<FixtureRoot> {
  const root = await mkdtemp(join(tmpdir(), "replay-corpus-mcp-"));
  return new FixtureRoot(root);
}

async function writeReplayFixture(
  root: string,
  relativeReplayDir: string,
  manifest: Record<string, unknown>,
  zipFiles: Record<string, Buffer>,
  htmlContents?: string
): Promise<void> {
  const replayDir = resolve(root, relativeReplayDir);
  await mkdir(replayDir, { recursive: true });
  await writeFile(join(replayDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  for (const [fileName, contents] of Object.entries(zipFiles)) {
    await writeFile(join(replayDir, fileName), contents);
  }
  if (htmlContents !== undefined) {
    await writeFile(join(replayDir, "game-one.html"), htmlContents, "utf8");
  }
}

async function buildPlayerZip(input: {
  owner: number;
  name: string;
  race: string;
  buildOrder: string;
  economySamples: Array<Record<string, unknown>>;
  supplySamples: Array<Record<string, unknown>>;
  unitCountSamples?: Array<Record<string, unknown>>;
  deathSamples?: Array<Record<string, unknown>>;
}): Promise<Buffer> {
  const zip = new ZipFile();

  zip.addBuffer(
    Buffer.from(
      JSON.stringify(
        {
          schema_version: "replay-analysis-player-bundle-v1",
          owner: input.owner,
          name: input.name,
          race: input.race,
          files: {
            build_order: "build_order.txt",
            economy: "economy.json",
            supply: "supply.json",
            unit_counts: "unit_counts.json",
            deaths: "deaths.json"
          }
        },
        null,
        2
      ) + "\n"
    ),
    "player.json"
  );
  zip.addBuffer(Buffer.from(input.buildOrder, "utf8"), "build_order.txt");
  zip.addBuffer(
    Buffer.from(
      JSON.stringify(
        {
          schema_version: "replay-analysis-economy-v1",
          owner: input.owner,
          race: input.race,
          samples: input.economySamples
        },
        null,
        2
      ) + "\n"
    ),
    "economy.json"
  );
  zip.addBuffer(
    Buffer.from(
      JSON.stringify(
        {
          schema_version: "replay-analysis-supply-v1",
          owner: input.owner,
          race: input.race,
          samples: input.supplySamples
        },
        null,
        2
      ) + "\n"
    ),
    "supply.json"
  );

  if (input.unitCountSamples) {
    zip.addBuffer(
      Buffer.from(
        JSON.stringify(
          {
            schema_version: "replay-analysis-unit-counts-v1",
            owner: input.owner,
            race: input.race,
            samples: input.unitCountSamples
          },
          null,
          2
        ) + "\n"
      ),
      "unit_counts.json"
    );
  }

  if (input.deathSamples) {
    zip.addBuffer(
      Buffer.from(
        JSON.stringify(
          {
            schema_version: "replay-analysis-deaths-v1",
            owner: input.owner,
            race: input.race,
            samples: input.deathSamples
          },
          null,
          2
        ) + "\n"
      ),
      "deaths.json"
    );
  }

  return await zipToBuffer(zip);
}

function zipToBuffer(zip: ZipFile): Promise<Buffer> {
  return new Promise<Buffer>((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on("error", reject);
    zip.outputStream.on("end", () => resolvePromise(Buffer.concat(chunks)));
    zip.end();
  });
}

async function readZipEntries(zipPath: string): Promise<Map<string, string>> {
  const buffer = await readFile(zipPath);
  const entries = new Map<string, string>();
  const zip = await new Promise<yauzl.ZipFile>((resolvePromise, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, handle) => {
      if (error || !handle) {
        reject(error ?? new Error("Failed to open zip"));
        return;
      }
      resolvePromise(handle);
    });
  });

  await new Promise<void>((resolvePromise, reject) => {
    zip.readEntry();
    zip.on("entry", (entry: yauzl.Entry) => {
      if (/\/$/.test(entry.fileName)) {
        zip.readEntry();
        return;
      }
      zip.openReadStream(entry, (error, stream) => {
        if (error || !stream) {
          reject(error ?? new Error(`Failed to open entry ${entry.fileName}`));
          return;
        }
        const chunks: Buffer[] = [];
        stream.on("data", (chunk: Buffer) => chunks.push(chunk));
        stream.on("error", reject);
        stream.on("end", () => {
          entries.set(entry.fileName, Buffer.concat(chunks).toString("utf8"));
          zip.readEntry();
        });
      });
    });
    zip.on("end", () => resolvePromise());
    zip.on("error", reject);
  });

  return entries;
}

function parseJsonResource(result: Awaited<ReturnType<Client["readResource"]>>): unknown {
  const textContent = result.contents.find(
    (content): content is Extract<(typeof result.contents)[number], { text: string }> => "text" in content
  );
  assert.ok(textContent, "expected text resource content");
  return JSON.parse(textContent.text);
}

function getToolText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const textContent = result.content.find(
    (content): content is Extract<(typeof result.content)[number], { type: "text"; text: string }> =>
      content.type === "text" && "text" in content
  );
  assert.ok(textContent, "expected tool text content");
  return textContent.text;
}

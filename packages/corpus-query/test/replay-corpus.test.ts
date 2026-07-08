import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ZipFile } from "yazl";
import { ensureSchema } from "../src/db/schema.js";
import { openDatabase } from "../src/db/sqlite.js";
import { discoverManifestPaths } from "../src/ingest/discovery.js";
import { ingestAnalysisRoot } from "../src/ingest/ingest.js";
import { parseBuildOrderLine } from "../src/domain/normalization.js";
import { findFirstEvent, findMutaVesselCandidates, findNthEvent, findReplays, getUnitCountAtOrBefore, listBuildEvents } from "../src/query/query.js";

void dirname(fileURLToPath(import.meta.url));

test("recursive manifest discovery finds nested manifests", async () => {
  await using fixture = await createFixtureRoot();
  await writeManifest(fixture.root, "alpha/manifest.json", manifestOne());
  await writeManifest(fixture.root, "alpha/nested/manifest.json", manifestTwo());

  const manifestPaths = await discoverManifestPaths(fixture.root);

  assert.equal(manifestPaths.length, 2);
  assert.deepEqual(
    manifestPaths.map((path) => path.slice(fixture.root.length + 1).replaceAll("\\", "/")),
    ["alpha/manifest.json", "alpha/nested/manifest.json"]
  );
});

test("build_order.txt parsing extracts time, item, and optional supply", () => {
  assert.deepEqual(parseBuildOrderLine("06:00 [58/66] Mutalisk"), {
    timeSeconds: 360,
    supplyUsed: 58,
    supplyMax: 66,
    item: "Mutalisk",
    rawLine: "06:00 [58/66] Mutalisk"
  });
  assert.deepEqual(parseBuildOrderLine("11:30 Science Vessel"), {
    timeSeconds: 690,
    supplyUsed: null,
    supplyMax: null,
    item: "Science Vessel",
    rawLine: "11:30 Science Vessel"
  });
});

test("ingest reads only the manifest-referenced zip filename and ignores sibling zips", async () => {
  await using fixture = await createFixtureRoot();
  await writeReplayFixture(fixture.root, "batch/game-one", manifestOne(), {
    "player_3.zip": await buildPlayerZip({
      owner: 3,
      name: "pbjt",
      race: "zerg",
      buildOrder: "05:45 [58/66] Mutalisk\n06:00 [60/66] Mutalisk\n",
      economySamples: [
        { frame: 100, time_seconds: 4.2, minerals: 50, gas: 0, gathered_minerals: 0, gathered_gas: 0, workers: 4 },
        { frame: 200, time_seconds: 8.4, minerals: 125, gas: 50, gathered_minerals: 100, gathered_gas: 50, workers: 8 }
      ],
      supplySamples: [
        { frame: 100, time_seconds: 4.2, current: 9, max: 18 },
        { frame: 200, time_seconds: 8.4, current: 18, max: 26 }
      ],
      unitCountSamples: [
        { frame: 300, time_seconds: 12.6, counts: { zergling: 6, mutalisk: 0 } },
        { frame: 400, time_seconds: 16.8, counts: { zergling: 6, mutalisk: 3 } }
      ],
      deathSamples: [{ frame: 350, time_seconds: 14.7, death: { id: 1, owner: 3, unit_type: "zergling", category: "unit" } }]
    }),
    "player_5.zip": await buildPlayerZip({
      owner: 5,
      name: "Scan",
      race: "terran",
      buildOrder: "10:40 Starport\n11:20 Science Vessel\n",
      economySamples: [{ frame: 100, time_seconds: 4.2, minerals: 50, gas: 0 }],
      supplySamples: [{ frame: 100, time_seconds: 4.2, current: 9, max: 18 }],
      unitCountSamples: [{ frame: 700, time_seconds: 29.4, counts: { science_vessel: 1 } }],
      deathSamples: [{ frame: 800, time_seconds: 33.6, death: { id: 2, owner: 5, unit_type: "marine", category: "unit" } }]
    }),
    "pbjt.zip": await buildPlayerZip({
      owner: 3,
      name: "pbjt",
      race: "zerg",
      buildOrder: "99:59 Fake Legacy Data\n",
      economySamples: [],
      supplySamples: []
    })
  });

  const databasePath = join(fixture.root, "corpus.sqlite");
  const { db } = await openDatabase(databasePath);
  ensureSchema(db);

  const result = await ingestAnalysisRoot(db, fixture.root);

  assert.deepEqual(result, {
    manifestsDiscovered: 1,
    replaysIngested: 1,
    playersInserted: 2,
    batchSize: 10,
    batches: [
      {
        batch_number: 1,
        manifest_count: 1,
        replay_ids: [manifestOne().replay_id],
        manifests_completed: 1,
        manifests_remaining: 0
      }
    ],
    warnings: [],
    errors: []
  });
  assert.equal(singleValue(db, "SELECT COUNT(*) FROM replays;"), 1);
  assert.equal(singleValue(db, "SELECT COUNT(*) FROM players;"), 2);
  assert.equal(singleValue(db, "SELECT COUNT(*) FROM economy_samples;"), 3);
  assert.equal(singleValue(db, "SELECT COUNT(*) FROM supply_samples;"), 3);
  assert.equal(singleValue(db, "SELECT COUNT(*) FROM unit_count_samples;"), 5);
  assert.equal(singleValue(db, "SELECT COUNT(*) FROM death_events;"), 2);
  assert.equal(
    singleValue(
      db,
      "SELECT MIN(time_seconds) FROM build_order_events WHERE replay_id = ? AND owner = ? AND item = ?;",
      [manifestOne().replay_id, 3, "Mutalisk"]
    ),
    345
  );
  assert.equal(
    singleValue(
      db,
      "SELECT COUNT(*) FROM build_order_events WHERE replay_id = ? AND owner = ? AND item = ?;",
      [manifestOne().replay_id, 3, "Fake Legacy Data"]
    ),
    0
  );
  db.close();
});

test("ingest groups replay ingestion into batches of 10 by default and emits progress updates", async () => {
  await using fixture = await createFixtureRoot();

  for (let index = 0; index < 21; index += 1) {
    const replayId = `replay-${index + 1}`;
    await writeReplayFixture(
      fixture.root,
      `batch/game-${String(index + 1).padStart(2, "0")}`,
      manifestForReplay(replayId, `game-${index + 1}.rep`),
      {
        "player_3.zip": await buildPlayerZip({
          owner: 3,
          name: "pbjt",
          race: "zerg",
          buildOrder: "05:45 Mutalisk\n",
          economySamples: [{ frame: 100, time_seconds: 4.2, minerals: 50, gas: 0 }],
          supplySamples: [{ frame: 100, time_seconds: 4.2, current: 9, max: 18 }]
        }),
        "player_5.zip": await buildPlayerZip({
          owner: 5,
          name: "Scan",
          race: "terran",
          buildOrder: "11:20 Science Vessel\n",
          economySamples: [{ frame: 100, time_seconds: 4.2, minerals: 50, gas: 0 }],
          supplySamples: [{ frame: 100, time_seconds: 4.2, current: 9, max: 18 }]
        })
      }
    );
  }

  const databasePath = join(fixture.root, "corpus.sqlite");
  const { db } = await openDatabase(databasePath);
  ensureSchema(db);

  const updates: Array<{
    batch_number: number;
    manifests_completed: number;
    manifests_remaining: number;
    manifest_count: number;
  }> = [];

  const result = await ingestAnalysisRoot(db, fixture.root, {
    onBatchComplete: (update) => {
      updates.push({
        batch_number: update.batch_number,
        manifests_completed: update.manifests_completed,
        manifests_remaining: update.manifests_remaining,
        manifest_count: update.manifest_count
      });
    }
  });

  assert.equal(result.manifestsDiscovered, 21);
  assert.equal(result.replaysIngested, 21);
  assert.equal(result.playersInserted, 42);
  assert.equal(result.batchSize, 10);
  assert.equal(result.batches.length, 3);
  assert.deepEqual(
    result.batches.map((batch) => batch.manifest_count),
    [10, 10, 1]
  );
  assert.deepEqual(updates, [
    { batch_number: 1, manifests_completed: 10, manifests_remaining: 11, manifest_count: 10 },
    { batch_number: 2, manifests_completed: 20, manifests_remaining: 1, manifest_count: 10 },
    { batch_number: 3, manifests_completed: 21, manifests_remaining: 0, manifest_count: 1 }
  ]);
  assert.equal(singleValue(db, "SELECT COUNT(*) FROM replays;"), 21);
  db.close();
});

test("ingest accepts manifest-referenced legacy zip filenames", async () => {
  await using fixture = await createFixtureRoot();
  const manifest = {
    schema_version: "replay-analysis-manifest-v1",
    replay_id: "legacy-replay",
    source: {
      filename: "legacy-game.rep",
      path: "C:\\replays\\legacy-game.rep"
    },
    matchup: "ZvT",
    map: null,
    duration_seconds: 500,
    players: [
      { owner: 3, name: "pbjt", race: "zerg", zip_filename: "pbjt.zip" },
      { owner: 5, name: "Scan", race: "terran", zip_filename: "Scan.zip" }
    ]
  };
  await writeReplayFixture(fixture.root, "batch/legacy-game", manifest, {
    "pbjt.zip": await buildPlayerZip({
      owner: 3,
      name: "pbjt",
      race: "zerg",
      buildOrder: "05:45 Mutalisk\n",
      economySamples: [{ frame: 100, time_seconds: 4.2, minerals: 50, gas: 0 }],
      supplySamples: [{ frame: 100, time_seconds: 4.2, current: 9, max: 18 }]
    }),
    "Scan.zip": await buildPlayerZip({
      owner: 5,
      name: "Scan",
      race: "terran",
      buildOrder: "11:20 Science Vessel\n",
      economySamples: [{ frame: 100, time_seconds: 4.2, minerals: 50, gas: 0 }],
      supplySamples: [{ frame: 100, time_seconds: 4.2, current: 9, max: 18 }]
    }),
    "player_3.zip": await buildPlayerZip({
      owner: 3,
      name: "pbjt",
      race: "zerg",
      buildOrder: "99:59 WrongSibling\n",
      economySamples: [],
      supplySamples: []
    })
  });

  const databasePath = join(fixture.root, "corpus.sqlite");
  const { db } = await openDatabase(databasePath);
  ensureSchema(db);

  await ingestAnalysisRoot(db, fixture.root);

  assert.equal(singleValue(db, "SELECT COUNT(*) FROM replays;"), 1);
  assert.equal(singleValue(db, "SELECT COUNT(*) FROM players;"), 2);
  assert.equal(
    singleValue(
      db,
      "SELECT COUNT(*) FROM build_order_events WHERE replay_id = ? AND owner = ? AND item = ?;",
      ["legacy-replay", 3, "WrongSibling"]
    ),
    0
  );
  db.close();
});

test("replay-idempotent replacement deletes old rows before reinserting", async () => {
  await using fixture = await createFixtureRoot();
  const replayDir = "batch/game-one";
  await writeReplayFixture(fixture.root, replayDir, manifestOne(), {
    "player_3.zip": await buildPlayerZip({
      owner: 3,
      name: "pbjt",
      race: "zerg",
      buildOrder: "05:45 Mutalisk\n",
      economySamples: [{ frame: 100, time_seconds: 4.2, minerals: 50, gas: 0 }],
      supplySamples: [{ frame: 100, time_seconds: 4.2, current: 9, max: 18 }]
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

  await writeReplayFixture(fixture.root, replayDir, manifestOne(), {
    "player_3.zip": await buildPlayerZip({
      owner: 3,
      name: "pbjt",
      race: "zerg",
      buildOrder: "05:30 Mutalisk\n06:10 Scourge\n",
      economySamples: [{ frame: 120, time_seconds: 5.04, minerals: 80, gas: 25 }],
      supplySamples: [{ frame: 120, time_seconds: 5.04, current: 11, max: 18 }]
    }),
    "player_5.zip": await buildPlayerZip({
      owner: 5,
      name: "Scan",
      race: "terran",
      buildOrder: "11:10 Science Vessel\n",
      economySamples: [{ frame: 120, time_seconds: 5.04, minerals: 80, gas: 25 }],
      supplySamples: [{ frame: 120, time_seconds: 5.04, current: 11, max: 18 }]
    })
  });

  await ingestAnalysisRoot(db, fixture.root);

  assert.equal(singleValue(db, "SELECT COUNT(*) FROM build_order_events WHERE replay_id = ?;", [manifestOne().replay_id]), 3);
  assert.equal(singleValue(db, "SELECT COUNT(*) FROM economy_samples WHERE replay_id = ?;", [manifestOne().replay_id]), 2);
  assert.equal(
    singleValue(
      db,
      "SELECT MIN(time_seconds) FROM build_order_events WHERE replay_id = ? AND owner = ? AND item = ?;",
      [manifestOne().replay_id, 3, "Mutalisk"]
    ),
    330
  );
  db.close();
});

test("first-event query returns earliest matching self and enemy events", async () => {
  await using fixture = await createFixtureRoot();
  await writeReplayFixture(fixture.root, "batch/game-one", manifestOne(), {
    "player_3.zip": await buildPlayerZip({
      owner: 3,
      name: "pbjt",
      race: "zerg",
      buildOrder: "05:45 Mutalisk\n06:00 Mutalisk\n",
      economySamples: [{ frame: 100, time_seconds: 4.2, minerals: 50, gas: 0 }],
      supplySamples: [{ frame: 100, time_seconds: 4.2, current: 9, max: 18 }]
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

  const selfEvents = findFirstEvent(db, { player: "PBJT", item: "Mutalisk" });
  const enemyEvents = findFirstEvent(db, { player: "pbjt", item: "Science Vessel", as: "enemy" });

  assert.equal(selfEvents.length, 1);
  assert.equal(selfEvents[0]?.source_replay_filename, "game-one.rep");
  assert.equal(selfEvents[0]?.event?.time_seconds, 345);
  assert.equal(enemyEvents.length, 1);
  assert.equal(enemyEvents[0]?.source_replay_filename, "game-one.rep");
  assert.equal(enemyEvents[0]?.target_owner, 5);
  assert.equal(enemyEvents[0]?.event?.time_seconds, 680);

  const filteredSelfEvents = findFirstEvent(db, { player: "pbjt", race: "zerg", matchup: "ZvT", item: "Mutalisk" });
  const filteredOutSelfEvents = findFirstEvent(db, { player: "pbjt", race: "terran", matchup: "ZvT", item: "Mutalisk" });
  assert.equal(filteredSelfEvents.length, 1);
  assert.equal(filteredOutSelfEvents.length, 0);
  db.close();
});

test("unit count query uses replay_id plus owner and returns latest sample at or before timestamp", async () => {
  await using fixture = await createFixtureRoot();
  await writeReplayFixture(fixture.root, "batch/game-one", manifestOne(), {
    "player_3.zip": await buildPlayerZip({
      owner: 3,
      name: "pbjt",
      race: "zerg",
      buildOrder: "05:45 Mutalisk\n",
      economySamples: [{ frame: 100, time_seconds: 4.2, minerals: 50, gas: 0 }],
      supplySamples: [{ frame: 100, time_seconds: 4.2, current: 9, max: 18 }],
      unitCountSamples: [
        { frame: 300, time_seconds: 12.6, counts: { mutalisk: 0 } },
        { frame: 400, time_seconds: 16.8, counts: { mutalisk: 3 } }
      ]
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
  await writeReplayFixture(fixture.root, "batch/game-two", manifestTwo(), {
    "player_3.zip": await buildPlayerZip({
      owner: 3,
      name: "OtherPlayer",
      race: "zerg",
      buildOrder: "04:00 Hydralisk\n",
      economySamples: [{ frame: 100, time_seconds: 4.2, minerals: 50, gas: 0 }],
      supplySamples: [{ frame: 100, time_seconds: 4.2, current: 9, max: 18 }],
      unitCountSamples: [{ frame: 300, time_seconds: 12.6, counts: { mutalisk: 99 } }]
    }),
    "player_8.zip": await buildPlayerZip({
      owner: 8,
      name: "TerranTwo",
      race: "terran",
      buildOrder: "11:00 Science Vessel\n",
      economySamples: [{ frame: 100, time_seconds: 4.2, minerals: 50, gas: 0 }],
      supplySamples: [{ frame: 100, time_seconds: 4.2, current: 9, max: 18 }]
    })
  });

  const databasePath = join(fixture.root, "corpus.sqlite");
  const { db } = await openDatabase(databasePath);
  ensureSchema(db);
  await ingestAnalysisRoot(db, fixture.root);

  const result = getUnitCountAtOrBefore(db, { player: "pbjt", unit: "Mutalisk", at: 17 });

  assert.equal(result.length, 1);
  assert.equal(result[0]?.replay_id, manifestOne().replay_id);
  assert.equal(result[0]?.source_replay_filename, "game-one.rep");
  assert.equal(result[0]?.sample?.count, 3);
  assert.equal(result[0]?.sample?.time_seconds, 16.8);

  const filteredByMatchup = getUnitCountAtOrBefore(db, { player: "pbjt", unit: "Mutalisk", at: 17, matchup: "ZvT", race: "zerg" });
  const filteredOutByRace = getUnitCountAtOrBefore(db, { player: "pbjt", unit: "Mutalisk", at: 17, matchup: "ZvT", race: "terran" });
  assert.equal(filteredByMatchup.length, 1);
  assert.equal(filteredOutByRace.length, 0);
  db.close();
});

test("ordered build-event queries support list and nth-event lookups", async () => {
  await using fixture = await createFixtureRoot();
  await writeReplayFixture(fixture.root, "batch/game-one", manifestOne(), {
    "player_3.zip": await buildPlayerZip({
      owner: 3,
      name: "pbjt",
      race: "zerg",
      buildOrder: "03:20 Hatchery\n03:55 Spire\n06:20 Hatchery\n07:45 Hydralisk Den\n",
      economySamples: [{ frame: 100, time_seconds: 4.2, minerals: 50, gas: 0 }],
      supplySamples: [{ frame: 100, time_seconds: 4.2, current: 9, max: 18 }]
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

  const hatcheryEvents = listBuildEvents(db, { player: "pbjt", item: "Hatchery" });
  const secondHatchery = findNthEvent(db, { player: "pbjt", item: "Hatchery", n: 2 });

  assert.equal(hatcheryEvents.length, 2);
  assert.equal(hatcheryEvents[0]?.event.time_seconds, 200);
  assert.equal(hatcheryEvents[1]?.event.time_seconds, 380);
  assert.equal(secondHatchery.length, 1);
  assert.equal(secondHatchery[0]?.n, 2);
  assert.equal(secondHatchery[0]?.event?.time_seconds, 380);
  db.close();
});

test("replay_id filters scope replay and perspective queries to a matched subset", async () => {
  await using fixture = await createFixtureRoot();
  await writeReplayFixture(fixture.root, "batch/game-one", manifestOne(), {
    "player_3.zip": await buildPlayerZip({
      owner: 3,
      name: "pbjt",
      race: "zerg",
      buildOrder: "05:45 Mutalisk\n",
      economySamples: [{ frame: 7142, time_seconds: 299.964, minerals: 240, gas: 300, gathered_minerals: 2800, gathered_gas: 500, workers: 24 }],
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
  await writeReplayFixture(fixture.root, "batch/game-two", {
    ...manifestTwo(),
    players: [
      { owner: 3, name: "pbjt", race: "zerg", zip_filename: "player_3.zip" },
      { owner: 8, name: "TerranTwo", race: "terran", zip_filename: "player_8.zip" }
    ]
  }, {
    "player_3.zip": await buildPlayerZip({
      owner: 3,
      name: "pbjt",
      race: "zerg",
      buildOrder: "06:05 Mutalisk\n",
      economySamples: [{ frame: 7142, time_seconds: 299.964, minerals: 200, gas: 250, gathered_minerals: 2600, gathered_gas: 450, workers: 22 }],
      supplySamples: [{ frame: 7100, time_seconds: 298.2, current: 54, max: 66 }]
    }),
    "player_8.zip": await buildPlayerZip({
      owner: 8,
      name: "TerranTwo",
      race: "terran",
      buildOrder: "11:00 Science Vessel\n",
      economySamples: [{ frame: 100, time_seconds: 4.2, minerals: 50, gas: 0 }],
      supplySamples: [{ frame: 100, time_seconds: 4.2, current: 9, max: 18 }]
    })
  });

  const databasePath = join(fixture.root, "corpus.sqlite");
  const { db } = await openDatabase(databasePath);
  ensureSchema(db);
  await ingestAnalysisRoot(db, fixture.root);

  const replaySubset = findFirstEvent(db, {
    player: "pbjt",
    item: "Mutalisk",
    replay_ids: ["replay-2"]
  });
  const replayRows = findReplays(db, { replay_ids: ["replay-2"] });

  assert.equal(replaySubset.length, 1);
  assert.equal(replaySubset[0]?.replay_id, "replay-2");
  assert.equal(replaySubset[0]?.event?.time_seconds, 365);
  assert.equal(replayRows.length, 1);
  assert.equal(replayRows[0]?.replay_id, "replay-2");
  db.close();
});

test("muta-vessel candidate query composes deterministic evidence by replay", async () => {
  await using fixture = await createFixtureRoot();
  await writeReplayFixture(fixture.root, "batch/qualifies", manifestOne(), {
    "player_3.zip": await buildPlayerZip({
      owner: 3,
      name: "pbjt",
      race: "zerg",
      buildOrder: "05:45 [58/66] Mutalisk\n06:10 Scourge\n",
      economySamples: [
        { frame: 7100, time_seconds: 298.2, minerals: 240, gas: 300, gathered_minerals: 2800, gathered_gas: 500, workers: 24 },
        { frame: 7200, time_seconds: 302.4, minerals: 260, gas: 320, gathered_minerals: 2860, gathered_gas: 520, workers: 24 }
      ],
      supplySamples: [{ frame: 7100, time_seconds: 298.2, current: 58, max: 66 }],
      unitCountSamples: [
        { frame: 10000, time_seconds: 420, counts: { mutalisk: 9 } },
        { frame: 10200, time_seconds: 428.4, counts: { mutalisk: 11 } }
      ],
      deathSamples: [
        { frame: 7600, time_seconds: 319.2, death: { id: 1, owner: 3, unit_type: "zergling", category: "unit" } },
        { frame: 9000, time_seconds: 378, death: { id: 2, owner: 3, unit_type: "mutalisk", category: "unit" } }
      ]
    }),
    "player_5.zip": await buildPlayerZip({
      owner: 5,
      name: "Scan",
      race: "terran",
      buildOrder: "11:20 Science Vessel\n",
      economySamples: [{ frame: 100, time_seconds: 4.2, minerals: 50, gas: 0 }],
      supplySamples: [{ frame: 100, time_seconds: 4.2, current: 9, max: 18 }],
      deathSamples: [{ frame: 8500, time_seconds: 357, death: { id: 3, owner: 5, unit_type: "marine", category: "unit" } }]
    })
  });
  await writeReplayFixture(fixture.root, "batch/late-muta", {
    ...manifestOne(),
    replay_id: "replay-late-muta",
    source: { filename: "late-muta.rep", path: "C:\\replays\\late-muta.rep" }
  }, {
    "player_3.zip": await buildPlayerZip({
      owner: 3,
      name: "pbjt",
      race: "zerg",
      buildOrder: "06:05 Mutalisk\n",
      economySamples: [{ frame: 7200, time_seconds: 302.4, minerals: 200, gas: 250, workers: 22 }],
      supplySamples: [{ frame: 7200, time_seconds: 302.4, current: 54, max: 66 }]
    }),
    "player_5.zip": await buildPlayerZip({
      owner: 5,
      name: "Scan",
      race: "terran",
      buildOrder: "11:00 Science Vessel\n",
      economySamples: [{ frame: 100, time_seconds: 4.2, minerals: 50, gas: 0 }],
      supplySamples: [{ frame: 100, time_seconds: 4.2, current: 9, max: 18 }]
    })
  });
  await writeReplayFixture(fixture.root, "batch/wrong-matchup", {
    ...manifestOne(),
    replay_id: "replay-tvz",
    matchup: "TvZ",
    source: { filename: "wrong-matchup.rep", path: "C:\\replays\\wrong-matchup.rep" }
  }, {
    "player_3.zip": await buildPlayerZip({
      owner: 3,
      name: "pbjt",
      race: "zerg",
      buildOrder: "05:30 Mutalisk\n",
      economySamples: [{ frame: 7200, time_seconds: 302.4, minerals: 210, gas: 260, workers: 22 }],
      supplySamples: [{ frame: 7200, time_seconds: 302.4, current: 54, max: 66 }]
    }),
    "player_5.zip": await buildPlayerZip({
      owner: 5,
      name: "Scan",
      race: "terran",
      buildOrder: "11:00 Science Vessel\n",
      economySamples: [{ frame: 100, time_seconds: 4.2, minerals: 50, gas: 0 }],
      supplySamples: [{ frame: 100, time_seconds: 4.2, current: 9, max: 18 }]
    })
  });

  const databasePath = join(fixture.root, "corpus.sqlite");
  const { db } = await openDatabase(databasePath);
  ensureSchema(db);
  await ingestAnalysisRoot(db, fixture.root);

  const candidates = findMutaVesselCandidates(db, {
    player: "pbjt",
    matchup: "ZvT",
    race: "zerg",
    mutaBefore: 360,
    vesselBefore: 690,
    mutaCountAt: 420,
    economyAt: 300,
    deathsFrom: 300,
    deathsTo: 480
  });

  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0], {
    replay_id: "replay-1",
    source_replay_filename: "game-one.rep",
    source_replay_path: "C:\\replays\\game-one.rep",
    matchup: "ZvT",
    player_name: "pbjt",
    player_owner: 3,
    enemy_name: "Scan",
    enemy_owner: 5,
    first_mutalisk: {
      time_seconds: 345,
      supply_used: 58,
      supply_max: 66,
      item: "Mutalisk",
      raw_line: "05:45 [58/66] Mutalisk"
    },
    first_enemy_science_vessel: {
      time_seconds: 680,
      supply_used: null,
      supply_max: null,
      item: "Science Vessel",
      raw_line: "11:20 Science Vessel"
    },
    mutalisk_count_at: {
      time_seconds: 420,
      unit_type: "mutalisk",
      count: 9
    },
    economy_at: {
      time_seconds: 298.2,
      minerals: 240,
      gas: 300,
      gathered_minerals: 2800,
      gathered_gas: 500,
      workers: 24
    },
    self_deaths_between: [
      {
        frame: 7600,
        time_seconds: 319.2,
        dead_owner: 3,
        unit_type: "zergling",
        category: "unit"
      },
      {
        frame: 9000,
        time_seconds: 378,
        dead_owner: 3,
        unit_type: "mutalisk",
        category: "unit"
      }
    ],
    self_deaths_summary: {
      total_deaths: 2,
      deaths_by_unit_type: {
        zergling: 1,
        mutalisk: 1
      },
      deaths_by_category: {
        unit: 2
      }
    },
    enemy_deaths_between: [
      {
        frame: 8500,
        time_seconds: 357,
        dead_owner: 5,
        unit_type: "marine",
        category: "unit"
      }
    ],
    enemy_deaths_summary: {
      total_deaths: 1,
      deaths_by_unit_type: {
        marine: 1
      },
      deaths_by_category: {
        unit: 1
      }
    },
    deaths_between: [
      {
        frame: 7600,
        time_seconds: 319.2,
        dead_owner: 3,
        unit_type: "zergling",
        category: "unit"
      },
      {
        frame: 9000,
        time_seconds: 378,
        dead_owner: 3,
        unit_type: "mutalisk",
        category: "unit"
      }
    ],
    deaths_summary: {
      total_deaths: 2,
      deaths_by_unit_type: {
        zergling: 1,
        mutalisk: 1
      },
      deaths_by_category: {
        unit: 2
      }
    }
  });
  db.close();
});

class FixtureRoot implements AsyncDisposable {
  constructor(readonly root: string) {}

  async [Symbol.asyncDispose](): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }
}

async function createFixtureRoot(): Promise<FixtureRoot> {
  const root = await mkdtemp(join(tmpdir(), "replay-corpus-query-"));
  return new FixtureRoot(root);
}

async function writeReplayFixture(
  root: string,
  relativeReplayDir: string,
  manifest: Record<string, unknown>,
  zipFiles: Record<string, Buffer>
): Promise<void> {
  const replayDir = resolve(root, relativeReplayDir);
  await mkdir(replayDir, { recursive: true });
  await writeFile(join(replayDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  for (const [fileName, contents] of Object.entries(zipFiles)) {
    await writeFile(join(replayDir, fileName), contents);
  }
}

async function writeManifest(root: string, relativePath: string, manifest: Record<string, unknown>): Promise<void> {
  const fullPath = resolve(root, relativePath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, JSON.stringify(manifest, null, 2));
}

function manifestOne(): Record<string, unknown> {
  return {
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
  };
}

function manifestTwo(): Record<string, unknown> {
  return {
    schema_version: "replay-analysis-manifest-v1",
    replay_id: "replay-2",
    source: {
      filename: "game-two.rep",
      path: "C:\\replays\\game-two.rep"
    },
    matchup: "ZvT",
    map: null,
    duration_seconds: 1000,
    players: [
      { owner: 3, name: "OtherPlayer", race: "zerg", zip_filename: "player_3.zip" },
      { owner: 8, name: "TerranTwo", race: "terran", zip_filename: "player_8.zip" }
    ]
  };
}

function manifestForReplay(replayId: string, filename: string): Record<string, unknown> {
  return {
    schema_version: "replay-analysis-manifest-v1",
    replay_id: replayId,
    source: {
      filename,
      path: `C:\\replays\\${filename}`
    },
    matchup: "ZvT",
    map: null,
    duration_seconds: 900,
    players: [
      { owner: 3, name: "pbjt", race: "zerg", zip_filename: "player_3.zip" },
      { owner: 5, name: "Scan", race: "terran", zip_filename: "player_5.zip" }
    ]
  };
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

function singleValue(db: Awaited<ReturnType<typeof openDatabase>>["db"], sql: string, params: unknown[] = []): number {
  const statement = db.prepare(sql);
  try {
    statement.bind(params);
    assert.equal(statement.step(), true);
    const row = statement.getAsObject();
    const firstKey = Object.keys(row)[0];
    return Number(row[firstKey ?? ""]);
  } finally {
    statement.free();
  }
}

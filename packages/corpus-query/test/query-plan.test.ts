import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ZipFile } from "yazl";
import { ensureSchema } from "../src/db/schema.js";
import { openDatabase, saveDatabase } from "../src/db/sqlite.js";
import { ingestAnalysisRoot } from "../src/ingest/ingest.js";
import { executeQueryPlan, validateQueryPlan, type QueryPlanV1 } from "../src/query-plan/executor.js";

void dirname(fileURLToPath(import.meta.url));

test("valid pbjt-style plan executes and gathers evidence for matched replays", async () => {
  await using fixture = await createFixtureRoot();
  const databasePath = await seedExecutorFixture(fixture.root);

  const result = await executeQueryPlan({
    dbPath: databasePath,
    plan: validPlan()
  });

  assert.equal(result.result_schema, "query-executor-result-v1");
  assert.deepEqual(result.coarse_replay_ids, ["replay-match", "replay-reject"]);
  assert.equal(result.replay_results.length, 1);
  assert.equal(result.replay_results[0]?.replay_id, "replay-match");
  assert.equal(result.replay_results[0]?.matched, true);
  assert.equal(result.replay_results[0]?.constraint_results.self_first_mutalisk_before_6m.passed, true);
  assert.equal(result.replay_results[0]?.constraint_results.enemy_first_science_vessel_before_11m30s.passed, true);
  assert.equal(result.replay_results[0]?.evidence.self_mutalisk_count_at_7m.value?.sample?.count, 9);
  assert.deepEqual(result.replay_results[0]?.evidence.self_deaths_5m_to_8m.value?.summaries, {
    total_count: 2,
    count_by_unit_type: { zergling: 1, mutalisk: 1 }
  });
});

test("event-before-event constraint and economy-at-event-time evidence work without direct replay-specific SQL from the caller", async () => {
  await using fixture = await createFixtureRoot();
  const databasePath = await seedExecutorFixture(fixture.root);

  const result = await executeQueryPlan({
    dbPath: databasePath,
    plan: {
      planner_schema: "query-planner-v1",
      query: {
        original_text: "Find pbjt ZvT games where Spire is before the third Hatchery and return workers at Spire time.",
        intent: "find_replays_matching_pattern"
      },
      replay_set: {
        matchup: "ZvT",
        player: "pbjt",
        race: "zerg"
      },
      constraints: [
        {
          id: "self_spire_before_second_hatchery_event",
          type: "event_before_event",
          perspective: "self",
          left_event: {
            type: "first_event",
            perspective: "self",
            item: "Spire"
          },
          right_event: {
            type: "nth_event",
            perspective: "self",
            item: "Hatchery",
            n: 2
          }
        }
      ],
      evidence_requests: [
        {
          id: "self_economy_at_first_spire",
          type: "economy_at_event_time",
          perspective: "self",
          event: {
            type: "first_event",
            perspective: "self",
            item: "Spire"
          }
        }
      ],
      assumptions: [],
      unsupported_or_approximate: []
    }
  });

  assert.deepEqual(result.replay_results.map((row) => row.replay_id), ["replay-match"]);
  assert.equal(
    result.replay_results[0]?.constraint_results.self_spire_before_second_hatchery_event.passed,
    true
  );
  assert.equal(
    result.replay_results[0]?.constraint_results.self_spire_before_second_hatchery_event.value?.left_event?.time_seconds,
    235
  );
  assert.equal(
    result.replay_results[0]?.constraint_results.self_spire_before_second_hatchery_event.value?.right_event?.time_seconds,
    380
  );
  assert.equal(result.replay_results[0]?.evidence.self_economy_at_first_spire.value?.event?.time_seconds, 235);
  assert.equal(result.replay_results[0]?.evidence.self_economy_at_first_spire.value?.sample?.workers, 18);
  assert.equal(result.replay_results[0]?.evidence.self_economy_at_first_spire.value?.sample?.time_seconds, 234.948);
});

test("query plan supports replay_ids-only coarse scoping", async () => {
  await using fixture = await createFixtureRoot();
  const databasePath = await seedExecutorFixture(fixture.root);

  const result = await executeQueryPlan({
    dbPath: databasePath,
    plan: {
      planner_schema: "query-planner-v1",
      query: {
        original_text: "Show replay subset.",
        intent: "gather_evidence_for_replays"
      },
      replay_set: {
        replay_ids: ["replay-reject"]
      },
      constraints: [],
      evidence_requests: [],
      assumptions: [],
      unsupported_or_approximate: []
    }
  });

  assert.deepEqual(result.coarse_replay_ids, ["replay-reject"]);
  assert.deepEqual(result.replay_results.map((row) => row.replay_id), ["replay-reject"]);
});

test("query plan supports replay_ids combined with player and replay-not-found yields no results", async () => {
  await using fixture = await createFixtureRoot();
  const databasePath = await seedExecutorFixture(fixture.root);

  const subsetResult = await executeQueryPlan({
    dbPath: databasePath,
    plan: {
      planner_schema: "query-planner-v1",
      query: {
        original_text: "Follow-up on matched subset.",
        intent: "gather_evidence_for_replays"
      },
      replay_set: {
        replay_ids: ["replay-match"],
        matchup: "ZvT",
        player: "pbjt",
        race: "zerg"
      },
      constraints: [],
      evidence_requests: [
        {
          id: "self_economy_at_5m",
          type: "economy_at",
          perspective: "self",
          at_seconds: 300
        }
      ],
      assumptions: [],
      unsupported_or_approximate: []
    }
  });

  assert.deepEqual(subsetResult.coarse_replay_ids, ["replay-match"]);
  assert.equal(subsetResult.replay_results.length, 1);
  assert.equal(subsetResult.replay_results[0]?.evidence.self_economy_at_5m.value?.sample?.workers, 24);

  const missingResult = await executeQueryPlan({
    dbPath: databasePath,
    plan: {
      planner_schema: "query-planner-v1",
      query: {
        original_text: "Missing replay id subset.",
        intent: "gather_evidence_for_replays"
      },
      replay_set: {
        replay_ids: ["does-not-exist"]
      },
      constraints: [],
      evidence_requests: [],
      assumptions: [],
      unsupported_or_approximate: []
    }
  });

  assert.deepEqual(missingResult.coarse_replay_ids, []);
  assert.deepEqual(missingResult.replay_results, []);
});

test("invalid unknown top-level field is rejected", async () => {
  await assert.rejects(
    () => executeQueryPlan({ dbPath: "./corpus.sqlite", plan: { ...validPlan(), extra: "invalid" } }),
    /unrecognized key/i
  );
});

test("duplicate IDs are rejected", () => {
  assert.throws(
    () =>
      validateQueryPlan({
        ...validPlan(),
        evidence_requests: [
          { id: "self_first_mutalisk_before_6m", type: "economy_at", perspective: "self", at_seconds: 300 }
        ]
      }),
    /Duplicate planner item id/
  );
});

test("missing perspective is rejected", () => {
  const plan = validPlan();
  const [firstConstraint, ...rest] = plan.constraints;
  assert.ok(firstConstraint);
  const { perspective: _discardedPerspective, ...withoutPerspective } = firstConstraint;
  assert.throws(
    () =>
      validateQueryPlan({
        ...plan,
        constraints: [withoutPerspective, ...rest]
      }),
    /perspective/i
  );
});

test("unsupported constraint type is rejected", () => {
  assert.throws(
    () =>
      validateQueryPlan({
        ...validPlan(),
        constraints: [
          {
            id: "won_muta_phase",
            type: "won_early_muta_phase",
            perspective: "self"
          }
        ]
      }),
    /type/i
  );
});

test("sample null fails constraints", async () => {
  await using fixture = await createFixtureRoot();
  const databasePath = await seedExecutorFixture(fixture.root);
  const plan = {
    ...validPlan(),
    constraints: [
      {
        id: "self_mutalisk_count_before_any_sample",
        type: "unit_count_at_least_at",
        perspective: "self",
        unit: "Mutalisk",
        at_seconds: 1,
        count_at_least: 1
      }
    ],
    evidence_requests: []
  };

  const result = await executeQueryPlan({ dbPath: databasePath, plan, mode: "debug" });
  assert.equal(result.replay_results.length, 2);
  assert.equal(result.replay_results[0]?.constraint_results.self_mutalisk_count_before_any_sample.passed, false);
  assert.equal(result.replay_results[0]?.constraint_results.self_mutalisk_count_before_any_sample.value?.sample, null);
});

test("null compared field fails constraints", async () => {
  await using fixture = await createFixtureRoot();
  const databasePath = await seedExecutorFixture(fixture.root);
  const plan = {
    ...validPlan(),
    constraints: [
      {
        id: "self_workers_at_least_24_at_5m",
        type: "economy_workers_at_least_at",
        perspective: "self",
        at_seconds: 300,
        workers_at_least: 24
      }
    ],
    evidence_requests: []
  };

  const result = await executeQueryPlan({ dbPath: databasePath, plan, mode: "debug" });
  const rejectedReplay = result.replay_results.find((row) => row.replay_id === "replay-reject");
  assert.equal(rejectedReplay?.constraint_results.self_workers_at_least_24_at_5m.passed, false);
  assert.equal(rejectedReplay?.constraint_results.self_workers_at_least_24_at_5m.value?.sample?.workers, null);
});

test("evidence is gathered only for matched replays in normal mode", async () => {
  await using fixture = await createFixtureRoot();
  const databasePath = await seedExecutorFixture(fixture.root);

  const result = await executeQueryPlan({
    dbPath: databasePath,
    plan: validPlan(),
    mode: "normal"
  });

  assert.deepEqual(result.replay_results.map((row) => row.replay_id), ["replay-match"]);
  assert.ok(result.replay_results[0]?.evidence.self_economy_at_5m);
});

test("debug mode includes rejected replay traces", async () => {
  await using fixture = await createFixtureRoot();
  const databasePath = await seedExecutorFixture(fixture.root);

  const result = await executeQueryPlan({
    dbPath: databasePath,
    plan: validPlan(),
    mode: "debug"
  });

  assert.deepEqual(result.replay_results.map((row) => row.replay_id), ["replay-match", "replay-reject"]);
  const rejectedReplay = result.replay_results.find((row) => row.replay_id === "replay-reject");
  assert.equal(rejectedReplay?.matched, false);
  assert.equal(rejectedReplay?.constraint_results.self_first_mutalisk_before_6m.passed, false);
  assert.deepEqual(rejectedReplay?.evidence, {});
});

class FixtureRoot implements AsyncDisposable {
  constructor(readonly root: string) {}

  async [Symbol.asyncDispose](): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }
}

async function createFixtureRoot(): Promise<FixtureRoot> {
  const root = await mkdtemp(join(tmpdir(), "replay-corpus-query-plan-"));
  return new FixtureRoot(root);
}

async function seedExecutorFixture(root: string): Promise<string> {
  await writeReplayFixture(root, "batch/match", {
    schema_version: "replay-analysis-manifest-v1",
    replay_id: "replay-match",
    source: {
      filename: "match.rep",
      path: "C:\\replays\\match.rep"
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
      buildOrder: "03:20 Hatchery\n03:55 Spire\n05:45 Mutalisk\n07:30 Hydralisk Den\n06:20 Hatchery\n",
      economySamples: [
        { frame: 5594, time_seconds: 234.948, minerals: 180, gas: 120, gathered_minerals: 1800, gathered_gas: 240, workers: 18 },
        { frame: 7142, time_seconds: 299.964, minerals: 240, gas: 300, gathered_minerals: 2800, gathered_gas: 500, workers: 24 }
      ],
      supplySamples: [{ frame: 7100, time_seconds: 298.2, current: 58, max: 66 }],
      unitCountSamples: [{ frame: 10000, time_seconds: 420, counts: { mutalisk: 9 } }],
      deathSamples: [
        { frame: 7600, time_seconds: 319.2, death: { id: 1, owner: 3, unit_type: "zergling", category: "unit" } },
        { frame: 9000, time_seconds: 378, death: { id: 2, owner: 3, unit_type: "mutalisk", category: "air" } }
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

  await writeReplayFixture(root, "batch/reject", {
    schema_version: "replay-analysis-manifest-v1",
    replay_id: "replay-reject",
    source: {
      filename: "reject.rep",
      path: "C:\\replays\\reject.rep"
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
      buildOrder: "03:20 Hatchery\n05:00 Hatchery\n06:05 Mutalisk\n06:30 Spire\n03:40 Hydralisk Den\n",
      economySamples: [
        { frame: 5700, time_seconds: 239.4, minerals: 150, gas: 100, gathered_minerals: 1700, gathered_gas: 180, workers: 17 },
        { frame: 7142, time_seconds: 299.964, minerals: 200, gas: 250, gathered_minerals: 2600, gathered_gas: 450, workers: null }
      ],
      supplySamples: [{ frame: 7100, time_seconds: 298.2, current: 54, max: 66 }],
      unitCountSamples: [{ frame: 10000, time_seconds: 420, counts: { mutalisk: 6 } }],
      deathSamples: [{ frame: 8800, time_seconds: 369.6, death: { id: 3, owner: 3, unit_type: "zergling", category: "unit" } }]
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

  const databasePath = join(root, "corpus.sqlite");
  const { db } = await openDatabase(databasePath);
  ensureSchema(db);
  await ingestAnalysisRoot(db, root);
  await saveDatabase(db, databasePath);
  db.close();
  return databasePath;
}

function validPlan(): QueryPlanV1 {
  return {
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
      },
      {
        id: "enemy_first_science_vessel_before_11m30s",
        type: "first_event_before",
        perspective: "enemy",
        item: "Science Vessel",
        before_seconds: 690
      }
    ],
    evidence_requests: [
      {
        id: "self_mutalisk_count_at_7m",
        type: "unit_count_at",
        perspective: "self",
        unit: "Mutalisk",
        at_seconds: 420
      },
      {
        id: "self_economy_at_5m",
        type: "economy_at",
        perspective: "self",
        at_seconds: 300
      },
      {
        id: "self_deaths_5m_to_8m",
        type: "deaths_between",
        perspective: "self",
        from_seconds: 300,
        to_seconds: 480,
        include_raw: true,
        summaries: ["total_count", "count_by_unit_type"]
      }
    ],
    assumptions: [],
    unsupported_or_approximate: []
  };
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

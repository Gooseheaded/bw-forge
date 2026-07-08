import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ZipFile } from "yazl";
import * as yauzl from "yauzl";
import { ensureSchema } from "../src/db/schema.js";
import { openDatabase, saveDatabase } from "../src/db/sqlite.js";
import { ingestAnalysisRoot } from "../src/ingest/ingest.js";
import { exportQueryPlanZip } from "../src/query-plan/export.js";
import type { QueryPlanV1 } from "../src/query-plan/executor.js";

void dirname(fileURLToPath(import.meta.url));

test("exportQueryPlanZip packages matched replay artifacts and metadata", async () => {
  await using fixture = await createFixtureRoot();
  const { databasePath, analysisRoot } = await seedExportFixture(fixture.root, { includeHtmlForMatch: true });
  const outputPath = join(fixture.root, "export.zip");

  const summary = await exportQueryPlanZip({
    dbPath: databasePath,
    plan: validPlan(),
    htmlRoot: analysisRoot,
    outPath: outputPath
  });

  assert.equal(summary.coarse_count, 2);
  assert.equal(summary.matched_count, 1);
  assert.equal(summary.html_files_added, 1);
  assert.equal(summary.warning_count, 0);

  const zipEntries = await readZipEntries(outputPath);
  assert.ok(zipEntries.has("README.md"));
  assert.ok(zipEntries.has("query-plan.json"));
  assert.ok(zipEntries.has("query-result.json"));
  assert.ok(zipEntries.has("matched-replays.csv"));
  const htmlEntryName = [...zipEntries.keys()].find((name) => name.startsWith("replays/"));
  assert.ok(htmlEntryName);
  assert.equal(htmlEntryName, "replays/match.html");
  assert.match(zipEntries.get("README.md") ?? "", /Which pbjt ZvT games have early Mutalisks/);
  assert.match(zipEntries.get("README.md") ?? "", /match\.rep/);
  assert.match(zipEntries.get("matched-replays.csv") ?? "", /replay-match/);
  assert.match(zipEntries.get("matched-replays.csv") ?? "", /"09:00"/);
  assert.match(zipEntries.get("query-result.json") ?? "", /"result_schema": "query-executor-result-v1"/);
});

test("exportQueryPlanZip warns when matched replay HTML is missing", async () => {
  await using fixture = await createFixtureRoot();
  const { databasePath, analysisRoot } = await seedExportFixture(fixture.root, { includeHtmlForMatch: false });
  const outputPath = join(fixture.root, "missing-html.zip");

  const summary = await exportQueryPlanZip({
    dbPath: databasePath,
    plan: validPlan(),
    htmlRoot: analysisRoot,
    outPath: outputPath
  });

  assert.equal(summary.coarse_count, 2);
  assert.equal(summary.matched_count, 1);
  assert.equal(summary.html_files_added, 0);
  assert.equal(summary.warning_count, 1);
  assert.equal(summary.warnings[0]?.kind, "missing_html");

  const zipEntries = await readZipEntries(outputPath);
  assert.equal([...zipEntries.keys()].some((name) => name.startsWith("replays/")), false);
  assert.match(zipEntries.get("README.md") ?? "", /No HTML artifact found/);
});

class FixtureRoot implements AsyncDisposable {
  constructor(readonly root: string) {}

  async [Symbol.asyncDispose](): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }
}

async function createFixtureRoot(): Promise<FixtureRoot> {
  return new FixtureRoot(await mkdtemp(join(tmpdir(), "replay-corpus-query-export-")));
}

async function seedExportFixture(root: string, options: { includeHtmlForMatch: boolean }): Promise<{ databasePath: string; analysisRoot: string }> {
  const analysisRoot = join(root, "analysis");
  await writeReplayFixture(analysisRoot, "batch/match", {
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
      buildOrder: "05:45 Mutalisk\n",
      economySamples: [{ frame: 7142, time_seconds: 299.964, minerals: 240, gas: 300, gathered_minerals: 2800, gathered_gas: 500, workers: 24 }],
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
      buildOrder: "09:00 Science Vessel\n",
      economySamples: [{ frame: 100, time_seconds: 4.2, minerals: 50, gas: 0 }],
      supplySamples: [{ frame: 100, time_seconds: 4.2, current: 9, max: 18 }]
    })
  }, options.includeHtmlForMatch ? "<html><body>match report</body></html>" : null);

  await writeReplayFixture(analysisRoot, "batch/reject", {
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
      buildOrder: "06:05 Mutalisk\n",
      economySamples: [{ frame: 7142, time_seconds: 299.964, minerals: 200, gas: 250, gathered_minerals: 2600, gathered_gas: 450, workers: 20 }],
      supplySamples: [{ frame: 7100, time_seconds: 298.2, current: 54, max: 66 }],
      unitCountSamples: [{ frame: 10000, time_seconds: 420, counts: { mutalisk: 6 } }],
      deathSamples: [{ frame: 8800, time_seconds: 369.6, death: { id: 3, owner: 3, unit_type: "zergling", category: "unit" } }]
    }),
    "player_5.zip": await buildPlayerZip({
      owner: 5,
      name: "Scan",
      race: "terran",
      buildOrder: "09:05 Science Vessel\n",
      economySamples: [{ frame: 100, time_seconds: 4.2, minerals: 50, gas: 0 }],
      supplySamples: [{ frame: 100, time_seconds: 4.2, current: 9, max: 18 }]
    })
  }, null);

  const databasePath = join(root, "corpus.sqlite");
  const { db } = await openDatabase(databasePath);
  ensureSchema(db);
  await ingestAnalysisRoot(db, analysisRoot);
  await saveDatabase(db, databasePath);
  db.close();
  return { databasePath, analysisRoot };
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
  analysisRoot: string,
  relativeReplayDir: string,
  manifest: Record<string, unknown>,
  zipFiles: Record<string, Buffer>,
  htmlContents: string | null
): Promise<void> {
  const replayDir = resolve(analysisRoot, relativeReplayDir);
  await mkdir(replayDir, { recursive: true });
  await writeFile(join(replayDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  for (const [fileName, contents] of Object.entries(zipFiles)) {
    await writeFile(join(replayDir, fileName), contents);
  }
  if (htmlContents !== null) {
    await writeFile(join(replayDir, `${basename(replayDir)}.html`), htmlContents, "utf8");
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

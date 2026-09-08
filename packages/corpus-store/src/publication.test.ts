import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createReplayPublisher, type PublicationDependencies } from "./publication.js";
import { ingestReplayAnalysis } from "./index.js";

let temp: string;
let fixture: string;
let corpusRoot: string;
let dbPath: string;
let dependencies: PublicationDependencies;
let calls: number;
const sha = createHash("sha256").update("replay").digest("hex");

beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), "bw-publication-test-"));
  fixture = join(temp, "fixture");
  corpusRoot = join(temp, "corpus");
  dbPath = join(corpusRoot, "db", "corpus.sqlite");
  const runtime = process.env.BW_FORGE_PYTHON ?? (process.platform === "win32" ? "py" : "python3");
  const result = spawnSync(runtime, [...(runtime === "py" ? ["-3"] : []),
    fileURLToPath(new URL("../tests/publication_fixture.py", import.meta.url)), fixture], { encoding: "utf8", windowsHide: true });
  if (result.error) throw result.error;
  expect(result.status, result.stderr).toBe(0);
  calls = 0;
  dependencies = {
    specification: async () => ({ bw_forge_version: "fixture", reducer_version: "fixture" }),
    ingest: ingestReplayAnalysis,
    analyze: async ({ replayPath, outputRoot, workDirectory }) => {
      calls++;
      expect(replayPath).toBe(join(corpusRoot, "replays", sha.slice(0, 2), `${sha}.rep`));
      expect(workDirectory.startsWith(join(corpusRoot, "work"))).toBe(true);
      const dest = join(outputRoot, "replays", sha);
      await cp(fixture, dest, { recursive: true });
      const path = join(dest, "replay-manifest.json");
      const manifest = JSON.parse(await readFile(path, "utf8"));
      manifest.legacy.html_files = ["report.html"];
      await writeFile(join(dest, "report.html"), "<html>fixture</html>");
      await writeFile(path, JSON.stringify(manifest));
    }
  };
});

afterEach(async () => {
  // temp is the exact mkdtemp result, confined to the system temp directory.
  await rm(temp, { recursive: true, force: true });
});

function options() { return { replayPath: join(fixture, "raw.rep"), corpusRoot, dbPath }; }
function rows(sql: string): unknown[] {
  const db = new Database(dbPath, { readonly: true });
  try { return db.query(sql).all(); } finally { db.close(); }
}

test("first publication ingests only final artifact paths; rerun reuses raw, directory and analysis", async () => {
  const publish = createReplayPublisher(dependencies);
  const first = await publish(options());
  expect(first.ingest.status).toBe("indexed");
  expect(first.rawReused).toBe(false);
  expect(first.artifactsReused).toBe(false);
  expect(first.analysisDirectory).toBe(join(corpusRoot, "analyses", sha, first.analysisKey));
  expect(await readdir(join(corpusRoot, "work"))).toEqual([]);
  const artifactPaths = rows("SELECT artifact_path FROM analysis_artifact_locations") as { artifact_path: string }[];
  expect(artifactPaths.length).toBeGreaterThan(2);
  for (const { artifact_path } of artifactPaths) {
    expect(artifact_path === first.rawReplayPath || artifact_path.startsWith(first.analysisDirectory)).toBe(true);
    expect(artifact_path.includes(`${join(corpusRoot, "work")}`)).toBe(false);
    expect((await stat(artifact_path)).isFile()).toBe(true);
  }
  expect(rows("SELECT replay_manifest_path FROM analysis_publications")).toEqual([{ replay_manifest_path: first.replayManifestPath }]);
  const rawStats = await stat(first.rawReplayPath);
  const receipt = await readFile(join(first.analysisDirectory, "publication.json"));
  const databaseBytes = await readFile(dbPath);
  const second = await publish(options());
  expect(second.analysisKey).toBe(first.analysisKey);
  expect(second.ingest.status).toBe("no-op");
  expect(second.rawReused).toBe(true);
  expect(second.artifactsReused).toBe(true);
  expect((await stat(first.rawReplayPath)).mtimeMs).toBe(rawStats.mtimeMs);
  expect(await readFile(join(first.analysisDirectory, "publication.json"))).toEqual(receipt);
  expect(await readFile(dbPath)).toEqual(databaseBytes);
  expect(rows("SELECT count(*) AS n FROM analysis_runs")).toEqual([{ n: 1 }]);
  expect(rows("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
  expect(rows("PRAGMA foreign_key_check")).toEqual([]);
  expect(await readdir(join(corpusRoot, "work"))).toEqual([]);
  expect(calls).toBe(2);
}, 30_000);

test("analyzer and output validation failures leave current untouched and clean staging", async () => {
  await createReplayPublisher(dependencies)(options());
  const before = await readFile(dbPath);
  await expect(createReplayPublisher({ ...dependencies, analyze: async () => { throw new Error("analyzer failure"); } })(options()))
    .rejects.toThrow("analyzer failure");
  expect(await readFile(dbPath)).toEqual(before);
  expect(await readdir(join(corpusRoot, "work"))).toEqual([]);
  const analyze = dependencies.analyze;
  await expect(createReplayPublisher({ ...dependencies, analyze: async params => {
    await analyze(params);
    await writeFile(join(params.outputRoot, "replays", sha, "player.zip"), "broken ZIP");
  } })(options())).rejects.toThrow();
  expect(await readFile(dbPath)).toEqual(before);
  expect(await readdir(join(corpusRoot, "work"))).toEqual([]);
});

test("publication survives ingest failure; rerun verifies/reuses it and reconciles the database", async () => {
  let publishedManifest = "";
  const failing = createReplayPublisher({ ...dependencies, ingest: async params => {
    publishedManifest = params.replayManifestPath;
    expect(publishedManifest.startsWith(join(corpusRoot, "analyses"))).toBe(true);
    expect((await stat(publishedManifest)).isFile()).toBe(true);
    throw new Error("injected DB failure");
  } });
  await expect(failing(options())).rejects.toThrow("injected DB failure");
  expect((await stat(publishedManifest)).isFile()).toBe(true);
  expect(await readdir(join(corpusRoot, "work"))).toEqual([]);
  const result = await createReplayPublisher(dependencies)(options());
  expect(result.artifactsReused).toBe(true);
  expect(result.rawReused).toBe(true);
  expect(result.replayManifestPath).toBe(publishedManifest);
  expect(result.ingest.status).toBe("indexed");
  expect(rows("SELECT count(*) AS n FROM analysis_runs")).toEqual([{ n: 1 }]);
});

test("real DB rejection after publication is recoverable without replacing artifacts", async () => {
  const rejectedDb = join(temp, "v1.sqlite");
  const v1 = new Database(rejectedDb);
  v1.exec("CREATE TABLE players(id)");
  v1.close();
  const before = await readFile(rejectedDb);
  const publish = createReplayPublisher(dependencies);
  await expect(publish({ ...options(), dbPath: rejectedDb })).rejects.toThrow("non-v2");
  expect(await readFile(rejectedDb)).toEqual(before);
  expect((await readdir(join(corpusRoot, "analyses", sha))).length).toBe(1);
  const result = await publish(options());
  expect(result.artifactsReused).toBe(true);
  expect(result.ingest.status).toBe("indexed");
});

test("failed current-pointer transaction retains the previous run; published alternate is retryable", async () => {
  const first = await createReplayPublisher(dependencies)(options());
  const db = new Database(dbPath);
  db.exec("CREATE TRIGGER reject_current BEFORE UPDATE ON current_analyses BEGIN SELECT RAISE(ABORT,'test pointer failure'); END");
  db.close();
  const before = await readFile(dbPath);
  const alternate = createReplayPublisher({ ...dependencies,
    specification: async () => ({ bw_forge_version: "fixture", reducer_version: "alternate" }) });
  await expect(alternate(options())).rejects.toThrow("test pointer failure");
  expect(await readFile(dbPath)).toEqual(before);
  expect(rows("SELECT analysis_id FROM current_analyses")).toEqual([{ analysis_id: first.ingest.analysisId }]);
  expect(rows("SELECT count(*) AS n FROM analysis_publications")).toEqual([{ n: 1 }]);
  expect((await readdir(join(corpusRoot, "analyses", sha))).length).toBe(2);
  expect(await readdir(join(corpusRoot, "work"))).toEqual([]);
  const repair = new Database(dbPath);
  repair.exec("DROP TRIGGER reject_current");
  repair.close();
  const retry = await alternate(options());
  expect(retry.artifactsReused).toBe(true);
  expect(retry.ingest.status).toBe("indexed");
  expect(retry.analysisKey).not.toBe(first.analysisKey);
  expect(rows("SELECT analysis_id FROM current_analyses")).toEqual([{ analysis_id: retry.ingest.analysisId }]);
  expect(rows("SELECT count(*) AS n FROM analysis_publications")).toEqual([{ n: 2 }]);
  expect(rows("PRAGMA foreign_key_check")).toEqual([]);
});

test("an empty pre-existing immutable directory is never replaced", async () => {
  const publish = createReplayPublisher(dependencies);
  const first = await publish(options());
  // Only this test's temporary publication is removed to simulate a conflicting empty directory.
  expect(first.analysisDirectory.startsWith(temp)).toBe(true);
  await rm(first.analysisDirectory, { recursive: true });
  await mkdir(first.analysisDirectory);
  await expect(publish(options())).rejects.toThrow();
  expect(await readdir(first.analysisDirectory)).toEqual([]);
});

test("mismatching immutable files are rejected and never overwritten", async () => {
  const publish = createReplayPublisher(dependencies);
  const first = await publish(options());
  const before = await readFile(dbPath);
  const path = join(first.analysisDirectory, "report.html");
  await writeFile(path, "modified immutable file");
  await expect(publish(options())).rejects.toThrow("Immutable artifact content mismatch");
  expect(await readFile(path, "utf8")).toBe("modified immutable file");
  expect(await readFile(dbPath)).toEqual(before);
  expect(await readdir(join(corpusRoot, "work"))).toEqual([]);
});

test("mismatching canonical replay is rejected without analysis or overwrite", async () => {
  const rawDir = join(corpusRoot, "replays", sha.slice(0, 2));
  await mkdir(rawDir, { recursive: true });
  const raw = join(rawDir, `${sha}.rep`);
  await writeFile(raw, "wrong replay");
  await expect(createReplayPublisher(dependencies)(options())).rejects.toThrow("Canonical replay content mismatch");
  expect(await readFile(raw, "utf8")).toBe("wrong replay");
  expect(calls).toBe(0);
  expect(await readdir(join(corpusRoot, "work"))).toEqual([]);
});

test("debug option retains failed work but successful staging is always cleaned", async () => {
  await expect(createReplayPublisher({ ...dependencies, analyze: async () => { throw new Error("debug failure"); } })({
    ...options(), keepFailedWork: true
  })).rejects.toThrow("debug failure");
  const retained = await readdir(join(corpusRoot, "work"));
  expect(retained.length).toBe(1);
  await createReplayPublisher(dependencies)({ ...options(), keepFailedWork: true });
  expect(await readdir(join(corpusRoot, "work"))).toEqual(retained);
});

test("database cannot be placed inside work or immutable analysis directories", async () => {
  await expect(createReplayPublisher(dependencies)({ ...options(), dbPath: join(corpusRoot, "analyses", "bad.sqlite") }))
    .rejects.toThrow("overlaps");
  expect(calls).toBe(0);
});

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CorpusCore } from "../src/corpus/core.ts";
import { CorpusRegistry } from "../src/corpus/registry.ts";

const sha = "a".repeat(64);
async function makeCorpus(root: string, analysisKey = "analysis-1") {
  const dbDir = join(root, "db"); await mkdir(dbDir, { recursive: true });
  const db = new Database(join(dbDir, "corpus.sqlite"));
  db.run("CREATE TABLE replays (replay_id INTEGER PRIMARY KEY, sha256 TEXT NOT NULL)");
  db.run("CREATE TABLE analysis_runs (analysis_id INTEGER PRIMARY KEY, analysis_key TEXT NOT NULL, replay_id INTEGER NOT NULL, status TEXT NOT NULL, queued_at_ms INTEGER, indexed_at_ms INTEGER)");
  db.run("CREATE TABLE analysis_publications (analysis_id INTEGER PRIMARY KEY, replay_manifest_path TEXT NOT NULL)");
  db.run("CREATE TABLE current_analyses (replay_id INTEGER PRIMARY KEY, analysis_id INTEGER NOT NULL)");
  db.run("INSERT INTO replays VALUES (1, ?)", [sha]); db.run("INSERT INTO analysis_runs VALUES (7, ?, 1, 'indexed', 0, 1)", [analysisKey]);
  db.run("INSERT INTO analysis_publications VALUES (7, ?)", [join(root, "analyses", "published", "manifest.json")]);
  db.run("INSERT INTO current_analyses VALUES (1, 7)"); db.close();
  const dir = join(root, "analyses", "published"); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "report.html"), "<html>ok</html>");
  await writeFile(join(dir, "manifest.json"), JSON.stringify({ replay_id: sha, legacy: { html_files: ["report.html"] } }));
}

describe("CorpusCore publication resolution", () => {
  test("resolves completed reuploads through read-only analysis metadata", async () => {
    const base = await import("node:fs/promises").then(fs => fs.mkdtemp(join(tmpdir(), "bw-core-")));
    await makeCorpus(base);
    const dbPath = join(base, "db", "corpus.sqlite");
    const before = await stat(dbPath);
    const registry = new CorpusRegistry({ community: { name: "Community", corpusRoot: base, database: join(base, "db", "corpus.sqlite"), access: "read-write" } }, undefined, "community");
    const path = await new CorpusCore(registry).reportPath({ corpusId: "community", replaySha256: sha, jobKey: "completed_7" });
    expect(await readFile(path, "utf8")).toContain("ok");
    const after = await stat(dbPath);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });
  test("keeps equal SHA identities independent across corpora", async () => {
    const a = await import("node:fs/promises").then(fs => fs.mkdtemp(join(tmpdir(), "bw-a-")));
    const b = await import("node:fs/promises").then(fs => fs.mkdtemp(join(tmpdir(), "bw-b-")));
    await makeCorpus(a, "a-key"); await makeCorpus(b, "b-key");
    const registry = new CorpusRegistry({ a: { name: "A", corpusRoot: a, database: join(a, "db", "corpus.sqlite"), access: "read-write" }, b: { name: "B", corpusRoot: b, database: join(b, "db", "corpus.sqlite"), access: "read-write" } }, undefined, "a");
    const core = new CorpusCore(registry);
    expect((await core.reportPath({ corpusId: "a", replaySha256: sha, jobKey: "completed_7" })).endsWith(join("published", "report.html"))).toBe(true);
    expect((await core.reportPath({ corpusId: "b", replaySha256: sha, jobKey: "completed_7" })).endsWith(join("published", "report.html"))).toBe(true);
  });
  test("rejects manifest report escape", async () => {
    const base = await import("node:fs/promises").then(fs => fs.mkdtemp(join(tmpdir(), "bw-escape-")));
    await makeCorpus(base);
    await writeFile(join(base, "analyses", "published", "manifest.json"), JSON.stringify({ replay_id: sha, legacy: { html_files: ["../../outside.html"] } }));
    const registry = new CorpusRegistry({ c: { name: "C", corpusRoot: base, database: join(base, "db", "corpus.sqlite"), access: "read-write" } }, undefined, "c");
    await expect(new CorpusCore(registry).reportPath({ corpusId: "c", replaySha256: sha, jobKey: "completed_7" })).rejects.toThrow("escaped");
  });
});

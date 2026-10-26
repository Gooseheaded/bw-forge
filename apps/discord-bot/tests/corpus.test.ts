import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CorpusRegistry } from "../src/corpus/registry.ts";
import { Database } from "bun:sqlite";

const corpus = (root: string, access: "read-only" | "read-write" = "read-write") => ({ name: "x", corpusRoot: root, database: join(root, "db", "corpus.sqlite"), access });
describe("corpus registry", () => {
  test("requires an explicit writable upload corpus", () => {
    const root = join(tmpdir(), "bw-registry-policy-corpus");
    expect(() => new CorpusRegistry({ x: corpus(root) })).toThrow("default upload corpus");
    expect(() => new CorpusRegistry({ x: corpus(root, "read-only") }, undefined, "x")).toThrow("writable");
  });
  test("allows corpus db under db and rejects managed-artifact overlap", () => {
    const root = join(tmpdir(), "bw-registry-policy-corpus");
    expect(() => new CorpusRegistry({ x: corpus(root) }, undefined, "x")).not.toThrow();
    expect(() => new CorpusRegistry({ x: { ...corpus(root), database: join(root, "replays", "bad.sqlite") } }, undefined, "x")).toThrow("managed artifacts");
  });
  test("rejects a read-only default before filesystem access", async () => {
    const root = await mkdtemp(join(tmpdir(), "bw-registry-"));
    await mkdir(join(root, "db")); await writeFile(join(root, "db", "corpus.sqlite"), "");
    expect(() => new CorpusRegistry({ x: corpus(root, "read-only") }, undefined, "x")).toThrow("writable");
  });
  test("creates nested writable layout and preserves read-only corpus", async () => {
    const root = await mkdtemp(join(tmpdir(), "bw-nested-"));
    const writable = join(root, "deep", "community");
    const ro = join(root, "professional");
    await mkdir(join(ro, "db"), { recursive: true });
    const initial = new Database(join(ro, "db", "corpus.sqlite"));
    initial.exec("CREATE TABLE corpus_metadata(singleton,schema_version,purpose); INSERT INTO corpus_metadata VALUES(1,2,'corpus-store')"); initial.close();
    const db = join(ro, "db", "corpus.sqlite");
    const before = await stat(db);
    const registry = new CorpusRegistry({ community: corpus(writable), pro: corpus(ro, "read-only") }, undefined, "community");
    await registry.validateFilesystem();
    const after = await stat(db);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect((await stat(writable)).isDirectory()).toBe(true);
  });
});

import { access, constants, mkdir, realpath, stat } from "node:fs/promises";
import { Database } from "bun:sqlite";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { ConfigError, type BotConfig } from "../config/index.ts";

export type CorpusAccess = "read-only" | "read-write";
export type CorpusReplayRef = { corpusId: string; replaySha256: string };
export type CorpusDefinition = NonNullable<BotConfig["corpus"]>["corpora"][string];

function contained(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== "" && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}
function canonicalCase(value: string): string { return process.platform === "win32" ? value.toLowerCase() : value; }
async function canonicalPath(path: string): Promise<string> {
  const parts: string[] = [];
  let current = resolve(path);
  while (true) {
    try { const actual = await realpath(current); return canonicalCase(resolve(actual, ...parts.reverse())); }
    catch { const parent = resolve(current, ".."); if (parent === current) throw new Error(`Cannot resolve path: ${path}`); parts.push(current.slice(parent.length + (parent.endsWith(sep) ? 0 : 1))); current = parent; }
  }
}

/** Validated named corpus registry. It is deliberately independent of the bot SQLite database. */
export class CorpusRegistry {
  readonly corpora: ReadonlyMap<string, CorpusDefinition>;
  constructor(
    definitions: Record<string, CorpusDefinition>,
    private readonly botDatabasePath?: string,
    readonly defaultUploadCorpus?: string,
    readonly readableCorpora: readonly string[] = Object.keys(definitions),
  ) {
    const entries = Object.entries(definitions);
    if (new Set(entries.map(([id]) => id)).size !== entries.length) throw new Error("Corpus IDs must be unique");
    if (entries.length && !defaultUploadCorpus) throw new Error("A default upload corpus is required when corpora are configured");
    for (const [id, c] of entries) {
      if (!id || !c.database || !c.corpusRoot) throw new Error(`Corpus ${id} has missing paths`);
      if (c.access !== "read-only" && c.access !== "read-write") throw new Error(`Corpus ${id} has invalid access policy`);
      if (!isAbsolute(c.corpusRoot) || !isAbsolute(c.database)) throw new Error(`Corpus ${id} paths must be absolute`);
      const root = resolve(c.corpusRoot), db = resolve(c.database), bot = botDatabasePath && resolve(botDatabasePath);
      if (resolve(root, "..") === root) throw new Error(`Corpus ${id} root cannot be a filesystem root`);
      if (db === root || db.endsWith(`${sep}analyses`) || db.endsWith(`${sep}replays`) || db.endsWith(`${sep}work`) || contained(db, root)) throw new Error(`Corpus ${id} database path is unsafe`);
      if (bot && (db === bot || contained(db, bot) || contained(bot, db))) throw new Error(`Corpus ${id} database overlaps bot database`);
      if (db === root || contained(resolve(root, "analyses"), db) || contained(resolve(root, "replays"), db) || contained(resolve(root, "work"), db)) throw new Error(`Corpus ${id} database overlaps managed artifacts`);
    }
    for (let i = 0; i < entries.length; i++) for (let j = i + 1; j < entries.length; j++) {
      const a = resolve(entries[i][1].corpusRoot), b = resolve(entries[j][1].corpusRoot);
      if (a === b || contained(a, b) || contained(b, a)) throw new Error(`Corpus roots overlap: ${entries[i][0]} and ${entries[j][0]}`);
      const da = resolve(entries[i][1].database), db = resolve(entries[j][1].database);
      if (da === db || contained(da, db) || contained(db, da)) throw new Error("Corpus databases overlap");
    }
    if (defaultUploadCorpus !== undefined) {
      const c = Object.hasOwn(definitions, defaultUploadCorpus) ? definitions[defaultUploadCorpus] : undefined;
      if (!c) throw new Error("Configured upload corpus is not registered");
      if (c.access !== "read-write") throw new Error("Upload corpus must be explicitly writable");
    }
    for (const id of readableCorpora) if (!Object.hasOwn(definitions, id)) throw new Error(`Readable corpus is not registered: ${id}`);
    this.corpora = new Map(entries.map(([id, value]) => [id, Object.freeze({ ...value })]));
  }

  get(id: string): CorpusDefinition {
    const result = this.corpora.get(id); if (!result) throw new Error(`Unknown corpus: ${id}`); return result;
  }
  requireWritable(id = this.defaultUploadCorpus): CorpusDefinition {
    if (!id) throw new Error("No upload corpus configured");
    const corpus = this.get(id); if (corpus.access !== "read-write") throw new Error(`Corpus ${id} is read-only`); return corpus;
  }
  ref(corpusId: string, replaySha256: string): CorpusReplayRef {
    if (!/^[a-f0-9]{64}$/.test(replaySha256)) throw new Error("Replay SHA-256 must be lowercase hexadecimal");
    this.get(corpusId); return { corpusId, replaySha256 };
  }

  /** Check layout and permissions at startup. Read-only corpora are never created or modified. */
  async validateFilesystem(): Promise<void> {
    // Resolve existing paths before creating anything, so symlink aliases cannot
    // bypass cross-corpus or bot-database overlap checks.
    const canonical: Array<{ id: string; root: string; db: string }> = [];
    const bot = this.botDatabasePath ? await canonicalPath(this.botDatabasePath) : undefined;
    for (const [id, corpus] of this.corpora) {
      const root = resolve(corpus.corpusRoot), db = resolve(corpus.database);
      const rootBase = await canonicalPath(root);
      const dbBase = await canonicalPath(db);
      if (bot && (dbBase === bot || rootBase === bot || rootBase === dirname(bot) || contained(rootBase, bot))) throw new Error(`Corpus ${id} overlaps bot database`);
      for (const part of ["analyses", "replays", "work"]) {
        const managed = await canonicalPath(resolve(root, part));
        if (dbBase === managed || contained(managed, dbBase)) throw new Error(`Corpus ${id} database overlaps managed artifacts`);
      }
      canonical.push({ id, root: rootBase, db: dbBase });
    }
    for (let i = 0; i < canonical.length; i++) for (let j = i + 1; j < canonical.length; j++) {
      if (canonical[i].root === canonical[j].root || contained(canonical[i].root, canonical[j].root) || contained(canonical[j].root, canonical[i].root) || canonical[i].db === canonical[j].db || contained(canonical[i].root, canonical[j].db) || contained(canonical[j].root, canonical[i].db)) throw new Error(`Canonical corpus paths overlap: ${canonical[i].id} and ${canonical[j].id}`);
    }
    // Existing databases must identify themselves as Corpus v2, including when
    // another bot database is configured under a different filename.
    const databaseFiles = new Map<string, string>();
    for (const [id, corpus] of this.corpora) {
      const info = await stat(corpus.database).catch(() => null);
      if (!info) continue;
      const identity = `${info.dev}:${info.ino}`;
      if (info.ino && databaseFiles.has(identity)) throw new Error(`Corpus databases alias the same file: ${databaseFiles.get(identity)} and ${id}`);
      if (info.ino) databaseFiles.set(identity, id);
      let db: Database | undefined;
      try {
        db = new Database(corpus.database, { readonly: true });
        const marker = db.query("SELECT schema_version,purpose FROM corpus_metadata WHERE singleton=1").get() as { schema_version: number; purpose: string } | null;
        if (marker?.schema_version !== 2 || marker.purpose !== "corpus-store") throw new Error("Invalid marker");
      } catch { throw new Error(`Corpus ${id} database is not a Corpus v2 store`); }
      finally { db?.close(); }
    }
    for (const [id, corpus] of this.corpora) {
      const root = resolve(corpus.corpusRoot), db = resolve(corpus.database);
      if (corpus.access === "read-write") {
        await mkdir(root, { recursive: true });
        await access(root, constants.R_OK | constants.W_OK);
      } else {
        const rootInfo = await stat(root).catch(() => undefined);
        if (!rootInfo?.isDirectory()) throw new Error(`Read-only corpus ${id} root is unavailable`);
        await access(root, constants.R_OK);
      }
      const actualRoot = await realpath(root);
      if (resolve(actualRoot) !== root && !contained(resolve(actualRoot), resolve(db))) throw new Error(`Corpus ${id} path resolves outside configured root`);
      const parent = resolve(db, "..");
      if (corpus.access === "read-write") await mkdir(parent, { recursive: true });
      const dbInfo = await stat(db).catch(() => undefined);
      if (dbInfo && !dbInfo.isFile()) throw new Error(`Corpus ${id} database is not a regular file`);
      if (corpus.access === "read-only" && !dbInfo) throw new Error(`Read-only corpus ${id} database is unavailable`);
      if (dbInfo && corpus.access === "read-only") await access(db, constants.R_OK);
      if (dbInfo && corpus.access === "read-write") await access(db, constants.R_OK | constants.W_OK);
      if (corpus.access === "read-write") await access(parent, constants.R_OK | constants.W_OK);
    }
  }
}


export function createCorpusRegistry(config: BotConfig): CorpusRegistry {
  const corpus = config.corpus ?? { corpora: {}, readableCorpora: [], defaultUploadCorpus: undefined };
  try { return new CorpusRegistry(corpus.corpora, config.storage.databasePath, corpus.defaultUploadCorpus, corpus.readableCorpora); }
  catch (error) { throw new ConfigError(`Invalid corpus registry: ${(error as Error).message}`); }
}

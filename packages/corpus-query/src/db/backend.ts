import type { Database } from "./sqlite.js";
import { openDatabase } from "./sqlite.js";
import { existsSync } from "node:fs";

export type CorpusBackend = "v1" | "v2";
const detected = new WeakMap<Database, CorpusBackend>();

export function sqlRows(db: Database, sql: string, params: unknown[] = []): Record<string, unknown>[] {
  const statement = db.prepare(sql);
  try {
    statement.bind(params);
    const rows: Record<string, unknown>[] = [];
    while (statement.step()) rows.push(statement.getAsObject());
    return rows;
  } finally { statement.free(); }
}

/** Strong markers take precedence. A prototype or malformed v2 must never fall back to v1. */
export function detectCorpusBackend(db: Database): CorpusBackend {
  const cached = detected.get(db);
  if (cached) return cached;
  const version = Number(sqlRows(db, "PRAGMA user_version")[0]?.user_version);
  const tables = new Set(sqlRows(db, "SELECT name FROM sqlite_schema WHERE type='table'").map(r => String(r.name)));
  if (version === 2 || tables.has("corpus_metadata")) {
    const marker = tables.has("corpus_metadata") ? sqlRows(db, "SELECT schema_version,purpose FROM corpus_metadata WHERE singleton=1")[0] : undefined;
    if (version !== 2 || marker?.schema_version !== 2 || marker?.purpose !== "corpus-store") throw new Error("Invalid or unsupported Corpus v2 marker");
    for (const name of ["replays", "participations", "analysis_specs", "analysis_runs", "current_analyses",
      "analysis_participations", "analysis_artifacts", "stream_coverage", "build_events", "economy_changes", "supply_changes",
      "unit_types", "analysis_unit_domain", "unit_count_changes", "death_events"]) {
      if (!tables.has(name)) throw new Error(`Corpus v2 is missing required table ${name}`);
    }
    detected.set(db, "v2");
    return "v2";
  }
  for (const name of ["replays", "players", "build_order_events", "economy_samples", "supply_samples", "unit_count_samples", "death_events"]) {
    if (!tables.has(name)) throw new Error(`Corpus schema is missing required table "${name}"`);
  }
  detected.set(db, "v1");
  return "v1";
}

export function requireV1(db: Database, capability: string): void {
  if (detectCorpusBackend(db) === "v2") {
    const error = new Error(`${capability} is not supported for Corpus v2 yet. Use analyze-v2 or ingest-v2 for ingestion.`);
    Object.assign(error, { code: "NOT_SUPPORTED_FOR_CORPUS_V2", backend: "v2", capability });
    throw error;
  }
}

export async function requireV1Database(path:string,capability:string):Promise<void> {
  // Preserve legacy plan validation order when no database has been created yet.
  if(!existsSync(path))return;
  const {db}=await openDatabase(path,{readOnly:true});
  try {requireV1(db,capability);} finally {db.close();}
}

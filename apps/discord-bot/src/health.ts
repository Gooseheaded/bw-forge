import { Database } from "bun:sqlite";
import { access, constants, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { loadConfig } from "./config/index.ts";
import { createCorpusRegistry } from "./corpus/registry.ts";
import { McpGateway } from "./agent/mcp-gateway.ts";

type Health = {
  ok: boolean; schemaVersion: number | null;
  turns: Record<string, number>; replayUploads: Record<string, number>; reportDeliveries: Record<string, number>;
  queue: { oldestQueuedAgeSeconds: number | null };
  usage: { requests: number; inputTokens: number | null; outputTokens: number | null; totalTokens: number | null; estimatedCostMicros: number | null; metadataAvailable: boolean };
  checks: Record<string, "ok" | "failed">;
};
const empty = (): Health => ({ ok: false, schemaVersion: null, turns: {}, replayUploads: {}, reportDeliveries: {}, queue: { oldestQueuedAgeSeconds: null }, usage: { requests: 0, inputTokens: null, outputTokens: null, totalTokens: null, estimatedCostMicros: null, metadataAvailable: false }, checks: {} });

/** Local, credential-free diagnostics. It never contacts Discord or an LLM. */
export async function inspectHealth(dbPath: string, options: { professionalRoot?: string; communityRoot?: string; mcpCommand?: string; mcpCheck?: boolean; corpusCheck?: boolean; env?: Record<string, string | undefined> } = {}): Promise<Health> {
  const result = empty(); let db: Database | undefined;
  try { db = new Database(dbPath, { readonly: true }); result.checks.database = "ok"; } catch { result.checks.database = "failed"; return result; }
  try { const row = db.query("SELECT version FROM schema_version LIMIT 1").get() as { version?: number } | null; result.schemaVersion = typeof row?.version === "number" ? row.version : null; result.checks.schema = result.schemaVersion === 4 || result.schemaVersion === 5 || result.schemaVersion === 6 ? "ok" : "failed"; } catch { result.checks.schema = "failed"; }
  const tableExists = (name: string) => Boolean(db!.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  const counts = (table: string, column: string): Record<string, number> => { try { if (!tableExists(table)) throw new Error("missing table"); const rows = db!.query(`SELECT ${column} AS state, COUNT(*) AS count FROM ${table} GROUP BY ${column}`).all() as Array<{ state: string; count: number }>; result.checks[table] = "ok"; return Object.fromEntries(rows.map((r) => [String(r.state), Number(r.count)])); } catch { result.checks[table] = "failed"; return {}; } };
  result.turns = counts("turns", "status"); result.replayUploads = counts("replay_uploads", "state"); result.reportDeliveries = counts("report_deliveries", "state");
  try { const hasTurnCreated = (db.query("PRAGMA table_info(turns)").all() as Array<{ name: string }>).some((r) => r.name === "created_at"); const row = db.query(hasTurnCreated ? "SELECT MIN(created_at) AS oldest FROM turns WHERE status='queued'" : "SELECT MIN(m.created_at) AS oldest FROM turns t JOIN messages m ON m.id=t.triggering_message_id WHERE t.status='queued'").get() as { oldest?: string | number } | null; const raw = row?.oldest; const millis = typeof raw === "number" ? (raw < 1e12 ? raw * 1000 : raw) : raw ? Date.parse(raw) : NaN; result.queue.oldestQueuedAgeSeconds = Number.isFinite(millis) ? Math.max(0, Math.floor((Date.now() - millis) / 1000)) : null; result.checks.queue = "ok"; } catch { result.checks.queue = "failed"; }
  try { if (!tableExists("provider_requests")) throw new Error("missing table"); const columns = new Set((db.query("PRAGMA table_info(provider_requests)").all() as Array<{ name: string }>).map((r) => r.name)); const hasInput = columns.has("input_tokens"), hasOutput = columns.has("output_tokens"), hasTotal = columns.has("total_tokens"), hasCost = columns.has("reported_cost_micros"); const input = hasInput ? "input_tokens" : "NULL"; const output = hasOutput ? "output_tokens" : "NULL"; const total = hasTotal ? "total_tokens" : `(${input}+${output})`; const cost = hasCost ? "SUM(reported_cost_micros)" : "NULL"; const row = db.query(`SELECT COUNT(*) AS requests, SUM(${input}) AS input, SUM(${output}) AS output, SUM(${total}) AS total, ${cost} AS cost FROM provider_requests WHERE status='completed'`).get() as any; result.usage = { requests: Number(row?.requests ?? 0), inputTokens: row?.input === null || row?.input === undefined ? null : Number(row.input), outputTokens: row?.output === null || row?.output === undefined ? null : Number(row.output), totalTokens: row?.total === null || row?.total === undefined ? null : Number(row.total), estimatedCostMicros: hasCost && row?.cost !== null && row?.cost !== undefined ? Number(row.cost) : null, metadataAvailable: hasInput || hasOutput || hasTotal }; result.checks.usage = "ok"; } catch { result.checks.usage = "failed"; }
  db.close();
  for (const [label, path, mode] of [["professional", options.professionalRoot, constants.R_OK], ["community", options.communityRoot, constants.R_OK | constants.W_OK]] as const) { if (!path) continue; try { await access(path, mode); result.checks[`${label}Access`] = "ok"; } catch { result.checks[`${label}Access`] = "failed"; } }
  if (options.corpusCheck) {
    try {
      const config = loadConfig(options.env);
      const registry = createCorpusRegistry(config);
      for (const [id, corpus] of registry.corpora) {
        const writable = corpus.access === "read-write";
        await access(corpus.corpusRoot, constants.R_OK | (writable ? constants.W_OK : 0));
        await access(corpus.database, constants.R_OK | (writable ? constants.W_OK : 0));
        if (writable) await access(dirname(corpus.database), constants.R_OK | constants.W_OK);
        const corpusDb = new Database(corpus.database, { readonly: true });
        try {
          const marker = corpusDb.query("SELECT schema_version,purpose FROM corpus_metadata WHERE singleton=1").get() as { schema_version?: number; purpose?: string } | null;
          if (marker?.schema_version !== 2 || marker.purpose !== "corpus-store") throw new Error("invalid corpus");
        } finally { corpusDb.close(); }
        result.checks[`corpus_${id}`] = "ok";
      }
      result.checks.corpora = "ok";
    } catch { result.checks.corpora = "failed"; }
  }
  if (options.mcpCommand) { try { await stat(options.mcpCommand); result.checks.mcpCommand = "ok"; } catch { result.checks.mcpCommand = "failed"; } }
  if (options.mcpCheck) {
    try {
      const config = loadConfig(options.env); const registry = createCorpusRegistry(config);
      const gateway = new McpGateway(config.corpus?.readableCorpora.map((id) => ({ id, dbPath: registry.get(id).database, readable: true, command: config.agent.mcpCommand!, args: config.agent.mcpArgs.map((arg) => arg.replaceAll("{db_path}", registry.get(id).database)), cwd: process.env.BW_FORGE_REPO_ROOT })) ?? [], { requestTimeoutMs: config.agent.toolTimeoutMs, maxResultBytes: config.agent.maxToolResultBytes });
      try {
        const tools = await gateway.listTools();
        result.checks.mcp = tools.length > 0 && gateway.getUnavailableCorpora().length === 0 ? "ok" : "failed";
      } finally { await gateway.close(); }
    } catch { result.checks.mcp = "failed"; }
  }
  result.ok = Object.values(result.checks).every((v) => v === "ok"); return result;
}
if (import.meta.main) { const args = process.argv.slice(2); const valueAfter = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; }; const dbPath = valueAfter("--db"); if (!dbPath || dbPath.startsWith("-")) { console.error("Usage: bun src/health.ts --db <bot-database> [--corpus-check] [--mcp-check]"); process.exitCode = 2; } else { const result = await inspectHealth(dbPath, { professionalRoot: valueAfter("--professional-root"), communityRoot: valueAfter("--community-root"), mcpCommand: valueAfter("--mcp-command"), mcpCheck: args.includes("--mcp-check"), corpusCheck: args.includes("--corpus-check") }); console.log(JSON.stringify(result)); process.exitCode = result.ok ? 0 : 1; } }

import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectHealth } from "../src/health.ts";
import { BotStore } from "../src/storage/store.ts";

test("health diagnostics are local, bounded, and omit sensitive values", async () => {
  const root = mkdtempSync(join(tmpdir(), "bw-health-"));
  const path = join(root, "bot.sqlite");
  const store = new BotStore({ dbPath: path });
  store.close();
  try {
    const result = await inspectHealth(path);
    expect(result.ok).toBe(true);
    expect(result.schemaVersion).toBeGreaterThanOrEqual(4);
    expect(result.turns).toEqual({});
    expect(result.usage.inputTokens).toBeNull();
    expect(result.usage.outputTokens).toBeNull();
    expect(result.usage.totalTokens).toBeNull();
    expect(JSON.stringify(result)).not.toContain(path);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("corpus health checks use the configured roots and read-only database opens", async () => {
  const root = mkdtempSync(join(tmpdir(), "bw-health-corpora-"));
  const botDbPath = join(root, "state", "bot.sqlite");
  const proRoot = join(root, "professional"), communityRoot = join(root, "community");
  const proDb = join(proRoot, "db", "corpus.sqlite"), communityDb = join(communityRoot, "db", "corpus.sqlite");
  const { mkdirSync } = await import("node:fs");
  for (const path of [join(proRoot, "db"), join(communityRoot, "db"), join(root, "state")]) mkdirSync(path, { recursive: true });
  for (const path of [proDb, communityDb]) {
    const db = new Database(path);
    db.exec("CREATE TABLE corpus_metadata(singleton INTEGER PRIMARY KEY,schema_version INTEGER,purpose TEXT); INSERT INTO corpus_metadata VALUES(1,2,'corpus-store');");
    db.close();
  }
  const bot = new BotStore({ dbPath: botDbPath }); bot.close();
  const env = {
    DISCORD_BOT_TOKEN: "secret", DISCORD_APPLICATION_ID: "12345678901234567", DISCORD_GUILD_ID: "12345678901234568",
    DISCORD_PARENT_CHANNEL_IDS: "12345678901234569", DISCORD_AUTHORIZED_ROLE_IDS: "12345678901234570", LLM_API_KEY: "secret", LLM_MODEL: "model",
    DISCORD_BOT_DATABASE_PATH: botDbPath, LLM_MAX_OUTPUT_TOKENS: "128", LLM_CONTEXT_BUDGET: "4096", LLM_REQUEST_TIMEOUT_MS: "5000",
    LLM_MAX_CONCURRENT_TURNS: "2", MAX_MESSAGES_QUEUED_PER_THREAD: "10",
    BW_FORGE_CORPORA_JSON: JSON.stringify({ pro: { name: "Pro", database: proDb, corpus_root: proRoot, access: "read-only" }, community: { name: "Community", database: communityDb, corpus_root: communityRoot, access: "read-write" } }),
    BW_FORGE_DEFAULT_UPLOAD_CORPUS: "community", BW_FORGE_READABLE_CORPORA: "pro,community",
  };
  try {
    const result = await inspectHealth(botDbPath, { corpusCheck: true, env });
    expect(result.checks.corpora).toBe("ok");
    expect(result.checks.corpus_pro).toBe("ok");
    expect(result.checks.corpus_community).toBe("ok");
    expect(JSON.stringify(result)).not.toContain(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

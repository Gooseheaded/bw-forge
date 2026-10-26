import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BotStore } from "../src/storage/store.ts";
import { ReplayCoordinator, downloadReplayAttachment, type CoordinatorOptions } from "../src/ingestion/coordinator.ts";
import { CorpusRegistry } from "../src/corpus/registry.ts";
import { CorpusCore } from "../src/corpus/core.ts";
import { loadConfig } from "../src/config/index.ts";

let root: string, store: BotStore, sessionId: number;
const coordinators: ReplayCoordinator[] = [];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bwf-m2-boundaries-"));
  store = new BotStore({ dbPath: join(root, "bot.sqlite") });
  const session = store.reserveSession({ guildId: "guild", parentChannelId: "parent", creatorUserId: "user", creationKey: "session" });
  sessionId = session.id; store.attachThread(sessionId, "thread");
});
afterEach(async () => {
  for (const coordinator of coordinators.splice(0)) await coordinator.stop();
  store.close(); store = undefined as unknown as BotStore;
  await new Promise<void>(resolve => setImmediate(resolve));
  Bun.gc(true); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
function coordinator(options: Partial<CoordinatorOptions> = {}) {
  const result = new ReplayCoordinator({ store, download: { maxBytes: 1000, timeoutMs: 1000, tempRoot: join(root, "uploads") },
    authorizeUpload: async () => true, gateway: { registerReplay: async () => ({ jobId: "job", state: "queued" }) }, ...options });
  coordinators.push(result); return result;
}
function input(id: string) { return { sessionId, threadId: "thread", messageId: `message-${id}`, userId: "user", corpusId: "uploads", authorize: async () => true,
  attachment: { id, name: "../../other-corpus.REP", url: `https://cdn.discordapp.com/attachments/1/${id}/game.rep`, size: 4 } }; }
function definition(path: string, access: "read-only" | "read-write" = "read-write") { return { name: "Corpus", corpusRoot: path, database: join(path, "db", "corpus.sqlite"), access }; }

test("duplicate registry IDs fail in both object and array JSON", () => {
  const env = { DISCORD_BOT_TOKEN: "secret", DISCORD_APPLICATION_ID: "12345678901234567", DISCORD_GUILD_ID: "12345678901234568",
    DISCORD_PARENT_CHANNEL_IDS: "12345678901234569", DISCORD_AUTHORIZED_ROLE_IDS: "12345678901234570", LLM_API_KEY: "secret",
    LLM_MODEL: "model", DISCORD_BOT_DATABASE_PATH: "bot.sqlite", LLM_MAX_OUTPUT_TOKENS: "128", LLM_CONTEXT_BUDGET: "4096",
    LLM_REQUEST_TIMEOUT_MS: "5000", LLM_MAX_CONCURRENT_TURNS: "2", MAX_MESSAGES_QUEUED_PER_THREAD: "10" };
  const value = { ...definition(join(root, "community")), id: "community" };
  expect(() => loadConfig({ ...env, BW_FORGE_CORPORA_JSON: JSON.stringify([value, value]) })).toThrow("Duplicate");
  expect(() => loadConfig({ ...env, BW_FORGE_CORPORA_JSON: `{"community":${JSON.stringify(value)},"community":${JSON.stringify(value)}}` })).toThrow("Duplicate");
});

test("canonical aliases of bot state and cross-corpus databases fail before writes", async () => {
  const alias = join(root, "state-alias"); await symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
  const aliased = new CorpusRegistry({ upload: { ...definition(alias), database: join(root, "elsewhere.sqlite") } }, join(root, "bot.sqlite"), "upload");
  await expect(aliased.validateFilesystem()).rejects.toThrow("overlaps bot database");
  await unlink(alias); // Remove only the junction, never the target directory.
  const professional = join(root, "professional"), writable = join(root, "writable");
  await mkdir(join(professional, "db"), { recursive: true }); await writeFile(join(professional, "db", "corpus.sqlite"), "preserve");
  const invalid = new CorpusRegistry({ professional: definition(professional, "read-only"), uploads: { ...definition(writable), database: join(professional, "db", "uploads.sqlite") } }, join(root, "bot.sqlite"), "uploads");
  await expect(invalid.validateFilesystem()).rejects.toThrow("overlap");
  expect(await readFile(join(professional, "db", "corpus.sqlite"), "utf8")).toBe("preserve");
  expect(await stat(writable).catch(() => null)).toBeNull();
});

test("read-only corpus writes are rejected at the API boundary", async () => {
  const pro = join(root, "professional"), writable = join(root, "community");
  await mkdir(join(pro, "db"), { recursive: true }); const database = join(pro, "db", "corpus.sqlite"); await writeFile(database, "untouched");
  const registry = new CorpusRegistry({ professional: definition(pro, "read-only"), writable: definition(writable) }, join(root, "bot.sqlite"), "writable");
  await expect(new CorpusCore(registry).registerAndEnqueue({ corpusId: "professional", replayPath: "anything.rep" })).rejects.toThrow("read-only");
  expect(await readFile(database, "utf8")).toBe("untouched");
  expect(registry.ref("professional", "a".repeat(64))).not.toEqual(registry.ref("writable", "a".repeat(64)));
});

test("redirected staging cannot write or clean files in a corpus", async () => {
  const professional = join(root, "professional"); await mkdir(professional);
  const protectedFile = join(professional, "12345678-1234-1234-1234-123456789abc.rep"); await writeFile(protectedFile, "preserve");
  const alias = join(root, "uploads"); await symlink(professional, alias, process.platform === "win32" ? "junction" : "dir");
  try {
    const runner = coordinator();
    await expect(runner.tickOnce()).rejects.toThrow("symlinks");
    await expect(downloadReplayAttachment(input("one").attachment, { maxBytes: 100, timeoutMs: 100, tempRoot: alias,
      fetch: async () => { throw new Error("must not download"); } })).rejects.toThrow("symlinks");
    expect(await readFile(protectedFile, "utf8")).toBe("preserve");
  } finally { await unlink(alias); }
});

test("an independently named bot database cannot be mistaken for a corpus", async () => {
  const other = join(root, "other-bot.sqlite"); new BotStore({ dbPath: other }).close();
  const before = await readFile(other), mtime = (await stat(other)).mtimeMs;
  const registry = new CorpusRegistry({ uploads: { ...definition(join(root, "community")), database: other } }, join(root, "bot.sqlite"), "uploads");
  await expect(registry.validateFilesystem()).rejects.toThrow("not a Corpus v2 store");
  expect(await readFile(other)).toEqual(before); expect((await stat(other)).mtimeMs).toBe(mtime);
});

test("intake denies unauthorized work and defers excess downloads without rejecting accepted uploads", async () => {
  let downloads = 0, active = 0, maximum = 0, release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const runner = coordinator({ maxDownloads: 1, maxPendingPerSession: 2, downloader: async (_attachment, options) => {
    downloads++; active++; maximum = Math.max(maximum, active); await barrier;
    await mkdir(options.tempRoot, { recursive: true }); const path = join(options.tempRoot, `${downloads}.rep`);
    await writeFile(path, "data"); active--; return { path, sha256: createHash("sha256").update("data").digest("hex") };
  } });
  await expect(runner.accept({ ...input("unauthorized"), authorize: async () => false })).rejects.toThrow("authorized");
  expect(store.listReplayUploads()).toHaveLength(0);
  const first = await runner.accept(input("one")), second = await runner.accept(input("two"));
  await expect(runner.accept(input("three"))).rejects.toThrow("pending replay limit");
  await runner.tickOnce();
  expect(store.getReplayUpload(second.id)?.state).toBe("received");
  release(); await runner.drain(); await runner.tickOnce(); await runner.drain();
  expect(downloads).toBe(2); expect(maximum).toBe(1);
  expect(store.getReplayUpload(first.id)?.state).toBe("queued"); expect(store.getReplayUpload(second.id)?.state).toBe("queued");
  expect(store.getReplayUpload(first.id)?.corpusId).toBe("uploads");
  expect(store.getReplayUpload(first.id)?.filename).toBe("other-corpus.REP");
  expect(await runner.accept(input("one"))).toMatchObject({ id: first.id });
  expect(downloads).toBe(2);
});

test("role revocation after download prevents enqueue and cleans staged bytes", async () => {
  let permitted = true, calls = 0;
  const runner = coordinator({ authorizeUpload: async () => permitted, downloader: async (_, options) => {
    await mkdir(options.tempRoot, { recursive: true }); const path = join(options.tempRoot, "revoked.rep"); await writeFile(path, "data");
    permitted = false; return { path, sha256: createHash("sha256").update("data").digest("hex") };
  }, gateway: { registerReplay: async () => { calls++; return { jobId: "never" }; } } });
  const upload = await runner.accept(input("revoked")); await runner.tickOnce(); await runner.drain();
  expect(calls).toBe(0); expect(store.getReplayUpload(upload.id)?.state).toBe("failed");
  expect(await stat(join(root, "uploads", "revoked.rep")).catch(() => null)).toBeNull();
});

test("delivery retry survives a real database reopen and respects persisted backoff", async () => {
  let now = Date.now(), attempts = 0;
  const upload = store.createReplayUpload({ sessionId, discordMessageId: "m", attachmentId: "a", userId: "u", corpusId: "uploads", filename: "x.rep" });
  store.updateReplayUpload(upload.id, { state: "succeeded", replaySha256: "a".repeat(64) });
  store.ensureReportDelivery(upload.id, "thread", join(root, "report.html"));
  let runner = coordinator({ clock: () => now, retryBaseMs: 100, onReportReady: async () => { attempts++; throw new Error("https://signed.example/secret"); } });
  await runner.tickOnce(); const retryAt = store.getReportDelivery(upload.id)?.nextAttemptAt;
  expect(retryAt).not.toBeNull(); expect(store.getReportDelivery(upload.id)?.error).not.toContain("secret");
  await runner.stop(); store.close(); store = new BotStore({ dbPath: join(root, "bot.sqlite") });
  runner = coordinator({ clock: () => now, retryBaseMs: 100, onReportReady: async () => { attempts++; return "delivered-after-restart"; } });
  await runner.tickOnce(); expect(attempts).toBe(1);
  now += 101; await runner.tickOnce(); expect(attempts).toBe(2);
  expect(store.getReportDelivery(upload.id)?.discordMessageId).toBe("delivered-after-restart");
});

test("worker outages preserve queued state, terminal analysis failures notify safely", async () => {
  let now = Date.now(), outage = true, notices = 0;
  const upload = store.createReplayUpload({ sessionId, discordMessageId: "m", attachmentId: "a", userId: "u", corpusId: "uploads", filename: "x.rep" });
  store.updateReplayUpload(upload.id, { state: "queued", jobId: "job" });
  const runner = coordinator({ clock: () => now, retryBaseMs: 100, gateway: {
    registerReplay: async () => ({ jobId: "unused" }), getJob: async () => { if (outage) throw new Error("database busy /private/path"); return { state: "failed", error: "/private/path" }; },
  }, onFailure: async (_, message) => { expect(message).not.toContain("/private/path"); notices++; } });
  await runner.tickOnce(); expect(store.getReplayUpload(upload.id)?.state).toBe("queued"); expect(notices).toBe(0);
  outage = false; now += 101; await runner.tickOnce(); expect(store.getReplayUpload(upload.id)?.state).toBe("failed"); expect(notices).toBe(1);
  await runner.tickOnce(); expect(notices).toBe(1);
});

test("oversized or permission-denied delivery preserves analysis and emits a durable safe notice", async () => {
  for (const error of [new Error("published report exceeds Discord upload limit"), Object.assign(new Error("/private/path"), { code: 50013 })]) {
    const upload = store.createReplayUpload({ sessionId, discordMessageId: String(Math.random()), attachmentId: "a", userId: "u", corpusId: "uploads", filename: "x.rep" });
    store.updateReplayUpload(upload.id, { state: "succeeded", replaySha256: "a".repeat(64) }); store.ensureReportDelivery(upload.id, "thread", "/private/report.html");
    let notices = 0;
    const runner = coordinator({ onReportReady: async () => { throw error; }, onFailure: async (_, message) => { expect(message).not.toContain("/private"); notices++; } });
    await runner.tickOnce(); expect(store.getReplayUpload(upload.id)?.state).toBe("succeeded");
    expect(store.getReportDelivery(upload.id)?.state).toBe("failed"); expect(notices).toBe(1);
    await runner.tickOnce(); expect(notices).toBe(1); await runner.stop();
  }
});

test("M1 sessions and conversations survive migrations from the original schema", () => {
  store.enqueueUserMessage({ sessionId, discordMessageId: "old-message", authorUserId: "user", content: "M1 conversation" });
  // Remove only the M2 tables to recreate the actual M1 schema on this fixture DB.
  store.db.exec("DROP TABLE report_deliveries; DROP TABLE replay_uploads; DROP TABLE session_replays; UPDATE schema_version SET version=1;");
  store.close(); store = new BotStore({ dbPath: join(root, "bot.sqlite") });
  expect(store.getSession(sessionId)?.threadId).toBe("thread");
  expect(store.getMessageByDiscordId("old-message")?.content).toBe("M1 conversation");
  expect(store.getPendingTurns()).toHaveLength(1);
  expect(store.db.query("SELECT version FROM schema_version").get()).toEqual({ version: 4 });
});

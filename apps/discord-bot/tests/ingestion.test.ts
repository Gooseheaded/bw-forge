import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BotStore } from "../src/storage/store.ts";
import { downloadReplayAttachment } from "../src/ingestion/coordinator.ts";

describe("replay ingestion durability", () => {
  test("deduplicates attachment events and preserves upload identity", async () => {
    const root = await mkdtemp(join(process.env.TEMP ?? ".", "bwf-ingest-"));
    const db = join(root, "bot.sqlite");
    const store = new BotStore({ dbPath: db });
    const session = store.reserveSession({ guildId: "1", parentChannelId: "2", creatorUserId: "3", creationKey: "k" });
    store.attachThread(session.id, "thread");
    const first = store.createReplayUpload({ sessionId: session.id, discordMessageId: "msg", attachmentId: "att", userId: "3", corpusId: "community", filename: "x.rep" });
    const second = store.createReplayUpload({ sessionId: session.id, discordMessageId: "msg", attachmentId: "att", userId: "3", corpusId: "community", filename: "x.rep" });
    expect(second.id).toBe(first.id);
    store.updateReplayUpload(first.id, { state: "registering", replaySha256: "a".repeat(64), filePath: join(root, "durable.rep") });
    store.close();
    const reopened = new BotStore({ dbPath: db });
    const recovered = reopened.getReplayUpload(first.id)!;
    expect(recovered.state).toBe("registering");
    expect(recovered.filePath).toContain("durable.rep");
    reopened.close(); await rm(root, { recursive: true, force: true });
  });
  test("rejects unsafe attachment metadata before network access", async () => {
    const options = { maxBytes: 10, timeoutMs: 100, tempRoot: "." };
    await expect(downloadReplayAttachment({ id: "1", name: "x.txt", url: "https://cdn.discordapp.com/x" }, options)).rejects.toThrow(".rep");
    await expect(downloadReplayAttachment({ id: "1", name: "x.rep", url: "https://evil.example/x" }, options)).rejects.toThrow("Discord");
    await expect(downloadReplayAttachment({ id: "1", name: "x.rep", url: "https://cdn.discordapp.com/attachments/1/2/x.rep", size: 11 }, options)).rejects.toThrow("size");
    await expect(downloadReplayAttachment({ id: "1", name: "x.rep", url: "https://cdn.discordapp.com:444/attachments/1/2/x.rep" }, options)).rejects.toThrow("Discord");
    await expect(downloadReplayAttachment({ id: "1", name: "x.rep", url: "https://u:p@cdn.discordapp.com/attachments/1/2/x.rep" }, options)).rejects.toThrow("Discord");
  });
  test("rejects redirects and malformed replay bytes", async () => {
    const oldFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      if (init?.redirect !== "manual") throw new Error("redirect policy missing");
      return new Response(new Uint8Array(64), { status: 302, headers: { location: "https://evil.example" } });
    }) as typeof fetch;
    try { await expect(downloadReplayAttachment({ id: "1", name: "x.rep", url: "https://cdn.discordapp.com/attachments/1/2/x.rep" }, { maxBytes: 1000, timeoutMs: 1000, tempRoot: "." })).rejects.toThrow(); }
    finally { globalThis.fetch = oldFetch; }
  });
  test("parses real fixture and rejects malformed data", async () => {
    const root = await mkdtemp(join(process.env.TEMP ?? ".", "bwf-fixture-"));
    const fixture = await readFile(resolve(import.meta.dir, "../../../fixtures/replays/191104,(4)KnockOut1.4.rep"));
    const good = await downloadReplayAttachment({ id: "1", name: "game.rep", url: "https://cdn.discordapp.com/attachments/1/2/game.rep", size: fixture.length }, { maxBytes: fixture.length + 1, timeoutMs: 10000, tempRoot: root, fetch: async () => new Response(fixture, { status: 200, headers: { "content-length": String(fixture.length) } }) });
    expect(await readFile(good.path)).toEqual(fixture);
    await expect(downloadReplayAttachment({ id: "2", name: "bad.rep", url: "https://cdn.discordapp.com/attachments/1/2/bad.rep" }, { maxBytes: 1000, timeoutMs: 1000, tempRoot: root, fetch: async () => new Response(new Uint8Array(64), { status: 200, headers: { "content-length": "64" } }) })).rejects.toThrow("valid");
    await rm(root, { recursive: true, force: true });
  });
  test("times out stalled body and cleans temporary files", async () => {
    const root = await mkdtemp(join(process.env.TEMP ?? ".", "bwf-timeout-"));
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array([1])); } });
    await expect(downloadReplayAttachment({ id: "1", name: "slow.rep", url: "https://cdn.discordapp.com/attachments/1/2/slow.rep" }, { maxBytes: 1000, timeoutMs: 20, tempRoot: root, fetch: async () => new Response(body, { status: 200 }) })).rejects.toThrow(/timed out|timeout/i);
    expect(await readdir(root)).toHaveLength(0); await rm(root, { recursive: true, force: true });
  });
  test("rejects oversized body and keeps generated path inside root", async () => {
    const root = await mkdtemp(join(process.env.TEMP ?? ".", "bwf-size-"));
    await expect(downloadReplayAttachment({ id: "1", name: "big.rep", url: "https://cdn.discordapp.com/attachments/1/2/big.rep" }, { maxBytes: 10, timeoutMs: 1000, tempRoot: root, fetch: async () => new Response(new Uint8Array(20), { status: 200 }) })).rejects.toThrow("size");
    const result = await downloadReplayAttachment({ id: "2", name: "../../escape.rep", url: "https://cdn.discordapp.com/attachments/1/2/x.rep" }, { maxBytes: 10, timeoutMs: 1000, tempRoot: root, fetch: async () => new Response(new Uint8Array([1]), { status: 200 }), validateReplay: async () => undefined });
    expect(result.path.startsWith(root)).toBe(true); await rm(root, { recursive: true, force: true });
  });
});

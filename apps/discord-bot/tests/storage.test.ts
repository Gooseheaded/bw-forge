import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { BotStore } from "../src/storage/store.ts";

describe("BotStore", () => {
  test("provider reservations enforce durable rate and session budgets across reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "bwf-provider-budget-"));
    const path = join(dir, "bot.sqlite");
    const first = new BotStore({ dbPath: path });
    const session = first.reserveSession({ guildId: "g", parentChannelId: "p", creatorUserId: "u", title: "x", creationKey: "k" });
    first.db.query("UPDATE sessions SET thread_id='t' WHERE id=?").run(session.id);
    const queued = first.enqueueUserMessage({ sessionId: session.id, discordMessageId: "m", authorUserId: "u", content: "x" });
    const running = first.claimNextTurn(session.id);
    expect(running).toBeTruthy();
    first.startProviderRequest(running!.id, { reservedTokens: 10, reservedCostMicros: 4, maxSessionTokens: 20, maxRequestsPerMinute: 2 });
    expect((first.db.query("SELECT reserved_tokens,reserved_cost_micros FROM provider_requests WHERE turn_id=?").all(running!.id) as any[])).toHaveLength(1);
    first.close();
    const reopened = new BotStore({ dbPath: path });
    const same = reopened.getTurn(running!.id);
    expect(same).toBeTruthy();
    reopened.close();
  });

  test("provider reservations enforce turn and session token/cost ceilings before insertion", () => {
    const dir = mkdtempSync(join(tmpdir(), "bwf-provider-caps-"));
    const store = new BotStore({ dbPath: join(dir, "bot.sqlite") });
    const session = store.reserveSession({ guildId: "g", parentChannelId: "p", creatorUserId: "u", creationKey: "caps" });
    store.db.query("UPDATE sessions SET thread_id='t' WHERE id=?").run(session.id);
    const first = store.enqueueUserMessage({ sessionId: session.id, discordMessageId: "cap-1", authorUserId: "u", content: "one" });
    const running = store.claimNextTurn(session.id)!;
    store.startProviderRequest(running.id, { reservedTokens: 10, reservedCostMicros: 5, maxTurnTokens: 20, maxTurnCostMicros: 10, maxSessionTokens: 100, maxSessionCostMicros: 100 });
    expect(() => store.startProviderRequest(running.id, { reservedTokens: 11, reservedCostMicros: 6, maxTurnTokens: 20, maxTurnCostMicros: 10 })).toThrow("budget");
    store.finishProviderRequest(running.id, 1, "completed");
    store.completeTurn(running.id);
    const second = store.enqueueUserMessage({ sessionId: session.id, discordMessageId: "cap-2", authorUserId: "u", content: "two" });
    const running2 = store.claimNextTurn(session.id)!;
    expect(() => store.startProviderRequest(running2.id, { reservedTokens: 91, reservedCostMicros: 96, maxSessionTokens: 100, maxSessionCostMicros: 100 })).toThrow("budget");
    store.close();
  });

  test("provider requests keep distinct round IDs and nullable partial usage", () => {
    const dir = mkdtempSync(join(tmpdir(), "bwf-provider-rounds-"));
    const store = new BotStore({ dbPath: join(dir, "bot.sqlite") });
    const session = store.reserveSession({ guildId: "g", parentChannelId: "p", creatorUserId: "u", creationKey: "rounds" });
    store.db.query("UPDATE sessions SET thread_id='t' WHERE id=?").run(session.id);
    const turn = store.enqueueUserMessage({ sessionId: session.id, discordMessageId: "round-1", authorUserId: "u", content: "x" }).turn;
    const running = store.claimNextTurn(session.id)!;
    const first = store.startProviderRequest(running.id, { reservedTokens: 20 });
    store.finishProviderRequest(running.id, first, "completed", undefined, { inputTokens: 3 }, 4);
    const second = store.startProviderRequest(running.id, { reservedTokens: 20 });
    store.finishProviderRequest(running.id, second, "failed", "provider request failed", undefined, 5);
    const rows = store.db.query("SELECT attempt,input_tokens,output_tokens,total_tokens,status FROM provider_requests WHERE turn_id=? ORDER BY attempt").all(running.id) as any[];
    expect(rows.map((row) => row.attempt)).toEqual([1, 2]);
    expect(rows[0].input_tokens).toBe(3);
    expect(rows[0].output_tokens).toBeNull();
    expect(rows[1].input_tokens).toBeNull();
    store.close();
  });
  test("rejects a corpus database without modifying its contents", () => {
    const dir = mkdtempSync(join(tmpdir(), "bwf-separate-db-"));
    const path = join(dir, "corpus.sqlite");
    const corpus = new Database(path);
    corpus.exec(
      "CREATE TABLE replays(id TEXT); INSERT INTO replays VALUES('retained');",
    );
    corpus.close();
    const before = readFileSync(path);
    expect(() => new BotStore({ dbPath: path })).toThrow(
      "separate bot state file",
    );
    expect(readFileSync(path)).toEqual(before);
    rmSync(dir, { recursive: true, force: true });
  });
  test("persists a collaborative session and deduplicates Discord delivery", () => {
    const store = new BotStore({ dbPath: ":memory:" });
    const reserved = store.reserveSession({
      guildId: "guild",
      parentChannelId: "parent",
      creatorUserId: "one",
      creationKey: "interaction",
    });
    store.attachThread(reserved.id, "thread");
    expect(
      store.reserveSession({
        guildId: "guild",
        parentChannelId: "parent",
        creatorUserId: "one",
        creationKey: "interaction",
      }).id,
    ).toBe(reserved.id);
    const first = store.enqueueUserMessage({
      sessionId: reserved.id,
      discordMessageId: "discord-message",
      authorUserId: "one",
      content: "hello",
    });
    const duplicate = store.enqueueUserMessage({
      sessionId: reserved.id,
      discordMessageId: "discord-message",
      authorUserId: "one",
      content: "hello",
    });
    expect(duplicate.duplicate).toBe(true);
    expect(store.getPendingTurns()).toHaveLength(1);
    expect(store.getConversationHistory(reserved.id)).toHaveLength(0);
    const claimed = store.claimNextTurn(reserved.id, "openai", "model");
    expect(claimed?.id).toBe(first.turn.id);
    store.completeTurn(first.turn.id);
    expect(
      store.getConversationHistory(reserved.id).map((m) => m.content),
    ).toEqual(["hello"]);
    store.close();
  });

  test("returns a corpus-qualified replay inventory isolated by session", () => {
    const store = new BotStore({ dbPath: ":memory:" });
    const first = store.reserveSession({ guildId: "g", parentChannelId: "p", creatorUserId: "u", creationKey: "first" });
    const second = store.reserveSession({ guildId: "g", parentChannelId: "p", creatorUserId: "u", creationKey: "second" });
    const hash = "a".repeat(64);
    store.associateSessionReplay(first.id, "community", hash, "first.rep");
    store.associateSessionReplay(first.id, "pro", hash, "same-hash-pro.rep");
    store.associateSessionReplay(second.id, "community", "b".repeat(64), "other.rep");
    expect(store.getSessionReplayInventory(first.id)).toEqual([
      { replayNumber: 1, corpusId: "community", replaySha256: hash, displayName: "first.rep", analysisAvailable: false },
      { replayNumber: 2, corpusId: "pro", replaySha256: hash, displayName: "same-hash-pro.rep", analysisAvailable: false },
    ]);
    expect(store.getSessionReplayInventory(second.id).map((item) => item.replaySha256)).toEqual(["b".repeat(64)]);
    store.close();
  });

  test("requeues interrupted work and excludes revoked turns", () => {
    const directory = mkdtempSync(join(tmpdir(), "bw-forge-discord-"));
    const path = join(directory, "bot.sqlite");
    const first = new BotStore({ dbPath: path });
    const session = first.reserveSession({
      guildId: "g",
      parentChannelId: "p",
      creatorUserId: "u",
      creationKey: "x",
    });
    first.attachThread(session.id, "thread");
    const queued = first.enqueueUserMessage({
      sessionId: session.id,
      discordMessageId: "m",
      authorUserId: "u",
      content: "secret",
    });
    first.claimNextTurn(session.id);
    first.close();
    const second = new BotStore({ dbPath: path });
    expect(second.getTurn(queued.turn.id)?.status).toBe("queued");
    const s2 = second.reserveSession({
      guildId: "g",
      parentChannelId: "p",
      creatorUserId: "u",
      creationKey: "y",
    });
    second.attachThread(s2.id, "thread-2");
    const t2 = second.enqueueUserMessage({
      sessionId: s2.id,
      discordMessageId: "m2",
      authorUserId: "u",
      content: "revoked",
    });
    second.cancelTurn(t2.turn.id);
    expect(second.getConversationHistory(s2.id)).toHaveLength(0);
    expect(second.getTurn(t2.turn.id)?.status).toBe("cancelled");
    second.close();
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      /* Windows may release SQLite handles after the test */
    }
  });

  test("serializes claims, bounds the queue, and records provider attempts", () => {
    const store = new BotStore({ dbPath: ":memory:", maxQueuedPerThread: 1 });
    const session = store.reserveSession({
      guildId: "g",
      parentChannelId: "p",
      creatorUserId: "u",
      creationKey: "q",
    });
    store.attachThread(session.id, "thread");
    store.enqueueUserMessage({
      sessionId: session.id,
      discordMessageId: "one",
      authorUserId: "u",
      content: "one",
    });
    expect(() =>
      store.enqueueUserMessage({
        sessionId: session.id,
        discordMessageId: "two",
        authorUserId: "u",
        content: "two",
      }),
    ).toThrow("queue is full");
    const claimed = store.claimNextTurn();
    expect(claimed).not.toBeNull();
    expect(store.claimNextTurn()).toBeNull();
    const attempt = store.startProviderRequest(claimed!.id);
    store.finishProviderRequest(claimed!.id, attempt, "failed", "timeout");
    store.failTurn(claimed!.id, "timeout");
    expect(store.getPendingTurns()).toHaveLength(1);
    store.close();
  });

  test("rejects a future schema without mutating it", () => {
    const path = join(tmpdir(), "bw-forge-schema-" + Date.now() + ".sqlite");
    const initial = new BotStore({ dbPath: path });
    initial.close();
    const raw = new Database(path);
    raw.query("UPDATE schema_version SET version=99").run();
    raw.close();
    expect(() => new BotStore({ dbPath: path })).toThrow(
      "Unsupported bot database schema version 99",
    );
    rmSync(path, { force: true });
  });
});

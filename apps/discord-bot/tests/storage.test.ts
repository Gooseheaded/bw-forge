import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { BotStore } from "../src/storage/store.ts";

describe("BotStore", () => {
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

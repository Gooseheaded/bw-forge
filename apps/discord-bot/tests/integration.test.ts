import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotStore } from "../src/storage/store.ts";
import { SqliteRuntimeStore, TurnRuntime } from "../src/agent/runtime.ts";
import { DiscordAdapter } from "../src/discord/adapter.ts";
import type { BotConfig } from "../src/config/index.ts";

const waitFor = async (check: () => boolean, ms = 1000) => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await Bun.sleep(5);
  expect(check()).toBe(true);
};

describe("persistent routing integration", () => {
  it("uses SQLite for duplicate-safe context and delivery retry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bwf-int-"));
    const path = join(dir, "bot.sqlite");
    const db = new BotStore({ dbPath: path });
    const reserved = db.reserveSession({
      guildId: "g",
      parentChannelId: "p",
      creatorUserId: "u",
      creationKey: "i",
    });
    db.attachThread(reserved.id, "t");
    db.addSystemMessage(reserved.id, "system");
    const runtimeStore = new SqliteRuntimeStore(db);
    let generations = 0;
    let sends = 0;
    const runtime = new TurnRuntime({
      store: runtimeStore,
      maxConcurrent: 1,
      requestTimeoutMs: 500,
      model: "mock",
      authorization: { authorize: async () => true },
      provider: {
        generate: async (r) => {
          generations++;
          return {
            text: `answer:${r.messages.at(-1)?.content}`,
            provider: "mock",
            model: "mock",
          };
        },
      },
      delivery: {
        send: async (x) => {
          sends++;
          if (sends === 1) throw new Error("temporary Discord failure");
        },
        failure: async () => {},
      },
    });
    const handlers = new Map<string, (value: any) => void>();
    const fakeClient: any = {
      user: { id: "bot" },
      on: (event: string, fn: any) => {
        handlers.set(event, fn);
      },
      guilds: {
        fetch: async () => ({
          members: {
            fetch: async () => ({
              roles: { cache: new Map([["role", true]]) },
            }),
          },
        }),
      },
      channels: { fetch: async () => undefined },
      destroy: async () => {},
    };
    const config: BotConfig = {
      discord: {
        token: "x",
        applicationId: "a",
        guildId: "g",
        parentChannelIds: ["p"],
        authorizedRoleIds: ["role"],
      },
      llm: {
        provider: "openai",
        apiKey: "x",
        model: "mock",
        maxOutputTokens: 100,
        contextBudget: 1000,
        requestTimeoutMs: 500,
      },
      storage: { databasePath: path },
      queue: { maxConcurrent: 1, maxPerThread: 10 },
    };
    const adapter = new DiscordAdapter({
      client: fakeClient,
      config,
      store: db,
      runtime,
    });
    const message = {
      id: "m",
      author: { id: "u", bot: false },
      webhookId: null,
      guild: {
        id: "g",
        members: {
          fetch: async () => ({ roles: { cache: new Map([["role", true]]) } }),
        },
      },
      channel: { isThread: () => true, id: "t", parentId: "p" },
      content: "hello",
      attachments: new Map(),
    };
    await handlers.get("messageCreate")!(message);
    await handlers.get("messageCreate")!(message);
    await runtime.start();
    await waitFor(() => generations === 1 && sends >= 2);
    expect(
      db.getConversationHistory(reserved.id).map((x) => x.content),
    ).toContain("answer:hello");
    await runtime.stop();
    db.close();
    const restarted = new BotStore({ dbPath: path });
    expect(
      restarted.getConversationHistory(reserved.id).map((x) => x.content),
    ).toContain("answer:hello");
    restarted.close();
  });

  it("reconstructs collaborative two-user context in FIFO order", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bwf-collab-"));
    const path = join(dir, "bot.sqlite");
    const db = new BotStore({ dbPath: path });
    const s = db.reserveSession({
      guildId: "g",
      parentChannelId: "p",
      creatorUserId: "u1",
      creationKey: "collab",
    });
    db.attachThread(s.id, "tc");
    db.enqueueUserMessage({
      sessionId: s.id,
      discordMessageId: "m1",
      authorUserId: "u1",
      content: "first",
    });
    db.enqueueUserMessage({
      sessionId: s.id,
      discordMessageId: "m2",
      authorUserId: "u2",
      content: "second",
    });
    const seen: string[][] = [];
    const rs = new SqliteRuntimeStore(db);
    const rt = new TurnRuntime({
      store: rs,
      model: "mock",
      maxConcurrent: 1,
      requestTimeoutMs: 500,
      authorization: { authorize: async () => true },
      provider: {
        generate: async (r) => {
          seen.push(r.messages.map((m) => m.content));
          return {
            text: `reply-${seen.length}`,
            provider: "mock",
            model: "mock",
          };
        },
      },
      delivery: { send: async () => {}, failure: async () => {} },
    });
    await rt.start();
    await waitFor(() => seen.length === 2);
    await rt.stop();
    expect(seen[0]).toContain("first");
    expect(seen[1]).toEqual(
      expect.arrayContaining(["first", "reply-1", "second"]),
    );
    db.close();
  });

  it("restarts a running turn with a saved response without regenerating", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bwf-restart-"));
    const path = join(dir, "bot.sqlite");
    const db = new BotStore({ dbPath: path });
    const s = db.reserveSession({
      guildId: "g",
      parentChannelId: "p",
      creatorUserId: "u",
      creationKey: "restart",
    });
    db.attachThread(s.id, "tr");
    db.enqueueUserMessage({
      sessionId: s.id,
      discordMessageId: "mr",
      authorUserId: "u",
      content: "recover",
    });
    const turn = db.claimNextTurn(s.id, "mock", "mock");
    if (!turn) throw new Error("turn not claimed");
    db.saveTurnResponse(turn.id, {
      text: "saved answer",
      provider: "mock",
      model: "mock",
    });
    db.close();
    const reopened = new BotStore({ dbPath: path });
    const rs = new SqliteRuntimeStore(reopened);
    let generated = 0;
    let delivered = "";
    const rt = new TurnRuntime({
      store: rs,
      model: "mock",
      maxConcurrent: 1,
      requestTimeoutMs: 500,
      authorization: { authorize: async () => true },
      provider: {
        generate: async () => {
          generated++;
          return { text: "wrong", provider: "mock", model: "mock" };
        },
      },
      delivery: {
        send: async (x) => {
          delivered = x.text;
        },
        failure: async () => {},
      },
    });
    await rt.start();
    await waitFor(() => delivered === "saved answer");
    await rt.stop();
    expect(generated).toBe(0);
    expect(delivered).toBe("saved answer");
    reopened.close();
  });

  it("persists a friendly failed response for a non-retryable provider error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bwf-fail-"));
    const path = join(dir, "bot.sqlite");
    const db = new BotStore({ dbPath: path });
    try {
      const s = db.reserveSession({
        guildId: "g",
        parentChannelId: "p",
        creatorUserId: "u",
        creationKey: "fail",
      });
      db.attachThread(s.id, "tf");
      db.enqueueUserMessage({
        sessionId: s.id,
        discordMessageId: "mf",
        authorUserId: "u",
        content: "bad",
      });
      const rs = new SqliteRuntimeStore(db);
      let delivered = "";
      const err = Object.assign(new Error("bad provider"), {
        retryable: false,
      });
      const rt = new TurnRuntime({
        store: rs,
        model: "mock",
        maxConcurrent: 1,
        maxAttempts: 1,
        requestTimeoutMs: 200,
        authorization: { authorize: async () => true },
        provider: {
          generate: async () => {
            throw err;
          },
        },
        delivery: {
          send: async (x) => {
            delivered = x.text;
          },
          failure: async () => {},
        },
      });
      await rt.start();
      await waitFor(() => delivered.length > 0);
      await rt.stop();
      const turns = db.getTurn(1);
      expect(turns?.status).toBe("failed");
      expect(delivered).toContain("couldn't complete");
      expect(db.getMessages(s.id).some((m) => m.role === "assistant")).toBe(
        true,
      );
    } finally {
      db.close();
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("marks terminal delivery failure without regenerating", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bwf-delivery-"));
    const path = join(dir, "bot.sqlite");
    const db = new BotStore({ dbPath: path });
    try {
      const s = db.reserveSession({
        guildId: "g",
        parentChannelId: "p",
        creatorUserId: "u",
        creationKey: "delivery",
      });
      db.attachThread(s.id, "td");
      db.enqueueUserMessage({
        sessionId: s.id,
        discordMessageId: "md",
        authorUserId: "u",
        content: "hello",
      });
      const rs = new SqliteRuntimeStore(db);
      let generations = 0;
      const rt = new TurnRuntime({
        store: rs,
        model: "mock",
        maxConcurrent: 1,
        maxAttempts: 1,
        requestTimeoutMs: 50,
        authorization: { authorize: async () => true },
        provider: {
          generate: async () => {
            generations++;
            return { text: "answer", provider: "mock", model: "mock" };
          },
        },
        delivery: {
          send: async () => {
            throw new Error("discord unavailable");
          },
          failure: async () => {},
        },
      });
      await rt.start();
      await waitFor(() => db.getTurn(1)?.status === "failed");
      await rt.stop();
      expect(generations).toBe(1);
      expect(db.getTurn(1)?.status).toBe("failed");
    } finally {
      db.close();
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("cancels a revoked queued collaborator without a provider request", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bwf-revoke-"));
    const path = join(dir, "bot.sqlite");
    const db = new BotStore({ dbPath: path });
    try {
      const s = db.reserveSession({
        guildId: "g",
        parentChannelId: "p",
        creatorUserId: "u1",
        creationKey: "revoke",
      });
      db.attachThread(s.id, "tv");
      db.enqueueUserMessage({
        sessionId: s.id,
        discordMessageId: "v1",
        authorUserId: "u1",
        content: "block",
      });
      db.enqueueUserMessage({
        sessionId: s.id,
        discordMessageId: "v2",
        authorUserId: "u2",
        content: "revoked",
      });
      let release!: () => void;
      const blocker = new Promise<void>((r) => {
        release = r;
      });
      let generations = 0;
      let secondAuth = true;
      const rt = new TurnRuntime({
        store: new SqliteRuntimeStore(db),
        model: "mock",
        maxConcurrent: 1,
        requestTimeoutMs: 1000,
        authorization: {
          authorize: async (x) => x.userId === "u1" || secondAuth,
        },
        provider: {
          generate: async () => {
            generations++;
            await blocker;
            return { text: "ok", provider: "mock", model: "mock" };
          },
        },
        delivery: { send: async () => {}, failure: async () => {} },
      });
      await rt.start();
      await waitFor(() => db.getTurn(1)?.status === "running");
      secondAuth = false;
      release();
      await waitFor(() => db.getTurn(2)?.status === "cancelled");
      await rt.stop();
      expect(generations).toBe(1);
      expect(db.getTurn(2)?.status).toBe("cancelled");
    } finally {
      db.close();
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("recovers a running turn after stop while provider ignores abort", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bwf-stop-"));
    const path = join(dir, "bot.sqlite");
    const db = new BotStore({ dbPath: path });
    try {
      const s = db.reserveSession({
        guildId: "g",
        parentChannelId: "p",
        creatorUserId: "u",
        creationKey: "stop",
      });
      db.attachThread(s.id, "ts");
      db.enqueueUserMessage({
        sessionId: s.id,
        discordMessageId: "vs",
        authorUserId: "u",
        content: "resume",
      });
      const rt = new TurnRuntime({
        store: new SqliteRuntimeStore(db),
        model: "mock",
        maxConcurrent: 1,
        requestTimeoutMs: 1000,
        authorization: { authorize: async () => true },
        provider: { generate: async () => new Promise(() => {}) },
        delivery: {
          send: async () => {
            throw new Error("should not deliver");
          },
          failure: async () => {
            throw new Error("should not fail");
          },
        },
      });
      await rt.start();
      await waitFor(() => db.getTurn(1)?.status === "running");
      await rt.stop(20);
      expect(db.getTurn(1)?.status).toBe("running");
      db.close();
      const reopened = new BotStore({ dbPath: path });
      let delivered = "";
      const recovered = new TurnRuntime({
        store: new SqliteRuntimeStore(reopened),
        model: "mock",
        maxConcurrent: 1,
        requestTimeoutMs: 500,
        authorization: { authorize: async () => true },
        provider: {
          generate: async () => ({
            text: "recovered",
            provider: "mock",
            model: "mock",
          }),
        },
        delivery: {
          send: async (x) => {
            delivered = x.text;
          },
          failure: async () => {},
        },
      });
      await recovered.start();
      await waitFor(() => delivered === "recovered");
      await recovered.stop();
      expect(reopened.getTurn(1)?.status).toBe("completed");
      reopened.close();
    } finally {
      try {
        db.close();
      } catch {}
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("production adapter ignores DMs, bots, webhooks, wrong parents, and unknown threads", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bwf-filter-"));
    const path = join(dir, "bot.sqlite");
    const db = new BotStore({ dbPath: path });
    try {
      const s = db.reserveSession({
        guildId: "g",
        parentChannelId: "p",
        creatorUserId: "u",
        creationKey: "filter",
      });
      db.attachThread(s.id, "known");
      const handlers = new Map<string, (value: any) => void>();
      const fakeClient: any = {
        user: { id: "bot" },
        on: (e: string, f: any) => handlers.set(e, f),
        guilds: {
          fetch: async () => ({
            members: {
              fetch: async () => ({
                roles: { cache: new Map([["role", true]]) },
              }),
            },
          }),
        },
        channels: { fetch: async () => undefined },
        destroy: async () => {},
      };
      const config: BotConfig = {
        discord: {
          token: "x",
          applicationId: "a",
          guildId: "g",
          parentChannelIds: ["p"],
          authorizedRoleIds: ["role"],
        },
        llm: {
          provider: "openai",
          apiKey: "x",
          model: "mock",
          maxOutputTokens: 100,
          contextBudget: 1000,
          requestTimeoutMs: 500,
        },
        storage: { databasePath: path },
        queue: { maxConcurrent: 1, maxPerThread: 10 },
      };
      let enqueued = 0;
      const adapter = new DiscordAdapter({
        client: fakeClient,
        config,
        store: db,
        runtime: {
          enqueue: async () => {
            enqueued++;
            return true;
          },
        } as any,
      });
      const base = {
        id: "x",
        author: { id: "u", bot: false },
        webhookId: null,
        guild: {
          id: "g",
          members: {
            fetch: async () => ({
              roles: { cache: new Map([["role", true]]) },
            }),
          },
        },
        channel: { isThread: () => true, id: "known", parentId: "p" },
        content: "x",
        attachments: new Map(),
      };
      for (const variant of [
        { ...base, author: { id: "bot", bot: true } },
        { ...base, webhookId: "w" },
        { ...base, guild: { ...base.guild, id: "other" } },
        { ...base, channel: { ...base.channel, parentId: "wrong" } },
        { ...base, channel: { ...base.channel, id: "unknown" } },
        {
          ...base,
          guild: undefined,
          channel: { ...base.channel, isThread: () => false },
        },
      ])
        await handlers.get("messageCreate")!(variant);
      await handlers.get("messageCreate")!(base);
      await Bun.sleep(20);
      expect(enqueued).toBe(1);
      void adapter;
    } finally {
      db.close();
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });
});

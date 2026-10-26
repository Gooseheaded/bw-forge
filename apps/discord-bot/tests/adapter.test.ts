import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotStore } from "../src/storage/store.ts";
import {
  DiscordAuthorization,
  DiscordDelivery,
} from "../src/discord/adapter.ts";
import { DiscordAdapter } from "../src/discord/adapter.ts";
import { ChannelType } from "discord.js";
import type { BotConfig } from "../src/config/index.ts";

const config = (roles = ["role"]) =>
  ({
    discord: {
      token: "secret",
      applicationId: "12345678901234567",
      guildId: "guild",
      parentChannelIds: ["parent"],
      authorizedRoleIds: roles,
    },
    llm: {
      provider: "openai",
      apiKey: "secret",
      model: "model",
      maxOutputTokens: 100,
      contextBudget: 1000,
      requestTimeoutMs: 1000,
    },
    storage: { databasePath: ":memory:" },
    queue: { maxConcurrent: 1, maxPerThread: 5 },
  }) as unknown as BotConfig;

function fakeClient(member: any): any {
  return {
    user: { id: "bot" },
    guilds: { fetch: async () => ({ members: { fetch: async () => member } }) },
  };
}

test("authorized collaborators upload multiple attachments independently of chat, and revoked roles cannot ingest", async () => {
  const root = mkdtempSync(join(tmpdir(), "bwf-m2-adapter-"));
  const store = new BotStore({ dbPath: join(root, "bot.sqlite") });
  try {
    const session = store.reserveSession({ guildId: "guild", parentChannelId: "parent", creatorUserId: "creator", creationKey: "session" }); store.attachThread(session.id, "thread");
    const member = { roles: { cache: new Map([["role", true]]) } }, uploads: any[] = [], turns: any[] = [], notices: any[] = [];
    const guild = { id: "guild", members: { fetch: async () => member } };
    const thread = { id: "thread", parentId: "parent", isThread: () => true, send: async (input: any) => { notices.push(input); return { id: "ack" }; } };
    const client: any = { on: () => client, user: { id: "bot" }, guilds: { fetch: async () => guild } };
    const adapter = new DiscordAdapter({ client, config: config(), store, runtime: { enqueue: async (input: any) => { turns.push(input); } } as any,
      replayIngestor: { accept: async input => { expect(await input.authorize!()).toBe(true); uploads.push(input); return { accepted: input.attachments.length, rejected: 0 }; } } });
    const message = { id: "message", author: { id: "collaborator", bot: false }, guild, channel: thread, webhookId: null, content: "", createdTimestamp: Date.now(),
      attachments: new Map([["a", { id: "a", name: "../pro/one.REP", size: 100, url: "https://cdn.discordapp.com/attachments/1/2/one.rep" }], ["b", { id: "b", name: "two.rep", size: 100, url: "https://cdn.discordapp.com/attachments/1/3/two.rep" }]]) };
    await (adapter as any).onMessage(message);
    expect(uploads).toHaveLength(1); expect(uploads[0].attachments).toHaveLength(2); expect(uploads[0].userId).toBe("collaborator");
    expect(turns).toHaveLength(0); expect(notices[0].content).toContain("2 accepted");
    member.roles.cache.clear(); await (adapter as any).onMessage({ ...message, id: "revoked" }); expect(uploads).toHaveLength(1);
    member.roles.cache.set("role", true); await (adapter as any).onMessage({ ...message, id: "chat", attachments: new Map(), content: "ordinary chat" });
    expect(turns).toHaveLength(1); expect(turns[0].content).toBe("ordinary chat");
  } finally { store.close(); Bun.gc(true); rmSync(root, { recursive: true, force: true }); }
});

describe("Discord authorization", () => {
  test("authorizes current role and denies revocation or lookup failure", async () => {
    const member = { roles: { cache: new Map([["role", true]]) } };
    const auth = new DiscordAuthorization(fakeClient(member), config());
    expect(await auth.authorize({ guildId: "guild", userId: "user" })).toBe(
      true,
    );
    member.roles.cache.clear();
    expect(await auth.authorize({ guildId: "guild", userId: "user" })).toBe(
      false,
    );
    const failing = new DiscordAuthorization(
      {
        guilds: {
          fetch: async () => {
            throw new Error("gone");
          },
        },
      } as any,
      config(),
    );
    expect(await failing.authorize({ guildId: "guild", userId: "user" })).toBe(
      false,
    );
  });
});

function interaction(id: string, member: any, channel: any): any {
  return {
    id,
    user: { id: "user" },
    guild: { id: "guild", members: { fetch: async () => member } },
    channel,
    isChatInputCommand: () => true,
    commandName: "forge",
    options: { getSubcommand: () => "start", getString: () => "Test" },
    deferReply: async () => undefined,
    editReply: async () => undefined,
    reply: async () => undefined,
  };
}

test("DiscordAdapter starts one persisted authorized session and deduplicates retries", async () => {
  const root = mkdtempSync(join(tmpdir(), "bwf-discord-start-"));
  const store = new BotStore({ dbPath: join(root, "bot.sqlite") });
  const member = { roles: { cache: new Map([["role", true]]) } };
  const sent: any[] = [];
  const thread: any = {
    id: "thread",
    name: "Test",
    ownerId: "bot",
    parentId: "parent",
    isThread: () => true,
    messages: { fetch: async () => sent },
    send: async (x: any) => {
      const m = {
        id: String(sent.length + 1),
        author: { id: "bot" },
        content: x.content,
      };
      sent.push(m);
      return m;
    },
  };
  let creates = 0;
  const channel: any = {
    id: "parent",
    type: ChannelType.GuildText,
    threads: {
      fetchActive: async () => ({ threads: { find: () => undefined } }),
      create: async () => {
        creates++;
        return thread;
      },
    },
  };
  const client: any = {
    user: { id: "bot" },
    on: () => client,
    guilds: { fetch: async () => ({ members: { fetch: async () => member } }) },
    channels: { fetch: async () => thread },
    login: async () => "token",
    destroy: () => undefined,
  };
  const runtime: any = {
    start: async () => undefined,
    stop: () => undefined,
    enqueue: async () => true,
  };
  const adapter = new DiscordAdapter({
    client,
    config: config(),
    store,
    runtime,
  });
  await Promise.all([
    (adapter as any).onInteraction(interaction("same", member, channel)),
    (adapter as any).onInteraction(interaction("same", member, channel)),
  ]);
  expect(creates).toBe(1);
  expect(store.getSessionByThread("thread")?.creatorUserId).toBe("user");
  expect(sent.length).toBe(1);
  store.close();
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* Windows SQLite cleanup */
  }
});

test("DiscordAdapter denies unauthorized session creation", async () => {
  const root = mkdtempSync(join(tmpdir(), "bwf-discord-deny-"));
  const store = new BotStore({ dbPath: join(root, "bot.sqlite") });
  const channel: any = {
    id: "parent",
    type: ChannelType.GuildText,
    threads: {
      fetchActive: async () => ({ threads: { find: () => undefined } }),
      create: async () => {
        throw new Error("must not create");
      },
    },
  };
  const client: any = {
    user: { id: "bot" },
    on: () => client,
    channels: { fetch: async () => channel },
  };
  const adapter = new DiscordAdapter({
    client,
    config: config(),
    store,
    runtime: { start: async () => undefined, stop: () => undefined } as any,
  });
  await (adapter as any).onInteraction(
    interaction("denied", { roles: { cache: new Map() } }, channel),
  );
  expect(store.getSessionByThread("thread")).toBeNull();
  store.close();
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* cleanup */
  }
});

describe("Discord delivery", () => {
  test("keeps long Unicode responses within Discord's UTF-16 limit", async () => {
    const root = mkdtempSync(join(tmpdir(), "bwf-discord-unicode-"));
    const store = new BotStore({ dbPath: join(root, "bot.sqlite") });
    const sent: any[] = [];
    const thread: any = {
      isThread: () => true,
      messages: { fetch: async () => sent },
      send: async (input: any) => {
        const m = {
          id: String(sent.length + 1),
          author: { id: "bot" },
          content: input.content,
        };
        sent.push(m);
        return m;
      },
    };
    const client: any = {
      user: { id: "bot" },
      channels: { fetch: async () => thread },
    };
    const session = store.reserveSession({
      guildId: "guild",
      parentChannelId: "parent",
      creatorUserId: "user",
      creationKey: "unicode",
    });
    store.attachThread(session.id, "thread");
    store.enqueueUserMessage({
      sessionId: session.id,
      discordMessageId: "unicode-message",
      authorUserId: "user",
      content: "hello",
    });
    const turn = store.claimNextTurn(session.id)!;
    await new DiscordDelivery(client, store).send({
      threadId: "thread",
      turnId: String(turn.id),
      text: "🙂".repeat(2500),
    });
    expect(sent.length).toBeGreaterThan(1);
    expect(sent.every((message) => message.content.length <= 2000)).toBe(true);
    store.close();
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* SQLite release is asynchronous on Windows. */
    }
  });

  test("reconciles a send-before-checkpoint and ignores forged markers", async () => {
    const root = mkdtempSync(join(tmpdir(), "bwf-discord-"));
    const store = new BotStore({ dbPath: join(root, "bot.sqlite") });
    const sent: any[] = [
      {
        id: "forged",
        author: { id: "user" },
        content: "\u2063bf0000000\u2063",
      },
    ];
    const thread: any = {
      isThread: () => true,
      messages: { fetch: async () => sent },
      send: async (input: any) => {
        const m = {
          id: String(sent.length + 1),
          author: { id: "bot" },
          content: input.content,
        };
        sent.push(m);
        return m;
      },
    };
    const client: any = {
      user: { id: "bot" },
      channels: { fetch: async () => thread },
    };
    const session = store.reserveSession({
      guildId: "guild",
      parentChannelId: "parent",
      creatorUserId: "user",
      creationKey: "interaction",
    });
    store.attachThread(session.id, "thread");
    const queued = store.enqueueUserMessage({
      sessionId: session.id,
      discordMessageId: "message",
      authorUserId: "user",
      content: "hello",
    });
    const turn = store.claimNextTurn(session.id)!;
    const delivery = new DiscordDelivery(client, store);
    await delivery.send({
      threadId: "thread",
      turnId: String(turn.id),
      text: "answer",
      signal: undefined,
    });
    // Simulate the process dying after Discord accepted the message but before the DB checkpoint.
    store.db
      .query("DELETE FROM delivery_attempts WHERE turn_id=?")
      .run(turn.id);
    await delivery.send({
      threadId: "thread",
      turnId: String(turn.id),
      text: "answer",
      signal: undefined,
    });
    expect(sent).toHaveLength(2);
    expect(store.getDelivery(turn.id)[0]?.status).toBe("delivered");
    expect(queued.message.content).toBe("hello");
    store.close();
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* Windows may release SQLite handles asynchronously. */
    }
  });
});

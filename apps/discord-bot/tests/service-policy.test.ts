import { expect, test } from "bun:test";
import { renderDiscordServicePolicy } from "../src/service-policy.ts";

test("service policy grants only bot state and writable upload corpus", async () => {
  const env: Record<string, string | undefined> = {
    DISCORD_BOT_TOKEN: "secret", DISCORD_APPLICATION_ID: "12345678901234567", DISCORD_GUILD_ID: "12345678901234568",
    DISCORD_PARENT_CHANNEL_IDS: "12345678901234569", DISCORD_AUTHORIZED_ROLE_IDS: "12345678901234570", LLM_API_KEY: "key", LLM_MODEL: "model",
    DISCORD_BOT_DATABASE_PATH: "/srv/bw forge/state/bot.sqlite", LLM_MAX_OUTPUT_TOKENS: "128", LLM_CONTEXT_BUDGET: "4096", LLM_REQUEST_TIMEOUT_MS: "5000",
    LLM_MAX_CONCURRENT_TURNS: "2", MAX_MESSAGES_QUEUED_PER_THREAD: "10",
    BW_FORGE_CORPORA_JSON: JSON.stringify({ pro: { name: "Pro", database: "/srv/pro/db/corpus.sqlite", corpus_root: "/srv/pro", access: "read-only" }, community: { name: "Community", database: "/srv/community/db/corpus.sqlite", corpus_root: "/srv/community", access: "read-write" } }),
    BW_FORGE_DEFAULT_UPLOAD_CORPUS: "community", BW_FORGE_READABLE_CORPORA: "pro,community",
  };
  const policy = await renderDiscordServicePolicy(env, { validateFilesystem: false });
  expect(policy).toContain("ReadWritePaths=\"/srv/bw\\x20forge/state\"");
  expect(policy).toContain("\"/srv/community\"");
  expect(policy).toContain("ReadOnlyPaths=\"/srv/pro\"");
  expect(policy).not.toContain("ReadWritePaths=\"/srv/pro\"");
  await expect(renderDiscordServicePolicy({ ...env, DISCORD_BOT_DATABASE_PATH: "/srv/bot.sqlite" }, { validateFilesystem: false })).rejects.toThrow("contains a read-only corpus");
});

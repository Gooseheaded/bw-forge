import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config/index.ts";

const base: Record<string, string | undefined> = {
  DISCORD_BOT_TOKEN: "secret",
  DISCORD_APPLICATION_ID: "12345678901234567",
  DISCORD_GUILD_ID: "12345678901234568",
  DISCORD_PARENT_CHANNEL_IDS: "12345678901234569",
  DISCORD_AUTHORIZED_ROLE_IDS: "12345678901234570",
  LLM_API_KEY: "key",
  LLM_MODEL: "gpt-test",
  DISCORD_BOT_DATABASE_PATH: "./bot.sqlite",
  LLM_MAX_OUTPUT_TOKENS: "128",
  LLM_CONTEXT_BUDGET: "4096",
  LLM_REQUEST_TIMEOUT_MS: "5000",
  LLM_MAX_CONCURRENT_TURNS: "2",
  MAX_MESSAGES_QUEUED_PER_THREAD: "10",
};
describe("configuration", () => {
  test("loads validated settings", () => {
    const c = loadConfig(base);
    expect(c.discord.guildId).toBe(base.DISCORD_GUILD_ID!);
    expect(c.queue.maxConcurrent).toBe(2);
    expect(c.agent.enabled).toBe(false);
    expect(c.agent.diagnosticToolArguments).toBe(false);
  });
  test("controls opt-in tool argument diagnostics", () => {
    expect(loadConfig({ ...base, BW_FORGE_TOOL_ARGUMENT_DIAGNOSTICS: "true" }).agent.diagnosticToolArguments).toBe(true);
    expect(loadConfig({ ...base, BW_FORGE_TOOL_ARGUMENT_DIAGNOSTICS: "0" }).agent.diagnosticToolArguments).toBe(false);
    expect(() => loadConfig({ ...base, BW_FORGE_TOOL_ARGUMENT_DIAGNOSTICS: "maybe" })).toThrow("BW_FORGE_TOOL_ARGUMENT_DIAGNOSTICS");
  });
  test("requires a trusted MCP command and readable corpus when analysis is enabled", () => {
    expect(() => loadConfig({ ...base, BW_FORGE_AGENT_ENABLED: "true" })).toThrow("BW_FORGE_MCP_COMMAND");
    const corpora = JSON.stringify({ pro: { name: "Pro", database: "C:/pro/db.sqlite", corpus_root: "C:/pro", access: "read-only" } });
    const configured = loadConfig({ ...base, BW_FORGE_AGENT_ENABLED: "true", BW_FORGE_MCP_COMMAND: "bun", BW_FORGE_MCP_ARGS: '["apps/cli/src/main.ts","mcp"]', BW_FORGE_CORPORA_JSON: corpora, BW_FORGE_READABLE_CORPORA: "pro" });
    expect(configured.agent).toMatchObject({ enabled: true, mcpCommand: "bun", mcpArgs: ["apps/cli/src/main.ts", "mcp"], maxRounds: 4, turnTimeoutMs: 120000 });
    expect(() => loadConfig({ ...base, BW_FORGE_AGENT_ENABLED: "true", BW_FORGE_MCP_COMMAND: "bun" })).toThrow("READABLE_CORPORA");
  });
  test("validates M3 limits and stdio argument format", () => {
    for (const [key, value] of [["BW_FORGE_AGENT_ENABLED", "maybe"], ["BW_FORGE_AGENT_MAX_ROUNDS", "0"], ["BW_FORGE_AGENT_MAX_TOOL_CALLS", "33"], ["BW_FORGE_AGENT_TURN_TIMEOUT_MS", "1000"], ["BW_FORGE_MCP_ARGS", "not-json"]] as const)
      expect(() => loadConfig({ ...base, [key]: value })).toThrow();
  });
  test("defaults provider to OpenAI and accepts OpenRouter case-insensitively", () => {
    expect(loadConfig(base).llm.provider).toBe("openai");
    expect(
      loadConfig({ ...base, BW_FORGE_LLM_PROVIDER: "OpenRouter" }).llm.provider,
    ).toBe("openrouter");
    expect(
      loadConfig({ ...base, BW_FORGE_LLM_PROVIDER: "OPENAI" }).llm.provider,
    ).toBe("openai");
  });
  test("rejects unknown provider without echoing secrets", () => {
    const secret = "provider-secret";
    expect(() =>
      loadConfig({ ...base, BW_FORGE_LLM_PROVIDER: secret }),
    ).toThrow("supported providers");
    try {
      loadConfig({ ...base, BW_FORGE_LLM_PROVIDER: secret });
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });
  test("reports missing secret", () => {
    const e = { ...base };
    delete e.DISCORD_BOT_TOKEN;
    expect(() => loadConfig(e)).toThrow("DISCORD_BOT_TOKEN");
  });
  test("rejects invalid IDs and bounds", () => {
    expect(() => loadConfig({ ...base, DISCORD_GUILD_ID: "x" })).toThrow(
      "DISCORD_GUILD_ID",
    );
    expect(() =>
      loadConfig({ ...base, LLM_MAX_CONCURRENT_TURNS: "0" }),
    ).toThrow("LLM_MAX_CONCURRENT_TURNS");
  });
  test("rejects invalid role/channel IDs and numeric limits", () => {
    for (const [key, value] of [
      ["DISCORD_AUTHORIZED_ROLE_IDS", "bad"],
      ["DISCORD_PARENT_CHANNEL_IDS", "99999999999999999999"],
      ["LLM_REQUEST_TIMEOUT_MS", "999"],
      ["LLM_CONTEXT_BUDGET", "100"],
      ["LLM_MAX_OUTPUT_TOKENS", "1"],
      ["LLM_MAX_CONCURRENT_TURNS", "65"],
      ["MAX_MESSAGES_QUEUED_PER_THREAD", "1001"],
      ["BW_FORGE_LLM_TEMPERATURE", "3"],
    ] as const)
      expect(() => loadConfig({ ...base, [key]: value })).toThrow();
  });
  test("fails without LLM secret and never echoes secret values", () => {
    const secret = "sentinel-super-secret";
    const e = { ...base, LLM_API_KEY: undefined, DISCORD_BOT_TOKEN: secret };
    expect(() => loadConfig(e)).toThrow("LLM_API_KEY");
    try {
      loadConfig({ ...base, DISCORD_PARENT_CHANNEL_IDS: secret });
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });
});

export type LlmProviderName = "openai";
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface BotConfig {
  discord: {
    token: string;
    applicationId: string;
    guildId: string;
    parentChannelIds: string[];
    authorizedRoleIds: string[];
  };
  llm: {
    provider: LlmProviderName;
    apiKey: string;
    model: string;
    maxOutputTokens: number;
    contextBudget: number;
    requestTimeoutMs: number;
    temperature?: number;
  };
  storage: { databasePath: string };
  queue: { maxConcurrent: number; maxPerThread: number };
}

const snowflake = /^\d{17,20}$/;

function required(
  env: Record<string, string | undefined>,
  key: string,
): string {
  const value = env[key]?.trim();
  if (!value) throw new ConfigError(`Missing required configuration: ${key}`);
  return value;
}

function idList(
  env: Record<string, string | undefined>,
  key: string,
): string[] {
  const values = required(env, key)
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  if (
    !values.length ||
    values.some(
      (v) =>
        !snowflake.test(v) ||
        BigInt(v) === 0n ||
        BigInt(v) > 18446744073709551615n,
    )
  ) {
    throw new ConfigError(
      `${key} must be a comma-separated list of valid Discord snowflake IDs`,
    );
  }
  return [...new Set(values)];
}

function integer(
  env: Record<string, string | undefined>,
  key: string,
  min: number,
  max: number,
): number {
  const raw = required(env, key);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new ConfigError(
      `${key} must be an integer between ${min} and ${max}`,
    );
  return value;
}

/** Load and validate secrets and bounded operational settings from environment variables. */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): BotConfig {
  const provider = (env.BW_FORGE_LLM_PROVIDER ?? "openai").trim().toLowerCase();
  if (provider !== "openai")
    throw new ConfigError(
      "Unsupported BW_FORGE_LLM_PROVIDER; supported providers: openai",
    );
  const temperatureRaw = env.BW_FORGE_LLM_TEMPERATURE?.trim();
  let temperature: number | undefined;
  if (temperatureRaw) {
    temperature = Number(temperatureRaw);
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
      throw new ConfigError("BW_FORGE_LLM_TEMPERATURE must be between 0 and 2");
    }
  }
  const guildId = required(env, "DISCORD_GUILD_ID");
  const applicationId = required(env, "DISCORD_APPLICATION_ID");
  if (
    !snowflake.test(guildId) ||
    BigInt(guildId) === 0n ||
    BigInt(guildId) > 18446744073709551615n
  )
    throw new ConfigError(
      "DISCORD_GUILD_ID must be a valid Discord snowflake ID",
    );
  if (
    !snowflake.test(applicationId) ||
    BigInt(applicationId) === 0n ||
    BigInt(applicationId) > 18446744073709551615n
  )
    throw new ConfigError(
      "DISCORD_APPLICATION_ID must be a valid Discord snowflake ID",
    );
  return {
    discord: {
      token: required(env, "DISCORD_BOT_TOKEN"),
      applicationId,
      guildId,
      parentChannelIds: idList(env, "DISCORD_PARENT_CHANNEL_IDS"),
      authorizedRoleIds: idList(env, "DISCORD_AUTHORIZED_ROLE_IDS"),
    },
    llm: {
      provider,
      apiKey: required(env, "LLM_API_KEY"),
      model: required(env, "LLM_MODEL"),
      maxOutputTokens: integer(env, "LLM_MAX_OUTPUT_TOKENS", 16, 131072),
      contextBudget: integer(env, "LLM_CONTEXT_BUDGET", 1024, 1_000_000),
      requestTimeoutMs: integer(env, "LLM_REQUEST_TIMEOUT_MS", 1000, 300000),
      temperature,
    },
    storage: { databasePath: required(env, "DISCORD_BOT_DATABASE_PATH") },
    queue: {
      maxConcurrent: integer(env, "LLM_MAX_CONCURRENT_TURNS", 1, 64),
      maxPerThread: integer(env, "MAX_MESSAGES_QUEUED_PER_THREAD", 1, 1000),
    },
  };
}

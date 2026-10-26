export type LlmProviderName = "openai" | "openrouter";
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
  agent: {
    enabled: boolean;
    diagnosticToolArguments: boolean;
    mcpCommand?: string;
    mcpArgs: string[];
    maxRounds: number;
    maxToolCalls: number;
    maxParallelCalls: number;
    turnTimeoutMs: number;
    toolTimeoutMs: number;
    maxToolResultBytes: number;
  };
  corpus?: {
    corpora: Record<string, { name: string; database: string; corpusRoot: string; access: "read-only" | "read-write" }>;
    defaultUploadCorpus?: string;
    readableCorpora: string[];
    maxAttachmentBytes: number;
    maxDownloads: number;
    downloadTimeoutMs: number;
    pollIntervalMs: number;
    deliveryRetryLimit: number;
    maxPendingPerSession: number;
  };
}

const snowflake = /^\d{17,20}$/;

// JSON.parse discards duplicate object keys. Reject duplicate corpus IDs before
// parsing the top-level object; escaped spellings of the same ID count too.
function rejectDuplicateCorpusKeys(json: string) {
  let depth = 0;
  const ids = new Set<string>();
  for (let i = 0; i < json.length; i++) {
    const char = json[i];
    if (char === '"') {
      const start = i++;
      while (i < json.length && json[i] !== '"') { if (json[i] === "\\") i++; i++; }
      let next = i + 1;
      while (/\s/.test(json[next] ?? "" ) && next < json.length) next++;
      if (depth === 1 && json.trimStart().startsWith("{") && json[next] === ":") {
        const id = JSON.parse(json.slice(start, i + 1)) as string;
        if (ids.has(id)) throw new ConfigError("Duplicate corpus ID in BW_FORGE_CORPORA_JSON");
        ids.add(id);
      }
    } else if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") depth--;
  }
}

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

function optionalBool(env: Record<string, string | undefined>, key: string, fallback: boolean): boolean {
  const raw = env[key]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === "true" || raw === "1" || raw === "yes") return true;
  if (raw === "false" || raw === "0" || raw === "no") return false;
  throw new ConfigError(`${key} must be true or false`);
}

/** Load and validate secrets and bounded operational settings from environment variables. */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): BotConfig {
  const provider = (env.BW_FORGE_LLM_PROVIDER ?? "openai").trim().toLowerCase();
  if (provider !== "openai" && provider !== "openrouter")
    throw new ConfigError(
      "Unsupported BW_FORGE_LLM_PROVIDER; supported providers: openai, openrouter",
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
  let corpora: NonNullable<BotConfig["corpus"]>["corpora"] = {};
  const corpusJson = env.BW_FORGE_CORPORA_JSON?.trim();
  if (corpusJson) {
    let parsed: unknown;
    try { parsed = JSON.parse(corpusJson); } catch { throw new ConfigError("BW_FORGE_CORPORA_JSON must be valid JSON"); }
    rejectDuplicateCorpusKeys(corpusJson);
    if (!parsed || typeof parsed !== "object") throw new ConfigError("BW_FORGE_CORPORA_JSON must be an object or array");
    const corpusEntries: Array<[string, unknown]> = Array.isArray(parsed)
      ? parsed.map((value, index) => [typeof value === "object" && value !== null && typeof (value as Record<string, unknown>).id === "string" ? (value as Record<string, unknown>).id as string : `#${index}`, value])
      : Object.entries(parsed as Record<string, unknown>);
    const seenIds = new Set<string>();
    for (const [id, value] of corpusEntries) {
      if (seenIds.has(id)) throw new ConfigError("Duplicate corpus ID in BW_FORGE_CORPORA_JSON");
      seenIds.add(id);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) throw new ConfigError(`Invalid corpus ID: ${id}`);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new ConfigError(`Invalid corpus configuration: ${id}`);
      const item = value as Record<string, unknown>;
      const name = typeof item.name === "string" && item.name.trim() ? item.name.trim() : id;
      const database = typeof item.database === "string" ? item.database.trim() : "";
      const corpusRoot = typeof item.corpus_root === "string" ? item.corpus_root.trim() : typeof item.corpusRoot === "string" ? item.corpusRoot.trim() : "";
      const access = item.access === "read-only" || item.access === "read-write" ? item.access : undefined;
      if (!database || !corpusRoot || !access) throw new ConfigError(`Corpus ${id} requires name, database, corpus_root, and access`);
      corpora[id] = { name, database, corpusRoot, access };
    }
  }
  const readableCorpora = (env.BW_FORGE_READABLE_CORPORA ?? Object.keys(corpora).join(",")).split(",").map(v => v.trim()).filter(Boolean);
  const defaultUploadCorpus = env.BW_FORGE_DEFAULT_UPLOAD_CORPUS?.trim() || undefined;
  const boundedOptional = (key: string, fallback: number, min: number, max: number) => {
    const raw = env[key]?.trim(); if (!raw) return fallback;
    const value = Number(raw); if (!Number.isSafeInteger(value) || value < min || value > max) throw new ConfigError(`${key} must be an integer between ${min} and ${max}`); return value;
  };
  const agentEnabled = optionalBool(env, "BW_FORGE_AGENT_ENABLED", false);
  const mcpCommand = env.BW_FORGE_MCP_COMMAND?.trim() || undefined;
  let mcpArgs: string[] = [];
  if (env.BW_FORGE_MCP_ARGS?.trim()) {
    try {
      const parsed: unknown = JSON.parse(env.BW_FORGE_MCP_ARGS);
      if (!Array.isArray(parsed) || parsed.some((arg) => typeof arg !== "string")) throw new Error();
      mcpArgs = parsed as string[];
    } catch { throw new ConfigError("BW_FORGE_MCP_ARGS must be a JSON array of strings"); }
  }
  if (agentEnabled && !mcpCommand) throw new ConfigError("BW_FORGE_MCP_COMMAND is required when BW_FORGE_AGENT_ENABLED is enabled");
  if (agentEnabled && !readableCorpora.length) throw new ConfigError("BW_FORGE_READABLE_CORPORA must include at least one corpus when analytical tools are enabled");
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
    agent: {
      enabled: agentEnabled,
      diagnosticToolArguments: optionalBool(env, "BW_FORGE_TOOL_ARGUMENT_DIAGNOSTICS", false),
      mcpCommand,
      mcpArgs,
      maxRounds: boundedOptional("BW_FORGE_AGENT_MAX_ROUNDS", 4, 1, 12),
      maxToolCalls: boundedOptional("BW_FORGE_AGENT_MAX_TOOL_CALLS", 6, 1, 32),
      maxParallelCalls: boundedOptional("BW_FORGE_AGENT_MAX_PARALLEL_TOOLS", 2, 1, 8),
      turnTimeoutMs: boundedOptional("BW_FORGE_AGENT_TURN_TIMEOUT_MS", 120000, 5000, 600000),
      toolTimeoutMs: boundedOptional("BW_FORGE_AGENT_TOOL_TIMEOUT_MS", 10000, 1000, 120000),
      maxToolResultBytes: boundedOptional("BW_FORGE_AGENT_MAX_TOOL_RESULT_BYTES", 24000, 1024, 256000),
    },
    corpus: {
      corpora,
      defaultUploadCorpus,
      readableCorpora,
      maxAttachmentBytes: boundedOptional("BW_FORGE_MAX_REPLAY_BYTES", 64 * 1024 * 1024, 1024, 1024 * 1024 * 1024),
      maxDownloads: boundedOptional("BW_FORGE_MAX_REPLAY_DOWNLOADS", 2, 1, 32),
      downloadTimeoutMs: boundedOptional("BW_FORGE_REPLAY_DOWNLOAD_TIMEOUT_MS", 120000, 1000, 900000),
      pollIntervalMs: boundedOptional("BW_FORGE_REPLAY_POLL_INTERVAL_MS", 5000, 250, 300000),
      deliveryRetryLimit: boundedOptional("BW_FORGE_REPORT_DELIVERY_RETRIES", 5, 1, 100),
      maxPendingPerSession: boundedOptional("BW_FORGE_MAX_PENDING_REPLAYS_PER_SESSION", 8, 1, 1000),
    },
  };
}

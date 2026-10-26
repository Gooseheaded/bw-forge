import { ConfigError, loadConfig } from "./config/index.ts";
import { TurnRuntime, SqliteRuntimeStore } from "./agent/runtime.ts";
import { OpenAiResponsesProvider } from "./llm/openai.ts";
import { BotStore } from "./storage/store.ts";
import { acquireProcessLock } from "./storage/process-lock.ts";
import {
  DiscordAdapter,
  DiscordAuthorization,
  DiscordDelivery,
  createDiscordClient,
} from "./discord/adapter.ts";

/** Production entry point. The process owns one SQLite database and one Discord client. */
export async function startBot(
  env: Record<string, string | undefined> = process.env,
): Promise<DiscordAdapter> {
  const config = loadConfig(env);
  const lock = acquireProcessLock(config.storage.databasePath);
  const releaseLock = () => lock.release();
  let store: BotStore;
  try {
    store = new BotStore({
      dbPath: lock.databasePath,
      maxQueuedPerThread: config.queue.maxPerThread,
    });
  } catch (error) {
    releaseLock();
    throw error;
  }
  const client = createDiscordClient();
  const authorization = new DiscordAuthorization(client, config);
  const delivery = new DiscordDelivery(client, store);
  const runtimeStore = new SqliteRuntimeStore(store, config.llm.contextBudget);
  const provider = new OpenAiResponsesProvider(config.llm.apiKey);
  const runtime = new TurnRuntime({
    maxConcurrent: config.queue.maxConcurrent,
    requestTimeoutMs: config.llm.requestTimeoutMs,
    model: config.llm.model,
    maxOutputTokens: config.llm.maxOutputTokens,
    temperature: config.llm.temperature,
    providerName: config.llm.provider,
    provider,
    store: runtimeStore,
    authorization,
    delivery,
    log: (message, details) => console.error(message, details ?? {}),
  });
  const adapter = new DiscordAdapter({
    client,
    config,
    store,
    runtime,
    onStopped: () => {
      releaseLock();
      process.removeListener("SIGINT", shutdown);
      process.removeListener("SIGTERM", shutdown);
    },
  });
  const shutdown = () => {
    void adapter.stop().catch(() => {
      console.error("Discord bot shutdown failed");
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    await adapter.start();
  } catch {
    await adapter.stop();
    throw new Error(
      "Discord connection failed; check credentials, intents, and network access.",
    );
  }
  return adapter;
}

if (import.meta.main) {
  startBot().catch((error) => {
    console.error(
      error instanceof ConfigError
        ? error.message
        : "Discord bot failed to start; check credentials, permissions, network access, and the state directory.",
    );
    process.exitCode = 1;
  });
}

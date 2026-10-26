import { ConfigError, loadConfig } from "./config/index.ts";
import { TurnRuntime, SqliteRuntimeStore } from "./agent/runtime.ts";
import { createLlmProvider } from "./llm/factory.ts";
import { BotStore } from "./storage/store.ts";
import { acquireProcessLock } from "./storage/process-lock.ts";
import {
  DiscordAdapter,
  DiscordAuthorization,
  DiscordDelivery,
  DiscordReportDelivery,
  createDiscordClient,
} from "./discord/adapter.ts";
import { createCorpusRegistry } from "./corpus/registry.ts";
import { CorpusCore } from "./corpus/core.ts";
import { ReplayCoordinator, type UploadAttachment } from "./ingestion/coordinator.ts";
import { dirname, join } from "node:path";

/** Production entry point. The process owns one SQLite database and one Discord client. */
export async function startBot(
  env: Record<string, string | undefined> = process.env,
): Promise<DiscordAdapter> {
  const config = loadConfig(env);
  const corpusConfig = config.corpus;
  const registry = createCorpusRegistry(config);
  try { if (registry.corpora.size) await registry.validateFilesystem(); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    console.error(JSON.stringify({ event: "corpus_configuration_failed", ...(code ? { code } : {}) }));
    throw new ConfigError("Corpus registry paths, layout or filesystem permissions are invalid; check configured roots and database access.");
  }
  const lock = acquireProcessLock(config.storage.databasePath);
  const releaseLock = () => lock.release();
  let store: BotStore;
  try {
    store = new BotStore({
      dbPath: lock.databasePath,
      maxQueuedPerThread: config.queue.maxPerThread,
    });
  } catch (error) {
    console.error(JSON.stringify({ event: "bot_storage_failed", code: (error as NodeJS.ErrnoException).code ?? "SQLITE_OPEN_OR_MIGRATION" }));
    releaseLock();
    throw error;
  }
  const client = createDiscordClient();
  const authorization = new DiscordAuthorization(client, config);
  const delivery = new DiscordDelivery(client, store);
  const runtimeStore = new SqliteRuntimeStore(store, config.llm.contextBudget);
  const provider = createLlmProvider(config.llm);
  let replayIngestor: import("./discord/adapter.ts").ReplayIngestor | undefined;
  if (corpusConfig?.defaultUploadCorpus && registry) {
    const core = new CorpusCore(registry);
    const reportTransport = new DiscordReportDelivery(client, store);
    const coordinator = new ReplayCoordinator({
      store,
      download: {
        maxBytes: corpusConfig.maxAttachmentBytes,
        timeoutMs: corpusConfig.downloadTimeoutMs,
        tempRoot: join(dirname(lock.databasePath), "uploads"),
      },
      pollIntervalMs: corpusConfig.pollIntervalMs,
      maxDeliveryAttempts: corpusConfig.deliveryRetryLimit,
      maxDownloads: corpusConfig.maxDownloads,
      maxPendingPerSession: corpusConfig.maxPendingPerSession,
      log: (event, details) => console.error(JSON.stringify({ event, ...details })),
      resolveAttachment: async (upload) => {
        const session = store.getSession(upload.sessionId); if (!session?.threadId) return null;
        const channel = await client.channels.fetch(session.threadId);
        if (!channel?.isThread() || channel.guildId !== session.guildId || channel.parentId !== session.parentChannelId) return null;
        const message = await channel.messages.fetch(upload.discordMessageId);
        if (message.author.id !== upload.userId || message.webhookId) return null;
        const attachment = message.attachments.get(upload.attachmentId);
        return attachment ? { id: attachment.id, name: attachment.name, size: attachment.size, url: attachment.url, contentType: attachment.contentType ?? undefined } : null;
      },
      authorizeUpload: async (upload) => {
        const session = store.getSession(upload.sessionId); return !!session && !!(await authorization.authorize({ guildId: session.guildId, userId: upload.userId }));
      },
      onFailure: async (upload, message) => {
        const session = store.getSession(upload.sessionId); if (!session?.threadId) throw new Error("Session thread unavailable");
        const channel = await client.channels.fetch(session.threadId); if (!channel?.isThread()) throw new Error("Session thread unavailable");
        const marker = `\u2063bf-upload-failure-${upload.id}\u2063`;
        const history = await channel.messages.fetch({ limit: 100 });
        if (history.find((m: any) => m.author?.id === client.user?.id && m.content?.includes(marker))) return;
        await channel.send({ content: `${message.slice(0, 400)} ${marker}`, nonce: `bff${upload.id}`, enforceNonce: true, allowedMentions: { parse: [], repliedUser: false } });
      },
      onReportReady: async (input) => reportTransport.deliver({
        ...input,
        corpusRoot: registry.get(input.corpusId).corpusRoot,
      }),
      gateway: {
        async registerReplay(input) {
          const registered = await core.registerAndEnqueue({ corpusId: input.corpusId, replayPath: input.filePath, sourceRef: input.idempotencyKey });
          return { replaySha256: registered.replaySha256, jobId: registered.jobKey, state: "queued" as const };
        },
        async getJob(input) {
          const shown = await core.show(input.corpusId, input.jobId);
          const job = shown.job;
          let artifactPath: string | undefined;
          if (job.status === "succeeded") {
            artifactPath = await core.reportPath({ corpusId: input.corpusId, replaySha256: job.replaySha256, jobKey: input.jobId }).catch(() => undefined);
          }
          return { state: job.status, artifactPath, error: job.lastError?.message };
        },
      },
    });
    replayIngestor = {
      async accept(input) {
        let accepted = 0, rejected = 0;
        for (const attachment of input.attachments) {
          if (store.getReplayUploadByAttachment(input.messageId, attachment.id)) continue;
          try {
            const result = await coordinator.accept({ sessionId: input.sessionId, threadId: input.threadId, messageId: input.messageId,
              userId: input.userId, corpusId: corpusConfig.defaultUploadCorpus!, attachment: attachment as UploadAttachment, authorize: input.authorize });
            result.state === "failed" ? rejected++ : accepted++;
          } catch {
            rejected++;
            console.error(JSON.stringify({ event: "upload_rejected", sessionId: input.sessionId, attachmentId: attachment.id }));
          }
        }
        return { accepted, rejected };
      },
      start: () => coordinator.start(),
      stop: () => coordinator.stop(),
    };
  }
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
    replayIngestor,
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
  } catch (error) {
    console.error(JSON.stringify({ event: "discord_connection_failed", code: safeErrorCode(error) }));
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
        : `Discord bot failed to start (${safeErrorCode(error)}); check credentials, permissions, network access, and the state directory.`,
    );
    process.exitCode = 1;
  });
}

function safeErrorCode(error: unknown): string | number {
  const value = (error as { code?: unknown; name?: unknown } | null)?.code ?? (error as Error | null)?.name;
  return typeof value === "number" ? value : typeof value === "string" && /^[A-Za-z_0-9-]{1,80}$/.test(value) ? value : "UNKNOWN";
}

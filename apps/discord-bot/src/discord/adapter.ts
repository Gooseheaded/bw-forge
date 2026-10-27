import {
  ChannelType,
  Client,
  AttachmentBuilder,
  GatewayIntentBits,
  Partials,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
  type Message,
  type TextChannel,
} from "discord.js";
import type { BotConfig } from "../config/index.ts";
import { BotStore } from "../storage/store.ts";
import type {
  RuntimeAuthorization,
  RuntimeDelivery,
  TurnRuntime,
} from "../agent/runtime.ts";
import { createHash } from "node:crypto";
import { realpath, lstat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** Boundary for deterministic replay ingestion. The coordinator owns downloads,
 * corpus registration, job observation, and durable upload state. */
export interface ReplayIngestor {
  accept(input: {
    sessionId: number;
    threadId: string;
    messageId: string;
    userId: string;
    attachments: readonly {
      id: string;
      name: string;
      size: number;
      url: string;
      contentType?: string | null;
    }[];
    authorized: boolean;
    authorize?: () => Promise<boolean>;
  }): Promise<{ accepted: number; rejected: number }>;
  stop?(): void | Promise<void>;
  start?(): void;
}

const MAX_DISCORD_MESSAGE = 2_000;
function marker(turnId: string, chunk: number): string {
  return `\u2063bf${createHash("sha256").update(`${turnId}:${chunk}`).digest("hex").slice(0, 24)}\u2063`;
}
function shortNonce(value: string): string {
  return `bf-${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

/** Fetches current membership on every check so role revocation takes effect promptly. */
export class DiscordAuthorization implements RuntimeAuthorization {
  constructor(
    private readonly client: Client,
    private readonly config: BotConfig,
  ) {}

  async authorize(input: {
    guildId: string;
    userId: string;
  }): Promise<boolean> {
    if (input.guildId !== this.config.discord.guildId) return false;
    try {
      const guild = await this.client.guilds.fetch(input.guildId);
      const member = await guild.members.fetch({
        user: input.userId,
        force: true,
      });
      return this.hasRole(member);
    } catch {
      return false;
    }
  }

  async memberAuthorized(
    guild: Guild,
    userId: string,
  ): Promise<GuildMember | null> {
    if (guild.id !== this.config.discord.guildId) return null;
    try {
      const member = await guild.members.fetch({ user: userId, force: true });
      return this.hasRole(member) ? member : null;
    } catch {
      return null;
    }
  }

  private hasRole(member: GuildMember): boolean {
    return this.config.discord.authorizedRoleIds.some((id) =>
      member.roles.cache.has(id),
    );
  }
}

function chunks(text: string): string[] {
  if (!text) return ["(The analyst returned an empty response.)"];
  const result: string[] = [];
  // Leave room for the marker and synthetic code-fence closures/reopenings.
  const limit = MAX_DISCORD_MESSAGE - 128;
  let offset = 0;
  let fence: string | undefined;
  while (offset < text.length) {
    let end = Math.min(text.length, offset + limit);
    if (end < text.length) {
      if (/^[\uDC00-\uDFFF]$/.test(text[end])) end--;
      const newline = text.lastIndexOf("\n", end - 1);
      if (newline > offset + limit / 2) end = newline + 1;
    }
    const raw = text.slice(offset, end);
    const prefix = fence === undefined ? "" : `\`\`\`${fence}\n`;
    for (const match of raw.matchAll(/^```([^\n]*)$/gm)) {
      fence = fence === undefined ? match[1].trim().slice(0, 32) : undefined;
    }
    result.push(prefix + raw + (fence === undefined ? "" : "\n```"));
    offset = end;
  }
  return result;
}

/** Durable, idempotent Discord response delivery. */
export class DiscordDelivery implements RuntimeDelivery {
  constructor(
    private readonly client: Client,
    private readonly store: BotStore,
  ) {}

  async send(input: {
    threadId: string;
    text: string;
    turnId: string;
    signal?: AbortSignal;
  }): Promise<void> {
    const thread = await this.client.channels.fetch(input.threadId);
    if (!thread || !thread.isThread())
      throw new Error("session thread is unavailable");
    const parts = chunks(input.text);
    const existing = this.store.getDelivery(Number(input.turnId));
    for (let index = 0; index < parts.length; index++) {
      if (input.signal?.aborted) throw new Error("delivery cancelled");
      const done = existing.find(
        (entry) => entry.chunkIndex === index && entry.status === "delivered",
      );
      if (done) continue;
      const nonce = marker(input.turnId, index);
      // Record before recovery lookup: a crash after send and before checkpoint is recoverable.
      this.store.recordDeliveryAttempt(Number(input.turnId), index);
      const history = await thread.messages.fetch({ limit: 100 });
      const found = history.find(
        (message) =>
          message.author.id === this.client.user?.id &&
          message.content.includes(nonce),
      );
      if (found) {
        this.store.markDeliveryDelivered(Number(input.turnId), index, found.id);
        continue;
      }
      const discordNonce = `bf${createHash("sha256").update(`${input.turnId}:${index}`).digest("hex").slice(0, 20)}`;
      const sent = await thread.send({
        content: `${parts[index]}\n${nonce}`,
        nonce: discordNonce,
        enforceNonce: true,
        allowedMentions: { parse: [], repliedUser: false },
      });
      this.store.markDeliveryDelivered(Number(input.turnId), index, sent.id);
    }
  }

  async failure(input: {
    threadId: string;
    turnId: string;
    signal?: AbortSignal;
  }): Promise<void> {
    const thread = await this.client.channels.fetch(input.threadId);
    if (!thread || !thread.isThread() || input.signal?.aborted) return;
    await thread.send({
      content: "I couldn't complete that request. Please try again later.",
      allowedMentions: { parse: [], repliedUser: false },
    });
  }
}

/** Durable publication delivery for standalone reports. Paths are checked against
 * the configured corpus root before being handed to discord.js. */
export class DiscordReportDelivery {
  constructor(
    private readonly client: Client,
    private readonly store: BotStore,
    // Discord's bot upload limit can remain 10 MiB even where the client UI
    // advertises larger limits; use the conservative API limit.
    private readonly maxBytes = 10 * 1024 * 1024,
  ) {}

  async deliver(input: {
    uploadId: number;
    threadId: string;
    artifactPath: string;
    corpusRoot: string;
    label: string;
  }): Promise<string> {
    const delivery = this.store.ensureReportDelivery(input.uploadId, input.threadId, input.artifactPath);
    if (delivery.state === "delivered" && delivery.discordMessageId) return delivery.discordMessageId;
    const root = await realpath(resolve(input.corpusRoot));
    const artifact = await realpath(resolve(input.artifactPath));
    const rel = relative(root, artifact);
    if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`))
      throw new Error("published report is outside the corpus artifact root");
    const requested = resolve(input.artifactPath);
    if ((process.platform === "win32" ? artifact.toLowerCase() !== requested.toLowerCase() : artifact !== requested)) throw new Error("published report contains a symlink");
    const info = await lstat(artifact);
    if (!info.isFile()) throw new Error("published report is not a regular file");
    if (info.size > this.maxBytes) throw new Error(`published report exceeds Discord upload limit (${this.maxBytes} bytes)`);
    const channel = await this.client.channels.fetch(input.threadId);
    if (!channel?.isThread()) throw new Error("session thread is unavailable");
    const marker = `\u2063bf-report-${createHash("sha256").update(String(input.uploadId)).digest("hex").slice(0, 24)}\u2063`;
    const history = await channel.messages.fetch({ limit: 100 });
    const existing = history.find((message: any) => message.author?.id === this.client.user?.id && message.content?.includes(marker));
    if (existing) {
      this.store.markReportDelivered(input.uploadId, existing.id);
      return existing.id;
    }
    const sent = await channel.send({
      content: `Analysis complete: ${input.label.replace(/[\r\n`*_~|<>]/g, "_").slice(0, 120)} (#${this.sessionReplayNumber(input.uploadId)}). Your HTML report is attached. ${marker}`,
      nonce: `bfr${createHash("sha256").update(String(input.uploadId)).digest("hex").slice(0, 20)}`,
      enforceNonce: true,
      files: [new AttachmentBuilder(artifact, { name: `${input.label.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80)}.html` })],
      allowedMentions: { parse: [], repliedUser: false },
    });
    this.store.markReportDelivered(input.uploadId, sent.id);
    return sent.id;
  }
  private sessionReplayNumber(uploadId: number): number {
    const upload = this.store.getReplayUpload(uploadId)!;
    const replays = this.store.db.query("SELECT corpus_id,replay_sha256 FROM session_replays WHERE session_id=? ORDER BY first_associated_at,rowid").all(upload.sessionId) as { corpus_id: string; replay_sha256: string }[];
    const index = replays.findIndex(replay => replay.corpus_id === upload.corpusId && replay.replay_sha256 === upload.replaySha256);
    return index >= 0 ? index + 1 : uploadId;
  }
}

export interface DiscordAdapterOptions {
  client?: Client;
  config: BotConfig;
  store: BotStore;
  runtime: TurnRuntime;
  onStopped?: () => void | Promise<void>;
  replayIngestor?: ReplayIngestor;
}

/** Discord event adapter. All authorization and durable state remains outside discord.js. */
export class DiscordAdapter {
  readonly client: Client;
  readonly authorization: DiscordAuthorization;
  readonly delivery: DiscordDelivery;
  readonly reportDelivery: DiscordReportDelivery;
  private stopping = false;
  private readonly messageChains = new Map<string, Promise<void>>();
  private readonly interactions = new Map<string, Promise<void>>();

  constructor(private readonly options: DiscordAdapterOptions) {
    this.client =
      options.client ??
      new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.MessageContent,
          GatewayIntentBits.GuildMembers,
        ],
        partials: [Partials.Channel],
      });
    this.authorization = new DiscordAuthorization(this.client, options.config);
    this.delivery = new DiscordDelivery(this.client, options.store);
    this.reportDelivery = new DiscordReportDelivery(this.client, options.store);
    this.client.on(
      "interactionCreate",
      (interaction) =>
        void this.onInteraction(
          interaction as ChatInputCommandInteraction,
        ).catch(() => undefined),
    );
    this.client.on(
      "messageCreate",
      (message) => void this.onMessage(message).catch(() => undefined),
    );
    this.client.on("error", () =>
      console.error("Discord gateway error; reconnect will be attempted"),
    );
  }

  async start(): Promise<void> {
    await this.client.login(this.options.config.discord.token);
    this.options.replayIngestor?.start?.();
    await this.options.runtime.start();
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    try {
      await this.options.runtime.stop();
      await this.options.replayIngestor?.stop?.();
    } finally {
      await this.client.destroy();
      this.options.store.close();
      await this.options.onStopped?.();
    }
  }

  private async onInteraction(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    if (this.stopping) return;
    if (
      !interaction.isChatInputCommand() ||
      interaction.commandName !== "forge" ||
      interaction.options.getSubcommand(false) !== "start"
    )
      return;
    // Concurrent redelivery shares one operation. Durable reservation/reconciliation handles restarts.
    const pending = this.interactions.get(interaction.id);
    if (pending) return pending;
    const task = this.startInteraction(interaction);
    this.interactions.set(interaction.id, task);
    try {
      await task;
    } finally {
      if (this.interactions.get(interaction.id) === task)
        this.interactions.delete(interaction.id);
    }
  }

  private async ensureWelcome(
    threadId: string,
    sessionId: number,
  ): Promise<void> {
    const key = `welcome:${sessionId}`;
    if (this.options.store.getMessageByDiscordId(key)) return;
    const thread = await this.client.channels.fetch(threadId);
    if (!thread?.isThread()) throw new Error("session thread unavailable");
    const welcomeMarker = `\u2063${shortNonce(key)}\u2063`;
    const history = await thread.messages.fetch({ limit: 100 });
    if (
      !history.find(
        (m) =>
          m.author.id === this.client.user?.id &&
          m.content.endsWith(welcomeMarker),
      )
    ) {
      await thread.send({
          content: `Welcome to BW Forge. Ask questions about Brood War strategy. Upload .rep files here for asynchronous HTML analysis; replay-aware answers use analytical tools when the operator has enabled them.${welcomeMarker}`,
        nonce: createHash("sha256").update(key).digest("hex").slice(0, 24),
        enforceNonce: true,
        allowedMentions: { parse: [], repliedUser: false },
      });
    }
    this.options.store.db
      .query(
        "INSERT OR IGNORE INTO messages(session_id,discord_message_id,author_user_id,role,content,created_at) VALUES(?,?,?,'system',?,?)",
      )
      .run(
        sessionId,
        key,
        "bot",
        "Welcome delivered",
        new Date().toISOString(),
      );
  }

  private async startInteraction(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    if (
      !interaction.guild ||
      interaction.guild.id !== this.options.config.discord.guildId
    ) {
      await interaction.reply({
        content: "This command is unavailable here.",
        ephemeral: true,
      });
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    const member = await this.authorization.memberAuthorized(
      interaction.guild,
      interaction.user.id,
    );
    if (!member) {
      await interaction.editReply("You are not authorized to use BW Forge.");
      return;
    }
    const channel = interaction.channel;
    if (
      !channel ||
      channel.type !== ChannelType.GuildText ||
      !this.options.config.discord.parentChannelIds.includes(channel.id)
    ) {
      await interaction.editReply(
        "Start a session in a configured BW Forge channel.",
      );
      return;
    }
    const title = interaction.options.getString("name")?.trim() || undefined;
    const reserved = this.options.store.reserveSession({
      guildId: interaction.guild.id,
      parentChannelId: channel.id,
      creatorUserId: interaction.user.id,
      title,
      creationKey: interaction.id,
    });
    try {
      if (reserved.threadId) {
        await this.ensureWelcome(reserved.threadId, reserved.id);
        await interaction.editReply(`Your session is <#${reserved.threadId}>.`);
        return;
      }
      const creationNonce = shortNonce(interaction.id);
      // A reservation may survive a crash between Discord creation and attachThread.
      // Reconcile active threads by the deterministic nonce before creating another one.
      const active = await (channel as TextChannel).threads.fetchActive();
      const existing = active.threads.find(
        (candidate) =>
          candidate.ownerId === this.client.user?.id &&
          candidate.parentId === channel.id &&
          candidate.name.endsWith(` · ${creationNonce}`),
      );
      const thread =
        existing ??
        (await (channel as TextChannel).threads.create({
          name: `${(title || "BW Forge session").slice(0, 69)} · ${creationNonce}`,
          type: ChannelType.PublicThread,
          reason: "BW Forge session",
        }));
      this.options.store.attachThread(reserved.id, thread.id);
      await this.ensureWelcome(thread.id, reserved.id);
      await interaction.editReply(`Your session is <#${thread.id}>.`);
    } catch (error) {
      await interaction.editReply(
        "I couldn't create the session thread. Check the bot's channel and thread permissions.",
      );
    }
  }

  private async onMessage(message: Message): Promise<void> {
    if (
      this.stopping ||
      message.author.bot ||
      message.webhookId ||
      !message.guild ||
      !message.channel.isThread()
    )
      return;
    const session = this.options.store.getSessionByThread(message.channel.id);
    if (
      !session ||
      session.status !== "active" ||
      message.guild.id !== this.options.config.discord.guildId ||
      session.guildId !== message.guild.id ||
      session.parentChannelId !== message.channel.parentId ||
      !this.options.config.discord.parentChannelIds.includes(
        session.parentChannelId,
      )
    )
      return;
    const previous =
      this.messageChains.get(message.channel.id) ?? Promise.resolve();
    let current!: Promise<void>;
    current = previous
      .catch(() => undefined)
      .then(async () => {
        if (this.stopping) return;
        if (
          !(await this.authorization.memberAuthorized(
            message.guild!,
            message.author.id,
          ))
        )
          return;
        if (message.attachments.size > 0 && this.options.replayIngestor) {
          const attachments = [...message.attachments.values()].map((a) => ({
            id: a.id,
            name: a.name ?? "attachment.rep",
            size: a.size ?? 0,
            url: a.url,
            contentType: a.contentType,
          }));
          try {
            const result = await this.options.replayIngestor.accept({
              sessionId: session.id,
              threadId: message.channel.id,
              messageId: message.id,
              userId: message.author.id,
              attachments,
              authorized: true,
              authorize: () => this.authorization.authorize({ guildId: message.guild!.id, userId: message.author.id }),
            });
            const accepted = result.accepted;
            await (message.channel as TextChannel).send({
              content: accepted > 0
                ? `Replay received (${accepted} accepted${result.rejected ? `, ${result.rejected} rejected` : ""}). Analysis will run asynchronously and the HTML report will be posted here.`
                : "No valid .rep attachments were accepted.",
              allowedMentions: { parse: [], repliedUser: false },
            });
          } catch (error) {
            console.error(JSON.stringify({ event: "replay_ingestion_failed", code: safeErrorCode(error) }));
            await (message.channel as TextChannel).send({ content: "Replay uploads could not be accepted; please try again later.", allowedMentions: { parse: [], repliedUser: false } });
          }
          if (!message.content.trim()) return;
        }
        if (message.attachments.size > 0 && !this.options.replayIngestor) {
          await (message.channel as TextChannel).send({ content: "Replay uploads are not configured on this server yet.", allowedMentions: { parse: [], repliedUser: false } });
        }
        if (message.attachments.size > 0 && !message.content.trim()) return;
        try {
          await this.options.runtime.enqueue({
            messageId: message.id,
            sessionId: String(session.id),
            threadId: message.channel.id,
            guildId: message.guild!.id,
            parentChannelId: session.parentChannelId,
            authorId: message.author.id,
            content: message.content,
            receivedAt: message.createdTimestamp,
          });
        } catch {
          await (message.channel as TextChannel).send({
            content: "This session is busy; please try again shortly.",
            allowedMentions: { parse: [], repliedUser: false },
          });
        }
      })
      .finally(() => {
        if (this.messageChains.get(message.channel.id) === current)
          this.messageChains.delete(message.channel.id);
      });
    this.messageChains.set(message.channel.id, current);
    await current;
  }
}

export function createDiscordClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMembers,
    ],
    partials: [Partials.Channel],
  });
}

function safeErrorCode(error: unknown): string | number {
  const value = (error as { code?: unknown; name?: unknown } | null)?.code ?? (error as Error | null)?.name;
  return typeof value === "number" ? value : typeof value === "string" && /^[A-Za-z_0-9-]{1,80}$/.test(value) ? value : "UNKNOWN";
}

# BW Forge Discord bot — M1

An independently deployable Bun/TypeScript frontend. Authorized guild members create collaborative public threads with `/forge start [name]` and converse without mentioning the bot. SQLite stores history and pending turns separately from replay corpora. No desktop application is required.

M1 supports conversation only. It does not download attachments, ingest replays, run replay analysis, deliver reports, connect to MCP, call tools, query corpora, or provide per-user memory. The assistant acknowledges these limits and must never fabricate replay evidence.

## Discord setup

1. Create an application at <https://discord.com/developers/applications>, add its bot, and retain the application ID and bot token. Keep the token private.
2. Under Bot → Privileged Gateway Intents, enable **Message Content** and **Server Members**. The client requests Guilds, Guild Messages, Message Content, and Guild Members. Obtain privileged intent approval if Discord requires it for your application.
3. Install into your testing guild with `bot` and `applications.commands` scopes. Grant **View Channel**, **Send Messages**, **Create Public Threads**, **Send Messages in Threads**, and **Read Message History** in enabled parent channels. Administrator permission is unnecessary. Users need channel permissions to access threads and use application commands.
4. Enable Discord Developer Mode and copy stable guild, parent text-channel, and authorized role IDs. Separate multiple channels or roles with commas. Any configured role grants application access in the configured guild. Public thread visibility follows Discord channel permissions; application authorization does not hide conversations from channel readers.
5. Register the command explicitly. Registration targets only the configured testing guild and is separate from startup.

## Local operation

Install Bun 1.3.11 or compatible. From the repository root:

```sh
bun install --frozen-lockfile
cd apps/discord-bot
cp .env.example .env
# Edit .env with credentials, IDs, model, and database location.
bun run register
bun run dev
```

Bun loads the application directory's `.env`. For unattended operation supply environment variables or a service environment file. Run commands from the application directory so relative database paths resolve consistently. Never commit real credentials.

`bun run start` runs TypeScript without watch mode. Production:

```sh
bun run build
bun run start:production
```

Build output externalizes packages: deploy with workspace dependencies installed, not just `dist/`. Root shortcuts are `bun run discord:dev`, `discord:test`, `discord:typecheck`, and `discord:build`. Root test/typecheck scripts include the bot.

## Configuration

All current settings are environment variables. Startup validates configuration before connecting.

| Variable | Purpose |
| --- | --- |
| `DISCORD_BOT_TOKEN` | Secret bot token |
| `DISCORD_APPLICATION_ID` | Application/client snowflake |
| `DISCORD_GUILD_ID` | One testing guild |
| `DISCORD_PARENT_CHANNEL_IDS` | Comma-separated enabled parent text-channel IDs |
| `DISCORD_AUTHORIZED_ROLE_IDS` | Comma-separated authorized role IDs |
| `BW_FORGE_LLM_PROVIDER` | `openai`, the implemented provider |
| `LLM_API_KEY` | Secret hosted provider key |
| `LLM_MODEL` | Model ID enabled for your API account |
| `LLM_MAX_OUTPUT_TOKENS` | Maximum generated tokens, including reasoning where applicable |
| `LLM_CONTEXT_BUDGET` | Conservative input budget accounted as UTF-8 bytes plus envelope overhead |
| `LLM_REQUEST_TIMEOUT_MS` | Hosted request deadline |
| `LLM_MAX_CONCURRENT_TURNS` | Global active turn limit |
| `MAX_MESSAGES_QUEUED_PER_THREAD` | Maximum waiting turns per thread |
| `DISCORD_BOT_DATABASE_PATH` | Persistent bot-specific SQLite file |
| `BW_FORGE_LLM_TEMPERATURE` | Optional temperature; omit when unsupported by model |

Choose input/output limits that fit your model's context window. Context reconstruction retains the triggering message and drops older history first; oversized triggers are clipped. There is no summarization or retrieval. Byte budgeting deliberately overestimates ordinary text tokens for a simple provider-independent bound.

The OpenAI adapter uses the [Responses API](https://developers.openai.com/api/docs/guides/text) with local history and `store: false`. Provider conversation IDs are not authoritative. Provider interfaces, context assembly, authorization, Discord transport, and storage are separate so later tool orchestration can preserve existing sessions. No tool calling is implemented.

## Persistence and recovery

Run **one process per database** on a local filesystem. SQLite transactions and unique Discord message/interaction IDs provide durable deduplication. Per-session claims serialize turns; a bounded scheduler allows independent threads to progress. Keep the database and SQLite sidecars on persistent writable storage.

Membership is fetched afresh for incoming actions and again before paid work. Lookup failures deny access. Role revocation prevents queued requests from consuming provider tokens. Bots, webhooks, DMs, and unregistered threads are ignored. Authorized collaborators share thread history.

Queued work survives restarts. Interrupted running turns are recovered under a bounded retry policy. Responses are saved before delivery so delivery retries reuse generated text. Delivery progress is persisted per chunk; stable markers and recent bot-message reconciliation reduce duplicates after a send/checkpoint crash. Discord and SQLite cannot share a transaction, so exactly-once external delivery is not guaranteed. Recent-history limits, deletion, thread renaming/archival, and long outages can limit reconciliation. A crash before saving a provider response may incur another paid request.

Each turn receives up to three execution attempts in one running process, with no automatic backoff. Non-retryable provider errors produce a persisted friendly failure immediately. A delivery retry reuses saved text and completed chunk checkpoints. Exhausted delivery becomes a terminal failed turn so later messages can proceed; operators can inspect `turns`, `provider_requests`, and `delivery_attempts` in SQLite. Startup requeues interrupted turns, reuses saved output, and substitutes a friendly failure for generation interrupted at its retry limit. This policy favors recovery of saved responses after a process crash; repeated crashes can cause additional delivery attempts. Failed and revoked turns are excluded from later conversational context.

The process lease uses an exclusive SQLite transaction in `<database>.owner.sqlite`, separate from conversation transactions. The operating system releases the lease on process death; do not delete the lease file to force a second process to run. Schema version 1 initializes the bot tables transactionally, and unknown newer versions are rejected. No replay-corpus tables are read or modified. Keep the bot database separate from any corpus path.

Long responses are split within Discord limits; output disables automatic mentions. Friendly errors omit internal details. SIGINT/SIGTERM cancel requests and drain work for a bounded period. Back up SQLite using its backup API or stop the bot before copying database files. Retain state across upgrades.

## Controlled server deployment

Build and install dependencies on a controlled server with Bun. Create an unprivileged `bw-forge` user and a writable state directory. Put secrets and absolute paths in `/etc/bw-forge/discord-bot.env`, readable only by the operator/service user. Set `DISCORD_BOT_DATABASE_PATH=/var/lib/bw-forge-discord/bot.sqlite` and create that directory with service-user ownership.

Adjust paths in `bw-forge-discord-bot.service`, copy it into `/etc/systemd/system`, then:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now bw-forge-discord-bot
sudo journalctl -u bw-forge-discord-bot -f
```

The sample service is independent of replay worker/MCP services. Register commands with the same environment before first deployment. Do not run a watcher against the production database.

## Verification

```sh
bun run test
bun run typecheck
bun run build
```

Automated tests mock Discord and provider requests and need no live credentials. They verify local behavior, not connectivity to a real guild/account. With real credentials, manually check:

1. Register `/forge start` and connect. An authorized user gets a public thread and welcome message in an enabled parent.
2. Two authorized users converse; later replies reference earlier exchanges without mentions.
3. Unauthorized users, DMs, and unrelated threads cause no paid requests. Revoke a queued user's role and verify denial.
4. Queue multiple messages in one thread and another in a second thread. Verify ordering and independent progress up to the global cap.
5. Restart during generation and delivery. Verify saved history, queued work, and delivery checkpoints recover. Inspect the send/checkpoint crash window for duplicates.
6. Try an attachment, long reply, provider timeout, and missing Discord permissions. Verify concise errors, suppressed mentions, and no replay analysis claims.

Live checks require operator-provided credentials and are separate from mocked acceptance tests.

## Future corpus configuration contract

M1 does not load or connect to corpora. A later configuration file can add:

```yaml
corpora:
  pro:
    database: /srv/bw-forge/pro/db/corpus.sqlite
    corpus_root: /srv/bw-forge/pro
    access: read-only
  community:
    database: /srv/bw-forge/community/db/corpus.sqlite
    corpus_root: /srv/bw-forge/community
    access: read-write
discord:
  default_upload_corpus: community
agent:
  readable_corpora:
    - pro
    - community
```

Corpus names identify independent stores; upload targets and readable corpora are separate policies. Future `session_replays`, `replay_uploads`, and `tool_invocations` can reference sessions/turns. M2 should add bounded attachment ingestion and analysis job/report delivery with explicit corpus policy while preserving authorization and persistent orchestration.

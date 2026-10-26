# BW Forge Discord bot — M2

An independently deployable Bun/TypeScript frontend. Authorized guild members create collaborative public threads with `/forge start [name]` and converse without mentioning the bot. SQLite stores history and pending turns separately from replay corpora. No desktop application is required.

M2 adds deterministic replay ingestion and report delivery while keeping it independent from the conversational turn queue. Authorized users can attach one or more `.rep` files to a BW Forge thread; the bot registers them in the configured writable corpus, observes the existing Corpus v2 job, and attaches the published standalone HTML report when analysis succeeds. The assistant still does not query replay facts or call tools.

## Discord setup

1. Create an application at <https://discord.com/developers/applications>, add its bot, and retain the application ID and bot token. Keep the token private.
2. Under Bot → Privileged Gateway Intents, enable **Message Content** and **Server Members**. The client requests Guilds, Guild Messages, Message Content, and Guild Members. Obtain privileged intent approval if Discord requires it for your application.
3. Install into your testing guild with `bot` and `applications.commands` scopes. Grant **View Channel**, **Send Messages**, **Create Public Threads**, **Send Messages in Threads**, **Attach Files**, and **Read Message History** in enabled parent channels. Administrator permission is unnecessary. Users need channel permissions to access threads and use application commands.
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

The ordinary application build externalizes packages: manual deployments need workspace dependencies installed alongside `dist/`. The PowerShell deployer below instead builds dependency-inclusive bundles on Windows for an offline Debian installation. Root shortcuts are `bun run discord:dev`, `discord:test`, `discord:typecheck`, and `discord:build`. Root test/typecheck scripts include the bot.

## Configuration

All current settings are environment variables. Startup validates configuration before connecting.

| Variable | Purpose |
| --- | --- |
| `DISCORD_BOT_TOKEN` | Secret bot token |
| `DISCORD_APPLICATION_ID` | Application/client snowflake |
| `DISCORD_GUILD_ID` | One testing guild |
| `DISCORD_PARENT_CHANNEL_IDS` | Comma-separated enabled parent text-channel IDs |
| `DISCORD_AUTHORIZED_ROLE_IDS` | Comma-separated authorized role IDs |
| `BW_FORGE_LLM_PROVIDER` | `openai` (default) or `openrouter` |
| `LLM_API_KEY` | Secret API key for the selected provider |
| `LLM_MODEL` | Provider model ID; use an OpenRouter model identifier when selecting OpenRouter |
| `LLM_MAX_OUTPUT_TOKENS` | Maximum generated tokens, including reasoning where applicable |
| `LLM_CONTEXT_BUDGET` | Conservative input budget accounted as UTF-8 bytes plus envelope overhead |
| `LLM_REQUEST_TIMEOUT_MS` | Hosted request deadline |
| `LLM_MAX_CONCURRENT_TURNS` | Global active turn limit |
| `MAX_MESSAGES_QUEUED_PER_THREAD` | Maximum waiting turns per thread |
| `DISCORD_BOT_DATABASE_PATH` | Persistent bot-specific SQLite file |
| `BW_FORGE_LLM_TEMPERATURE` | Optional temperature; omit when unsupported by model |
| `BW_FORGE_CORPORA_JSON` | JSON registry of named corpora (`database`, `corpus_root`, `access`) |
| `BW_FORGE_DEFAULT_UPLOAD_CORPUS` | The sole corpus used for Discord uploads; it must be explicitly `read-write` |
| `BW_FORGE_READABLE_CORPORA` | Comma-separated corpus IDs available to the application |
| `BW_FORGE_MAX_REPLAY_BYTES` | Maximum downloaded attachment size (default 64 MiB) |
| `BW_FORGE_MAX_REPLAY_DOWNLOADS` | Maximum concurrent attachment downloads (default 2) |
| `BW_FORGE_MAX_PENDING_REPLAYS_PER_SESSION` | Pending uploads/jobs per session (default 8); process-wide limit is 256 |
| `BW_FORGE_REPLAY_DOWNLOAD_TIMEOUT_MS` | Attachment download deadline (default 120000 ms) |
| `BW_FORGE_REPLAY_POLL_INTERVAL_MS` | Corpus job polling interval (default 5000 ms) |
| `BW_FORGE_REPORT_DELIVERY_RETRIES` | Bounded report delivery retry count (default 5) |
| `BW_FORGE_REPO_ROOT` | Application checkout root for bundled Python/screp helpers; supplied automatically by the deployer |
| `BW_FORGE_AGENT_ENABLED` | Enable read-only analytical MCP tool calling (default `false`; conversation remains available when disabled) |
| `BW_FORGE_MCP_COMMAND` | Trusted operator-configured executable used for local stdio MCP servers (for example `bun`) |
| `BW_FORGE_MCP_ARGS` | JSON string array of executable arguments; `{db_path}` is replaced with each registered corpus database path |
| `BW_FORGE_AGENT_MAX_ROUNDS` | Maximum model/tool rounds per turn (default 4, max 12) |
| `BW_FORGE_AGENT_MAX_TOOL_CALLS` | Maximum MCP calls per turn (default 6, max 32) |
| `BW_FORGE_AGENT_MAX_PARALLEL_TOOLS` | Maximum simultaneous tool calls (default 2, max 8) |
| `BW_FORGE_AGENT_TURN_TIMEOUT_MS` | Total agent-turn deadline, including all model rounds and tools (default 120000 ms, max 600000) |
| `BW_FORGE_AGENT_TOOL_TIMEOUT_MS` | Per-tool deadline (default 10000 ms, max 120000 ms) |
| `BW_FORGE_AGENT_MAX_TOOL_RESULT_BYTES` | Maximum serialized tool result size (default 24000 bytes, max 256000) |

Example production registry (JSON is used so the existing environment-file deployment remains compatible):

```dotenv
BW_FORGE_CORPORA_JSON='{"pro":{"name":"Professional Replays","database":"/srv/bw-forge/pro/db/corpus.sqlite","corpus_root":"/srv/bw-forge/pro","access":"read-only"},"community":{"name":"Community Replays","database":"/srv/bw-forge/community/db/corpus.sqlite","corpus_root":"/srv/bw-forge/community","access":"read-write"}}'
BW_FORGE_DEFAULT_UPLOAD_CORPUS=community
BW_FORGE_READABLE_CORPORA=pro,community
```

The bot database must be outside every corpus database and root. Startup rejects duplicate IDs, missing paths, overlapping layouts, a read-only upload target, and a corpus database equal to the bot database. Corpus IDs qualify replay identity (`corpusId` plus SHA-256), so the same bytes in professional and community corpora remain separate records. Application APIs enforce read-only writes; deployment should additionally grant the bot account write access only to the community corpus and read access to professional data.

## M3 replay-aware analytical tools

Analytical tools are disabled by default. To enable them, configure an MCP command that the service account trusts and can run. The bot starts one local stdio MCP server per configured readable corpus, discovers the server schemas, and exposes only the allowlisted read-only tools: `get_economy`, `get_economy_distribution`, `get_unit_count`, `get_deaths`, `list_build_events`, `get_event_timing_distribution`, `get_composition_snapshot`, `get_corpus_summary`, `list_players`, `list_matchups`, `list_build_items`, `count_replays_with_event_before_event`, `get_death_summary`, and `get_player_replay_card`. Ingestion, writes, SQL, filesystem operations, and administrative tools are not passed to the model. Each call selects an explicit registered corpus; replay numbers are resolved against the current Discord session's inventory before a replay hash reaches MCP.

Example for a bundled appliance checkout (edit the MCP executable arguments to match the actual installation paths):

```dotenv
BW_FORGE_AGENT_ENABLED=true
BW_FORGE_MCP_COMMAND=bun
BW_FORGE_MCP_ARGS='["/srv/bw-forge/app/apps/cli/src/main.ts","mcp","--db","{db_path}","--transport","stdio"]'
BW_FORGE_AGENT_MAX_ROUNDS=4
BW_FORGE_AGENT_MAX_TOOL_CALLS=6
BW_FORGE_AGENT_MAX_PARALLEL_TOOLS=2
BW_FORGE_AGENT_TURN_TIMEOUT_MS=120000
BW_FORGE_AGENT_TOOL_TIMEOUT_MS=10000
BW_FORGE_AGENT_MAX_TOOL_RESULT_BYTES=24000
BW_FORGE_READABLE_CORPORA=pro,community
```

`{db_path}` is substituted separately for each readable corpus, so the professional and community MCP processes receive the correct database. The process command and arguments are operator configuration and are never accepted from Discord or the model. Keep the professional database and its sidecar directory read-only to the bot service account. The parallel-call limit applies globally across active Discord turns. If one MCP corpus is unavailable, reachable corpora stay available; if no configured corpus can provide approved tools, the bot falls back to conversation-only behavior for that turn.

After updating `/etc/bw-forge/discord-bot.env`, restart and inspect the service:

```sh
sudo systemctl restart bw-forge-discord-bot
sudo systemctl status bw-forge-discord-bot
sudo journalctl -u bw-forge-discord-bot -f
```

On the appliance, test in an authorized Discord thread: upload a replay and ask “How many workers did I have at 5:00 in replay #1?”, then ask “How about at 7:00?”. Upload a second replay and ask for a comparison with replay #2, then compare its five-minute economy with professional players in the same matchup. Verify the answer identifies the replay/corpus, reports actual measurements and sample sizes, and does not claim a comparison without tool evidence. To test failure recovery, stop the local MCP process or temporarily configure an invalid trusted executable, ask a normal strategy question and an analytical question, then restore the command and restart the service. Check `journalctl` for `analytical MCP unavailable` and `analytical tool call rejected`; do not treat fixture tests as live model or appliance acceptance.

The provider tool-call compatibility probe is optional and requires the configured key/model. From the bot directory, run `bun run probe:tools` with `BW_FORGE_LLM_PROVIDER`, `LLM_API_KEY`, and `LLM_MODEL` set in the environment. It asks for a harmless `get_corpus_summary` function call without starting Discord or executing the function; exit code 0 means the model returned the expected structured request, 2 means it returned no expected call or an incomplete response, and 1 means a provider error. Do not record secrets or reasoning traces. Automated fixtures cover protocol parsing; no live provider probe or Discord acceptance is claimed by this implementation session.

Successful tool provenance is logged as `analytical tool call completed` with turn/session IDs, tool call ID, tool name, corpus ID, replay number when applicable, and result byte count. MCP query errors use `analytical tool call failed`; validation or authorization failures use `analytical tool call rejected`, both with bounded error codes. The logs omit tool arguments, replay hashes, database paths, credentials, and model reasoning. Inspect the bot's `journalctl` stream alongside the bot database's turns and provider request rows when troubleshooting.

Attachments are accepted only from Discord's attachment metadata, are checked case-insensitively for `.rep`, downloaded to generated temporary paths with bounded size, timeout, and concurrency, then removed after registration or terminal failure. Filenames never become paths. Duplicate Discord events preserve upload provenance while reusing content-addressed Corpus v2 work. Pending uploads and report deliveries are stored in the bot SQLite database and reconciled after restart; a crash between registration and checkpoint is repaired by deterministic replay identity.

Choose input/output limits that fit your model's context window. Context reconstruction retains the triggering message and drops older history first; oversized triggers are clipped. There is no summarization or retrieval. Byte budgeting deliberately overestimates ordinary text tokens for a simple provider-independent bound.

The OpenAI adapter uses the [Responses API](https://developers.openai.com/api/docs/guides/text) with local history and `store: false`. Provider conversation IDs are not authoritative. Structured tool calls and tool outputs stay inside the provider adapter contract and the bounded orchestrator; only approved gateway definitions are sent to the hosted model.

To use OpenRouter, edit the existing `/etc/bw-forge/discord-bot.env` on Debian:

```dotenv
BW_FORGE_LLM_PROVIDER=openrouter
LLM_API_KEY=your-openrouter-api-key
LLM_MODEL=provider/your-model-id
```

Replace the placeholders with your key and the exact model identifier from your OpenRouter account. Keep the other settings. The adapter sends requests to `https://openrouter.ai/api/v1/responses` using OpenRouter's [stateless Responses API](https://openrouter.ai/docs/api_reference/responses/overview). It includes local conversation history, uses `store: false`, and records `openrouter` as the provider. Select a model that supports text responses through this endpoint, and set context/output limits and optional temperature to values supported by that model.

Deploy the updated committed revision with `.\Deploy-BwForge.ps1 -DeployDiscordBot`; the existing environment file and conversation database are retained. Switching providers does not require slash-command registration or a new session. Dependency-inclusive bundles still install offline on Debian. Provider requests require runtime access to OpenRouter. Mocked tests verify the protocol and error handling; a live OpenRouter smoke test needs your credentials and is not part of automated verification.

## Persistence and recovery

Run **one process per database** on a local filesystem. SQLite transactions and unique Discord message/interaction IDs provide durable deduplication. Per-session claims serialize turns; a bounded scheduler allows independent threads to progress. Keep the database and SQLite sidecars on persistent writable storage.

Membership is fetched afresh for incoming actions and again before paid work. Lookup failures deny access. Role revocation prevents queued requests from consuming provider tokens. Bots, webhooks, DMs, and unregistered threads are ignored. Authorized collaborators share thread history.

Queued work survives restarts. Interrupted running turns are recovered under a bounded retry policy. Responses are saved before delivery so delivery retries reuse generated text. Delivery progress is persisted per chunk; stable markers and recent bot-message reconciliation reduce duplicates after a send/checkpoint crash. Discord and SQLite cannot share a transaction, so exactly-once external delivery is not guaranteed. Recent-history limits, deletion, thread renaming/archival, and long outages can limit reconciliation. A crash before saving a provider response may incur another paid request.

Each turn receives up to three execution attempts in one running process, with no automatic backoff. Non-retryable provider errors produce a persisted friendly failure immediately. A delivery retry reuses saved text and completed chunk checkpoints. Exhausted delivery becomes a terminal failed turn so later messages can proceed; operators can inspect `turns`, `provider_requests`, and `delivery_attempts` in SQLite. Startup requeues interrupted turns, reuses saved output, and substitutes a friendly failure for generation interrupted at its retry limit. This policy favors recovery of saved responses after a process crash; repeated crashes can cause additional delivery attempts. Failed and revoked turns are excluded from later conversational context.

The process lease uses an exclusive SQLite transaction in `<database>.owner.sqlite`, separate from conversation transactions. The operating system releases the lease on process death; do not delete the lease file to force a second process to run. Bot schema migrations through version 4 retain M1 sessions and add replay-upload/session/delivery associations. Unknown newer versions are rejected. Keep the bot database separate from all corpus paths.

Long responses are split within Discord limits; output disables automatic mentions. Friendly errors omit internal details. SIGINT/SIGTERM cancel requests and drain work for a bounded period. Back up SQLite using its backup API or stop the bot before copying database files. Retain state across upgrades.

## Controlled server deployment

For the existing Windows → Debian workflow, use the repository's primary PowerShell deployer:

```powershell
.\Deploy-BwForge.ps1 -DeployDiscordBot
```

On first deployment it creates `/etc/bw-forge/discord-bot.env` with restricted permissions and installs the service. Fill in that file on Debian (`sudo nano /etc/bw-forge/discord-bot.env`): bot token, application/guild/channel/role IDs, provider key, and model. Enable the Discord intents and install the app into the guild as described above. Then run:

```powershell
.\Deploy-BwForge.ps1 -DeployDiscordBot -RegisterDiscordCommands
```

This builds the bot, registers `/forge start` in the configured guild, and starts/restarts `bw-forge-discord-bot.service`. Command registration is explicit; subsequent deployments can use just `-DeployDiscordBot`. Once installed, the bot is also detected and rebuilt by normal deployments so replacing the application tree does not remove its dependencies. `-Restart DiscordBot` and `-Restart All` support the bot as well.

To enable the read-only replay-aware analytical agent and configure its local MCP command during deployment, use:

```powershell
.\Deploy-BwForge.ps1 -DeployDiscordBot -EnableAnalyticalAgent -Restart DiscordBot
```

Before enabling it, configure `BW_FORGE_CORPORA_JSON` and `BW_FORGE_READABLE_CORPORA` in `/etc/bw-forge/discord-bot.env`. The deployer validates the resulting environment with the bot's `loadConfig`; if required credentials or readable corpora are missing, the service remains stopped for correction. Existing secrets, corpus definitions, and agent limits are preserved. Disable analytical tools explicitly with:

```powershell
.\Deploy-BwForge.ps1 -DeployDiscordBot -DisableAnalyticalAgent -Restart DiscordBot
```

The enable and disable switches are mutually exclusive and require `-DeployDiscordBot`.

The default deployer layout is `/srv/bw-forge/app/apps/discord-bot`, with conversations retained at `/srv/bw-forge/discord-bot-state/bot.sqlite`. Secrets and state survive application swaps and backup pruning. Override locations with `-RemoteDiscordEnv` and `-RemoteDiscordStateRoot`.

Debian requires **no internet access to install**. The connected Windows machine needs Bun and npm-registry access on a cache miss. It installs dependencies from the selected commit's frozen lockfile and bundles both bot entrypoints with their JavaScript dependencies. The archive is cached by commit and local Bun version, uploaded, checked with SHA-256, and imported on Debian before replacing the installed application. No Discord package install or build runs on Debian, and no Windows `node_modules` or native executable is copied. Debian still needs the existing Bun runtime. `-ForceDependencyUpload` also forces a fresh local bot bundle build. The existing offline corpus-query dependency cache remains separate.

Deployment archives the selected **committed** revision (`-Commit`, default `HEAD`). Check status/logs with `sudo systemctl status bw-forge-discord-bot` and `sudo journalctl -u bw-forge-discord-bot -f`. The running bot and explicit slash-command registration still require a network route to Discord and the hosted LLM; a completely isolated server cannot provide those hosted features without permitted egress or a suitable proxy.

For a manual installation instead:

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

## M2 operational acceptance

See [M2 operations](M2-OPERATIONS.md) for exact environment-file quoting, first-time community provisioning, offline deployment, isolation, recovery commands and manual smoke testing.

Before enabling uploads, provision both corpus roots and confirm the professional
database checksum against the operator's known-good copy. Configure the JSON
registry above, then run the bot and the independent community worker under the
same unprivileged account. The recommended smoke test uses two different `.rep`
files in one authorized thread: both should receive prompt acknowledgements,
appear as separate session inventory entries, complete as Corpus v2 jobs, and
produce two standalone HTML attachments. Uploading the same bytes in a second
thread should reuse content-addressed analysis while delivering that thread's
own report association.

Restart the bot while jobs are running and restart the community worker while a
job is leased. On recovery, durable upload rows are reconciled from Discord
message/attachment metadata and staged bytes; registration is idempotent and
pending report deliveries resume without creating a second job. Accepted jobs
continue toward the originating shared thread even if the uploader later loses
the authorized role. New uploads and every user-directed operation recheck the
current role.

Upload and delivery state uses the versioned bot schema (schema 4). Pending
uploads are bounded to eight per session and 256 globally; downloads are bounded
by the configured size, timeout, and concurrency limits. Delivery retries use
bounded persistent backoff (five attempts by default), record the terminal error,
and never drop a successful analysis. Operators can inspect `replay_uploads` and
`report_deliveries` in the bot database and reset one terminal delivery by its
stable upload/delivery ID after correcting permissions. Do not run a broad SQL
update against all sessions.

Discord currently has practical attachment limits that vary by account and
server boost level. BW Forge uses a conservative 10 MiB report limit for direct
HTML delivery; an oversized report is retained in the corpus and reported as a
delivery limitation rather than silently discarded. M2 does not host reports
publicly or generate LLM replay commentary.

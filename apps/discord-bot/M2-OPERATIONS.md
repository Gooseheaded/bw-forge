# M2 configuration, deployment and recovery

M2 does deterministic upload ingestion and standalone HTML delivery independently of conversational LLM turns. Replay simulation/publication belongs to the existing Corpus v2 worker. The bot never runs simulation or lets the LLM choose destinations, execute code, or write files. M3 replay-aware chat and MCP clients remain unimplemented.

## Migrate an existing M1 installation

Stop the bot and back up its SQLite database before its first M2 start. Retain the existing credentials, provider settings, Discord IDs and `DISCORD_BOT_DATABASE_PATH`. Bot migrations through schema 4 preserve conversations. Unknown newer schemas fail closed. Keep one process per bot database and its owner-lock database.

Add these **nonsecret** settings to the existing `/etc/bw-forge/discord-bot.env`. This example preserves the existing professional corpus at `/srv/bw-forge/corpus`; change that path to its actual location without moving/deleting it:

```dotenv
BW_FORGE_CORPORA_JSON='{"pro":{"name":"Professional Replays","database":"/srv/bw-forge/corpus/db/corpus.sqlite","corpus_root":"/srv/bw-forge/corpus","access":"read-only"},"community":{"name":"Community Replays","database":"/srv/bw-forge/community/db/corpus.sqlite","corpus_root":"/srv/bw-forge/community","access":"read-write"}}'
BW_FORGE_DEFAULT_UPLOAD_CORPUS=community
BW_FORGE_READABLE_CORPORA=pro,community
```

The outer single quotes preserve JSON's double quotes in systemd EnvironmentFiles. Bun dotenv also accepts this form. Named IDs are arbitrary and must remain stable for persisted associations. Array-form JSON with explicit `id` fields is supported; duplicate IDs in either form are rejected. Roots/databases must be absolute, distinct and safe, and bot state must be outside every corpus root. Read-only corpora must already exist and are never initialized. Writable database parents can be created during startup. Removing a configured corpus while uploads refer to it leaves recoverable errors; restore that ID/path before retrying.

To retain conversation-only M1 operation, use an empty registry and omit both the upload destination and readable list. Existing M1 environment files remain compatible. The example environment intentionally leaves M2 disabled until valid storage is configured.

Defaults: 64 MiB per replay, two simultaneous downloads, 120-second network deadline, eight pending uploads/jobs per session, 256 pending process-wide, five-second job polling, five report delivery attempts. Override with `BW_FORGE_MAX_REPLAY_BYTES`, `BW_FORGE_MAX_REPLAY_DOWNLOADS`, `BW_FORGE_REPLAY_DOWNLOAD_TIMEOUT_MS`, `BW_FORGE_MAX_PENDING_REPLAYS_PER_SESSION`, `BW_FORGE_REPLAY_POLL_INTERVAL_MS`, and `BW_FORGE_REPORT_DELIVERY_RETRIES`. Attachment bytes stream to restrictive generated files; parsing uses the pinned existing screp runtime with its own bounded process deadline. Discord filenames/text never select filesystem paths or corpora.

## Provision the separate community worker

The optional worker installer requires an existing community DB and `analyses` directory. Provision once with the appliance service account (replace `gctrindade` and the Bun path if different):

```sh
sudo install -d -m 0750 -o gctrindade -g gctrindade /srv/bw-forge/community/{analyses,db,replays,work}
sudo -u gctrindade /usr/local/bin/bun /srv/bw-forge/app/apps/cli/src/main.ts jobs list --db /srv/bw-forge/community/db/corpus.sqlite
```

The second command explicitly initializes only the new writable Corpus v2 DB. Verify that exact destination first. Keep the professional worker's environment unchanged.

From Windows, deploy a committed revision:

```powershell
.\Deploy-BwForge.ps1 -DeployDiscordBot -DeployCommunityWorker -Restart All
```

`-RemoteCommunityRoot` and `-RemoteCommunityDb` override the defaults. The installer creates `bw-forge-community-worker.service` and `/etc/bw-forge/community-worker.env`; the existing primary worker retains `/etc/bw-forge/bw-forge.env`. Both use the established core `worker run` command. The target retains the community worker on later systemd updates. `-Restart CommunityWorker` and `-Restart DiscordBot` control them independently. A bot restart leaves queued/running jobs intact; a worker restart leaves conversations and delivery intentions intact.

The Windows deployment builds dependency-inclusive Discord bundles and checksummed dependency archives before transfer. Debian performs no registry install. The application tree is replaced while credentials, bot state and both corpora remain outside it. The deployed bot command supplies `BW_FORGE_REPO_ROOT` so relocated bundles resolve Python/screp helpers even with an older environment file. A manual bundled install must set that variable to the full checkout root. Python, Bun and pinned Linux screp remain appliance prerequisites. Runtime egress to Discord and the configured hosted provider is still required. No private development-network address appears in application routing.

## Authorization and filesystem protection

Fresh role membership is required at acceptance, before download and immediately before enqueue, including after restart. Membership lookup failures deny new work. Already accepted jobs may finish and completion/failure notifications continue into the original shared thread after role revocation. They continue an accepted operation; subsequent user-directed operations require authorization again. Discord channel/thread permissions control who can read those notifications.

Application APIs reject read-only corpus writes. Job/publication observation opens SQLite read-only handles and never calls the mutating core initialization path. Report paths come from `analysis_publications` plus immutable manifests and must remain inside the corpus's `analyses` root without symlink escapes. The same SHA in different corpora remains a different qualified reference.

Recommended filesystem access:

| Process | Application/runtime | Bot state | Community | Professional |
| --- | --- | --- | --- | --- |
| Discord bot | read/execute | read/write | read/write | read/traverse |
| Community worker | read/execute | none | read/write | none |
| Primary professional worker | read/execute | none | none | its existing permissions |
| MCP server | read/execute | none | read if configured | read if configured |

The deployer preserves the existing unprivileged appliance account. If that account also runs a primary worker with professional write access, OS separation is **not** automatic: use a dedicated bot account and operator-managed ownership/ACLs or read-only mounts. No service runs as root. Keep professional directories non-writable to the bot, including SQLite sidecar directories; provide readable existing WAL/SHM or a checkpointed snapshot. Shared-account deployment relies on application policy for the write boundary. M2 does not rearrange existing corpus ownership.

## Persistence and crash recovery

Bot SQLite stores upload provenance, `(session, corpus, SHA)` inventory, core job/analysis references and report delivery state. It does not duplicate analysis data. Discord message/attachment IDs deduplicate events; different upload requests retain separate notifications even when analysis is reused.

The coordinator fetches a fresh signed attachment URL from the original Discord message after restart. Downloads use private `<bot-db-dir>/uploads` staging. Validated bytes and SHA are persisted **before** registration; replay bytes are synced before that checkpoint. If a crash occurs after core registration but before the bot's job-reference checkpoint, recovery verifies staged content and re-enqueues idempotently. Canonical bytes and the existing Corpus v2 queue deduplicate work. Referenced staging survives retries; enqueue/terminal completion removes it, and startup removes orphan generated files. Deleting the original message can make an unfinished, unstaged upload permanently unavailable.

Infrastructure ingestion failures receive up to six attempts with exponential backoff capped at five minutes. Validation/authorization failures are permanent. Job observation backs off during outages and keeps its durable reference; an unavailable worker leaves the core job queued. Terminal worker errors generate safe failure notices. Completed reuploads reuse the current indexed analysis even if it predates bot ingestion.

Staging must be a real private directory without symlink redirects. Startup, download, recovery and cleanup validate that boundary; a redirected staging directory is rejected before files are written or orphan files are removed.

Delivery intent is persisted before sending. Stable Discord nonces and bot-only markers reconcile the latest 100 thread messages after a send/checkpoint crash. Discord and SQLite cannot share a transaction: deletions, history gaps and nonce retention can still produce duplicates. Report retry counts and backoff survive restart. Exhaustion or a permission/size failure leaves the immutable analysis intact and a terminal delivery record; a safe limitation notice is retried when Discord becomes available. New uploads never require an LLM call.

Inspect event logs with `journalctl -u bw-forge-discord-bot -f` and core status with `jobs list/show --db <community-db>`. Logs contain stable session/upload/corpus/SHA/job IDs and safe event categories; they exclude signed URLs, credentials, provider bodies and filesystem paths from user-facing notices.

To retry one terminal report after correcting permissions, stop the bot, back up its DB and identify the exact upload ID. Reset **only that row**:

```sql
UPDATE report_deliveries SET state='pending',attempts=0,next_attempt_at=NULL,error=NULL WHERE upload_id=123;
```

Restart the bot. For a terminal ingestion error, upload in a new Discord message. Never alter Corpus v2 tables through the bot DB. Use SQLite's backup API or stop writers before copying databases; do not discard WAL files from a live database.

## HTML delivery and live acceptance

Discord's [official upload reference](https://github.com/discord/discord-api-docs/blob/main/developers/reference.mdx) documents multipart attachments and a 20 MiB default. [Bot API reports](https://github.com/discord/discord-api-docs/issues/8572) describe continued 10 MiB enforcement, so M2 conservatively caps report attachments at 10 MiB. Oversized reports produce a clear notice and stay on the appliance for operator retrieval. HTML is delivered as a downloadable standalone file; inline viewing is unnecessary. There is no public hosting service. The bot needs **Attach Files** and **Read Message History**, alongside existing channel/thread permissions.

Automated tests use no live Discord/provider credentials. The M2 integration test uses a real replay, real registration/queue/worker lease/publication APIs and mocked Discord; the expensive simulator is a deterministic fixture producer. It is not a live appliance smoke test.

1. While its own writers are stopped, record professional corpus checksums. Confirm the upload target and both worker environment paths.
2. Start bot and community worker. In a registered thread, upload two different valid replays in one message. Acknowledgement must precede analysis; conversational messages in this and other sessions must continue.
3. Observe community jobs complete, download/open both HTML reports, and verify inventory identities. Professional checksums must be unchanged by the bot.
4. Upload identical bytes in a different session; confirm no new analysis and a report in the second thread.
5. Stop the worker, queue an upload, restart the bot, then start the worker. Repeat during registration/running analysis and a temporary delivery outage. Confirm recovery and bounded duplicate suppression.
6. Try unrelated extensions, malformed/oversized replays and a revoked role. Confirm no unauthorized downloads/jobs. Temporarily remove Attach Files; verify persisted failure and a safe notice.

Before M3, retain these deterministic boundaries and expose only read-only, corpus-qualified session-query capabilities to the future agent.

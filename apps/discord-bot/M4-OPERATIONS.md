# M4 operator procedures

The bot exposes a local diagnostic that never contacts Discord or the configured
model:

```sh
cd /srv/bw-forge/app/apps/discord-bot
/usr/local/bin/bun dist/health.js --db /srv/bw-forge/discord-bot-state/bot.sqlite
```

It returns JSON with schema status and counts of queued/running/failed turns,
replay uploads, and report deliveries. It intentionally excludes paths,
conversation text, replay hashes, credentials, and exception details. A non-zero
exit means the database could not be opened or a required table is unavailable.
Add `--corpus-check` to check every configured corpus root and database with
permission queries and read-only opens. It reports per-corpus status labels,
never configured paths. Provider usage totals preserve missing metadata; an
estimated cost is shown only when reported input/output usage and configured
prices are both available.
When analytical MCP is enabled, run the same command with `--mcp-check` under the
service environment; this performs only MCP initialize and tool discovery and does
not call the hosted model or execute an analytical query. The check fails if any
configured readable MCP server is unavailable.

For a routine check, inspect the bot and community worker together:

```sh
sudo systemctl is-active bw-forge-discord-bot bw-forge-community-worker
sudo systemctl show bw-forge-discord-bot -p User -p ProtectSystem -p NoNewPrivileges -p MemoryMax -p TasksMax
sudo systemctl show bw-forge-discord-bot -p ReadWritePaths -p ReadOnlyPaths
sudo journalctl -u bw-forge-discord-bot --since '15 minutes ago' --no-pager
sudo journalctl -u bw-forge-community-worker --since '15 minutes ago' --no-pager
```

Common recovery is bounded and reversible. Restart the bot when Discord or the
provider is unavailable; saved responses and queued turns remain in SQLite:

```sh
sudo systemctl restart bw-forge-discord-bot
```

If replay jobs accumulate, restart only the community worker and inspect its
journal. Do not delete the bot database, corpus database, WAL/SHM files, staged
uploads, or report artifacts. If a report delivery is terminally failed, correct
permissions or Discord availability first, then use the existing delivery reset
procedure for that single delivery ID. Back up SQLite with its backup API or stop
the bot before copying it.

The professional corpus remains an operator-managed boundary. The bot process
must run as an unprivileged account that has read/traverse access to the
professional tree and write access only to bot state and the community tree.
`ProtectSystem=strict`, `NoNewPrivileges=true`, private temporary directories
and resource ceilings are installed by the service units. The deployment renders
`ReadWritePaths` from the validated bot state and community upload registry, and
`ReadOnlyPaths` from every registered read-only corpus. Inspect those directives
with `systemctl show bw-forge-discord-bot -p ReadWritePaths -p ReadOnlyPaths`.
On an existing host, apply the independent community worker policy with
`Deploy-BwForge.ps1 -DeployCommunityWorker -Restart CommunityWorker`; this
regenerates that unit from the community root/database configuration and restarts
only the community worker. Verify its resulting `ProtectSystem` and
`ReadWritePaths` values as well.
The manual unit template needs the same paths rendered with
`bun dist/service-policy.js` before it can start under strict confinement.
Verify the account ACLs and the unit policy after every deployment:

```sh
BOT_USER=$(systemctl show --value -p User bw-forge-discord-bot)
sudo -u "$BOT_USER" test -r /srv/bw-forge/pro/db/corpus.sqlite
sudo -u "$BOT_USER" test ! -w /srv/bw-forge/pro/db/corpus.sqlite
```

The first live acceptance checklist is intentionally safe and uses no provider
credits until the final conversational check: confirm service state and unit
hardening; run `dist/health.js`; verify the professional database is not writable;
upload one fixture replay to the community corpus; confirm one durable job and one
report; restart the bot while a second job is queued; confirm it resumes; stop and
restart the MCP process and confirm ordinary conversation remains available; then
perform one authorized analytical question and inspect its correlated structured
logs. Record the commit, unit output, health JSON, job IDs, and any deferred
checks in the deployment change log. Live acceptance requires appliance access and
real Discord/provider credentials; fixture tests do not claim it.

Rollback uses the deployment script's committed archive selection. Stop the bot,
restore the previous committed application tree and environment, run the health
check, then start the service. Never roll back by replacing corpus or bot state.
Schema migrations are forward-compatible only: a newer bot binary may open an
older database, but an older binary must not be pointed at a database migrated by
a newer release. If rollback crosses a schema migration, restore the matching
SQLite backup (including WAL/SHM state) or finish the upgrade and roll forward;
do not delete columns or run ad-hoc downgrade SQL.

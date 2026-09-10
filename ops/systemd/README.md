# Debian systemd appliance integration

These files supervise the existing BW Forge watcher, worker, and MCP HTTP server.
Systemd starts and restarts the processes; replay registration, queue correctness,
worker leases, immutable publication, and accepted analyses remain application and
SQLite responsibilities.

The installer writes exactly:

```text
/etc/bw-forge/bw-forge.env
/etc/systemd/system/bw-forge-watch.service
/etc/systemd/system/bw-forge-worker.service
/etc/systemd/system/bw-forge-mcp.service
/etc/systemd/system/bw-forge.target
```

It does not copy the application, initialize a database, alter Corpus contents,
configure networking, or start services unless `--start` is supplied. The stable
application path remains `/srv/bw-forge/app` (or the configured equivalent), and
every service uses it as `WorkingDirectory` with an absolute Bun and CLI entrypoint.

## Installation

Create or deploy the application and existing Corpus first. The configured service
account must already exist and must not be root. On the current appliance:

```sh
sudo ./ops/systemd/install.sh \
  --user gctrindade \
  --app-root /srv/bw-forge/app \
  --corpus-root /srv/bw-forge/corpus \
  --inbox /srv/bw-forge/inbox \
  --db /srv/bw-forge/corpus/db/corpus.sqlite

sudo systemctl enable --now bw-forge.target
```

The installer resolves `bun`, `node`, and `python3` to absolute executable paths.
Pass `--bun`, `--node`, or `--python` when the correct appliance runtime is elsewhere.
Those paths are persisted as `BW_FORGE_BUN`, `BW_FORGE_NODE`, and
`BW_FORGE_PYTHON`; the units do not depend on login-shell aliases or profiles.

The app root, Corpus root, database, and database directory must already exist.
The installer refuses to create or migrate a missing production database. The inbox
must also exist unless `--create-inbox` is explicit; that flag creates only the
configured inbox with mode `0750` and the service user's primary group.

Before writing systemd files, the installer checks the service user's read/traverse
access to the app and CLI, read/write/traverse access to the Corpus, inbox, and DB
directory, read/write access to the database, and execute access to all runtimes. It
does not recursively `chmod` or `chown` existing trees. Fix reported ownership or ACL
errors deliberately, for example with narrowly scoped administrator commands suited
to the appliance's ownership policy.

`--start` enables and restarts the target after installation. Without it, the target
is enabled for future boots but remains stopped until explicitly started. Rerunning
the installer replaces only the environment/unit definitions, runs
`systemctl daemon-reload`, and re-enables the target; it is safe after an app upgrade.

## Central configuration

`/etc/bw-forge/bw-forge.env` contains the configured values:

```ini
BW_FORGE_APP_ROOT="/srv/bw-forge/app"
BW_FORGE_CORPUS_ROOT="/srv/bw-forge/corpus"
BW_FORGE_DB="/srv/bw-forge/corpus/db/corpus.sqlite"
BW_FORGE_INBOX="/srv/bw-forge/inbox"
BW_FORGE_BUN="/usr/local/bin/bun"
BW_FORGE_NODE="/usr/local/bin/node"
BW_FORGE_PYTHON="/usr/bin/python3"
BW_FORGE_MCP_HOST="127.0.0.1"
BW_FORGE_MCP_PORT="8089"
BW_FORGE_MCP_PATH="/mcp"
BW_FORGE_WATCH_STABILITY_MS="1500"
BW_FORGE_WATCH_RECONCILE_SECONDS="60"
```

The default MCP endpoint is `http://127.0.0.1:8089/mcp`. Loopback requires no
external link and does not expose the unauthenticated, unencrypted endpoint to the
LAN. A non-loopback `--mcp-host` is allowed for deliberate advanced use; the
installer warns that this milestone provides no TLS, authentication, firewall, or
reverse proxy. It does not configure Ethernet, Wi-Fi, NetworkManager, or the
temporary `10.77.0.2` address.

## Service behavior

The units execute these effective commands as the configured unprivileged user:

```sh
bun /srv/bw-forge/app/apps/cli/src/main.ts watch run \
  --path /srv/bw-forge/inbox \
  --corpus-root /srv/bw-forge/corpus \
  --db /srv/bw-forge/corpus/db/corpus.sqlite \
  --stability-ms 1500 --reconcile-seconds 60

bun /srv/bw-forge/app/apps/cli/src/main.ts worker run \
  --corpus-root /srv/bw-forge/corpus \
  --db /srv/bw-forge/corpus/db/corpus.sqlite

bun /srv/bw-forge/app/apps/cli/src/main.ts mcp \
  --db /srv/bw-forge/corpus/db/corpus.sqlite \
  --transport http --host 127.0.0.1 --port 8089 --path /mcp
```

All three start after local filesystems only. They use `Restart=on-failure` with a
two-second delay and a five-start-per-minute limit; a clean systemd stop does not
restart them. SIGTERM reaches the application normally. Watcher and MCP get 30
seconds to stop. The worker gets 15 minutes so an ordinary analysis can finish; if
systemd must eventually kill it, its SQLite lease expires and the existing
at-least-once worker recovery reclaims the job.

Each service remains independently controllable. Stopping the watcher leaves queued
work and the worker intact; stopping the worker still allows enqueueing; stopping MCP
does not stop analysis. `bw-forge.target` provides group start/stop/restart and pulls
all three services into boot through `multi-user.target`.

The conservative hardening is `NoNewPrivileges=true`, `PrivateTmp=true`,
`UMask=0027`, an empty capability bounding set, and `RestrictSUIDSGID=true`. Corpus,
SQLite/WAL, replay, work, runtime, and temporary-directory access remains available.
Because `PrivateTmp` gives each service a private `/tmp`, do not configure the app,
Corpus, database, or inbox beneath the host's `/tmp`; use persistent appliance paths
such as `/srv/bw-forge`. Stdout and stderr go only to journald.

## Operations and diagnostics

```sh
sudo systemctl start bw-forge.target
sudo systemctl stop bw-forge.target
sudo systemctl restart bw-forge.target
sudo systemctl disable --now bw-forge.target

systemctl status bw-forge.target
systemctl status bw-forge-watch.service
systemctl status bw-forge-worker.service
systemctl status bw-forge-mcp.service

journalctl -u bw-forge-watch.service
journalctl -u bw-forge-worker.service -f
journalctl -u bw-forge-mcp.service
ss -ltn | grep 8089
bw-forge jobs list --db /srv/bw-forge/corpus/db/corpus.sqlite
```

An unexpected watcher exit is restarted and its mandatory startup scan reconciles
missed files. An unexpected worker exit is restarted and lease expiry makes abandoned
jobs reclaimable. An unexpected MCP exit is restarted and recreates the HTTP endpoint.
No systemd-specific rows or schema revision are added to Corpus v2.

## Application upgrades

Stop the target before atomically replacing the stable application directory. This
prevents old processes from remaining attached to a renamed backup tree:

```sh
sudo systemctl stop bw-forge.target
# Deploy the new tree at /srv/bw-forge/app.
sudo ./ops/systemd/install.sh \
  --user gctrindade --app-root /srv/bw-forge/app \
  --corpus-root /srv/bw-forge/corpus --inbox /srv/bw-forge/inbox \
  --db /srv/bw-forge/corpus/db/corpus.sqlite
sudo systemctl start bw-forge.target
```

## Reboot acceptance procedure

On the real appliance, install and enable the target, then run `sudo reboot`. After
boot, without an interactive login:

1. Confirm the target and all three services are active with `systemctl status`.
2. Confirm `http://127.0.0.1:8089/mcp` accepts an MCP initialize/request sequence.
3. Copy a new replay to `/srv/bw-forge/inbox` without moving or deleting it afterward.
4. Follow watcher and worker journals; inspect `bw-forge jobs list` until the job is
   `succeeded`.
5. Query the replay through Corpus v2/MCP.
6. Kill each main PID unexpectedly in turn. Confirm systemd restarts that service;
   for a killed worker, wait for lease expiry and confirm the job is reclaimed.
7. Stop `bw-forge.target` and confirm all services become cleanly inactive without a
   restart loop; start it again and confirm all return active.

`systemd-analyze verify` can validate staged or installed unit files. The renderer's
`--output-dir` and installer's `--destdir` are intended for packaging and tests and do
not call `systemctl`.

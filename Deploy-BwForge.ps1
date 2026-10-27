param(
    [Parameter(Position=0)]
    [string]$RepoPath = ".",

    [string]$Commit = "HEAD",
    [string]$DebianHost = "10.77.0.2",
    [string]$DebianUser = "gctrindade",
    [string]$RemoteAppRoot = "/srv/bw-forge",
    [string]$RemoteCorpusRoot = "/srv/bw-forge/corpus",
    [string]$RemoteInbox = "/srv/bw-forge/inbox",
    [string]$RemoteCorpusDb = "/srv/bw-forge/corpus/db/corpus.sqlite",
    [string]$RemoteCommunityRoot = "/srv/bw-forge/community",
    [string]$RemoteCommunityDb = "/srv/bw-forge/community/db/corpus.sqlite",
    [string]$RemoteDiscordEnv = "/etc/bw-forge/discord-bot.env",
    [string]$RemoteDiscordStateRoot = "/srv/bw-forge/discord-bot-state",

    [string]$CacheRoot = $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA "bw-forge-deploy" } else { Join-Path $HOME ".cache\bw-forge-deploy" }),
    [int]$BackupCount = 2,
    [string]$IdentityFile = "",

    [switch]$UpdateSystemd,
    [ValidateSet("None", "Watcher", "DiscordBot", "CommunityWorker", "All")]
    [string]$Restart = "None",
    [switch]$DeployDiscordBot,
    [switch]$EnableAnalyticalAgent,
    [switch]$DisableAnalyticalAgent,
    [switch]$DeployCommunityWorker,
    [switch]$RegisterDiscordCommands,
    [switch]$ForceDependencyUpload,
    [switch]$FullIntegrityCheck
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$ScriptRevision = "2026-10-26-v4-offline-discord-bundle"

$PnpmVersion = "10.32.1"
$PnpmWinSha256 = "849141504c83bcd08a3d84dc20d43cff2584d672138d28c33ad62bdac809e7f2"
$PnpmLinuxSha256 = "c5607a86bfb948297e96b393a53c90107766fe56329e62967b1f239d861d4363"

function Require-Command([string]$Name) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command not found on Windows PATH: $Name"
    }
}

function Invoke-Native([string]$Description, [scriptblock]$Command) {
    & $Command
    if ($LASTEXITCODE -ne 0) {
        throw "$Description failed with exit code $LASTEXITCODE"
    }
}

function Get-Sha256([string]$Path) {
    return (Get-FileHash -Algorithm SHA256 $Path).Hash.ToLowerInvariant()
}

function Ensure-DownloadedAndVerified(
    [string]$Url,
    [string]$Path,
    [string]$ExpectedSha256
) {
    $Expected = $ExpectedSha256.ToLowerInvariant()
    if (Test-Path $Path) {
        $Actual = Get-Sha256 $Path
        if ($Actual -eq $Expected) {
            Write-Host "    cached: $Path"
            return
        }
        Write-Warning "Cached file hash mismatch; redownloading $Path"
        Remove-Item -Force $Path
    }

    $Parent = Split-Path -Parent $Path
    New-Item -ItemType Directory -Force -Path $Parent | Out-Null
    $Temp = "$Path.download-$([guid]::NewGuid().ToString('N'))"
    try {
        Write-Host "    downloading $Url"
        Invoke-WebRequest -Uri $Url -OutFile $Temp
        $Actual = Get-Sha256 $Temp
        if ($Actual -ne $Expected) {
            throw "SHA256 mismatch for $Temp. Expected $Expected, got $Actual"
        }
        Move-Item -Force $Temp $Path
    }
    finally {
        if (Test-Path $Temp) { Remove-Item -Force $Temp }
    }
}

function Write-Utf8NoBom([string]$Path, [string]$Text) {
    [IO.File]::WriteAllText($Path, $Text, [Text.UTF8Encoding]::new($false))
}

if ($BackupCount -lt 0) { throw "BackupCount must be >= 0" }
if ($DeployCommunityWorker) { $UpdateSystemd = $true }
if ($EnableAnalyticalAgent -and $DisableAnalyticalAgent) {
    throw "-EnableAnalyticalAgent and -DisableAnalyticalAgent are mutually exclusive"
}
if (($EnableAnalyticalAgent -or $DisableAnalyticalAgent) -and -not $DeployDiscordBot) {
    throw "Analytical agent flags require -DeployDiscordBot"
}
if ($RegisterDiscordCommands -and -not $DeployDiscordBot) {
    throw "-RegisterDiscordCommands requires -DeployDiscordBot"
}
foreach ($RemotePath in @($RemoteAppRoot, $RemoteCorpusRoot, $RemoteInbox, $RemoteCorpusDb, $RemoteCommunityRoot, $RemoteCommunityDb, $RemoteDiscordEnv, $RemoteDiscordStateRoot)) {
    if ($RemotePath -notmatch '^/[A-Za-z0-9_./-]+$' -or $RemotePath -match '(^|/)\.\.?(/|$)|//') { throw "Remote paths must be normalized absolute paths using letters, numbers, '/', '.', '_', or '-'." }
}
if ($DebianUser -notmatch '^[A-Za-z_][A-Za-z0-9_-]*$') { throw "DebianUser must be a simple Unix account name" }
if ($RemoteAppRoot -eq '/' -or $RemoteDiscordStateRoot -eq '/' -or $RemoteDiscordStateRoot -eq $RemoteAppRoot) { throw "RemoteAppRoot and Discord state must be separate non-root paths" }
foreach ($PersistentPath in @($RemoteDiscordEnv, $RemoteDiscordStateRoot, $RemoteCorpusRoot, $RemoteCorpusDb, $RemoteCommunityRoot, $RemoteCommunityDb, $RemoteInbox)) {
    if ($PersistentPath -eq "$RemoteAppRoot/app" -or $PersistentPath.StartsWith("$RemoteAppRoot/app/") -or $PersistentPath.StartsWith("$RemoteAppRoot/app-backup-")) { throw "Discord configuration and state must be outside the replaceable application and backups." }
}
foreach ($PersistentRoot in @($RemoteCorpusRoot, $RemoteCommunityRoot, $RemoteDiscordStateRoot, $RemoteInbox)) {
    if ("$RemoteAppRoot/app".StartsWith("$PersistentRoot/")) { throw "Persistent storage roots must not contain the replaceable application directory." }
}

Require-Command git
Require-Command ssh
Require-Command scp
Require-Command tar

$RepoPath = (Resolve-Path $RepoPath).Path
$CacheRoot = [IO.Path]::GetFullPath($CacheRoot)
New-Item -ItemType Directory -Force -Path $CacheRoot | Out-Null

$SshCommon = @()
if ($IdentityFile) {
    $IdentityFile = (Resolve-Path $IdentityFile).Path
    $SshCommon += @("-i", $IdentityFile)
}

Write-Host "==> Verifying repository and resolving commit"
Invoke-Native "git repository check" { git -C $RepoPath rev-parse --is-inside-work-tree | Out-Null }
$ResolvedCommit = (& git -C $RepoPath rev-parse "$Commit^{commit}").Trim()
if ($LASTEXITCODE -ne 0 -or -not $ResolvedCommit) {
    throw "Commit '$Commit' is not available in $RepoPath"
}
$ShortCommit = $ResolvedCommit.Substring(0, 12)
Write-Host "    requested: $Commit"
Write-Host "    resolved:  $ResolvedCommit"

$LockSpec = "${ResolvedCommit}:packages/corpus-query/pnpm-lock.yaml"
$LockBlob = (& git -C $RepoPath rev-parse $LockSpec).Trim()
if ($LASTEXITCODE -ne 0 -or -not $LockBlob) {
    throw "Could not resolve packages/corpus-query/pnpm-lock.yaml at $ResolvedCommit"
}
Write-Host "    corpus-query lock blob: $LockBlob"

$ToolsDir = Join-Path $CacheRoot "tools\pnpm-$PnpmVersion"
$StoresDir = Join-Path $CacheRoot "stores\pnpm-$PnpmVersion"
$ArchivesDir = Join-Path $CacheRoot "archives"
New-Item -ItemType Directory -Force -Path $ToolsDir, $StoresDir, $ArchivesDir | Out-Null

$PnpmWin = Join-Path $ToolsDir "pnpm-win-x64.exe"
$PnpmLinux = Join-Path $ToolsDir "pnpm-linux-x64"

Write-Host "==> Ensuring cached pnpm $PnpmVersion binaries"
Ensure-DownloadedAndVerified `
    "https://github.com/pnpm/pnpm/releases/download/v$PnpmVersion/pnpm-win-x64.exe" `
    $PnpmWin `
    $PnpmWinSha256
Ensure-DownloadedAndVerified `
    "https://github.com/pnpm/pnpm/releases/download/v$PnpmVersion/pnpm-linux-x64" `
    $PnpmLinux `
    $PnpmLinuxSha256

$StoreDir = Join-Path $StoresDir $LockBlob
$StoreReady = Join-Path $StoreDir ".bwforge-ready"
$StoreArchive = Join-Path $ArchivesDir "corpus-query-store-pnpm-$PnpmVersion-$LockBlob.tar.gz"

$TempRoot = Join-Path ([IO.Path]::GetTempPath()) "bwforge-deploy-$ShortCommit-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Force -Path $TempRoot | Out-Null

try {
    if (-not (Test-Path $StoreReady)) {
        Write-Host "==> Populating persistent corpus-query dependency cache"
        New-Item -ItemType Directory -Force -Path $StoreDir | Out-Null
        $LockWorkspace = Join-Path $TempRoot "lock-workspace"
        New-Item -ItemType Directory -Force -Path $LockWorkspace | Out-Null

        $LockLines = & git -C $RepoPath show $LockSpec
        if ($LASTEXITCODE -ne 0) { throw "git show failed for $LockSpec" }
        Write-Utf8NoBom (Join-Path $LockWorkspace "pnpm-lock.yaml") (($LockLines -join "`n") + "`n")

        Push-Location $LockWorkspace
        try {
            & $PnpmWin fetch --frozen-lockfile --store-dir $StoreDir
            if ($LASTEXITCODE -ne 0) { throw "pnpm fetch failed" }
        }
        finally {
            Pop-Location
        }
        Write-Utf8NoBom $StoreReady "$ResolvedCommit`n$LockBlob`n"
    }
    else {
        Write-Host "==> Dependency store already cached for lock $LockBlob"
    }

    if (-not (Test-Path $StoreArchive)) {
        Write-Host "==> Creating reusable dependency-store archive"
        $ArchiveTemp = "$StoreArchive.tmp-$([guid]::NewGuid().ToString('N'))"
        try {
            & tar -czf $ArchiveTemp -C $StoreDir .
            if ($LASTEXITCODE -ne 0) { throw "Failed to archive pnpm store" }
            Move-Item -Force $ArchiveTemp $StoreArchive
        }
        finally {
            if (Test-Path $ArchiveTemp) { Remove-Item -Force $ArchiveTemp }
        }
    }
    else {
        Write-Host "    cached archive: $StoreArchive"
    }

    $SourceArchive = Join-Path $TempRoot "source.tar.gz"
    Write-Host "==> Archiving BW Forge $ShortCommit"
    & git -C $RepoPath archive --format=tar.gz -o $SourceArchive $ResolvedCommit
    if ($LASTEXITCODE -ne 0) { throw "git archive failed" }

    $DiscordSourceSpec = "${ResolvedCommit}:apps/discord-bot/package.json"
    & git -C $RepoPath cat-file -e $DiscordSourceSpec 2>$null
    $HasDiscordSource = ($LASTEXITCODE -eq 0)
    if ($DeployDiscordBot -and -not $HasDiscordSource) {
        throw "Commit $ResolvedCommit does not contain apps/discord-bot; choose a commit with the Discord bot before deploying it."
    }
    $DiscordBundle = $null
    $DiscordBundleSha256 = ""
    if ($HasDiscordSource) {
        Require-Command bun
        $BunVersion = (& bun --version).Trim()
        if ($LASTEXITCODE -ne 0 -or $BunVersion -notmatch '^[0-9]+\.[0-9]+\.[0-9]+$') { throw "Could not resolve a safe Bun version for Discord bundling" }
        $DiscordBundle = Join-Path $ArchivesDir "discord-bot-bundle-$ResolvedCommit-bun$BunVersion-v1.tar.gz"
        if ($ForceDependencyUpload -or -not (Test-Path $DiscordBundle)) {
            Write-Host "==> Building self-contained Discord bot bundle locally"
            $DiscordBuildRoot = Join-Path $TempRoot "discord-source"
            New-Item -ItemType Directory -Force -Path $DiscordBuildRoot | Out-Null
            & tar -xzf $SourceArchive -C $DiscordBuildRoot
            if ($LASTEXITCODE -ne 0) { throw "Failed to extract source for local Discord bundle build" }
            Push-Location $DiscordBuildRoot
            $BundleTemp = $null
            try {
                & bun install --frozen-lockfile --production --ignore-scripts --filter "@bw-forge/discord-bot"
                if ($LASTEXITCODE -ne 0) { throw "Local Discord dependency install failed" }
                & bun build ./apps/discord-bot/src/main.ts ./apps/discord-bot/src/discord/register.ts ./apps/discord-bot/src/health.ts ./apps/discord-bot/src/service-policy.ts --target=bun --packages=bundle --outdir=discord-dist
                if ($LASTEXITCODE -ne 0) { throw "Local Discord bundle build failed" }
                if (-not (Test-Path "discord-dist/main.js") -or -not (Test-Path "discord-dist/discord/register.js") -or -not (Test-Path "discord-dist/health.js") -or -not (Test-Path "discord-dist/service-policy.js")) { throw "Discord bundle outputs are missing" }
                $BundleTemp = "$DiscordBundle.tmp-$([guid]::NewGuid().ToString('N'))"
                & tar -czf $BundleTemp -C discord-dist main.js discord/register.js health.js service-policy.js
                if ($LASTEXITCODE -ne 0) { throw "Failed to archive Discord bundle" }
                Move-Item -Force $BundleTemp $DiscordBundle
            }
            finally { Pop-Location; if ($BundleTemp -and (Test-Path $BundleTemp)) { Remove-Item -Force $BundleTemp } }
        }
        $DiscordBundleSha256 = Get-Sha256 $DiscordBundle
        Write-Host "    Discord bundle: $DiscordBundleSha256"
    }

    $RemoteHome = "/home/$DebianUser"
    $RemoteCache = "$RemoteHome/.cache/bwforge-deploy"
    $RemoteTools = "$RemoteCache/tools"
    $RemoteStores = "$RemoteCache/stores"
    $RemotePnpm = "$RemoteTools/pnpm-$PnpmVersion-linux-x64"
    $RemoteStore = "$RemoteStores/$LockBlob"
    $RemoteDrop = "$RemoteCache/drop-$ShortCommit-$([guid]::NewGuid().ToString('N').Substring(0,8))"

    # This probe uses BatchMode intentionally so it never creates an extra password prompt.
    & ssh @SshCommon -o BatchMode=yes "$DebianUser@$DebianHost" "true" 2>$null
    $PasswordlessSsh = ($LASTEXITCODE -eq 0)
    if (-not $PasswordlessSsh) {
        Write-Warning "Passwordless SSH is not configured. This deployment may prompt for the Debian login password up to three times. Configure an SSH key/agent to eliminate those prompts."
    }

    Write-Host "==> Probing persistent Debian deployment cache"
    $ProbeCommand = @"
set -e
mkdir -p '$RemoteDrop' '$RemoteTools' '$RemoteStores'
if [ -f '$RemotePnpm' ] && echo '$PnpmLinuxSha256  $RemotePnpm' | sha256sum -c - >/dev/null 2>&1; then
  echo PNPM_OK=1
else
  echo PNPM_OK=0
fi
if [ -f '$RemoteStore/.ready' ]; then
  echo STORE_OK=1
else
  echo STORE_OK=0
fi
"@
    $ProbeOutput = & ssh @SshCommon "$DebianUser@$DebianHost" $ProbeCommand
    if ($LASTEXITCODE -ne 0) { throw "Could not probe/create remote deployment cache" }
    $ProbeText = $ProbeOutput -join "`n"
    $RemoteHasPnpm = $ProbeText -match "(?m)^PNPM_OK=1$"
    $RemoteHasStore = $ProbeText -match "(?m)^STORE_OK=1$"

    if ($ForceDependencyUpload) {
        $RemoteHasPnpm = $false
        $RemoteHasStore = $false
    }

    Write-Host "    remote pnpm cache: $(if ($RemoteHasPnpm) { 'hit' } else { 'miss' })"
    Write-Host "    remote dependency cache: $(if ($RemoteHasStore) { 'hit' } else { 'miss' })"

    $RemoteScriptLocal = Join-Path $TempRoot "install.sh"
    $UpdateSystemdFlag = if ($UpdateSystemd) { "1" } else { "0" }
    $FullIntegrityFlag = if ($FullIntegrityCheck) { "1" } else { "0" }
$DeployDiscordFlag = if ($DeployDiscordBot) { "1" } else { "0" }
$EnableAnalyticalFlag = if ($EnableAnalyticalAgent) { "1" } else { "0" }
$DisableAnalyticalFlag = if ($DisableAnalyticalAgent) { "1" } else { "0" }
$RegisterDiscordFlag = if ($RegisterDiscordCommands) { "1" } else { "0" }
$DeployCommunityFlag = if ($DeployCommunityWorker) { "1" } else { "0" }

    $remoteScript = @'
#!/bin/bash
set -euo pipefail

COMMIT="__COMMIT__"
SHORT="__SHORT__"
USER_NAME="__USER__"
DROP="__DROP__"
APP_ROOT="__APPROOT__"
CORPUS_ROOT="__CORPUSROOT__"
INBOX="__INBOX__"
CORPUS_DB="__CORPUSDB__"
COMMUNITY_ROOT="__COMMUNITYROOT__"
COMMUNITY_DB="__COMMUNITYDB__"
BACKUP_COUNT="__BACKUPCOUNT__"
PNPM_VERSION="__PNPMVERSION__"
PNPM_SHA="__PNPMSHA__"
LOCK_BLOB="__LOCKBLOB__"
UPDATE_SYSTEMD="__UPDATESYSTEMD__"
RESTART_MODE="__RESTARTMODE__"
FULL_INTEGRITY="__FULLINTEGRITY__"
DEPLOY_DISCORD="__DEPLOYDISCORD__"
ENABLE_ANALYTICAL="__ENABLEANALYTICAL__"
DISABLE_ANALYTICAL="__DISABLEANALYTICAL__"
DEPLOY_COMMUNITY="__DEPLOYCOMMUNITY__"
REGISTER_DISCORD="__REGISTERDISCORD__"
DISCORD_ENV="__DISCORDENV__"
DISCORD_STATE="__DISCORDSTATE__"
DISCORD_BUNDLE_SHA="__DISCORDBUNDLESHA__"

# Keep an already-installed bot healthy when the normal replay deployment swaps
# the application tree. A fresh bot is opt-in with -DeployDiscordBot.
if [ "$DEPLOY_DISCORD" = "0" ] && { [ -f /etc/systemd/system/bw-forge-discord-bot.service ] || systemctl is-enabled --quiet bw-forge-discord-bot.service 2>/dev/null || systemctl is-active --quiet bw-forge-discord-bot.service 2>/dev/null; }; then
  DEPLOY_DISCORD="1"
  echo "==> Existing Discord bot detected; rebuilding it with this application revision"
fi
DISCORD_WAS_RUNNING=0
DISCORD_NEW_READY=0

CACHE="$HOME/.cache/bwforge-deploy"
TOOLS="$CACHE/tools"
STORES="$CACHE/stores"
PNPM="$TOOLS/pnpm-$PNPM_VERSION-linux-x64"
STORE="$STORES/$LOCK_BLOB"
BUILD="$CACHE/build-$SHORT-$$"

cleanup() {
  if [ "${DISCORD_WAS_RUNNING:-0}" = "1" ] && [ "${DISCORD_NEW_READY:-0}" = "0" ]; then
    sudo -n systemctl start bw-forge-discord-bot.service >/dev/null 2>&1 || true
  fi
  rm -rf "$BUILD"
}
trap cleanup EXIT

mkdir -p "$TOOLS" "$STORES" "$BUILD/app"

echo "==> Preparing cached deployment dependencies"
if [ -f "$DROP/pnpm-linux-x64" ]; then
  echo "$PNPM_SHA  $DROP/pnpm-linux-x64" | sha256sum -c - >/dev/null
  install -m 0755 "$DROP/pnpm-linux-x64" "$PNPM"
fi

test -f "$PNPM" || { echo "Missing cached pnpm binary: $PNPM" >&2; exit 1; }
echo "$PNPM_SHA  $PNPM" | sha256sum -c - >/dev/null
chmod +x "$PNPM"

if [ -f "$DROP/pnpm-store.tar.gz" ]; then
  TMP_STORE="$STORES/.${LOCK_BLOB}.tmp.$$"
  rm -rf "$TMP_STORE"
  mkdir -p "$TMP_STORE"
  tar -xzf "$DROP/pnpm-store.tar.gz" -C "$TMP_STORE"
  touch "$TMP_STORE/.ready"
  rm -rf "$STORE"
  mv "$TMP_STORE" "$STORE"
fi

test -f "$STORE/.ready" || { echo "Missing cached pnpm store for lock $LOCK_BLOB" >&2; exit 1; }

echo "==> Preparing source"
tar -xzf "$DROP/source.tar.gz" -C "$BUILD/app"
test -f "$BUILD/app/packages/corpus-query/pnpm-lock.yaml"

echo "==> Installing corpus-query dependencies fully offline"
cd "$BUILD/app/packages/corpus-query"
"$PNPM" install --offline --frozen-lockfile --store-dir "$STORE"
test -f "$BUILD/app/packages/corpus-query/node_modules/tsx/dist/cli.mjs"

echo "==> Building corpus-query"
"$PNPM" run build

# BEGIN OFFLINE DISCORD INSTALL
if [ "$DEPLOY_DISCORD" = "1" ]; then
  echo "==> Preparing self-contained Discord bot bundle"
  cd "$BUILD/app"
  command -v bun >/dev/null 2>&1 || { echo "Bun is required on the Debian host to deploy the Discord bot" >&2; exit 1; }
  test -n "$DISCORD_BUNDLE_SHA" || { echo "Missing local Discord bundle for this commit" >&2; exit 1; }
  echo "$DISCORD_BUNDLE_SHA  $DROP/discord-bot-bundle.tar.gz" | sha256sum -c - >/dev/null
  mkdir -p apps/discord-bot/dist
  tar -xzf "$DROP/discord-bot-bundle.tar.gz" -C apps/discord-bot/dist
  test -f apps/discord-bot/dist/main.js
  test -f apps/discord-bot/dist/discord/register.js
  bun --eval 'await import("./apps/discord-bot/dist/main.js"); await import("./apps/discord-bot/dist/discord/register.js");'
fi
# END OFFLINE DISCORD INSTALL

echo "==> Verifying new BW Forge source"
cd "$BUILD/app"
bun ./apps/cli/src/main.ts --help | grep -q "analyze-v2"
bun ./apps/cli/src/main.ts --help | grep -q "mcp"
test -f packages/corpus-query/dist/mcp/server.js

# Ask for sudo once, immediately before the privileged portion.
echo "==> Installing application"
sudo -v
sudo mkdir -p "$APP_ROOT"

STAGED="$APP_ROOT/.app-new-$SHORT-$$"
sudo rm -rf "$STAGED"
sudo cp -a "$BUILD/app" "$STAGED"
sudo chown -R "$USER_NAME:$USER_NAME" "$STAGED"

if [ "$DEPLOY_DISCORD" = "1" ] && systemctl is-active --quiet bw-forge-discord-bot.service 2>/dev/null; then
  echo "    stopping Discord bot before replacing its application tree"
  sudo systemctl stop bw-forge-discord-bot.service
  DISCORD_WAS_RUNNING=1
fi

if [ -e "$APP_ROOT/app" ]; then
  BACKUP="$APP_ROOT/app-backup-$(date +%Y%m%d-%H%M%S)"
  echo "    preserving previous app as $BACKUP"
  sudo mv "$APP_ROOT/app" "$BACKUP"
fi
sudo mv "$STAGED" "$APP_ROOT/app"

# Keep only the newest N backup directories.
if [ "$BACKUP_COUNT" -ge 0 ]; then
  mapfile -t BACKUPS < <(sudo find "$APP_ROOT" -maxdepth 1 -mindepth 1 -type d -name 'app-backup-*' -printf '%T@ %p\n' | sort -nr | cut -d' ' -f2-)
  if [ "${#BACKUPS[@]}" -gt "$BACKUP_COUNT" ]; then
    for ((i=BACKUP_COUNT; i<${#BACKUPS[@]}; i++)); do
      echo "    pruning old backup ${BACKUPS[$i]}"
      sudo rm -rf -- "${BACKUPS[$i]}"
    done
  fi
fi

if [ "$UPDATE_SYSTEMD" = "1" ]; then
  echo "==> Updating installed systemd appliance configuration"
  COMMUNITY_ARGS=()
  if [ "$DEPLOY_COMMUNITY" = "1" ]; then COMMUNITY_ARGS=(--community-corpus-root "$COMMUNITY_ROOT" --community-db "$COMMUNITY_DB"); fi
  sudo bash "$APP_ROOT/app/ops/systemd/install.sh" \
    --user "$USER_NAME" \
    --app-root "$APP_ROOT/app" \
    --corpus-root "$CORPUS_ROOT" \
    --inbox "$INBOX" \
    --db "$CORPUS_DB" "${COMMUNITY_ARGS[@]}"
fi

if [ "$DEPLOY_DISCORD" = "1" ]; then
  echo "==> Installing Discord bot service"
  BUN_BIN=$(command -v bun)
  sudo mkdir -p "$DISCORD_STATE" "$(dirname "$DISCORD_ENV")"
  sudo chown "$USER_NAME:$USER_NAME" "$DISCORD_STATE"
  sudo chmod 700 "$DISCORD_STATE"
  if [ ! -f "$DISCORD_ENV" ]; then
    sudo install -o "$USER_NAME" -g "$USER_NAME" -m 600 "$APP_ROOT/app/apps/discord-bot/.env.example" "$DISCORD_ENV"
    sudo sed -i "s#^DISCORD_BOT_DATABASE_PATH=.*#DISCORD_BOT_DATABASE_PATH=$DISCORD_STATE/bot.sqlite#" "$DISCORD_ENV"
    sudo sed -i "s#^BW_FORGE_REPO_ROOT=.*#BW_FORGE_REPO_ROOT=$APP_ROOT/app#" "$DISCORD_ENV"
    echo "Created $DISCORD_ENV from the bot example. Fill in its Discord and LLM secrets, then rerun with -DeployDiscordBot."
    DISCORD_CONFIGURED=0
  else
    DISCORD_CONFIGURED=0
  fi
  if [ "$ENABLE_ANALYTICAL" = "1" ] || [ "$DISABLE_ANALYTICAL" = "1" ]; then
    # Change only the explicitly requested agent settings. Existing operator
    # secrets, corpus definitions, and tuning values remain untouched.
    set_env_value() {
      local key="$1" value="$2" tmp
      tmp="$BUILD/.env.$$.tmp"
      sudo awk -v key="$key" -v value="$value" '
        BEGIN { updated = 0 }
        index($0, key "=") == 1 { print key "=" value; updated = 1; next }
        { print }
        END { if (!updated) print key "=" value }
      ' "$DISCORD_ENV" > "$tmp"
      sudo install -o "$USER_NAME" -g "$USER_NAME" -m 600 "$tmp" "$DISCORD_ENV"
      rm -f "$tmp"
    }
    if [ "$ENABLE_ANALYTICAL" = "1" ]; then
      echo "==> Enabling replay-aware analytical MCP tools"
      set_env_value BW_FORGE_AGENT_ENABLED true
      set_env_value BW_FORGE_MCP_COMMAND "$BUN_BIN"
      # Keep the JSON in single quotes so systemd EnvironmentFile parsing
      # preserves the inner double quotes for JSON.parse in loadConfig().
      set_env_value BW_FORGE_MCP_ARGS "'[\"$APP_ROOT/app/apps/cli/src/main.ts\",\"mcp\",\"--db\",\"{db_path}\",\"--transport\",\"stdio\"]'"
    else
      echo "==> Disabling replay-aware analytical MCP tools"
      set_env_value BW_FORGE_AGENT_ENABLED false
    fi
  fi
  if [ -f "$DISCORD_ENV" ]; then
    if sudo systemd-run --quiet --wait --collect \
      -p User="$USER_NAME" \
      -p WorkingDirectory="$APP_ROOT/app/apps/discord-bot" \
      -p EnvironmentFile="$DISCORD_ENV" \
      /usr/bin/env "DISCORD_BOT_DATABASE_PATH=$DISCORD_STATE/bot.sqlite" "$BUN_BIN" --eval 'import { loadConfig } from "./src/config/index.ts"; try { loadConfig(); } catch { process.exit(1); }'; then
      DISCORD_CONFIGURED=1
    else
      echo "Discord environment exists but required values are missing; bot will remain stopped until $DISCORD_ENV is configured."
    fi
  fi
  BUN_BIN=$(command -v bun)
  SERVICE_TMP="$BUILD/bw-forge-discord-bot.service"
  BOT_POLICY=""
  if [ "$DISCORD_CONFIGURED" = "1" ]; then
    # Derive policy from the same validated registry used by the bot. This
    # emits only escaped systemd path directives, never credentials or IDs.
    BOT_POLICY=$(sudo systemd-run --quiet --wait --pipe --collect \
      -p User="$USER_NAME" \
      -p WorkingDirectory="$APP_ROOT/app/apps/discord-bot" \
      -p EnvironmentFile="$DISCORD_ENV" \
      /usr/bin/env "DISCORD_BOT_DATABASE_PATH=$DISCORD_STATE/bot.sqlite" "$BUN_BIN" "$APP_ROOT/app/apps/discord-bot/src/service-policy.ts")
  fi
  sed -e "s#^User=.*#User=$USER_NAME#" \
      -e "s#^WorkingDirectory=.*#WorkingDirectory=$APP_ROOT/app/apps/discord-bot#" \
      -e "s#^EnvironmentFile=.*#EnvironmentFile=$DISCORD_ENV#" \
      -e "s#^ExecStart=.*#ExecStart=/usr/bin/env BW_FORGE_REPO_ROOT=$APP_ROOT/app DISCORD_BOT_DATABASE_PATH=$DISCORD_STATE/bot.sqlite $BUN_BIN $APP_ROOT/app/apps/discord-bot/dist/main.js#" \
      "$APP_ROOT/app/apps/discord-bot/bw-forge-discord-bot.service" \
      | sed '/^ReadWritePaths=/d; /^ReadOnlyPaths=/d' > "$SERVICE_TMP.base"
  if [ -n "$BOT_POLICY" ]; then
    sed '/^\[Install\]/,$d' "$SERVICE_TMP.base" > "$SERVICE_TMP"
    printf '%s\n' "$BOT_POLICY" >> "$SERVICE_TMP"
    sed -n '/^\[Install\]/,$p' "$SERVICE_TMP.base" >> "$SERVICE_TMP"
    rm -f "$SERVICE_TMP.base"
  else
    mv "$SERVICE_TMP.base" "$SERVICE_TMP"
  fi
  sudo install -o root -g root -m 644 "$SERVICE_TMP" /etc/systemd/system/bw-forge-discord-bot.service
  sudo systemctl daemon-reload
  if [ "$DISCORD_CONFIGURED" = "1" ]; then
    sudo systemctl enable bw-forge-discord-bot.service
    sudo systemctl restart bw-forge-discord-bot.service
    sudo systemctl is-active --quiet bw-forge-discord-bot.service
    DISCORD_NEW_READY=1
  else
    DISCORD_NEW_READY=1
    echo "Discord bot service installed but not started until $DISCORD_ENV is configured."
  fi
fi

if [ "$REGISTER_DISCORD" = "1" ]; then
  if [ "$DEPLOY_DISCORD" != "1" ]; then
    echo "RegisterDiscordCommands requires DeployDiscordBot" >&2
    exit 1
  fi
  test "$DISCORD_CONFIGURED" = "1" || { echo "Discord environment is not configured; command registration skipped."; REGISTER_DISCORD=0; }
  if [ "$REGISTER_DISCORD" = "1" ]; then
  echo "==> Registering Discord slash commands in the configured guild"
  sudo systemd-run --quiet --wait --collect \
    -p User="$USER_NAME" \
    -p WorkingDirectory="$APP_ROOT/app/apps/discord-bot" \
    -p EnvironmentFile="$DISCORD_ENV" \
    -p Environment="DISCORD_BOT_DATABASE_PATH=$DISCORD_STATE/bot.sqlite" \
    /usr/bin/env "DISCORD_BOT_DATABASE_PATH=$DISCORD_STATE/bot.sqlite" "$BUN_BIN" "$APP_ROOT/app/apps/discord-bot/dist/discord/register.js"
  fi
fi

case "$RESTART_MODE" in
  None)
    ;;
  Watcher)
    echo "==> Restarting watcher only"
    sudo systemctl restart bw-forge-watch.service
    ;;
  All)
    echo "==> Restarting BW Forge appliance services"
    sudo systemctl restart bw-forge-watch.service bw-forge-worker.service bw-forge-mcp.service bw-forge-reports-index.timer
    if sudo systemctl cat bw-forge-community-worker.service >/dev/null 2>&1; then sudo systemctl restart bw-forge-community-worker.service; fi
    if [ "${DISCORD_CONFIGURED:-1}" = "1" ] && sudo systemctl is-enabled --quiet bw-forge-discord-bot.service 2>/dev/null; then sudo systemctl restart bw-forge-discord-bot.service; fi
    ;;
  DiscordBot)
    if [ "${DISCORD_CONFIGURED:-1}" = "1" ]; then sudo systemctl restart bw-forge-discord-bot.service; else echo "Discord bot environment is not configured; bot was not restarted."; fi
    ;;
  CommunityWorker)
    if sudo systemctl cat bw-forge-community-worker.service >/dev/null 2>&1; then sudo systemctl restart bw-forge-community-worker.service; else echo "Community worker is not installed; use -DeployCommunityWorker first."; fi
    ;;
  *)
    echo "Invalid restart mode: $RESTART_MODE" >&2
    exit 1
    ;;
esac

echo "==> Final checks"
cd /
cd "$APP_ROOT/app"
pwd -P
bun ./apps/cli/src/main.ts --help | grep -q "mcp"
test -f packages/corpus-query/node_modules/tsx/dist/cli.mjs
test -f packages/corpus-query/dist/mcp/server.js

if [ -f "$CORPUS_DB" ]; then
  if [ "$FULL_INTEGRITY" = "1" ]; then
    echo "    running SQLite integrity_check"
    CHECK=$(sqlite3 "$CORPUS_DB" 'PRAGMA integrity_check;')
  else
    echo "    running SQLite quick_check"
    CHECK=$(sqlite3 "$CORPUS_DB" 'PRAGMA quick_check;')
  fi
  printf '%s\n' "$CHECK"
  test "$CHECK" = "ok"
else
  echo "    NOTE: corpus DB not found at $CORPUS_DB"
fi

rm -rf "$DROP"

echo
echo "Deployment complete: $COMMIT"
if [ "$RESTART_MODE" = "None" ]; then
  echo "NOTE: running replay services were not restarted. They may continue using already-loaded code until restarted."
fi
'@

    $Replacements = @{
        "__COMMIT__"       = $ResolvedCommit
        "__SHORT__"        = $ShortCommit
        "__USER__"         = $DebianUser
        "__DROP__"         = $RemoteDrop
        "__APPROOT__"      = $RemoteAppRoot
        "__CORPUSROOT__"   = $RemoteCorpusRoot
        "__INBOX__"        = $RemoteInbox
        "__CORPUSDB__"     = $RemoteCorpusDb
        "__COMMUNITYROOT__"= $RemoteCommunityRoot
        "__COMMUNITYDB__"  = $RemoteCommunityDb
        "__BACKUPCOUNT__"  = $BackupCount.ToString()
        "__PNPMVERSION__"  = $PnpmVersion
        "__PNPMSHA__"      = $PnpmLinuxSha256
        "__LOCKBLOB__"     = $LockBlob
        "__UPDATESYSTEMD__"= $UpdateSystemdFlag
        "__RESTARTMODE__"  = $Restart
        "__FULLINTEGRITY__"= $FullIntegrityFlag
        "__DEPLOYDISCORD__"= $DeployDiscordFlag
        "__ENABLEANALYTICAL__"= $EnableAnalyticalFlag
        "__DISABLEANALYTICAL__"= $DisableAnalyticalFlag
        "__DEPLOYCOMMUNITY__"= $DeployCommunityFlag
        "__REGISTERDISCORD__"= $RegisterDiscordFlag
        "__DISCORDENV__"= $RemoteDiscordEnv
        "__DISCORDSTATE__"= $RemoteDiscordStateRoot
        "__DISCORDBUNDLESHA__"= $DiscordBundleSha256
    }
    foreach ($Key in $Replacements.Keys) {
        $remoteScript = $remoteScript.Replace($Key, [string]$Replacements[$Key])
    }
    $remoteScript = $remoteScript -replace "`r`n", "`n"
    Write-Utf8NoBom $RemoteScriptLocal $remoteScript

    Write-Host "==> Uploading deployment payload"
    $ScpFiles = @($SourceArchive, $RemoteScriptLocal)
    if (-not $RemoteHasPnpm) { $ScpFiles += $PnpmLinux }
    if (-not $RemoteHasStore) { $ScpFiles += $StoreArchive }

    # Use predictable names in the remote drop.
    $UploadStage = Join-Path $TempRoot "upload"
    New-Item -ItemType Directory -Force -Path $UploadStage | Out-Null
    Copy-Item $SourceArchive (Join-Path $UploadStage "source.tar.gz")
    Copy-Item $RemoteScriptLocal (Join-Path $UploadStage "install.sh")
    if ($HasDiscordSource) { Copy-Item $DiscordBundle (Join-Path $UploadStage "discord-bot-bundle.tar.gz") }
    if (-not $RemoteHasPnpm) { Copy-Item $PnpmLinux (Join-Path $UploadStage "pnpm-linux-x64") }
    if (-not $RemoteHasStore) { Copy-Item $StoreArchive (Join-Path $UploadStage "pnpm-store.tar.gz") }

    $UploadFiles = Get-ChildItem -File $UploadStage | ForEach-Object { $_.FullName }
    & scp @SshCommon @UploadFiles "$DebianUser@$DebianHost`:$RemoteDrop/"
    if ($LASTEXITCODE -ne 0) { throw "scp deployment payload failed" }

    Write-Host ""
    Write-Host "==> Running Debian-side installer"
    Write-Host "    You should see at most one sudo password prompt."
    & ssh @SshCommon -t "$DebianUser@$DebianHost" "chmod +x '$RemoteDrop/install.sh' && '$RemoteDrop/install.sh'"
    if ($LASTEXITCODE -ne 0) { throw "Remote installer failed" }

    Write-Host ""
    Write-Host "SUCCESS: BW Forge $ShortCommit deployed."
    Write-Host "Local cache: $CacheRoot"
    Write-Host "Dependency lock cache: $LockBlob"
}
finally {
    if (Test-Path $TempRoot) {
        $CleanupTarget = [IO.Path]::GetFullPath($TempRoot)
        $CleanupBoundary = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
        if (-not $CleanupTarget.StartsWith($CleanupBoundary, [StringComparison]::OrdinalIgnoreCase)) { throw "Refusing cleanup outside the system temporary directory." }
        Remove-Item -LiteralPath $CleanupTarget -Recurse -Force
    }
}

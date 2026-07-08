# BW Forge Desktop

BW Forge Desktop is the local Windows product shell for the existing
`bw-forge` replay-analysis pipeline. It does not parse replays or interpret
strategy itself. The Electron main process invokes the existing root CLI for
analysis, SQLite ingestion, and MCP serving, while the React renderer provides
selection, progress, library, report, settings, and server controls.

## Current Packaging Model

The Windows installer now packages a self-contained BW Forge runtime under
`resources/runtime`. An installed user does not need a repository checkout or
developer runtimes.

The packaged runtime includes:

- the bundled root CLI entrypoint used for analyze, ingest, and MCP;
- the bundled `packages/corpus-query` CLI and MCP server entrypoints;
- the pinned Windows embeddable CPython runtime used for replay reduction;
- the replay reducer, report template, and runtime manifest; and
- the compiled BW Forge replay engine built from the imported ShieldBattery
  fork.

The one intentional external prerequisite is an existing
StarCraft: Brood War installation. BW Forge does not redistribute or install
StarCraft. In packaged mode, Settings prompts for a StarCraft directory,
validates it by checking for `x86\StarCraft.exe` and `x86\clientsdk.dll`,
persists the path, and reports packaged-runtime integrity separately from that
external dependency.

## Developer Setup

From the repository root:

```powershell
bun install
```

Prepare the imported runtime components if they are not already installed:

```powershell
cd packages\corpus-query
corepack enable
pnpm install
pnpm build

cd ..\..\third_party\shieldbattery
corepack enable
pnpm install
cd app
pnpm install
```

Follow the ShieldBattery build instructions for the native game hooks and make
sure the local ShieldBattery client can launch a replay before debugging the
desktop pipeline.

## Development

Start Electron with renderer hot reload:

```powershell
bun run desktop:dev
```

In development the application automatically uses the current repository as
its default runtime root. Settings are stored in Electron's per-user data
directory, not in the repository. Development mode still expects the existing
repository toolchain and imported runtime dependencies.

Run focused checks:

```powershell
bun run desktop:typecheck
bun run desktop:test
bun run desktop:build
```

The unit tests do not launch Electron, StarCraft, or the replay exporter.

## User Workflow

1. Open **Settings** and confirm the StarCraft installation, output, and
   database paths. In packaged mode the runtime location and bundled
   executables are fixed and read-only.
2. Open **Analyze** and choose one or more `.rep` files or a folder.
3. Select **Analyze and ingest**.
4. Monitor each replay and the streamed process log. A failed replay does not
   hide successful replay results.
5. Open **Library** after ingestion to browse canonical manifest metadata and
   launch the generated standalone report in BW Forge or the system browser.
6. Open **MCP server**, start the HTTP server, and copy the displayed endpoint
   into an MCP-capable client.

Only the process lifecycle determines success or failure. CLI text is shown
for diagnostics but is not treated as a machine-readable status protocol.

## Local Files

The application persists a versioned `settings.json` under Electron's
`userData` directory. Analysis artifacts and the SQLite database are written
to the paths selected in Settings.

The desktop app reads:

```text
<output>\corpus-manifest.json
<output>\replays\<replay-id>\replay-manifest.json
```

It opens only report files declared by a loaded replay manifest and contained
under the configured output directory.

## Common Failures

### StarCraft installation is missing or invalid

Choose the directory that contains:

```text
x86\StarCraft.exe
x86\clientsdk.dll
```

BW Forge will not start replay export until that directory is configured.

### Packaged runtime validation fails

The installed app expects its bundled runtime files beneath:

```text
<install dir>\resources\runtime
```

If runtime validation reports a missing internal component, reinstall the same
build instead of pointing the app at repository files or developer tools.

### MCP cannot start

MCP requires an existing SQLite corpus. Complete analysis and ingestion or
select an existing database in Settings.

## Windows Distribution

Build an unpacked application directory:

```powershell
cd apps\desktop
bun run pack:dir
```

Build the x64 NSIS installer:

```powershell
bun run desktop:pack:win
```

Artifacts are written to `apps\desktop\release`. The installer packages the
Electron shell, the bundled runtime, and third-party notices. On first launch,
select a valid StarCraft installation if one was not auto-detected.

The installer is not currently code-signed. Windows may show the standard
SmartScreen warning for an unsigned application.

## Release Verification Workflow

Use the installed artifact, not the repository runtime, for release checks.

1. Build the installer:

```powershell
bun run desktop:pack:win
```

2. Install it into a clean directory such as `C:\_bwf_install`.

3. Confirm the installed layout contains:

```text
BW Forge.exe
resources\runtime\manifest.json
resources\runtime\python\...\python.exe
resources\app.asar
```

4. Verify the installed app launches.

5. Run the installed CLI through the installed executable in Node mode to
   exercise analyze, ingest, and MCP against a fixture replay. Set:

```text
ELECTRON_RUN_AS_NODE=1
BW_FORGE_RUNTIME_KIND=packaged
BW_FORGE_NODE=<install dir>\BW Forge.exe
BW_FORGE_PYTHON=<install dir>\resources\runtime\python\...\python.exe
BW_FORGE_REPLAY_ENGINE_EXE=<install dir>\resources\runtime\third_party\shieldbattery\dist\bw-forge-replay-engine\win-unpacked\BW Forge Replay Engine.exe
BW_FORGE_REPLAY_ENGINE_CWD=<install dir>\resources\runtime\third_party\shieldbattery\dist\bw-forge-replay-engine\win-unpacked
BW_FORGE_STARCRAFT_PATH=<StarCraft install dir>
```

Then invoke:

```powershell
& '<install dir>\BW Forge.exe' '<install dir>\resources\runtime\apps\cli\src\main.js' analyze <fixture.rep> --out <analysis-dir>
& '<install dir>\BW Forge.exe' '<install dir>\resources\runtime\apps\cli\src\main.js' ingest <analysis-dir> --db <analysis-dir>\corpus.sqlite
& '<install dir>\BW Forge.exe' '<install dir>\resources\runtime\apps\cli\src\main.js' mcp --db <analysis-dir>\corpus.sqlite --transport http --host 127.0.0.1 --port 8099 --path /mcp
```

6. Verify:

- `corpus-manifest.json` and `corpus.sqlite` are created;
- replay reports resolve from manifest-declared paths under the installed
  workflow output; and
- no `BW Forge`, `BW Forge Replay Engine`, or `StarCraft` processes remain
  after analyze or MCP shutdown.

## Current Verification Status

The following has been verified against installed artifacts:

- the installer builds successfully;
- the app installs into a clean test directory (`C:\_bwf_install`);
- the installed app launches;
- the installed Settings screen shows packaged runtime integrity checks passing
  with a valid StarCraft installation;
- the installed runtime payload is present under `resources\runtime`;
- installed-resource analyze succeeds against a fixture replay;
- installed-resource ingest succeeds and creates `corpus.sqlite`;
- installed-resource MCP starts and binds an HTTP listener; and
- app-owned `BW Forge`, replay-engine, and `StarCraft` processes terminate
  after analyze and MCP shutdown.

The following is currently verified indirectly rather than by clicking through
the installed GUI:

- library loading and report-path resolution have been verified against the
  installed workflow output and manifest declarations, but report opening has
  not yet been exercised from the installed GUI with UI automation.

## Security Boundary

- Renderer sandboxing and context isolation are enabled.
- Node integration is disabled in the main UI and report windows.
- The preload exposes a narrow typed API.
- CLI commands use argument arrays with shell execution disabled.
- Report requests are checked against manifest-declared paths.
- Cancellation and shutdown terminate only child processes started by the app.

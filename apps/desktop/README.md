# BW Forge Desktop

The BW Forge desktop application is the Windows product shell for replay
analysis, corpus ingestion, report browsing, and the local MCP server.

## Packaged runtime

The Windows installer includes everything needed for replay analysis:

- the pinned headless-bwsim WebAssembly replay engine and asset pack;
- the bwsim JSONL exporter;
- embedded Python and the replay reducer;
- the standalone report template; and
- the corpus-query CLI and MCP server.

Users do not need StarCraft, ShieldBattery, Node, Bun, pnpm, Python, or a
separate headless-bwsim checkout. Standard competitive Melee and Top-vs-Bottom
replays are the supported baseline. Use Map Settings compatibility is not
guaranteed.

## User workflow

1. Add one or more `.rep` files, choose a replay folder, or drag replays into
   the Analyze view.
2. Start analysis.
3. Browse the generated reports in Library.
4. Start the MCP server when a local replay database is available.

No replay-engine setup or game installation path is required.

## Developer setup

From the repository root:

```powershell
bun install
cd packages\corpus-query
pnpm install
pnpm build
cd ..\..
```

The vendored `third_party/bwsim` runtime must be present. No backend-specific
package installation is required.

Useful commands:

```powershell
bun run desktop:dev
bun run desktop:test
bun run desktop:typecheck
bun run desktop:build
bun run desktop:pack:win
```

## Windows distribution

`bun run desktop:pack:win` creates an NSIS installer under
`apps/desktop/release`. `bun run --cwd apps/desktop pack:dir` creates an
unpacked application for smoke testing.

The installed runtime is under:

```text
resources\runtime\
  apps\cli\src\main.js
  apps\cli\src\bwsim-exporter.js
  apps\sc-forge\dist\build-order.single-file.html
  packages\legacy-replay-analysis\replay_analysis.py
  packages\corpus-query\dist\
  python\cpython-3.14.6-embed-amd64\
  third_party\bwsim\
    bwsim_wasm.bwforge.wasm
    sim.pack.gz
```

The desktop uses its own Electron executable in Node mode for the bundled CLI
and bwsim worker. It does not ship or launch a second Electron application.

## Local files and cleanup

User settings and analysis output remain under normal BW Forge user-data and
Documents locations. On startup, the app removes only the obsolete,
BW Forge-owned cache at:

```text
%LOCALAPPDATA%\BW Forge\runtime-cache\replay-engine
```

It never touches a StarCraft installation or an unrelated ShieldBattery
installation.

## Release verification

For a clean-machine smoke test:

1. Ensure no StarCraft path or installation is available.
2. Build the unpacked application or installer.
3. Confirm the installed runtime contains the two bwsim engine assets above and
   contains no replay-engine Electron distribution.
4. Analyze a representative `.rep`, ingest the output, open the report, and
   start the MCP server.
5. Run the repository test and typecheck gates before publishing.

The renderer remains sandboxed with no direct Node access. Filesystem and child
process operations stay in Electron's main process behind the typed preload
API.

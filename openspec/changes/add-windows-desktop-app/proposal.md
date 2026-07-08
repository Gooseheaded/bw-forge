## Why

`bw-forge` already produces deterministic replay analysis, reports, a SQLite corpus, and an MCP server, but its terminal-only workflow is not suitable for most Windows users. A local desktop product shell can make the existing pipeline usable without rewriting or weakening the proven analysis and query components.

## What Changes

- Add an Electron, React, TypeScript, and Vite desktop application under `apps/desktop`.
- Let users select replay files or replay directories, choose an app-managed output location, and run analysis plus corpus ingestion as one visible job.
- Show live process logs, stage progress, per-input outcomes, actionable setup failures, and cancellation state.
- Discover analyzed replay manifests into a local library with replay, player, race, matchup, duration, and report metadata.
- Open generated standalone reports in a protected in-app viewer or the system browser.
- Persist output, database, MCP, and runtime settings in the Electron user-data directory.
- Start and stop the existing MCP server for the selected corpus and show its connection details.
- Add focused tests, development scripts, Windows packaging configuration, runtime validation, and developer/user documentation.
- Preserve all existing CLI behavior and keep deterministic facts and strategy-neutral semantics in the existing pipeline.

## Capabilities

### New Capabilities

- `desktop-application`: Windows desktop workflow for replay selection, pipeline orchestration, progress and failure reporting, replay-library browsing, report opening, settings persistence, MCP lifecycle management, runtime validation, and distributable packaging.

### Modified Capabilities

None.

## Impact

- Adds `apps/desktop` and new root workspace/scripts.
- Adds Electron, React, Vite, testing, and Windows packaging dependencies.
- Reads canonical `corpus-manifest.json` and `replay-manifest.json` artifacts without changing their schemas.
- Invokes the existing `apps/cli/src/main.ts` entry point as child processes; no analyzer, corpus-query, MCP, or report-viewer rewrite is required.
- Packaged MVP builds may still require separately installed StarCraft, Python, Node/Bun, pnpm, and prepared ShieldBattery/corpus-query dependencies; startup validation and documentation will make those prerequisites explicit.

# bw-forge

`bw-forge` is an offline StarCraft: Brood War replay-analysis system. It turns
`.rep` files into deterministic game facts, standalone visual reports, a
queryable SQLite corpus, and an MCP interface for LLM-assisted analysis.

The repository began as a Milestone 1 consolidation of several sibling
projects. The current source also includes the later MCP analytics, native
SQLite, implicit database-path, informative text-output, and bounded
read-only SQL work.

## System Overview

```text
.rep replay
    |
    v
ShieldBattery replay exporter
    |
    | per-frame MessagePack timeline (.sbtl)
    v
Python replay analyzer
    |
    +-- per-player ZIP datasets
    +-- legacy manifest.json
    +-- standalone embedded HTML report
    |
    v
bw-forge canonical replay and corpus manifests
    |
    v
SQLite corpus ingestion
    |
    +-- deterministic CLI queries
    +-- structured query plans and ZIP exports
    +-- corpus analytics
    +-- MCP over stdio or HTTP
    +-- bounded read-only SQL
```

The design deliberately separates two responsibilities:

- The pipeline and MCP server are the **hard layer**. They return exact replay
  IDs, names, races, timings, counts, resources, deaths, and other
  deterministic facts.
- An LLM or human analyst is the **soft layer**. It interprets those facts as
  openings, transitions, timing windows, advantages, and strategic mistakes.
  Subjective coaching conclusions do not belong in the data layer.

## Components

### Root orchestration CLI

`apps/cli` contains the Bun/TypeScript `bw-forge` command. It:

- accepts a replay file or recursively discovers replay files in a directory;
- computes a SHA-256 replay ID and copies the original replay into canonical
  output;
- builds the current `sc-forge` standalone report template when necessary;
- invokes the ShieldBattery exporter and Python analyzer;
- writes normalized replay and corpus manifests;
- delegates ingestion and MCP serving to `packages/corpus-query`; and
- refuses to place analysis output in protected repository/source paths.

Entry point: `apps/cli/src/main.ts`

### Windows desktop application

`apps/desktop` is an Electron, React, TypeScript, and Vite product shell around
the root CLI. It provides replay file/folder import, a per-replay analysis
queue, streamed logs, corpus ingestion, a canonical-manifest replay library,
sandboxed report viewing, persistent settings, runtime prerequisite checks,
and managed MCP HTTP start/stop controls.

The desktop renderer has no direct Node access. Filesystem operations and
child processes stay in Electron's main process behind a typed preload API.
The Windows installer now packages the desktop shell together with the runtime
needed for analyze, ingest, report, library, and MCP workflows. The remaining
external prerequisite is an existing StarCraft: Brood War installation chosen
by the user; see `apps/desktop/README.md` for packaged-user and release
verification details.

### ShieldBattery replay execution and telemetry

`third_party/shieldbattery` is an imported ShieldBattery fork. Most of it is
upstream application code; the part central to `bw-forge` is the replay-export
path.

`pnpm run replay-export` launches Electron and StarCraft in fast replay-export
mode. Custom Rust instrumentation in
`third_party/shieldbattery/game/src/unit_timeline.rs` records per-frame:

- player names and owner IDs;
- minerals, gas, gathered resources, workers, and supply;
- unit counts and detailed unit state;
- production queues, morphs, upgrades, and tech in progress; and
- unit deaths.

The preferred timeline format is the compact `sb-unit-timeline-v2`
MessagePack format (`.sbtl`). JSONL remains supported for debugging and
compatibility.

### Python replay reduction

`packages/legacy-replay-analysis/replay_analysis.py` consumes a replay or an
exported timeline. For replay input it first runs the ShieldBattery exporter
and deletes the temporary timeline after analysis.

The analyzer detects building starts, morphs, production starts, upgrades,
optional tech research, economy, supply, composition changes, and deaths. It
uses ShieldBattery's 42 ms fastest-game replay clock and warns when timeline
sampling skips frames.

For each player it writes a ZIP bundle containing:

```text
player.json
build_order.txt
economy.json
supply.json
unit_counts.json   # when available
deaths.json        # when available
```

It also writes the legacy `replay-analysis-manifest-v1` manifest and an
embedded standalone HTML report. The legacy output contract is intentionally
preserved because corpus ingestion consumes it directly.

### Standalone replay report

`apps/sc-forge` is the maintained offline HTML viewer:

- `build-order.html` is the source document;
- `build-order.override.js` contains replay-analysis behavior and UI wiring;
- `build_single_file.js` embeds JavaScript and JSZip into one distributable
  HTML file; and
- `dist/build-order.single-file.html` is generated output.

The viewer presents build orders, economy, supply, army composition, and
combat losses on a shared timeline. It can import player ZIP bundles, carry an
embedded original replay, and produce compact textual analysis reports for
humans or LLMs.

`apps/sc-forge/raw-data`, `starcraft-data.csv`, and
`fetch_liquipedia.py` are legacy reference material, not runtime sources of
truth.

### Canonical manifests

`packages/schemas` defines the TypeScript types layered around legacy output:

- `bw-forge-replay-manifest-v1` identifies one replay, its copied source,
  legacy artifacts, players, and optional debug snapshot.
- `bw-forge-corpus-manifest-v1` indexes all replay directories under an
  analysis output root.

These wrapper manifests make the monorepo output stable without rewriting the
legacy player ZIP format. The SQLite ingester currently discovers and reads
the nested legacy `manifest.json` files.

### SQLite corpus and deterministic queries

`packages/corpus-query` ingests replay-analysis output into a native SQLite
database using Node's built-in `node:sqlite`. It no longer loads the complete
database into WASM memory.

The schema contains:

```text
schema_metadata
replays
players
build_order_events
economy_samples
supply_samples
unit_count_samples
death_events
```

Ingestion recursively discovers legacy manifests, reads only the ZIP filename
explicitly referenced for each player, and replaces existing replay rows
transactionally. Queries are perspective-aware: `self` and `enemy` refer to
the named player's and opponent's bundles within the same replay.

The package provides:

- primitive replay, event, economy, unit-count, and death queries;
- validated `query-planner-v1` execution;
- ZIP export containing plans, results, CSV/README summaries, and matched HTML;
- corpus discovery and aggregate timing/composition/economy/death analytics;
- compact player replay cards;
- schema descriptions, semantic notes, and curated SQL examples; and
- conservatively validated, row-bounded, read-only SQL execution.

See `packages/corpus-query/README.md` and its local `AGENTS.md` for the exact
query and interpretation contracts.

### MCP server

`packages/corpus-query/src/mcp` exposes the corpus over MCP using stdio or
Streamable HTTP transports. It returns both model-friendly `content.text` and
canonical machine-readable `structuredContent`.

The MCP surface includes:

- server/build metadata;
- schema discovery and safe SQL;
- explicit corpus ingestion;
- player, matchup, item, and unit discovery;
- aggregate replay analytics;
- structured query-plan execution and export; and
- backward-compatible primitive tools and `bw_replay://` resource templates.

Read-only tools resolve the database in this order:

1. explicit `db_path`;
2. `BW_REPLAY_DB_PATH`; then
3. `./corpus.sqlite`.

`ingest_corpus` remains an explicit write operation and requires a target
database path.

### Preserved browser summarizer

`packages/replay-analysis-summarizer` is an auxiliary Playwright script that
loads generated HTML reports and calls their report-building API to produce
combined text files. It is preserved for compatibility but is not invoked by
the root CLI's normal analyze/ingest/MCP path.

## Repository Layout

```text
apps/cli                         Root Bun/TypeScript wrapper CLI
apps/desktop                     Electron/React Windows product shell
apps/sc-forge                    Offline replay-report UI and single-file builder
packages/corpus-query            SQLite ingest, queries, analytics, and MCP
packages/legacy-replay-analysis  Python timeline reducer and artifact writer
packages/replay-analysis-summarizer
packages/schemas                 Canonical wrapper manifest types
third_party/shieldbattery        Imported replay runtime and telemetry exporter
fixtures                         Golden replay and expected-output fixtures
docs                             Artifact and migration documentation
openspec                         Spec-driven change proposals and tasks
.beads                           Persistent issue-tracking data
```

Generated analysis output should go in a dedicated ignored directory such as
`out/` or `tmp/runs/<name>/`, not under a source component.

## Commands

Run the public workflow from the repository root:

```powershell
bun run bw-forge -- analyze <replay-or-dir> --out <dir>
bun run bw-forge -- ingest <analysis-dir> --db <path>
bun run bw-forge -- mcp --db <path>
```

Examples:

```powershell
bun run bw-forge -- analyze .\fixtures\replays --out .\tmp\runs\fixtures
bun run bw-forge -- ingest .\tmp\runs\fixtures --db .\tmp\fixtures.sqlite
bun run bw-forge -- mcp --db .\tmp\fixtures.sqlite
```

`mcp` defaults to stdio. It also supports HTTP:

```powershell
bun run bw-forge -- mcp --db .\tmp\fixtures.sqlite --transport http --host 127.0.0.1 --port 8089 --path /mcp
```

If the repository is linked with `bun link`, the binary name is `bw-forge`.

Desktop development and packaging:

```powershell
bun install
bun run desktop:dev
bun run desktop:test
bun run desktop:typecheck
bun run desktop:build
bun run desktop:pack:win
```

## Analyze Output

`bw-forge analyze` writes:

```text
<out>/
  corpus-manifest.json
  replays/
    <sha256-replay-id>/
      replay-manifest.json
      raw/
        <original replay>.rep
      debug/
        <replay-id>.sbtl       # only with --keep-snapshots
      legacy/
        manifest.json
        player_<owner>.zip
        <standalone report>.html
```

By default the intermediate `.sbtl` timeline is temporary.
`--keep-snapshots` preserves it for debugging, and `--snapshot-dir` can
override its location.

## Runtime Requirements and Boundaries

- Replay analysis is currently Windows-only because it runs the imported
  ShieldBattery/Electron/StarCraft replay exporter.
- The root package uses Bun 1.3.x.
- The desktop shell uses Electron, React, TypeScript, Vite, and
  electron-builder. Its Windows distributable now bundles the BW Forge runtime
  and still requires an existing StarCraft installation.
- `packages/corpus-query` uses pnpm and requires Node 24 or newer for
  `node:sqlite`.
- Replay reduction requires Python 3 but uses only the standard library.
- ShieldBattery also contains Rust game instrumentation and a much larger
  upstream client/server codebase. Do not assume all of that code participates
  in `bw-forge`.
- The root Bun workspace intentionally lists only `apps/cli` and
  `packages/schemas`; imported components retain their own package managers and
  build/test commands.

## Tests and Quality Gates

Root TypeScript:

```powershell
bun run test
bun run typecheck
```

These root scripts dispatch each component through its required runtime:
Bun for the wrapper CLI, Vitest for the desktop app, and Node/tsx for the
native-`node:sqlite` corpus package.

Desktop application:

```powershell
bun run desktop:typecheck
bun run desktop:test
bun run desktop:build
```

Corpus query package:

```powershell
cd packages\corpus-query
pnpm check
pnpm build
pnpm test
```

Python replay analyzer:

```powershell
python -m unittest discover -s packages\legacy-replay-analysis\tests -p "test_*.py"
```

Standalone viewer:

```powershell
cd apps\sc-forge
node .\smoke-test.js
```

Tests cover output-path safety, timeline decoding and event detection,
artifact generation, manifest-referenced ZIP ingestion, idempotent replay
replacement, perspective-aware queries, query plans, MCP transports and
resources, analytics, SQL validation, and export packaging.

## Fixtures and Sample Output

- `fixtures/replays` contains source replay fixtures.
- `fixtures/expected` contains golden legacy analysis output.
- Generated or manually inspected corpora may exist elsewhere in a working
  tree; they are not authoritative source code.

## Development Workflow

- Use `bd` for issue tracking. Start with `bd prime` and `bd ready`.
- Use OpenSpec proposals under `openspec/changes` for larger spec-driven
  changes.
- Preserve existing MCP tools and compatibility resources additively.
- Keep deterministic facts in the data/MCP layer and strategic interpretation
  outside it.
- When changing corpus queries, test both MCP tool and compatibility-resource
  paths where applicable.
- Treat generated `dist` files, SQLite databases, replay outputs, and
  snapshots as artifacts rather than source unless a task explicitly says
  otherwise.

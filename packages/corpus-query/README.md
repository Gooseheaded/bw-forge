# bw-replay-corpus-query

Deterministic Brood War replay-corpus ingest, query, query-plan execution, and MCP serving over `replay-analysis` output.

## Corpus v1 and v2 backends

The same query API, MCP server, tool names, resource templates and stdio/HTTP
transports support both backends. `db/backend.ts` detects Corpus v2 using
`PRAGMA user_version=2` **and** the `corpus_metadata` marker
(`schema_version=2`, `purpose=corpus-store`), then checks its required tables.
Prototype or malformed v2 databases are rejected rather than guessed to be v1.
V1 implementations remain in `query/legacyQuery.ts` and `analytics/legacy_*`;
the public query/analytics modules dispatch beneath the existing MCP handlers.
There is no migration or production cutover.

```sh
bw-forge mcp --db /srv/bw-forge/corpus/db/corpus.sqlite
```

`server_info` reports the selected `corpus_backend`, supported backends and
v1-only tools. It also accepts an optional `db_path`. With no selected database
it reports backend capabilities; an unavailable/invalid database is reported
in `database_error`. Query and resource operations open read-only connections;
each MCP query holds a read transaction so its multiple lookups share one
accepted-analysis snapshot. Read-only SQL restrictions and row limits remain
unchanged.

The following tools support v2:

- Discovery: `get_corpus_summary`, `list_players`, `list_matchups`,
  `list_build_items`, `search_build_items`, `list_unit_types`, `find_replays`.
- Primitives: `find_first_event`, `list_build_events`, `find_nth_event`,
  `get_unit_count`, `get_economy`, `get_deaths`.
- Analytics: `get_event_timing_distribution`,
  `count_replays_with_event_before_event`, `get_composition_snapshot`,
  `get_economy_distribution`, `get_death_summary`, `get_player_replay_card`.
- Assistance: `describe_schema`, `get_schema_notes`, `list_query_examples`,
  `validate_readonly_sql`, `execute_readonly_sql`, `server_info`.

`ingest_corpus`, `execute_query_plan` and `export_query_plan_zip` retain v1
behavior. Against v2 they return an MCP error with
`error.code=NOT_SUPPORTED_FOR_CORPUS_V2` and `error.backend=v2`. Use `analyze-v2`
and `ingest-v2` for v2 ingestion. No alias, canonical-player, group/scope, queue,
watcher, downloader or historical-analysis API is introduced.

### V2 interpretation and compatible result extensions

All normal queries join `replays -> current_analyses -> indexed analysis_runs ->
analysis_participations`. External replay IDs are SHA-256 strings; integer
replay, participation and observation IDs stay internal. Player matching uses
raw `participations.observed_name` with the existing case-insensitive matching
convention, never aliases. Matchups are derived from the races of current
participating slots in owner order; maps come from observed replay metadata.

Seconds APIs use each current analysis specification's rational frame clock.
Economy and supply read the latest full tuple **inside** the covering segment.
Composition reads the latest per-unit change inside its segment, honoring the
spec's `analysis_unit_domain`. Explicit positive-to-zero transitions remain zero.
An in-domain unit absent from a complete baseline is known zero; an out-of-domain
unit is UNKNOWN. Nothing carries across a coverage gap or beyond an endpoint.
All these queries operate on sparse indexed tables; no dense compatibility
tables or telemetry expansion are created.

Existing primitive `sample` shapes are preserved. V2 adds `availability`:
`known`, `before_coverage`, `after_coverage`, `gap`, or `unobserved`. UNKNOWN has
`sample:null`, not count zero. Known samples include their source/baseline frame;
unit samples add `basis` (`explicit_change` or `complete_baseline_absence`).
Composition aggregates expose per-unit `unknownCounts`, `unitSampleSizes`, and
example `availability`; numeric summaries exclude unknown values. Economy
aggregates add `unknownCount`. `sampleSize` remains the number of participating
perspectives with usable samples, rather than the number of raw sparse rows.

Build events retain every occurrence and coarse `time_seconds`. Additional
`frame`, `frame_min`, `frame_max`, `timing_basis`, and seconds bounds preserve
legacy timestamp uncertainty. Time filters/statistics use recorded coarse
timestamps; they do not claim exact frame precision. Event-before-event
comparisons require non-overlapping bounds for a definite ordering; overlapping
cases are returned in `uncertainCount`/`uncertainExamples` and excluded from the
definite-match percentage denominator. The same occurrence is never before itself.

Deaths remain individual observed events in inclusive frame/time intervals,
including simultaneous deaths. Death results and summaries disclose
`coverage_basis=observations_only`: no events is not proof of complete coverage.
The compatibility field `killed` means opponent losses, not killer attribution.

Published v2 databases use `analysis_publications` and
`analysis_artifact_locations` for current immutable paths and ZIP members.
Unpublished 2A databases can lack these optional tables, so filenames/source
paths are null and legacy non-null manifest/ZIP path fields are empty strings.
No source artifacts are read during queries. Duration is the current
`processed_end_frame` converted with its clock, an observed endpoint rather than
a guarantee of full replay duration; replay cards expose `duration_basis`.
V2 discovery's legacy `unitCountSampleCount` counts sparse change rows.

Schema notes and runnable SQL examples teach these v2 joins, clocks, coverage,
domain/zero semantics and immutable artifact metadata. They select their backend
from `db_path` or the configured database; without a database they retain v1
guidance. Raw read-only SQL can deliberately inspect history, but callers must
join through `current_analyses` for the normal current-only interpretation.

V2 tests construct real artifact bundles and run the shared corpus-store importer,
including historical/current runs. Set `BW_FORGE_PYTHON` to Python 3.11+ (or the
embedded Windows runtime) when running repository tests. The stdio smoke test
launches the actual `bw-forge mcp --db <v2>` CLI; `BW_FORGE_BUN` can select Bun.

The preferred packaged commands are:

- `bw-replay-corpus` for the local CLI
- `bw-replays-mcp` for the stdio MCP server

Legacy aliases `replay-corpus` and `replay-corpus-mcp` are still shipped for compatibility.

## Package

- package name: `bw-replay-corpus-query`
- current runtime entrypoints:
  - `bw-replay-corpus`
  - `bw-replays-mcp`
- runtime files are shipped from `dist/` plus the README, planner docs, and example query plans

`pnpm build` compiles the TypeScript sources to `dist/` and writes `dist/build-info.json`, which is used by the MCP `server_info` tool to report the live build timestamp.

## CLI

Typical local workflow:

```powershell
pnpm build
bw-replay-corpus ingest <analysis-output-root> --db .\corpus.sqlite
bw-replay-corpus query replays --db .\corpus.sqlite --matchup ZvT --player pbjt --race zerg
bw-replay-corpus query-plan execute --db .\corpus.sqlite --plan .\examples\query-plans\pbjt-zvt-early-muta-vessel.json
bw-replay-corpus query-plan export-zip --db .\corpus.sqlite --plan .\examples\query-plans\pbjt-zvt-early-muta-vessel.json --html-root <analysis-output-root> --out .\results.zip
```

You can also invoke the built files directly:

```powershell
node dist/cli.js ingest <analysis-output-root> --db .\corpus.sqlite
node dist/cli.js query-plan execute --db .\corpus.sqlite --plan .\examples\query-plans\pbjt-zvt-early-muta-vessel.json
```

Ingest now runs in replay batches of 10 by default. The CLI prints a per-batch progress line to stderr after each chunk completes, and you can override the chunk size with `--batch-size <count>`.

Player-scoped query results always include:

- `replay_id`
- `source_replay_filename`
- `source_replay_path`
- `matchup`
- `player_name` / `self_owner`
- `target_name` / `target_owner`

Primitive perspective-aware queries, including `get_deaths`, work against either player bundle:

- default `as: "self"` reads the named player's own bundle
- `as: "enemy"` reads the opponent bundle from the same replay

This means the corpus can answer death queries for both sides when both player ZIPs are present in the manifest.

The CLI `query muta-vessel-candidates` helper now returns both death perspectives explicitly:

- `self_deaths_between`
- `self_deaths_summary`
- `enemy_deaths_between`
- `enemy_deaths_summary`

For compatibility, it also keeps:

- `deaths_between`
- `deaths_summary`

Those legacy fields are aliases for the self-side deaths only.

## Manifest ZIP Rule

The ingester follows the manifest exactly.

- It reads only the ZIP filename named by `players[].zip_filename`.
- It does not scan sibling ZIPs.
- It does not care whether the referenced filename is deterministic (`player_<owner>.zip`) or legacy (`pbjt.zip`, `Aether-X.zip`, etc.).
- Deterministic `player_<owner>.zip` is preferred, but not required if the manifest points elsewhere.

This means a manifest-referenced legacy ZIP filename is accepted for compatibility.

## Query Plan ZIP Export

`query-plan export-zip` is a presentation/export layer over the deterministic query-plan executor.

- It executes an existing `query-planner-v1` plan against the SQLite corpus.
- It writes `query-plan.json` and `query-result.json` into the ZIP for reproducibility.
- It emits `README.md` and `matched-replays.csv` for human review.
- It packages matched replay HTML artifacts under `replays/` when they can be found under `--html-root`.
- Missing HTML does not fail the export. The replay still appears in the README and CSV, and a warning is recorded instead.

## MCP Server

The project exposes the deterministic query layer through a thin stdio MCP server.

- `ingest_corpus` is the explicit write path for creating or updating a SQLite corpus from `replay-analysis` output.
- Query tools open an existing SQLite corpus and call the current query helpers.
- Query and export tools do not auto-ingest.
- The server does not parse replay folders during query execution.
- The server does not call `replay-analysis`.
- The server does not contain LLM logic, strategic interpretation, or derived predicates.

### MCP Tools

- `server_info`
- `ingest_corpus`
- `find_replays`
- `find_first_event`
- `list_build_events`
- `find_nth_event`
- `get_unit_count`
- `get_economy`
- `get_deaths`
- `execute_query_plan`
- `export_query_plan_zip`

All primitive query tools return structured JSON with:

- `count`
- `results`

`execute_query_plan` returns a `query-executor-result-v1` payload.

`export_query_plan_zip` returns:

- `out_path`
- `coarse_count`
- `matched_count`
- `html_files_added`
- `warning_count`
- `warnings`

`ingest_corpus` returns:

- `db_path`
- `analysis_output_root`
- `manifests_discovered`
- `replays_ingested`
- `players_inserted`
- `batch_size`
- `batches`
- `warnings`
- `errors`

`server_info` returns:

- `package_name`
- `package_version`
- `build_timestamp`
- `supported_tools`
- `current_working_directory`
- `node_version`

### Local Development Run

```powershell
pnpm build
node dist/mcp/server.js
```

For source-driven development:

```powershell
pnpm mcp:start
```

## Packaged MCP Installation

The preferred installation path is the packaged binary command, not a repo-local `node dist/...` path.

### Build and Pack

```powershell
pnpm clean
pnpm install
pnpm check
pnpm build
pnpm test
pnpm pack
```

This produces a tarball like `bw-replay-corpus-query-0.2.0.tgz`.

### Install From Tarball

In a clean temp directory:

```powershell
npm install C:/path/to/bw-replay-corpus-query-0.2.0.tgz
npx bw-replays-mcp
```

Or globally:

```powershell
npm install -g C:/path/to/bw-replay-corpus-query-0.2.0.tgz
bw-replays-mcp
```

### Preferred MCP Client Configuration

```json
{
  "mcpServers": {
    "bw_replays": {
      "command": "bw-replays-mcp",
      "args": []
    }
  }
}
```

This is the recommended way to run the packaged server as a third-party-style MCP installation.

### Fallback Repo-Local Configuration

If you are developing locally and want to run the built artifact directly:

```json
{
  "mcpServers": {
    "bw_replays": {
      "command": "node",
      "args": [
        "C:/Users/gctri/Documents/_/replay-corpus-query/dist/mcp/server.js"
      ]
    }
  }
}
```

### Corpus Selection

The MCP server does not keep a default corpus open. Each tool call must provide `db_path`, for example:

- `./corpus.sqlite`
- `C:/Users/gctri/Documents/_/replay-corpus-query/corpus.sqlite`

For replay-centric follow-up exploration, primitive tools and `execute_query_plan` also support optional `replay_ids` scoping. This lets a later query stay inside a previously matched replay subset without adding aggregate semantics.

### `server_info` Verification

Use the MCP `server_info` tool after install or redeploy to verify the live server:

- package name
- package version
- build timestamp
- supported tool names
- current working directory
- node version

This is the intended check for “is the live `bw_replays` server stale?”

## MCP Usage Notes

- For multi-step replay-centric questions, LLMs should prefer `execute_query_plan`.
- Primitive MCP tools remain available for simple lookups, inspection, and debugging.
- If the user asks for “a ZIP file with the results,” the LLM should create a query plan and call `export_query_plan_zip`.
- MCP v1 exposes only generic deterministic primitives.
- Strategy-specific composition or classification belongs in future query-planning or database-enrichment layers.
- When using `get_deaths`, set `as: "self"` or `as: "enemy"` deliberately rather than assuming death evidence is self-only.

## Example MCP Payloads

`server_info`

```json
{}
```

`ingest_corpus`

```json
{
  "analysis_output_root": "C:/Users/gctri/Documents/_/replay-analysis/zvt-pbjt",
  "db_path": "./corpus.sqlite"
}
```

`execute_query_plan`

```json
{
  "db_path": "./corpus.sqlite",
  "mode": "normal",
  "plan": {
    "planner_schema": "query-planner-v1",
    "query": {
      "original_text": "Which pbjt ZvT games have early Mutalisks before enemy Science Vessels are out?",
      "intent": "find_replays_matching_pattern"
    },
    "replay_set": {
      "matchup": "ZvT",
      "player": "pbjt",
      "race": "zerg"
    },
    "constraints": [
      {
        "id": "self_first_mutalisk_before_6m",
        "type": "first_event_before",
        "perspective": "self",
        "item": "Mutalisk",
        "before_seconds": 360
      }
    ],
    "evidence_requests": [],
    "assumptions": [],
    "unsupported_or_approximate": []
  }
}
```

`export_query_plan_zip`

```json
{
  "db_path": "./corpus.sqlite",
  "html_root": "C:/Users/gctri/Documents/_/replay-analysis/zvt-pbjt",
  "out_path": "./pbjt-results.zip",
  "mode": "normal",
  "plan": {
    "planner_schema": "query-planner-v1",
    "query": {
      "original_text": "Which pbjt ZvT games have early Mutalisks before enemy Science Vessels are out?",
      "intent": "find_replays_matching_pattern"
    },
    "replay_set": {
      "matchup": "ZvT",
      "player": "pbjt",
      "race": "zerg"
    },
    "constraints": [
      {
        "id": "self_first_mutalisk_before_6m",
        "type": "first_event_before",
        "perspective": "self",
        "item": "Mutalisk",
        "before_seconds": 360
      }
    ],
    "evidence_requests": [],
    "assumptions": [],
    "unsupported_or_approximate": []
  }
}
```

`find_replays`

```json
{
  "db_path": "./corpus.sqlite",
  "matchup": "ZvT",
  "player": "pbjt",
  "race": "zerg"
}
```

`find_first_event`

```json
{
  "db_path": "./corpus.sqlite",
  "player": "pbjt",
  "item": "Mutalisk",
  "matchup": "ZvT",
  "race": "zerg",
  "as": "self"
}
```

`list_build_events`

```json
{
  "db_path": "./corpus.sqlite",
  "player": "pbjt",
  "item": "Hatchery",
  "matchup": "ZvT",
  "race": "zerg",
  "as": "self",
  "from_seconds": 180,
  "to_seconds": 480
}
```

`find_nth_event`

```json
{
  "db_path": "./corpus.sqlite",
  "player": "pbjt",
  "item": "Hatchery",
  "n": 2,
  "matchup": "ZvT",
  "race": "zerg",
  "as": "self"
}
```

`get_unit_count`

```json
{
  "db_path": "./corpus.sqlite",
  "player": "pbjt",
  "unit": "Mutalisk",
  "at_seconds": 420,
  "matchup": "ZvT",
  "race": "zerg",
  "as": "self"
}
```

`get_economy`

```json
{
  "db_path": "./corpus.sqlite",
  "player": "pbjt",
  "at_seconds": 300,
  "matchup": "ZvT",
  "race": "zerg",
  "as": "self"
}
```

`get_deaths`

```json
{
  "db_path": "./corpus.sqlite",
  "player": "pbjt",
  "from_seconds": 300,
  "to_seconds": 480,
  "matchup": "ZvT",
  "race": "zerg",
  "as": "self"
}
```

## Packaging Smoke Test

The repo ships a packaging smoke-test helper:

```powershell
pnpm pack
pnpm verify:packaged .\bw-replay-corpus-query-0.2.0.tgz
```

It installs the tarball into a clean temp directory, launches the packaged `bw-replays-mcp` binary over stdio, calls `server_info`, and prints the observed package/build metadata and tool surface.

The verifier tries `npm install` first. If that stalls or cannot reach the registry in a locked-down environment, it falls back to `pnpm add --offline` so local packaging smoke tests do not hang indefinitely.

# Corpus store (Milestone 2A)

```ts
import { ingestReplayAnalysis } from "@bw-forge/corpus-store";
const result = await ingestReplayAnalysis({ dbPath, replayManifestPath });
```

Manual testing: `bun run bw-forge ingest-v2 <replay-manifest.json> --db <new-v2.sqlite>`.
Requires Python 3.11+ with SQLite 3.37+. Set `BW_FORGE_PYTHON` to the executable
(including BW Forge's embedded Python on Windows); otherwise uses py/python on
Windows and python3/python on Unix. No Python packages are required. The typed
API launches the shared Python importer with a hidden window and returns its
JSON result. Python callers can use `ingest_replay_analysis(db_path, manifest_path)`.

The SQLite schema is `python/schema.sql` plus `python/events.sql`. Existing v1,
prototype, or unrelated databases are rejected. This is an opt-in store; neither
the v1 ingest command nor analyzer output paths change. No artifact publication,
daemon, watcher, MCP, alias resolution, or production cutover is included.

`python/sparse.py` promotes Milestone 1's verified economy/composition ingestion
and reconstruction unchanged. Economy stores full tuple changes, resetting at
coverage gaps. Composition compares complete dictionaries, explicitly writes
disappearances as zero, and ends coverage at the final source snapshot. Only
observed composition labels enter the immutable spec domain: unknown historical
exclusions must not turn unobserved labels into zero.

Each nonblank build line is an occurrence, including identical lines. The source
renderer already deduplicated some events; those lost occurrences cannot be
recovered. Its second-floor timestamps become inclusive integer frame bounds
`ceil(seconds*1000/42)` through `ceil((seconds+1)*1000/42)-1`, with exact frame
NULL and timing basis `legacy_second_floor`. Item text is preserved, including
upgrade/research labels, in the compact unit dictionary. Builds make no continuous
coverage assertion. Supply stores tuple changes through its last sample. Deaths
retain individual frames, source unit IDs, types, categories and coordinates;
coverage proves only frames with observations, never absence between events.

Specifications include the producer/reducer identity, bwsim version, WASM and
asset hashes, telemetry contract, settings, 42ms clock, observation domain, and
importer implementation hash. Existing manifests omit producer provenance: these
values are explicitly `unknown`/NULL, never inferred from today's installation.
Optional `analysis_spec` objects in legacy and replay manifests supply known
provenance (replay manifest takes precedence); every supplied field is retained
in the fingerprint, including extra result-affecting settings. The reader supports
this metadata without changing analyzer output. Source-normalized implementation
hashes are stable across CRLF/LF checkouts. Specs contain no replay SHA or artifact
hashes, so compatible analyses can share a spec.

Analysis keys hash replay SHA, specification fingerprint, and the sorted logical
artifact/checksum inventory: raw replay bytes, semantic manifest metadata, and
every uncompressed ZIP member keyed by owner/name. ZIP compression/timestamps,
manifest formatting, and filesystem location do not affect identity. Stored
artifact hashes describe these exact logical bytes, not ZIP container bytes.
HTML/debug files are not analytical inputs and are not inventoried. This is
registration only, not publication or file copying.

Parsing, ownership checks, source clocks, counts and checksums happen before the
database write transaction. `BEGIN IMMEDIATE` serializes writers; replay and
participation conflicts never delete or recreate identities. All new runs,
observations, domain entries, coverage, data and artifact registration roll back
together if validation or the final current-pointer write fails. The validator
reconstructs every economy sample and composition snapshot and compares every
build/death occurrence and supply change. Foreign keys and integrity are checked
before indexing. Reimporting any indexed analysis is a true no-op, even if a newer
analysis is current. Historic runs and participation IDs are retained.

Run tests with `bun test packages/corpus-store/src` or
`$BW_FORGE_PYTHON -m unittest discover -s packages/corpus-store/tests -v`.

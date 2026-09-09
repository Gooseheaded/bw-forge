# Corpus store (Milestones 2A–2B)

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
the v1 ingest command nor analyzer output paths change. No daemon, watcher, MCP,
alias resolution, or production cutover is included.

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
HTML/debug files are not analytical inputs and are excluded from the analysis
key. Publication separately checks all published file bytes, including HTML.

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

## Immutable publication

```ts
import { analyzeAndPublishReplay } from "@bw-forge/corpus-store/publication";
const result = await analyzeAndPublishReplay({ replayPath, corpusRoot, dbPath });
```

```text
bw-forge analyze-v2 replay.rep --corpus-root corpus [--db corpus/db/corpus.sqlite]

corpus/
  replays/<first-two-sha-characters>/<replay-sha>.rep
  analyses/<replay-sha>/<analysis-key>/
    replay-manifest.json
    publication.json
    legacy/manifest.json
    legacy/player_*.zip
    legacy/*.html
  work/analysis-<unique-id>/             # disposable; empty after success
  db/corpus.sqlite
```

The default adapter invokes the existing `analyze` CLI under Bun. Node callers
also need Bun on PATH. The bwsim/reducer pipeline and old commands are unchanged.
Snapshots and the old analyzer output tree remain inside each unique work
directory. After validation, only that replay's artifact directory is published.
The transient raw copy is removed and the published manifest points to the
canonical raw replay. The importer accepts this external raw reference only for
the exact managed `analyses/<sha>/<key>` and `replays/<prefix>/<sha>.rep` layout;
ordinary legacy manifests retain their original path confinement rules.

The adapter records the actual producer files, WASM and asset checksums, bwsim
provenance version, reducer identity, and settings in `analysis_spec`, checking
they did not change during analysis. `prepareReplayAnalysis(manifestPath)` calls
the same Python preparation code as ingestion and never opens SQLite.

Canonical replay creation uses an exclusive same-filesystem hard link from a
verified temporary copy, then removes that temporary link. An existing replay
must have matching bytes. Analysis publication uses a same-filesystem directory
rename after validation, with an explicit refusal to replace existing directories
(including empty directories or symlinks). Keep `work`, `replays`, and `analyses`
on one filesystem; there is no non-atomic cross-device copy fallback.

`publication.json` records the byte sizes and SHA-256 checksums of every published
file except itself. Reuse verifies this entire inventory and recomputes the same
corpus-store analysis key. ZIP container timestamps/compression can differ on a
rerun while the logical analysis is identical; existing verified container and
report bytes are retained. No published file is rewritten or repaired in place.
Immutability is enforced by this API, not by filesystem ACLs.

Only after publication and verification does ingestion begin. The additive
`python/publication.sql` tables store final manifest/raw paths and physical
artifact paths with ZIP-member names. They are created inside the v2 ingestion
transaction, with foreign keys to existing analysis/artifact IDs. Existing
unpublished analyses can acquire publication locations without changing their
current pointers. Ordinary `ingest-v2` imports remain unchanged; v1 is never
migrated. Locations are absolute paths and relocating a corpus is outside this
milestone.

An analyzer or validation failure leaves the database untouched. If publication
succeeds and ingestion fails, artifacts remain immutable and available. Rerun
the same command: it analyzes in new staging, verifies/reuses the existing
analysis directory, and retries ingestion. An already indexed analysis remains
a no-op under the existing current-analysis rules. Successful staging is always
removed; failed staging is removed unless `keepFailedWork: true` or CLI
`--keep-failed-work` is set. Cleanup is confined to this invocation's resolved
work directory. Canonical raw replays may remain after failure for reuse.

Publication remains local to one host. The analysis-job queue below prevents two
active jobs for one replay, while independent replay jobs may run in separate
worker processes. Tests use `createReplayPublisher` to inject an analyzer or
failure while exercising real filesystem publication and the real v2 importer.

## Identity catalog administration

The additive identity schema is managed by `python/migrations.py` and
`python/identities.sql`, with transactional revisions in `corpus_migrations`.
Both Corpus major-version markers remain 2; v1 is never migrated. Fresh databases
receive all current revisions. Existing v2 databases migrate on an administrative
write such as `identities apply`, queue use, or ingest.

`applyIdentities(dbPath, configPath)` and `exportIdentities(dbPath)` expose the
same administration API as `bw-forge identities apply <config.json> --db <path>`
and `bw-forge identities export --db <path>`. The versioned JSON catalog is
validated in full and replaced atomically; raw evidence and telemetry are untouched.
See [the query identity documentation](../corpus-query/README.md#curated-corpus-v2-identities-and-scopes)
for the full format, precedence, namespace normalization and appliance examples.

## Persistent analysis jobs

Additive migration revision 2 adds `replay_sources`, `analysis_jobs`, and
`analysis_job_attempts`. The major markers remain `PRAGMA user_version=2` and
`corpus_metadata.schema_version=2`. Migration is transactional and idempotent;
ordinary read-only Corpus v2 queries do not run it. A pre-revision-2 database
therefore remains queryable until a job command or another Corpus write installs
the queue tables.

Enqueue first hashes the source replay, copies it to a verified temporary file
beside its canonical destination, and atomically links that file into
`replays/<sha-prefix>/<sha>.rep` with no replacement. This is the portable
same-filesystem no-replace operation used instead of `rename`, which may overwrite
an existing destination. Existing managed bytes are hashed and reused; different
content is never overwritten. Only after registration does a short SQLite
transaction record the replay, its `manual` source reference, and queued work.
The source filename never controls a managed path, and the original source may be
deleted as soon as enqueue returns.

```sh
bw-forge jobs enqueue game.rep \
  --corpus-root /srv/bw-forge/corpus \
  --db /srv/bw-forge/corpus/db/corpus.sqlite

bw-forge worker run \
  --corpus-root /srv/bw-forge/corpus \
  --db /srv/bw-forge/corpus/db/corpus.sqlite

bw-forge jobs list \
  --db /srv/bw-forge/corpus/db/corpus.sqlite \
  --status failed
```

`jobs enqueue` returns the existing queued/running job for duplicate active work.
An already indexed replay returns `already-indexed`; `--force` creates later
re-analysis work while the partial unique index still permits only one active job
per replay. Different source paths for identical bytes add provenance rows without
another replay or managed copy. `--priority` is an integer; higher values claim
first, followed by the oldest available job.

`worker once` claims at most one job and exits successfully with `idle`,
`succeeded`, or `failed`. `worker run` polls about once per second. It creates one
process-lifetime worker ID (`hostname:pid:random`) unless `--worker-id` is supplied.
SIGINT/SIGTERM stops future claims and polling; an active analysis is allowed to
finish with heartbeats continuing, then the process exits. Default concurrency is
one execution slot per process; run independent processes for more slots.

Claims use a short `BEGIN IMMEDIATE` transaction, increment the attempt count,
assign the worker, and commit a lease before analysis starts. Heartbeats renew the
lease in separate short transactions. Heavy bwsim/reducer work never holds a queue
transaction. A current lease cannot be stolen. An expired lease is reclaimable
until the finite attempt limit; exhausted jobs become `failed`. Each claim is kept
in `analysis_job_attempts`, including abandoned expired leases and structured
errors. Explicit analyzer failures fail immediately rather than spinning.

The worker calls `analyzeAndPublishReplay()` directly against the canonical replay.
It never shells out to `analyze-v2` or implements another artifact path. Execution
is at least once: if publication commits and the worker disappears before success
bookkeeping, the lease expires, another worker reruns, immutable publication is
verified/reused, and the same job is marked succeeded. A heartbeat/bookkeeping
loss deliberately leaves the job running for this recovery path.

```sh
bw-forge jobs show <job-key> --db /srv/bw-forge/corpus/db/corpus.sqlite
bw-forge jobs retry <job-key> --db /srv/bw-forge/corpus/db/corpus.sqlite
bw-forge worker once --corpus-root /srv/bw-forge/corpus \
  --db /srv/bw-forge/corpus/db/corpus.sqlite
```

Retry moves an explicit failed job back to queued while preserving attempts and
extending its attempt allowance when needed. Succeeded and failed jobs remain for
inspection. `result_analysis_id` links success to the indexed analysis, but
`current_analyses` remains the sole accepted-analysis pointer; queue status is only
operational history.

The database may be outside the corpus root, matching existing publication API
behavior, but it cannot overlap `replays`, `analyses`, or `work`. At execution the
worker requires the SHA-derived canonical replay path under the supplied root;
this is the reliable root/DB consistency check available today. There is no remote
submission, cancellation, watcher, downloader, scheduler, systemd unit, or web UI.

Future input integrations must use the same boundary:

```text
watcher / downloader
        -> canonical replay registration + jobs enqueue
        -> persistent analysis_jobs
        -> leased worker
        -> analyzeAndPublishReplay
```

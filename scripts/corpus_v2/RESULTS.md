# Milestone 1 measured result — 2026-09-08

Source: the audited 56-replay / 112-participation corpus. Isolated candidate:
`tmp/corpus-v2/run-3.candidate.sqlite`. Its sibling JSON report contains every
object's bytes/MiB/percentage/row count, source SHA-256 fingerprints, lookup results,
and EXPLAIN QUERY PLAN output. Candidate and full local report are not committed.

| Measurement | Result |
|---|---:|
| v1 whole database | 754,204,672 bytes (719.265625 MiB) |
| Candidate | 12,275,712 bytes (11.70703125 MiB) |
| Whole-file reduction | 98.3724% |
| Candidate decimal MB/replay | 0.219209 |
| Page size / pages / freelist pages | 4,096 / 2,997 / 0 |
| Economy rows, v1 → candidate | 2,653,505 → 417,446 |
| Unit rows, v1 → candidate | 1,076,629 → 80,568 |
| Economy samples validated exactly | 2,653,505 |
| Complete composition snapshots validated exactly | 63,709 |
| Explicit disappearance-to-zero transitions verified | 3,710 |
| Source files fingerprinted unchanged | 506 |

This is the requested **12-table prototype**, not a full replacement corpus.
It excludes build, supply, and death tables, other future entities, and artifacts.
Its compact WITHOUT ROWID primary-key tables also avoid the separate telemetry
lookup-index trees used in v1. Do not interpret the result as a guaranteed complete
Corpus v2 capacity estimate or a fixed bytes/replay expectation for longer games.

## Tables (primary-key storage included for WITHOUT ROWID tables)

| Table | Rows | Bytes |
|---|---:|---:|
| corpus_metadata | 1 | 4,096 |
| replays | 56 | 12,288 |
| participations | 112 | 12,288 |
| analysis_specs | 56 | 73,728 |
| analysis_runs | 56 | 20,480 |
| current_analyses | 56 | 4,096 |
| analysis_participations | 112 | 4,096 |
| stream_coverage | 224 | 12,288 |
| economy_changes | 417,446 | 10,850,304 |
| unit_types | 84 | 4,096 |
| analysis_unit_domain | 2,257 | 24,576 |
| unit_count_changes | 80,568 | 1,187,840 |

## Indexes

| Index | Bytes |
|---|---:|
| observations_by_participation | 4,096 |
| sqlite_autoindex_analysis_participations_1 | 4,096 |
| sqlite_autoindex_analysis_runs_1 | 12,288 |
| sqlite_autoindex_analysis_runs_2 | 4,096 |
| sqlite_autoindex_analysis_specs_1 | 4,096 |
| sqlite_autoindex_corpus_metadata_1 | 4,096 |
| sqlite_autoindex_current_analyses_1 | 4,096 |
| sqlite_autoindex_participations_1 | 4,096 |
| sqlite_autoindex_participations_2 | 4,096 |
| sqlite_autoindex_replays_1 | 4,096 |
| sqlite_autoindex_unit_types_1 | 4,096 |

Indexes total 53,248 bytes. SQLite schema storage is another 12,288 bytes.
Tables + indexes + schema account for the entire file; freelist is empty.

## Validation and isolation

- 13 automated tests pass, including repeatable fixture imports, gaps, all temporal
  boundaries, nullable counters, strict/FK constraints, and deliberate corruption.
- Existing corpus-query suite: 49 tests pass; TypeScript check passes.
- Every source sample/snapshot was reconstructed using SQL point lookups.
- Regression replay `02c781f766e9cdd345bcfd1fbd3ee88cc00a885b1f51e069818c141ffa26957a`,
  owner 1: zergling is known zero at frame 7275 (305.55 seconds), backed by an
  explicit change at that frame.
- Economy/worker lookups use `(observation_id, frame)` PRIMARY KEY searches.
- Unit lookup and composition correlated lookups use
  `(observation_id, unit_type_id, frame)` PRIMARY KEY searches; no telemetry scan.
- Source v1 and artifact fingerprints match before/after; production source code
  is untouched and both inspected desktop database paths still report schema 1.
- No architectural blocker or schema correction. Bundled Python lacks `dbstat`;
  a read-only Node SQLite helper supplies native measurements.
- Legacy composition coverage ends at the last snapshot. Unknown producer unit
  exclusions remain unknown; the imported domain is conservatively limited to
  labels demonstrated by each replay's bundles.

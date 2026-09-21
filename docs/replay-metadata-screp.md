# Static replay metadata: screp v1.13.4

BW Forge uses pinned screp v1.13.4 as its static replay-file parser and retains
headless-bwsim as its simulation/frame-telemetry engine. Static chronology and
map lookups do not initialize bwsim or its WASM module.

## Map-name selection

The screp JSON interface exposes both `Header.Map` and `MapData.Name`. A local
comparison over 100 representative replay files succeeded for all 100 and found:

- 96 equal selections;
- 4 differences;
- 0 unknown selected names.

All four differences were meaningful fixed-width header truncations. Examples:

| Header.Map | MapData.Name |
| --- | --- |
| `MatchPoint Remastered ` | `MatchPoint Remastered 1.4` |
| `VGT30 Fastest Space Perfec` | `VGT30 Fastest Space Perfect` |
| `Dominator SE 2.` | `Dominator SE 2.0` |
| `(4)Paranoid Android XXL 3.` | `(4)Paranoid Android XXL 3.8` |

BW Forge therefore follows screp overview precedence: use nonblank
`MapData.Name`, otherwise fall back to `Header.Map`. screp's decoded strings may
contain in-band StarCraft color/control bytes; BW Forge removes those
nonprinting controls to preserve its established visible-name result (including
`KnockOut 1.4`) and otherwise preserves the decoded string without trimming,
normalization, case-folding, version stripping, or canonicalization.

## Timestamp equivalence

The pinned screp timestamp and the former bwsim decoder were compared on 20
representative replays. All 19 replays successfully decoded by both implementations
agreed exactly in Unix seconds. screp also decoded one replay for which bwsim
returned an `unreachable` parse failure. The tracked fixture remains exactly
`1775408548` (`2026-04-05T17:02:28Z`). Filesystem and filename timestamps are
never consulted.

## Reproducible benchmark

Run against canonical appliance replay paths:

```sh
/usr/bin/time -v bun scripts/benchmark-replay-metadata.ts \
  --corpus-root /srv/bw-forge/corpus \
  --limit 100
```

The script reports attempts, successes, failures, unknown maps, wall time,
replays/second, maps/minute, and per-replay errors. GNU `time -v` supplies peak
resident memory for the benchmark command. The architecture invokes at most one
short-lived screp process at a time, preserves path order, and never invokes
bwsim/WASM.

The initial stock screp appliance benchmark was 100/100 successful with zero
unknown maps in 1.118957 seconds (89.37 replays/second, 5362.1 maps/minute) and
about 9 MiB observed peak screp RSS. The integrated Windows development path,
including TypeScript orchestration, integrity verification, JSON validation, and
100 sequential subprocesses, completed the same-size representative sample with
100/100 successes and zero unknown maps in 5.569729 seconds (17.95
replays/second, 1077.25 maps/minute). This is still seconds rather than minutes
and roughly 38 times the former 28-maps/minute bwsim rate. Windows did not expose
a reliable child-process peak RSS measurement; use the documented GNU `time`
command for the deployed Linux measurement.

## Fidelity boundary

screp performs legacy replay decoding and its CLI emits decoded JSON strings.
BW Forge does not store raw map-name bytes or add CP949/EUC-KR heuristics, so
universal byte-for-byte legacy-encoding fidelity is not claimed.

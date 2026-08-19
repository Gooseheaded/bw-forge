# Parallel headless-bwsim backend milestone

## Architecture

The `analyze` command now accepts `--backend shieldbattery|bwsim` and continues
to default to `shieldbattery`. The bwsim path is:

```text
.rep -> Node 24 worker -> vendored headless-bwsim -> compatible JSONL
     -> unchanged replay_analysis.py -> unchanged ZIP/HTML/manifest pipeline
```

The Node worker isolates the Memory64 Wasm runtime from the Bun orchestration
process. A non-retained JSONL is created in a temporary directory and removed
after reduction. `--keep-snapshots` instead retains `<replay-id>.jsonl` in the
normal debug directory. The desktop runtime builder bundles the worker and
copies the vendored runtime so packaged use does not require StarCraft,
ShieldBattery, or a separate upstream checkout.

## Vendored provenance

- Repository: `https://github.com/Gooseheaded/headless-bwsim`
- Release/tag: `v0.1.1`
- Commit: `0ba6042053bfacb06d3252fac1e5435876336902`
- Original Wasm SHA-256: `b321eb4f274d2602be1ccdf3cefa72b0ba934e2025d76d7c25379a18af4d1226`
- Patched Wasm SHA-256: `aec4109937e4d1efefa921cf4fef8bfd2febc772809a026510ff1a6e88ca9a7d`
- `sim.pack.gz` SHA-256: `32f8cc3561e11d2756a579dc54675e0758e94c15b9f767a66a1ba533a9856a44`

The v0.1.1 release adds only the public JavaScript wrapper for the engine's
existing production-queue export. The Wasm and asset-pack hashes are unchanged
from v0.1.0. The patched Wasm supplies generation-bearing
`bw_unit_instance_id(index) -> i32`. Changes required by BW Forge must be made,
tested, and released upstream before this directory is refreshed.

## Emitted JSONL contract

Every line has these fields:

```text
schema_version, frame, owners, deaths
```

Every owner value has:

```text
name, minerals, gas, supply_current, supply_max, workers_alive,
unit_counts, units
```

Every live unit has:

```text
id, owner, unit_type, unit_type_id, category, completed, pos_x, pos_y,
build_queue_unit_ids, morphing_building
```

The following unit fields are emitted only when applicable:

```text
morph_target_unit_type_id, morph_target_unit_type,
build_time, remaining_build_time,
tech_in_progress, upgrade_in_progress
```

Death entries are the previous emitted live records for generation-safe IDs
that disappeared at the current frame. `gathered_minerals` and `gathered_gas`
are omitted, not null or zero. Scanner Sweep is excluded before owner counts
and death reconstruction. Frames begin at 1, are monotonic at stride 1, and
include the terminal frame.

Termination is the earliest of replay-header end, frame 43,200, or the accepted
standalone PlayerLeave command frame plus one. This is deliberately a host
heuristic, not a reconstruction of Storm connection state.

## LastReplay golden comparison

Replay SHA-256:
`44b77091c689e59a4657215aff6bd281d6329dca73e4b6e1c7e9670117461ec6`.
Both fresh runs used frames 1 through 32,937 inclusive and the same replay path.

| Artifact | Result | Classification |
|---|---|---|
| `build_order.txt`, both owners | Byte-identical after target-progress normalization for explicit building morphs | EXACT MATCH |
| `supply.json`, both owners | Byte-identical | EXACT MATCH |
| `unit_counts.json`, Zerg | Same semantic samples; object-key insertion order can differ | EXACT MATCH |
| `unit_counts.json`, Terran | Exact after removing Scanner Sweep and collapsing the now-redundant samples | EXPECTED INTENTIONAL DIFFERENCE |
| `deaths.json`, Zerg | Byte-identical | EXACT MATCH |
| `deaths.json`, Terran | Exact after removing 17 Scanner Sweep disappearance records | EXPECTED INTENTIONAL DIFFERENCE |
| `economy.json`, both owners | All 32,937 bank/worker samples exact after removing gathered counters | EXPECTED INTENTIONAL DIFFERENCE |
| legacy manifest metadata | Byte-identical | EXACT MATCH |
| standalone HTML | Same template and exact/normalized datasets above; embedded gathered fields and Scanner data differ | EXPECTED INTENTIONAL DIFFERENCE |

No unexplained output difference remains. Seven known construction-progress
estimates still differ by one raw frame before whole-second rendering, but none
changes this replay's rendered `build_order.txt`. This remains a documented
comparison target rather than a speculative simulator patch.

## Performance

Measured on the same workstation and replay using the developer CLI with
`--keep-snapshots`:

| Backend | Extraction/orchestration | Reduction | Total command wall time |
|---|---:|---:|---:|
| ShieldBattery | approximately 207.1 s | 181.1 s | 388.2 s |
| bwsim | 349.1 s | 45.8 s | 397.7 s |

The bwsim JSONL was 918,251,531 bytes versus 5,817,518,215 bytes for the retained
full Shield JSONL reference. The first implementation samples all live queues
for correctness and has not been optimized. A final corrected production run
without `--keep-snapshots` measured 333.8 s extraction, 46.0 s reduction, and
382.7 s total; the difference is normal run-to-run variation plus debug-file
retention, not an optimization claim.

## Known gaps and next step

The accepted first-milestone gaps are cumulative gathered-resource counters and
intentional Scanner Sweep omission. The recommended next step is to exercise
the bwsim backend on a broader replay corpus, including the three early-leave
fixtures, before considering a default-backend change. Performance work should
follow corpus correctness, not precede it.

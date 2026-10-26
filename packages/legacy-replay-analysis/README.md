# replay-analysis

This package is BW Forge's Python telemetry reducer. Normal users should invoke
it through `bw-forge analyze`; the root CLI runs the bundled bwsim engine,
creates JSONL telemetry, and passes that telemetry here.

The reducer does not execute `.rep` files and has no simulator, StarCraft, or
injection-runtime dependency.

## Inputs and outputs

The primary input is `sb-unit-timeline-v2` JSONL with frame, owner state, live
units, and deaths. Legacy SBTL parsing remains available for historical data.

For each player the reducer writes:

- `player.json`
- `build_order.txt`
- `economy.json`
- `supply.json`
- `unit_counts.json`
- `deaths.json`

It also creates player ZIP bundles, `manifest.json`, and a standalone HTML
report. The artifact contract is retained for SQLite ingestion, desktop views,
corpus queries, and MCP tools.

## Direct development usage

```powershell
python .\replay_analysis.py timeline.jsonl .\out `
  --embedded-replay-input .\game.rep `
  --build-order-template .\build-order.html
```

Useful options include `--owner`, `--include-initial`, `--include-tech`,
`--include-unit-appearances`, `--embedded-html-output`, and `--page-title`.
The top-level `bw-forge analyze` production path always passes `--include-tech`;
direct reducer invocations must still opt in explicitly for compatibility.

Upgrade and tech names come from the shared canonical event catalog at
`../corpus-query/src/domain/event-catalog.json`. Both are emitted when first
observed in progress, never at completion. Existing artifacts and Corpus v2 rows
are not rewritten, so historical analyses may lack tech events.

Existing standalone reports and manifests can be refreshed without replay
simulation:

```powershell
python .\replay_analysis.py report.html --refresh-embedded-html
python .\replay_analysis.py output-directory --refresh-manifests
```

Run tests from this directory:

```powershell
python -m unittest discover -s tests -p "test_*.py"
```

## Mineral saturation model

`mineral_saturation.py` is a pure economic primitive for later opportunity-cost
calculation. `MineralSaturationModel.rate(worker_count, patch_count)` returns an
estimated total mineral income rate in minerals per `fastest-replay-second`,
using the repository's 42 ms/frame fastest-game clock. It consumes no replay
telemetry. `mineral_income_rate(n, p)` is the versioned default wrapper.

The published calibration data in `mineral_saturation_calibration.py` comes
from [Liquipedia's StarCraft mining saturation table](https://liquipedia.net/starcraft/Mining#Saturation),
an approximate nine-patch SCV example in minerals per minute at fastest speed.
The raw worker/total table is retained for provenance. The evaluator fits the
mathematical zero plus the measured 9- and 27-worker anchors `(0, 0)`,
`(9, 585/60)`, `(27, 1285/60)`, then caps at 27 workers. It agrees with every
published row within 0.5 minerals per minute; rounded intermediate rows are
not treated as additional curve knots.

For a different patch count, workers are normalized to the nine-patch reference
and the resulting total is scaled by `patch_count / 9`. This is a transparent
capacity approximation; it does not model mineral-field geometry, patch
distance, worker pathing, queueing, depletion, or player behavior. Worker and
patch counts above `10**12` are rejected, and calibration rates are bounded so
finite output is guaranteed.

Use `MineralSaturationModel` with documented `CalibrationPoint` values when a
future calibration is substituted. Opportunity cost and telemetry attribution
belong to later milestones.

Example:

```python
from mineral_saturation import DEFAULT_MODEL, mineral_income_rate

rate = mineral_income_rate(worker_count=18, patch_count=9)
assert DEFAULT_MODEL.version == "liquipedia-scv-nine-patch-v1"
```

The indexed-source notes and clock caveats are recorded in
[`docs/mineral-saturation-calibration.md`](../../docs/mineral-saturation-calibration.md).

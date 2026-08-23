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

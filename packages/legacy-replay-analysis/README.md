# replay-analysis

Small tools for turning ShieldBattery unit timeline exports into concise,
human-readable replay summaries.

## Replay Summary Export

The script can either consume an existing ShieldBattery timeline file (`.sbtl` MessagePack or
`.jsonl`) or invoke the local ShieldBattery replay exporter for you when you pass a replay `.rep`
file.

Replay-first usage:

```powershell
python .\replay_analysis.py "C:\Users\gctri\Documents\StarCraft\Maps\Replays\aether\2026-04-08@072115_Aether-X(t)_vs_BSL-Strudel(t).rep" .\out
```

Replay-directory batch usage:

```powershell
python .\replay_analysis.py "C:\Users\gctri\Documents\StarCraft\Maps\Replays\aether" .\out
```

When the input is a directory, the script recursively finds `.rep` files and writes one output
subdirectory per replay under the requested output directory.

If you only want to process replays that do not already have their output subdirectory, add:

```powershell
python .\replay_analysis.py "C:\Users\gctri\Documents\StarCraft\Maps\Replays\aether" .\out --skip-existing
```

## Refresh Existing Embedded Reports

If you update `build-order.html` and want to rebuild previously generated standalone reports without
re-exporting or re-analyzing the replay data, use refresh mode against an existing embedded HTML file:

```powershell
python .\replay_analysis.py .\out\some-report.html --refresh-embedded-html
```

This reads the old report, preserves its embedded dataset/replay/page-meta blocks, and rewrites the
file in place using the current template. You can also point it at a directory, and it will recurse
through the tree refreshing every embedded report it finds:

```powershell
python .\replay_analysis.py .\out --refresh-embedded-html
```

Override the template or write a single refreshed file somewhere else if needed:

```powershell
python .\replay_analysis.py .\out\some-report.html --refresh-embedded-html --build-order-template .\build-order.html --embedded-html-output .\out\some-report.refreshed.html
```

If you only need to backfill `manifest.json` for existing replay output folders without rewriting ZIPs
or HTML, use:

```powershell
python .\replay_analysis.py .\out --refresh-manifests
```

This recurses existing embedded report folders, inspects the already-written player ZIPs, and writes
only `manifest.json`. When deterministic `player_<owner>.zip` files are present, the manifest points
to them; otherwise it points to the older name-based ZIP filenames already on disk.

When the input is a replay file, `replay_analysis.py` runs replay export in binary mode by default:

```powershell
pnpm run replay-export -- "<replay.rep>" --replay-export-speed 128
```

from the ShieldBattery repo and forces frame-precision timeline export with these settings:

```text
SB_UNIT_TIMELINE=1
SB_UNIT_TIMELINE_FORMAT=msgpack
SB_UNIT_TIMELINE_TIME_UNIT=frames
SB_UNIT_TIMELINE_STRIDE=1
```

The ShieldBattery repo path defaults to:

```text
C:\Users\gctri\Documents\_\ShieldBattery
```

Override it if needed:

```powershell
python .\replay_analysis.py game.rep .\out --shieldbattery-dir D:\src\ShieldBattery
```

Adjust replay export speed if needed:

```powershell
python .\replay_analysis.py game.rep .\out --replay-export-speed 256
```

Existing-JSONL usage is still supported:

```powershell
python .\replay_analysis.py C:\Windows\Temp\sb-unit-timeline.jsonl .\out
```

Existing-binary usage is also supported:

```powershell
python .\replay_analysis.py C:\Windows\Temp\sb-unit-timeline.sbtl .\out
```

If you need replay export to emit JSONL instead of the default binary format:

```powershell
python .\replay_analysis.py game.rep .\out --timeline-format jsonl
```

The output directory receives one deterministic zip bundle per owner plus a replay manifest:

```text
manifest.json
player_3.zip
player_5.zip
build-order.embedded.html
```

In batch mode, each replay gets its own subdirectory containing that replay’s owner ZIP bundles and
standalone HTML report.

For backward compatibility, the script also writes the previous name-based ZIP filenames when they
do not already match the deterministic `player_<owner>.zip` names.

Each zip is self-contained and uses stable internal filenames:

```text
player.json
build_order.txt
economy.json
supply.json
```

Each replay output directory also contains a `manifest.json` with replay-level metadata:

```json
{
  "schema_version": "replay-analysis-manifest-v1",
  "replay_id": "...",
  "source": {
    "filename": "game.rep",
    "path": "C:\\path\\to\\game.rep"
  },
  "matchup": "ZvT",
  "map": null,
  "duration_seconds": 123.4,
  "players": [
    { "owner": 3, "name": "MysteriousZerg", "race": "zerg", "zip_filename": "player_3.zip" }
  ]
}
```

The script also writes a standalone HTML file that starts from `build-order.html` and embeds every
exported player dataset directly into the page as sibling `<script>` tags with class
`embedded-build-order-dataset`. Each embedded script contains a base64-encoded ZIP payload with:

```text
player.json
build_order.txt
economy.json
supply.json
unit_counts.json   (when available)
deaths.json        (when available)
```

When a replay file is available, the standalone HTML can also embed it as a separate
`embedded-build-order-replay` script tag containing a base64-encoded ZIP with the replay file.
This happens automatically when the main input is a `.rep` file, or you can provide one explicitly:

```powershell
python .\replay_analysis.py timeline.jsonl .\out --embedded-replay-input .\game.rep
```

The standalone HTML also embeds page metadata for the browser tab title and visible report title.
Override it if needed:

```powershell
python .\replay_analysis.py game.rep .\out --page-title "Replay Title Here"
```

By default this file is written to:

```text
<output_dir>\build-order.embedded.html
```

Override the template or output filename if needed:

```powershell
python .\replay_analysis.py game.rep .\out --build-order-template .\build-order.html --embedded-html-output .\out\custom-build-order.html
```

`player.json` maps the ShieldBattery owner id to replay display context:

```json
{
  "schema_version": "replay-analysis-player-bundle-v1",
  "owner": 3,
  "name": "MysteriousZerg",
  "race": "zerg",
  "files": {
    "build_order": "build_order.txt",
    "economy": "economy.json",
    "supply": "supply.json"
  }
}
```

Build-order file format:

```text
00:02 Drone
00:25 Spawning Pool
01:40 Metabolic Boost
```

By default the first snapshot is treated as the baseline and is not emitted. This avoids listing
starting workers, starting buildings, minerals, and other map fixtures. Use `--include-initial` if
you want first-snapshot units included.

Timestamps use ShieldBattery's fastest-game replay clock of 42 ms per frame. This avoids accumulating
drift from treating replay frames as exactly 24 frames per second.

The event detector currently emits:

- Building starts, preferring explicit morph/construction starts and backdating partially observed
  buildings using ShieldBattery build-progress fields.
- Unit production starts inferred from `build_queue_unit_ids`, including Zerg eggs resolving to
  their target unit.
- Upgrade and tech starts inferred from `upgrade_in_progress` and `tech_in_progress`.

If the input JSONL skips frames, `replay_analysis.py` prints a warning because build-order
timestamps may be approximate.

For cleaner output, pass `--owner <id>` for the player you care about. Without it, one zip bundle is
written for every owner present in the JSONL data.

## Useful Options

```powershell
python .\replay_analysis.py input.jsonl out --owner 3 --include-tech
python .\replay_analysis.py input.jsonl out --owner 3 --include-unit-appearances
python .\replay_analysis.py input.jsonl out --owner 3 --include-initial
```

`--include-tech` includes tech research such as `Lurker Aspect` and `Psionic Storm`. Upgrades are
included by default because they are part of the requested output shape.

`--include-unit-appearances` also emits non-building unit first appearances. This is noisier and can
duplicate production-queue events, so it is off by default.

Economy data is stored as `economy.json` inside each player bundle. It contains real resource
time-series data from ShieldBattery and uses this shape:

```json
{
  "schema_version": "replay-analysis-economy-v1",
  "owner": 3,
  "race": "zerg",
  "samples": [
    { "frame": 0, "time_seconds": 0.0, "minerals": 50, "gas": 0, "gathered_minerals": 0, "gathered_gas": 0 }
  ]
}
```

When available, economy samples also include `gathered_minerals` and `gathered_gas`, which are
cumulative worker-harvest income totals returned to the player’s base. They are monotonic running
totals and are not reduced by spending.

Supply data is stored as `supply.json` inside each player bundle. It contains real displayed
current/max supply values from ShieldBattery and uses this shape:

```json
{
  "schema_version": "replay-analysis-supply-v1",
  "owner": 3,
  "race": "zerg",
  "samples": [
    { "frame": 0, "time_seconds": 0.0, "current": 4, "max": 9 }
  ]
}
```

# bwsim-only shipping validation

Measured on Windows on 2026-08-23 after removing ShieldBattery from the
production dependency graph.

## Production architecture

Replay analysis now has one execution path:

```text
.rep -> bundled headless-bwsim -> compatible JSONL -> Python reducer -> artifacts
```

The CLI no longer exposes a replay-backend selector. `--bwsim-dir` remains as a
developer override. The desktop runtime does not stage or validate a second
Electron replay engine, and settings no longer contain a StarCraft path or
ShieldBattery execution options.

The previous `%LOCALAPPDATA%\BW Forge\runtime-cache\replay-engine` directory is
an exclusively BW Forge-generated cache. Desktop startup removes that exact
obsolete directory and leaves sibling files, StarCraft installations, and
unrelated ShieldBattery installations untouched. Cleanup failure is reported as
a warning and does not block startup.

## Packaged runtime

The simulator-specific payload contains:

| File | Bytes |
| --- | ---: |
| `bwsim_wasm.bwforge.wasm` | 1,330,285 |
| `sim.pack.gz` | 7,925,151 |
| bundled bwsim exporter | 37,247 |
| **Total** | **9,292,683 (8.862 MiB)** |

The package contains no ShieldBattery source, replay-engine Electron
distribution, injection DLL, or ShieldBattery runtime dependency. A StarCraft
installation is not required.

## Size result

| Metric | Before | bwsim-only | Measured change |
| --- | ---: | ---: | ---: |
| Unpacked app | ~720 MiB stale package | 367.906 MiB | -352.094 MiB |
| Unpacked app | ~730 MiB estimated both-backend package | 367.906 MiB | -362.094 MiB |
| Windows installer | 202.867 MiB stale package | 107.791 MiB | -95.076 MiB |
| Vendored replay engine checkout | 11.774 GiB ShieldBattery plus 10.167 MiB bwsim | 10.167 MiB bwsim | approximately -11.774 GiB |
| Local replay-engine cache | 2.840 GiB | absent | -2.840 GiB |

The installer comparison is against the previously measured stale installer,
not a controlled rebuild of the same commit with both payloads. It is therefore
an observed product-size change, not a direct compression-ratio measurement.

## Validation

- CLI tests: 17 passed.
- Desktop tests: 45 passed.
- Corpus-query/MCP tests: 49 passed.
- Python reducer tests: 32 passed.
- Repository and desktop typechecks passed.
- Production NSIS installer build passed.
- Unpacked production runtime analyzed a replay with its bundled Electron/Node,
  Python, and bwsim files and produced the normal manifest and player bundles.
- Focused competitive fixtures reached frames 6 (PlayerLeave), 11,819, 12,312,
  32,937, and 43,200 (safety cap). Every player ZIP contained `player.json`,
  `build_order.txt`, `economy.json`, `supply.json`, `unit_counts.json`, and
  `deaths.json`.

The supported release baseline is standard competitive Melee and Top-vs-Bottom
replays. UMS compatibility is not guaranteed. Previously accepted telemetry and
legacy-normalization differences remain documented separately and are not
changed by this migration.

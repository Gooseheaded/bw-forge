# Mineral saturation calibration (M1)

## Evidence

As of 2026-10-26, the requested Liquipedia Brood War mining page is HTTP 403 to both the browser and a direct request. Its indexed content is available in the [Liquipedia Mining](https://liquipedia.net/starcraft/Mining) search result, which reports this approximate SCV example for a nine-patch mineral line:

| SCVs | minerals/SCV/min | total minerals/min |
|---:|---:|---:|
| 5 | 65.0 | 325 |
| 7 | 65.0 | 455 |
| 9 | 65.0 | 585 |
| 11 | 60.3 | 663 |
| 13 | 57.0 | 741 |
| 15 | 54.6 | 818 |
| 17 | 52.7 | 896 |
| 19 | 51.3 | 974 |
| 21 | 50.1 | 1052 |
| 23 | 49.1 | 1129 |
| 25 | 48.3 | 1207 |
| 27 | 47.6 | 1285 |
| 29 | 44.3 | 1285 |

The page says saturation is approximately three workers per patch, growth is linear through one worker per patch and slower through three workers per patch, and returns vary because of worker wandering. It also reports a single SCV rate of 65 minerals per minute on fastest speed. Reference [2] is the historical Python SCV measurement post at `https://tl.net/forum/brood-war/92971-mining-rates-for-each-patch-python`; the indexed page does not expose a complete protocol for every table row.

Related Brood War experiments are described in [Worker Saturation](https://tl.net/forum/brood-war/83287-worker-saturation) and [Wandering and worker saturation](https://tl.net/forum/bw-strategy/111203-wandering-and-worker-saturation). The first used BW 1.15.3 on Python 1.3, two five-minute trials per worker count at two mains, and the Chaoslauncher timer. The second is explicitly a Protoss-probe study, not an SCV replication; it used Fastest-speed tests with APMLive's clock and demonstrates geometry and wandering effects. It reports nine-patch theoretical and observed maxima of about 1281.6 and 1270 minerals/minute, respectively. These observations support the qualitative geometry caveat, not the SCV table's numerical calibration.

The indexed Liquipedia page labels the rates “on fastest speed” and its frame-data section reports an SCV average of 176.7 frames per trip. The sources do not establish a StarCraft-II-style 1.4x game-clock conversion. The model therefore treats the published values as minerals per replay elapsed second at the repository's 42 ms/frame fastest-speed convention. This is an explicit model interpretation of “per minute,” not precision proof of the original timer; future calibration should reproduce the table with frame counters.

## Interpretation for M1

Use the mathematical zero anchor `(0, 0)` and two published anchors, `(9, 585)` and `(27, 1285)`, in minerals per fastest-speed minute. For normalized workers `x = 9 * workerCount / patchCount`, use `F(x) = 65x` through 9, `585 + (700 / 18) * (x - 9)` through 27, and 1285 thereafter. Total rate is `R = patchCount / (9 * 60) * F(x)`.

This stays within 0.5 minerals/minute of every published table row while avoiding artificial slope changes caused by rounded observations. Zero workers or patches return zero. Counts above the 27-worker reference saturation clamp at 1285 minerals/minute. Scaling by `patchCount / 9` preserves the reference curve while accepting that patch distance, town-hall geometry, pathing, and mineral depletion are not represented. These scaling and extrapolation rules are implementation assumptions, not additional measurements.

The exact table values are traceable to the indexed Liquipedia result and its listed references, but direct source access remains a provenance limitation. A future calibration should capture an accessible revision or reproduce the measurements on a pinned Brood War map and engine.

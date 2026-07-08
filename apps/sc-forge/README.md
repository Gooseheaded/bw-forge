# sc-forge

This repository is maintained as an offline-first StarCraft: Brood War replay-analysis tool centered on [`build-order.html`](/C:/Users/gctri/Documents/_/sc-forge/build-order.html).

## Maintained Surface

- `build-order.html`: primary source document for the replay-analysis UI
- `build-order.override.js`: replay-analysis behavior and centralized UI wiring
- `build_single_file.js`: builder for `dist/build-order.single-file.html`
- `dist/build-order.single-file.html`: generated standalone distribution artifact

## Repository Status

- The quiz and glossary pages were removed during cleanup because they are no longer maintained product surfaces.
- Inline data in `build-order.html` is currently the authoritative gameplay/build dataset.
- `starcraft-data.csv`, `raw-data/`, and `fetch_liquipedia.py` are legacy reference material only. They are not the runtime source of truth for replay analysis.

## Smoke Check

Run:

```powershell
node .\smoke-test.js
```

This verifies the standalone build path and checks a few cleanup invariants.

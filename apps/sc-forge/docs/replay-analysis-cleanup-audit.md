# Replay Analysis Cleanup Audit

## Runtime Contracts To Preserve

- `build-order.html` must remain usable as a standalone local HTML document.
- `build_single_file.js --input --output` must keep producing a self-contained replay-analysis artifact.
- `dist/build-order.single-file.html` must preserve bundle import, embedded replay payload loading, and text export behavior.
- Embedded replay and dataset payload parsing must keep working with the current ZIP structure and `deaths.json` expectations.
- Local-document behavior must remain stable: no server dependency, no new framework/runtime requirement, and no broken file:// usage.

## Architectural Fault Lines

- `build-order.html` still carries a very large inline runtime plus authoritative data, making ownership and review difficult.
- `build-order.override.js` remains too large and still acts as a second runtime layer, even after moving UI event wiring out of inline markup.
- Global mutable state spans rendering, import/export, and analysis concerns with weak boundaries.
- The repo previously mixed three product surfaces with duplicated data; quiz/glossary removal fixes the product-level ambiguity but not the replay-analysis internal coupling.
- Legacy reference datasets (`starcraft-data.csv`, `raw-data/`, `fetch_liquipedia.py`) were discoverable alongside runtime assets without a clear authority model.

## Ranked Cleanup Candidates

1. Low risk / high value: document the maintained surface and legacy data status.
2. Low risk / high value: remove deprecated pages and keep the repo aligned with the real product.
3. Low risk / medium value: centralize DOM event wiring and reduce inline behavior in `build-order.html`.
4. Medium risk / high value: split replay-analysis code into clear ownership areas inside the JS runtime.
5. Medium risk / medium value: extract authoritative replay-analysis data from the HTML body into a dedicated source file or generated artifact.
6. Higher risk / high value: replace the current base-plus-override runtime layering with a single owned application module structure.

## Recommended Order

1. Establish documentation and cleanup guardrails.
2. Remove deprecated product surfaces.
3. Centralize event binding and tighten builder/smoke coverage.
4. Split replay-analysis runtime by concern without changing user-facing behavior.
5. Revisit data extraction and deeper runtime ownership changes after the first structural pass is stable.

## Ticketized Backlog

### Structure

- `STRUCT-1`: Keep replay analysis as the only maintained surface in repo docs and file layout.
- `STRUCT-2`: Replace remaining base/runtime layering with a single owned application structure.
- `STRUCT-3`: Reduce `build-order.override.js` size by grouping code into concern-based files or generated sections.

### Data / State

- `STATE-1`: Preserve inline data as canonical for now, but isolate its ownership from layout markup.
- `STATE-2`: Document persistence behavior and add explicit regression checks around load/save state.
- `STATE-3`: Continue reducing cross-cutting globals where state transitions are hard to reason about.

### Rendering

- `RENDER-1`: Keep centralized event binding; remove any new inline action wiring from future changes.
- `RENDER-2`: Convert the riskiest `innerHTML` paths to DOM construction where clarity improves.
- `RENDER-3`: Separate timeline, build-order table, and combat rendering responsibilities more clearly.

### Import / Export

- `IO-1`: Preserve bundle ZIP loading and embedded payload parsing unchanged.
- `IO-2`: Keep analysis/build-order copy exports stable and covered by smoke assertions where practical.
- `IO-3`: Continue simplifying the single-file builder so it is driven by explicit external script contracts.

### Validation

- `VALIDATE-1`: Keep a zero-dependency smoke script for build and structural invariants.
- `VALIDATE-2`: Add focused regression assertions for important exported text formats as they evolve.
- `VALIDATE-3`: Add a browser-level local-file smoke pass if the project gains more complex client-side boot behavior.

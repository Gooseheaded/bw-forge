## Context

The current desktop analysis screen shows live logs and a queue-level completion bar based only on finished replay jobs. That works for short runs, but long replay playback feels stalled because the first stage can spend tens of seconds with no visible movement beyond new log lines.

The existing pipeline already emits enough signals to improve this without redesigning the analysis stack:

- ShieldBattery replay export emits progress lines when packaged replay export reports frame and total-frame data.
- The Python reducer emits `[analysis] <percent>` lines while reading timeline data.
- Corpus ingest emits processed/discovered replay counts per batch.

The desktop app currently forwards all of those lines as opaque logs. The change is cross-cutting because it touches shared contracts, main-process orchestration, renderer state, and tests.

## Goals / Non-Goals

**Goals:**
- Convert existing child-process output into structured progress state in the main process.
- Show users a primary per-replay progress bar that moves during long-running replay analysis.
- Show secondary queue progress across all selected replays.
- Preserve raw logs for troubleshooting while making them secondary in the UI.
- Prefer exact progress when available and fall back to a clearly labeled heuristic only when necessary.

**Non-Goals:**
- Rework the underlying analyze, ingest, or replay-export command surfaces.
- Add new runtime dependencies or a background telemetry channel.
- Guarantee mathematically exact end-to-end percentage during every replay-export environment.

## Decisions

### Decision: Parse progress in the main process and publish structured state

The renderer should consume typed progress data, not infer meaning from raw log text. This keeps parsing logic close to the child-process boundary, avoids duplicating regex logic in the UI, and lets tests validate state transitions directly.

Alternative considered:
- Parse logs in React. Rejected because it couples presentation to CLI log syntax and makes state transitions harder to test.

### Decision: Model progress at two levels

The analysis screen will show:

- primary progress for the active stage and current replay
- secondary queue progress for completed work across all selected replays

This matches the feedback: users mainly want reassurance that the active replay is still moving, but they also need context for the whole batch.

Alternative considered:
- One aggregated bar only. Rejected because it still stays visually flat during the first replay of a batch.

### Decision: Use stage-aware exact parsing with a bounded fallback heuristic

The progress model will parse three exact sources:

- replay export percent from ShieldBattery `[replay-export] progress ... 27.0%`
- timeline analysis percent from Python `[analysis] 37.5%`
- ingest percent from `X/Y replays processed`

When replay export only emits heartbeat output such as `running... elapsed 12.4s`, the app will show an estimated replay-export bar that climbs conservatively and never reaches completion before a stronger signal arrives.

Alternative considered:
- Leave replay export indeterminate. Rejected because the user feedback specifically asks for a bar that conveys movement.

### Decision: Keep the raw log but collapse it by default

Troubleshooting still benefits from the raw output, especially for power users and development. The default analysis view should prioritize plain progress language and only expose the detailed log when the user wants it.

Alternative considered:
- Remove the log completely. Rejected because it would weaken diagnosability.

## Risks / Trade-offs

- [Replay-export log formats differ between environments] → Use exact parsing when present and fall back to the elapsed-time heuristic otherwise.
- [Heuristic progress could over-promise] → Cap heuristic replay-export progress below completion and label it as estimated.
- [More frequent progress updates could create noisy UI churn] → Reuse existing process-line cadence and only update on parsed lines or stage transitions.
- [Contract growth increases test surface] → Add focused unit tests for parsing and state updates instead of broad integration-only coverage.

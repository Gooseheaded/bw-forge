## Why

The desktop app currently exposes analysis progress mainly as raw process logs plus a coarse job-count bar. Users cannot tell whether long replay playback is still making progress, which makes the first stage feel stalled even when it is healthy.

## What Changes

- Replace the current count-only analysis indicator with structured progress state produced by the main process.
- Show a primary progress bar for the active stage and replay, with friendly labels and status text.
- Show secondary queue progress across all selected replays.
- Parse existing replay-export, timeline-analysis, and ingest output into exact progress when available.
- Fall back to a clearly labeled heuristic during replay playback when only heartbeat output is available.
- Keep raw logs available for troubleshooting, but collapse them by default in the analysis screen.
- Add focused tests for progress parsing, state transitions, and renderer behavior.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `desktop-application`: analysis progress reporting now needs structured per-stage and per-replay progress, user-friendly progress presentation, and clearer long-running replay feedback.

## Impact

- Affects the desktop shared contracts, analysis manager, and analysis screen renderer.
- Adds parsing of existing CLI and replay-export output lines without changing their public command surface.
- Extends desktop tests around analysis state transitions and renderer output.

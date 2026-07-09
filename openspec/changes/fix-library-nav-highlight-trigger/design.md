## Context

The current highlight feature compares only the previous and next library entry counts. That is simple, but it is not the best proxy for “analysis finished and your library changed,” and the resulting visual treatment is subtle enough that a user can miss it entirely.

In practice, users may re-process the same replay ID and still expect a visible confirmation that the analysis run finished and the Library refreshed.

## Goals / Non-Goals

**Goals:**
- Trigger the highlight from successful analysis-driven library refreshes, not only count changes.
- Make the nav cue visually explicit enough to confirm that something changed.
- Preserve the existing dismiss-on-open behavior.

**Non-Goals:**
- Persist read/unread library state across app restarts.
- Add toast notifications or modal interruptions.

## Decisions

### Decision: Highlight on successful analysis-driven refresh

The renderer will treat a successful post-analysis library refresh as the signal to highlight the Library navigation item while the user is off the Library page. This aligns the cue with the user’s workflow rather than with replay identity semantics.

### Decision: Add an explicit nav dot/badge

The shimmer stays, but the nav button also gets a small visible “new” indicator so the user does not have to rely on noticing a subtle background change.

## Risks / Trade-offs

- [A repeated ingest of an existing replay ID still highlights] → Acceptable; the cue now means “the Library was refreshed by your completed analysis.”
- [A manual refresh without analysis does not highlight] → Acceptable; the feature is meant to confirm analysis outcomes.

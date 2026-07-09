## Context

The current highlight feature compares only the previous and next library entry counts. That is simple, but it is not the best proxy for “new items appeared,” and the resulting visual treatment is subtle enough that a user can miss it entirely.

The library model already exposes stable replay IDs, so the renderer can compare sets of replay IDs instead of raw counts.

## Goals / Non-Goals

**Goals:**
- Trigger the highlight from new replay IDs, not only count changes.
- Make the nav cue visually explicit enough to confirm that something changed.
- Preserve the existing dismiss-on-open behavior.

**Non-Goals:**
- Persist read/unread library state across app restarts.
- Add toast notifications or modal interruptions.

## Decisions

### Decision: Compare replay ID sets

The renderer will keep the previous replay ID set and highlight when the next library contains any replay ID that was not present before, while the user is off the Library page.

### Decision: Add an explicit nav dot/badge

The shimmer stays, but the nav button also gets a small visible “new” indicator so the user does not have to rely on noticing a subtle background change.

## Risks / Trade-offs

- [A manual refresh with genuinely new items also highlights] → Acceptable and consistent with the feature goal.
- [Reordered library entries cause no highlight] → Correct; ordering changes are not new items.

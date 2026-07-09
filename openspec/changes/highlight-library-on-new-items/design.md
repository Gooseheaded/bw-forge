## Context

The desktop app already refreshes the replay library after successful analysis and ingestion, but the sidebar does not distinguish between a stable library count and a newly increased one. Users who stay on Analyze after a run can miss that the library has changed unless they explicitly navigate there.

This is a renderer-only feature. The current library model already contains enough information: we can compare the previous and next library entry counts and trigger a local UI flag when the count grows.

## Goals / Non-Goals

**Goals:**
- Highlight the Library nav item when new entries appear.
- Avoid highlighting while the user is already on the Library page.
- Clear the highlight immediately when the Library page is opened.
- Keep the effect subtle and aligned with the existing sidebar style.

**Non-Goals:**
- Change the library data model or persistence.
- Add notifications, toasts, or badge counts beyond the existing nav metadata.
- Track per-entry read/unread status.

## Decisions

### Decision: Detect new items by entry-count growth in the renderer

The renderer will keep the previous library count in a ref and set a `libraryHasNewItems` flag when `library.entries.length` increases while the current view is not `library`.

Alternative considered:
- Track this from the analysis manager or shared state. Rejected because the effect is purely presentation logic.

### Decision: Dismiss on Library view activation

Opening the Library page clears the highlight immediately, regardless of whether the user got there through the sidebar or another action.

Alternative considered:
- Clear only after some user interaction in the Library page. Rejected because the request explicitly ties dismissal to opening the Library.

## Risks / Trade-offs

- [A manual library refresh could also trigger the highlight] → Acceptable; the effect reflects newly loaded entries, not only analysis-driven additions.
- [Count-based detection will not notice content changes without count changes] → Acceptable for this request, which is specifically about items being added.

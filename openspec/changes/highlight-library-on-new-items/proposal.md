## Why

When analysis adds replays to the library, the user has no strong visual cue in the sidebar that something new is waiting there. A temporary highlight on the Library navigation item would provide immediate feedback without interrupting the workflow.

## What Changes

- Add a temporary visual highlight to the Library navigation button when the loaded library gains new entries.
- Trigger the highlight only when the user is not already viewing the Library page.
- Clear the highlight when the user opens the Library page.
- Keep the effect lightweight and consistent with the existing desktop visual style.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `desktop-application`: the Library navigation item now signals newly added replay entries until the user opens the Library page.

## Impact

- Affects the desktop renderer state around library refreshes and navigation.
- Adds a small nav-button visual treatment in the renderer stylesheet.
- Extends renderer-focused tests around Analyze/Library workflow cues.

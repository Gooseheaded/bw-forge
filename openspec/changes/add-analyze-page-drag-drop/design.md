## Context

Replay discovery already exists in the main process and is used by the file and folder pickers. The missing piece is a renderer-to-main path for dropped filesystem items, plus the UI event handling required to accept Windows drag-and-drop instead of letting Chromium reject it.

## Goals / Non-Goals

**Goals:**
- Accept dropped replay files and folders on the Analyze page.
- Reuse existing replay discovery and warning behavior.
- Show clear drop-state feedback while dragging over the page.

**Non-Goals:**
- Support dragging from non-filesystem sources.
- Add drag-and-drop to unrelated pages.

## Decisions

### Decision: Add a dedicated dropped-paths IPC call

The renderer will extract filesystem paths from dropped items and send them to the main process, where the existing replay discovery helper will process them. This keeps file traversal and validation centralized.

### Decision: Keep drop handling page-local

The Analyze page will own the drag events and visual state rather than adding a global app-wide drop target. That matches the current workflow and limits accidental drops on unrelated views.

## Risks / Trade-offs

- [Dropped file objects may not expose paths consistently] → Mitigation: use Electron's `webUtils.getPathForFile` via preload instead of relying on ad hoc renderer-only properties.
- [Nested drag events can cause flickery highlight state] → Mitigation: track drag depth and clear state on drop/leave.

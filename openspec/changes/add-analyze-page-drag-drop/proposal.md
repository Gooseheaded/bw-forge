## Why

The Analyze page promises drag-and-drop replay intake, but the desktop app currently does not implement it. On Windows this results in a blocked cursor and makes the existing copy misleading.

## What Changes

- Add actual file and folder drag-and-drop support to the Analyze page.
- Route dropped paths through the same replay discovery, deduplication, and warning flow used by the picker actions.
- Provide visible drop-target feedback while dragging files over the Analyze page.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `desktop-application`: replay input selection will support dropping replay files and folders onto the Analyze page in addition to picker-based selection.

## Impact

- Affects the desktop renderer Analyze page interaction model.
- Affects preload/shared contracts and main-process IPC for dropped-path replay discovery.

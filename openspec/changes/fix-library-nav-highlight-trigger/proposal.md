## Why

The first Library-nav highlight implementation proved too fragile in practice and too subtle visually. Users need the signal to fire reliably when new replay entries appear and be obvious enough to notice from the Analyze page.

## What Changes

- Change the Library highlight trigger from count-only comparison to replay-ID comparison.
- Add a more explicit nav indicator in addition to the existing sheen treatment.
- Keep the dismiss-on-open behavior unchanged.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `desktop-application`: the Library navigation highlight for newly added entries is now triggered from replay-ID deltas and uses a more obvious visual indicator.

## Impact

- Affects renderer-side library highlight detection and nav-button presentation.
- Extends the renderer tests for Library-nav highlight behavior.

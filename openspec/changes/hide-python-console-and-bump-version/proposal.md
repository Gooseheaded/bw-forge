## Why

Packaged Windows builds can show a visible black `python` console window during replay analysis. That makes the app look unstable and invites users to interfere with a background process that should stay fully app-managed.

## What Changes

- Hide the packaged Python subprocess window during replay analysis on Windows.
- Preserve streamed analysis output so the desktop app can still show progress and errors.
- Bump the app and workspace version from `0.1.0` to `0.2.0`.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `desktop-application`: replay analysis must not expose an extra visible Python console window to end users during normal desktop operation.

## Impact

- Affects the CLI subprocess launcher used by packaged replay analysis.
- Affects packaged Windows desktop release metadata and versioned package manifests.

## Why

The Library view currently offers two ways to open replay reports, but users do not benefit from the in-app window. A single browser-opening action is simpler and reduces choice without losing useful functionality.

## What Changes

- Remove the separate in-app report-opening action from the Library view.
- Keep a single browser-opening report action in each Library row.
- Style that remaining action like the current punchier “Open report” button.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `desktop-application`: Library report access changes from dual in-app/browser actions to a single browser-opening action.

## Impact

- Affects the desktop renderer Library action row and button copy/styling.
- Leaves the main-process report-opening plumbing intact but no longer exposed in the Library UI.

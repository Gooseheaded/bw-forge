## Context

The Library row currently exposes two report actions: one opens an in-app report window and the other opens the system browser. The user wants to standardize on the browser path and keep only the stronger-looking primary button treatment.

## Goals / Non-Goals

**Goals:**
- Reduce the Library report action to a single browser-opening button.
- Preserve the more prominent current “Open report” styling.

**Non-Goals:**
- Remove report-opening support from the main process or IPC layer.
- Change report validation or trusted-path logic.

## Decisions

### Decision: Make the remaining action browser-only in the renderer

The renderer will stop offering the `"app"` mode from the Library row and invoke the existing browser mode directly. This is the smallest change and preserves the trusted report path checks already enforced in the main process.

### Decision: Keep the primary button styling and relabel minimally

The remaining button keeps the current primary styling and uses the simpler “Open report” label, while its behavior maps to the browser mode.

## Risks / Trade-offs

- [The in-app report window remains callable internally] → Mitigation: acceptable for now because the user asked for a UI simplification, not backend removal.
- [Users lose a choice they previously had] → Mitigation: intentional; the browser path is the standardized behavior.

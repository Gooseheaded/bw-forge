## Context

The desktop app already hides the top-level analysis child process from Windows users, but the packaged CLI later launches the Python-based legacy replay analysis step directly. That inner spawn currently inherits stdio and does not request window hiding, which allows a separate black `python` console window to appear during analysis in packaged builds.

The requested version bump is operationally simple, but it should be folded into the same change so the next shipped installer and manifests clearly reflect the user-visible improvement.

## Goals / Non-Goals

**Goals:**
- Prevent packaged Windows replay analysis from showing a visible Python console window.
- Preserve the existing analysis output stream so progress parsing and diagnostics still work.
- Update workspace/package version metadata from `0.1.0` to `0.2.0`.

**Non-Goals:**
- Rework the analysis pipeline away from Python.
- Change replay-engine visibility behavior beyond the Python subprocess.
- Introduce a new release process or installer channel.

## Decisions

### Decision: Hide the CLI-spawned analysis subprocess on Windows

The CLI `runCommand` helper will explicitly set `windowsHide: true` when launching subprocesses. That is the narrowest fix because it directly covers the Python-based legacy analysis step and any similar Windows child commands launched by the CLI in packaged mode.

Alternative considered:
- Change only Python invocations to use `pythonw.exe`. Rejected because it is narrower than necessary and can interfere with inherited stdout/stderr behavior that the desktop app relies on for progress and errors.

### Decision: Keep stdio inheritance unchanged

The CLI will continue to use inherited stdio. The desktop main process already captures stdout/stderr from the top-level analysis command, and inherited stdio is how nested CLI children currently feed that stream.

Alternative considered:
- Replace inherited stdio with explicit pipes in the CLI. Rejected for this change because it is a larger behavioral shift and would require revalidating all nested progress reporting.

### Decision: Bump workspace-owned package versions together

The root package and BW Forge-owned packages will move from `0.1.0` to `0.2.0` together so package metadata, desktop installer metadata, and tests remain aligned.

## Risks / Trade-offs

- [Hidden subprocess makes direct local debugging slightly less obvious on Windows] → Mitigation: stdout/stderr remains inherited, so logs still surface in the desktop UI and terminal-driven development remains possible.
- [Version bump misses a workspace-owned reference] → Mitigation: update the package manifests, notices, lockfile, and versioned tests together, then run targeted verification.

## Why

The Windows installer currently packages only the desktop shell and still requires a prepared
repository checkout plus developer runtimes. A normal user should be able to install BW Forge,
select an existing StarCraft installation, and use analysis, library, report, ingestion, and MCP
features without installing Bun, Node, pnpm, Python, or ShieldBattery separately.

## What Changes

- Package the executable replay engine, replay reducer, report assets, corpus engine, and MCP
  server with the desktop application.
- Run packaged JavaScript through Electron's embedded Node runtime and package an isolated Python
  runtime for replay reduction.
- Package the forked ShieldBattery replay-export client under a BW Forge-specific application
  identity so it cannot collide with an installed or running upstream ShieldBattery client.
- Prompt for and validate an existing StarCraft: Brood War installation as the intentional external
  prerequisite.
- Validate packaged runtime integrity at startup and present actionable errors for missing or
  incompatible files.
- Preserve repository-based development commands and runtime overrides for developers.

## Capabilities

### New Capabilities

- `installed-runtime`: Self-contained Windows runtime packaging, StarCraft installation selection,
  replay-engine process isolation, and production runtime validation.

### Modified Capabilities

None.

## Impact

This affects the Electron packaging configuration and desktop settings/command construction, the
root CLI's runtime path resolution, the Python export invocation, the corpus-query entrypoints, and
the imported ShieldBattery build identity. The installed artifact becomes larger, while StarCraft
remains external and user-supplied.

## Context

The desktop installer currently contains only the Electron product shell. Production commands still
target TypeScript source in a repository checkout and require Bun, Node, pnpm, Python, and a
prepared ShieldBattery tree. ShieldBattery also uses its product-derived application name for its
user-data directory and single-instance pipe, so packaging the fork under the upstream identity
would let an installed upstream client intercept replay-export launches.

StarCraft itself cannot be redistributed and remains an intentional user-supplied prerequisite.
Development workflows must continue to run directly from the repository.

## Goals / Non-Goals

**Goals:**

- Make the installed desktop application's analysis, ingestion, report, library, and MCP paths
  independent of a repository checkout and developer runtimes.
- Give the packaged replay engine a BW Forge-specific product name, application ID, user-data
  directory, executable name, and single-instance namespace.
- Allow upstream ShieldBattery and the BW Forge replay engine to run concurrently without either
  process receiving the other's launch arguments.
- Prompt for, validate, and persist an existing StarCraft installation.
- Keep production child processes observable and preserve existing CLI behavior in development.

**Non-Goals:**

- Redistribute or install StarCraft.
- Replace ShieldBattery's injection/runtime implementation.
- Remove repository-based developer commands.

## Decisions

### Package a dedicated replay-engine application

Build the imported ShieldBattery client with a BW Forge-specific electron-builder configuration.
The product and executable will be named `BW Forge Replay Engine`, and the application ID will be
under the BW Forge namespace. ShieldBattery derives its single-instance pipe from `app.name`, which
is derived from the product-specific user-data directory, so this separates both persistence and
IPC from upstream ShieldBattery.

Using the upstream `ShieldBattery` product identity was rejected because a running upstream process
can consume the second process's arguments and exit it before BW Forge owns the lifecycle.

### Make replay-export mode non-interactive and side-effect limited

The replay-engine build will retain the fork's `--replay-export` path and hidden Electron window.
Replay-export invocations will use the BW Forge application ID and will not focus a window when a
second replay-export invocation is forwarded. Production packaging will not include upstream
signing or publishing configuration.

The injected game runtime will suppress visibility requests for StarCraft's known main window while
replay export is enabled. It will also receive a non-persistent muted settings snapshot by default;
an explicit launch option may restore audio for debugging. Normal replay playback remains unchanged.

### Use Electron's embedded Node runtime for packaged JavaScript

Bundle the root CLI and corpus CLI/MCP entrypoints as stable JavaScript and execute them with the
desktop Electron executable in Node mode. This removes external Bun and Node requirements while
keeping command construction and child-process boundaries intact.

### Bundle an isolated standard-library Python runtime

Package the official Windows embeddable Python distribution with the standard-library-only replay
reducer. Production commands will resolve Python and reducer paths from the packaged runtime
manifest; development continues to use configured commands and source paths.

### Treat the packaged runtime as immutable

Place engine files beneath Electron `resources/runtime` and keep user output, settings, SQLite
databases, and replay-engine user data outside the installation directory. Startup validation will
verify required files and report the StarCraft path separately from internal runtime integrity.

## Risks / Trade-offs

- **Large installer due to Electron, Python, and ShieldBattery game binaries** → Package compiled
  artifacts rather than ShieldBattery build dependencies and record runtime contents in a manifest.
- **Upstream and replay-engine processes still share StarCraft itself** → Serialize app-owned replay
  analysis and report a clear error when StarCraft cannot launch.
- **Product identity can regress through packaging changes** → Add automated identity/configuration
  checks and an integration test that launches the packaged engine while upstream ShieldBattery is
  already running.
- **Suppressing visibility could affect initialization assumptions** → Keep the message loop and
  timers running, suppress only the known StarCraft main window, and verify a complete fixture
  export after every native change.
- **Embedded runtimes require security updates** → Pin versions/checksums and make runtime versions
  visible in the packaged manifest.

## Migration Plan

1. Add and verify the dedicated replay-engine packaging identity.
2. Bundle JavaScript, Python, report, and replay-engine artifacts into the desktop resources.
3. Switch production command resolution to the packaged runtime while retaining development
   resolution.
4. Add StarCraft path selection/validation and remove developer-runtime controls from production
   settings.
5. Build, install, and exercise analyze, ingest, report, library, and MCP workflows from an
   installed artifact.

Rollback retains the existing repository-backed development path and can omit the packaged runtime
resources without changing replay/corpus artifact formats.

## Open Questions

None for the replay-engine isolation phase.

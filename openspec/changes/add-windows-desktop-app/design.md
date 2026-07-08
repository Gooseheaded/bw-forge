## Context

The existing root CLI is the authoritative integration point for replay analysis, corpus ingestion, and MCP serving. Analysis is Windows-specific and depends on a prepared ShieldBattery checkout, StarCraft, Python, Bun, Node, pnpm, and the corpus-query runtime. The desktop application must improve usability while keeping those processes isolated from the renderer and preserving every existing CLI contract.

The first distributable does not attempt to turn the full ShieldBattery/StarCraft toolchain into a hermetic embedded runtime. It packages the desktop shell and validates a separately prepared `bw-forge` runtime directory. Development defaults to the current repository. This follows the explicit allowance to document large runtime prerequisites while still providing a real Windows packaging path.

## Goals / Non-Goals

**Goals:**

- Provide one Windows UI for replay selection, analysis, ingestion, report browsing, and MCP lifecycle.
- Invoke the existing root CLI with argument arrays and observable child processes.
- Give every selected replay an explicit queued/running/succeeded/failed/cancelled outcome.
- Keep settings, runtime checks, process state, and filesystem access in the Electron main process.
- Keep the renderer sandboxed behind a narrow typed preload API.
- Package the desktop shell as an installable Windows application.
- Make command construction, path policy, settings, manifest loading, and state transitions independently testable.

**Non-Goals:**

- Reimplement replay parsing, analysis, corpus queries, MCP tools, or the standalone report.
- Add strategic interpretation, cloud synchronization, accounts, telemetry, or a backend.
- Embed or silently install StarCraft, Python, Bun, Node, pnpm, or all ShieldBattery build dependencies in the first package.
- Change existing CLI arguments, artifact schemas, or query semantics.

## Decisions

### Use Electron main/preload/renderer boundaries

The desktop app will use Electron with React and TypeScript, built by `electron-vite`. The renderer will run with context isolation and sandboxing, no direct Node integration, and a typed API exposed from a preload script.

Alternative: a React renderer with direct Node access would be faster to scaffold but would make report loading and filesystem operations unnecessarily dangerous.

### Keep the root CLI as the only pipeline integration contract

The main process will spawn:

```text
bun <runtime-root>/apps/cli/src/main.ts analyze <replay> --out <output>
bun <runtime-root>/apps/cli/src/main.ts ingest <output> --db <database>
bun <runtime-root>/apps/cli/src/main.ts mcp --db <database> --transport http ...
```

Commands use `shell: false`, explicit argument arrays, a validated runtime root, and streamed stdout/stderr. Command construction will be pure and covered by tests. This avoids importing Bun-oriented CLI modules into Electron's Node runtime or duplicating orchestration logic.

Alternative: importing analyzer/query internals into Electron would couple the app to implementation details and violate the product-shell constraint.

### Expand directory selections into a per-replay queue

The main process will recursively enumerate `.rep` files from selected folders, de-duplicate canonical paths, and execute one `analyze` child per replay. Successful analysis jobs share one output root. After all replay jobs settle, the app will run one ingestion stage if at least one replay succeeded.

This provides truthful per-replay outcomes even though the CLI also accepts directories. It also allows later retry and cancellation behavior without changing the CLI.

Alternative: passing one directory directly to the CLI loses reliable per-replay status because only aggregate process exit is observable.

### Store settings as versioned JSON in Electron user data

Settings will include runtime root, analysis output root, database path, replay-export speed, snapshot preference, and MCP host/port/path. Defaults place output under the user's Documents directory rather than the repository. Writes will use a temporary file plus rename.

Alternative: a renderer local-storage settings store cannot safely validate paths and is harder to migrate or inspect.

### Derive the library from canonical manifests

The replay library will read `corpus-manifest.json`, then each referenced `replay-manifest.json`, and expose a renderer-safe view model containing source filename, replay ID, matchup, duration, players, paths, and report availability. Malformed entries become library warnings rather than crashing the app.

No deterministic facts will be recomputed in the desktop app.

### Open reports through main-process-controlled paths

The main process will verify that a requested report is one of the manifest-declared HTML files under the configured output root. It can either open that file with the operating system or load it in a dedicated sandboxed `BrowserWindow` with Node integration disabled.

Alternative: accepting arbitrary renderer-supplied file URLs would create a local-file privilege boundary violation.

### Manage exactly one MCP child process

The app-managed MCP server will use the existing HTTP transport so it can expose meaningful connection details. Starting validates the database and settings, replaces no running process implicitly, streams logs, and records PID/state. Stop requests terminate the child and use a bounded forced termination fallback on Windows. Unexpected exits become visible failures.

### Validate external runtime prerequisites instead of hiding them

Startup and settings validation will report:

- Windows support;
- runtime-root and required source paths;
- Bun, Node, pnpm, and Python availability;
- prepared ShieldBattery and corpus-query dependency locations;
- configured output/database path safety; and
- whether a database exists before MCP start.

The development app derives the repository root automatically. A packaged app checks `BW_FORGE_RUNTIME_ROOT`, a saved runtime root, or an optional bundled runtime directory.

### Package the shell with electron-builder

`electron-builder` will produce an x64 NSIS installer and unpacked Windows directory. The packaged application includes the compiled main/preload/renderer assets and documentation. The README will describe the runtime checkout/dependency prerequisites and how to point the installed app at them.

## Risks / Trade-offs

- **External runtime setup remains substantial** → Provide a visible prerequisite checklist, actionable remediation text, and developer/user setup documentation.
- **One child process per replay repeats exporter startup cost** → Accept this for truthful MVP status; add a future batch protocol only if profiling justifies changing the CLI.
- **CLI logs are not a stable machine protocol** → Use process lifecycle for authoritative status and logs only for display/coarse stage hints.
- **Windows process trees may survive normal termination** → Use `taskkill /T /F` only as a bounded fallback for app-owned child PIDs.
- **Manifest files can be stale or partially written** → Refresh only after process completion, validate schemas defensively, and surface warnings.
- **The existing worktree contains concurrent corpus-query changes** → Keep desktop files additive and avoid modifying those source files.

## Migration Plan

1. Add the desktop workspace and root scripts without changing existing CLI commands.
2. Implement/test main-process services and typed IPC.
3. Implement the React workflow and documentation.
4. Validate local fixture analysis when runtime prerequisites are available.
5. Build the renderer/main bundles and an unpacked/installer Windows artifact.
6. Rollback consists of removing `apps/desktop` and the additive root workspace/scripts; existing CLI behavior remains intact.

## Open Questions

- A future milestone may provide a hermetic runtime bundle or bootstrapper for StarCraft/ShieldBattery dependencies.
- A future CLI machine-readable progress protocol could reduce log parsing and process startup overhead.

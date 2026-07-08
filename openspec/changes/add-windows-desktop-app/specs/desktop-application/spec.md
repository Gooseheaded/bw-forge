## ADDED Requirements

### Requirement: Sandboxed desktop application
The system SHALL provide a Windows Electron desktop application with a React and TypeScript renderer built through Vite, and SHALL isolate privileged filesystem and process operations in the main process behind a typed preload API.

#### Scenario: Renderer starts securely
- **WHEN** the desktop window is created
- **THEN** context isolation and renderer sandboxing are enabled, Node integration is disabled, and the renderer receives only the documented desktop API

### Requirement: Safe default storage
The system SHALL default analysis output and corpus storage to an app-managed user directory outside repository source directories, and SHALL reject unsafe or invalid configured paths before starting work.

#### Scenario: First application launch
- **WHEN** no saved settings exist
- **THEN** the application selects an output root under the current user's documents or application-data area and derives a database path within that managed area

#### Scenario: Unsafe output path
- **WHEN** a configured output directory resolves to the runtime repository root or one of its protected source directories
- **THEN** validation fails with an actionable message and no pipeline child process starts

### Requirement: Replay input selection
The system SHALL let users select one or more `.rep` files or directories and SHALL recursively discover, canonicalize, de-duplicate, and display the replay files that will be analyzed.

#### Scenario: Directory import
- **WHEN** a user selects a directory containing replay files in nested folders
- **THEN** every nested `.rep` file appears once in the pending import list

#### Scenario: Invalid selection
- **WHEN** a selected path is missing, unreadable, or contains no replay files
- **THEN** the application preserves valid selections and displays a clear warning for the invalid selection

### Requirement: Existing CLI orchestration
The system SHALL implement main-process child wrappers for the existing `bw-forge analyze`, `bw-forge ingest`, and `bw-forge mcp` commands without changing their public arguments or semantics.

#### Scenario: Analyze command construction
- **WHEN** a replay job is started
- **THEN** the child command invokes the configured Bun executable, the runtime root CLI entry point, `analyze`, the replay path, and the configured output arguments using an argument array with shell execution disabled

#### Scenario: Ingest command construction
- **WHEN** one or more replay analyses succeed
- **THEN** the child command invokes `ingest` for the configured output root and database path after all replay analysis processes have settled

#### Scenario: MCP command construction
- **WHEN** the user starts MCP
- **THEN** the child command invokes `mcp` for the selected database and configured HTTP host, port, and route

### Requirement: Observable analysis jobs
The system SHALL show aggregate job state, live timestamped stdout/stderr logs, and queued/running/succeeded/failed/cancelled status for each replay.

#### Scenario: Mixed replay outcomes
- **WHEN** one replay process fails and another succeeds
- **THEN** both outcomes remain visible, ingestion proceeds for available successful output, and the overall job reports partial failure

#### Scenario: User cancellation
- **WHEN** the user cancels an active analysis run
- **THEN** the app terminates the app-owned active process, marks unstarted replay jobs cancelled, and does not report them as failures or successes

### Requirement: Actionable runtime validation
The system SHALL validate platform, runtime-root files, required executables, prepared dependency locations, output paths, and database readiness, and SHALL expose remediation-oriented results in the UI.

#### Scenario: Missing Python
- **WHEN** no supported Python command can be executed
- **THEN** startup validation reports Python as unavailable and analysis cannot start

#### Scenario: Missing database for MCP
- **WHEN** the user attempts to start MCP before the configured corpus database exists
- **THEN** MCP remains stopped and the UI directs the user to analyze and ingest replays or select an existing database

### Requirement: Persistent local settings
The system SHALL persist versioned settings locally for runtime root, output directory, database path, replay analysis options, and MCP host/port/path.

#### Scenario: Settings survive restart
- **WHEN** a user saves valid settings and restarts the application
- **THEN** the saved values are restored before the first library refresh or runtime validation

#### Scenario: Corrupt settings
- **WHEN** the stored settings file cannot be parsed or contains invalid values
- **THEN** the application uses safe defaults and reports a recoverable settings warning

### Requirement: Replay library
The system SHALL load canonical corpus and replay manifests into a replay library showing available replay ID, source filename, matchup, duration, players, races, and report availability without deriving new strategy conclusions.

#### Scenario: Library refresh after ingestion
- **WHEN** analysis and ingestion finish
- **THEN** the library refreshes from canonical manifests and displays every valid analyzed replay

#### Scenario: Partially malformed corpus
- **WHEN** one replay manifest is missing or malformed
- **THEN** valid replay entries still load and the invalid entry produces a visible library warning

### Requirement: Safe report opening
The system SHALL let users open a manifest-declared standalone replay report inside a sandboxed application window or in the system browser.

#### Scenario: Open in application
- **WHEN** the user chooses the in-app action for an available report
- **THEN** the application validates the report path under the configured output root and opens it with Node integration disabled

#### Scenario: Reject untrusted report path
- **WHEN** the renderer requests a path that is not declared by the selected replay manifest or escapes the output root
- **THEN** the main process rejects the request and does not open the file

### Requirement: Managed MCP lifecycle
The system SHALL start, monitor, and stop at most one app-owned MCP HTTP server for the selected database and SHALL display state, PID when available, endpoint, and process logs.

#### Scenario: MCP starts successfully
- **WHEN** validation passes and the MCP child remains running
- **THEN** the UI reports a running server and displays its complete HTTP endpoint

#### Scenario: MCP exits unexpectedly
- **WHEN** the MCP child exits without a user stop request
- **THEN** the UI reports the exit code or signal and changes the server state to failed

#### Scenario: Application exits
- **WHEN** the desktop application quits while MCP or analysis is running
- **THEN** it terminates all child processes owned by the application

### Requirement: Clear setup and process failures
The system SHALL convert common spawn, missing-tool, invalid-path, nonzero-exit, and malformed-manifest failures into clear user-facing messages while retaining diagnostic logs.

#### Scenario: Child command cannot spawn
- **WHEN** an executable is missing or cannot be launched
- **THEN** the affected operation fails with the executable name, remediation guidance, and the original diagnostic detail in logs

### Requirement: Focused automated coverage
The system SHALL include automated tests for command construction, protected path handling, settings normalization, replay discovery and manifest loading, and core job state transitions.

#### Scenario: Desktop test command
- **WHEN** a developer runs the documented desktop test command
- **THEN** the focused tests run without starting Electron, StarCraft, or the replay exporter

### Requirement: Developer and Windows distribution workflows
The system SHALL provide documented commands to run the desktop app in development, build production assets, and produce an x64 Windows distributable with an established Electron packaging tool.

#### Scenario: Development launch
- **WHEN** a developer installs documented dependencies and runs the desktop development command on Windows
- **THEN** Electron opens the React application and automatically targets the current repository as its runtime root

#### Scenario: Windows packaging
- **WHEN** a developer runs the documented Windows packaging command with required build tools installed
- **THEN** the build produces an NSIS installer or unpacked Windows application and documentation states any runtime prerequisites not embedded in that artifact

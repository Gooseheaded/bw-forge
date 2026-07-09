## MODIFIED Requirements

### Requirement: Existing CLI orchestration
The system SHALL implement main-process child wrappers for the existing `bw-forge analyze`, `bw-forge ingest`, and `bw-forge mcp` commands without changing their public arguments or semantics, and packaged Windows analysis SHALL NOT expose an extra visible Python console window during normal operation.

#### Scenario: Analyze command construction
- **WHEN** a replay job is started
- **THEN** the child command invokes the configured Bun executable, the runtime root CLI entry point, `analyze`, the replay path, and the configured output arguments using an argument array with shell execution disabled

#### Scenario: Ingest command construction
- **WHEN** one or more replay analyses succeed
- **THEN** the child command invokes `ingest` for the configured output root and database path after all replay analysis processes have settled

#### Scenario: MCP command construction
- **WHEN** the user starts MCP
- **THEN** the child command invokes `mcp` for the selected database and configured HTTP host, port, and route

#### Scenario: Packaged Windows analysis
- **WHEN** the packaged desktop app launches replay analysis on Windows
- **THEN** the Python-based legacy analysis subprocess runs without creating a visible console window for the user

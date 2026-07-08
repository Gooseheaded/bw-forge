## ADDED Requirements

### Requirement: Self-contained installed runtime
The Windows desktop installer SHALL include the executable JavaScript engine, Python replay
reducer, report assets, corpus engine, MCP server, and replay-export runtime required by all
application workflows without requiring a repository checkout, Bun, Node, pnpm, or a separately
installed Python.

#### Scenario: First launch on a non-developer machine
- **WHEN** a user installs and starts BW Forge on a supported Windows system
- **THEN** internal runtime validation succeeds without locating developer tools or source files

### Requirement: External StarCraft installation
The installed application SHALL treat an existing compatible StarCraft: Brood War installation as
an external prerequisite and SHALL let the user select, validate, and persist its installation
directory.

#### Scenario: StarCraft is not discovered
- **WHEN** replay analysis is requested and no valid StarCraft installation is configured
- **THEN** the application prompts for an installation directory and does not start replay export

#### Scenario: User selects a valid installation
- **WHEN** the selected directory contains the compatible StarCraft executable and required files
- **THEN** the application persists the directory and makes replay analysis available

### Requirement: Isolated replay-engine identity
The packaged replay exporter SHALL use a BW Forge-specific product name, executable name,
application ID, user-data directory, and single-instance namespace that are distinct from upstream
ShieldBattery.

#### Scenario: Upstream ShieldBattery is already running
- **WHEN** BW Forge starts its packaged replay engine while an upstream ShieldBattery process is
  running for the same Windows user
- **THEN** the replay-engine process handles its own replay arguments and upstream ShieldBattery
  neither receives those arguments nor changes visibility

#### Scenario: Replay engine completes
- **WHEN** unattended replay export reaches its terminal frame or normal replay completion
- **THEN** the app-owned StarCraft process and replay-engine Electron process exit without user
  interaction while upstream ShieldBattery remains running

### Requirement: Non-disruptive replay execution
Unattended replay export SHALL keep the ShieldBattery and StarCraft main windows hidden and SHALL
mute StarCraft audio by default without changing the user's persisted game settings.

#### Scenario: Replay export initializes
- **WHEN** the app-owned StarCraft process creates or attempts to show its main window
- **THEN** the native window remains hidden while initialization, playback, telemetry, and shutdown
  continue

#### Scenario: Replay export plays game audio
- **WHEN** unattended replay playback would normally produce music, effects, speech, or background
  audio
- **THEN** the launch-specific settings disable that audio without overwriting persisted settings

#### Scenario: Developer explicitly enables audio
- **WHEN** replay export is launched with audio suppression disabled
- **THEN** the replay uses the configured game audio settings for that invocation

### Requirement: Development runtime compatibility
Repository development commands SHALL continue to use source files and configured developer
runtimes without depending on packaged resources.

#### Scenario: Desktop development launch
- **WHEN** a developer runs the documented desktop development command from the repository
- **THEN** the application resolves the repository runtime and existing development toolchain

### Requirement: Packaged runtime validation
The desktop application SHALL validate packaged runtime contents and versions separately from the
external StarCraft installation and SHALL provide actionable failures for missing or incompatible
components.

#### Scenario: Internal runtime file is missing
- **WHEN** a required packaged engine, reducer, report, or replay-export file is absent
- **THEN** startup validation identifies the missing component and prevents the affected operation

### Requirement: Installed workflow verification
The release workflow SHALL verify replay analysis, corpus ingestion, library loading, report
opening, and MCP startup using files beneath an installed application's resources.

#### Scenario: Release verification
- **WHEN** the Windows installer is built for release
- **THEN** an automated or documented integration run exercises the fixture replay through every
  installed workflow and confirms that app-owned child processes terminate

## 1. Replay Engine Isolation

- [x] 1.1 Add an unsigned BW Forge replay-engine build configuration with a unique product name, executable name, application ID, user-data directory, and single-instance namespace
- [x] 1.2 Prevent replay-export launches from focusing an existing application window and cover identity selection with focused tests
- [x] 1.3 Build and run the packaged replay engine against the fixture while upstream ShieldBattery remains open, then verify independent process shutdown
- [ ] 1.4 Suppress the StarCraft main window and audio during replay export, preserve an audio debugging override, and verify unattended fixture completion

## 2. Packaged Engine Runtime

- [x] 2.1 Bundle the root CLI and corpus CLI/MCP entrypoints for Electron's embedded Node runtime
- [x] 2.2 Download, checksum, and package the Windows embeddable Python runtime and replay reducer
- [x] 2.3 Package the report template and compiled ShieldBattery replay-engine artifacts under a versioned runtime manifest
- [x] 2.4 Stage replay-injection DLLs in a short versioned local path and validate the path before launch
- [x] 2.5 Update CLI path and child-process resolution for packaged and development modes

## 3. Desktop Production Integration

- [x] 3.1 Resolve immutable packaged runtime paths in production command construction and retain repository defaults in development
- [x] 3.2 Add StarCraft installation selection, validation, persistence, and replay-engine environment configuration
- [x] 3.3 Replace developer prerequisite settings in production with packaged-runtime integrity status
- [x] 3.4 Add focused tests for production commands, settings migration, runtime validation, and missing-component failures

## 4. Distribution Verification

- [x] 4.1 Include runtime resources and third-party notices in the Windows installer
- [x] 4.2 Build and install the application into a clean test location
- [x] 4.3 Verify fixture analysis, corpus ingestion, library/report access, and MCP lifecycle from installed resources
- [x] 4.4 Update user and developer documentation with the StarCraft-only external prerequisite and release verification workflow

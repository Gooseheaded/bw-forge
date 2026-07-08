## 1. Workspace and Application Scaffold

- [x] 1.1 Add `apps/desktop` as a Bun workspace with Electron, React, TypeScript, Vite, Vitest, and electron-builder configuration
- [x] 1.2 Add root development, test, build, and Windows packaging scripts without changing existing CLI scripts
- [x] 1.3 Create secure Electron main, preload, renderer entry points and shared typed IPC contracts

## 2. Main-Process Domain Services

- [x] 2.1 Implement versioned settings defaults, normalization, atomic persistence, and path-safety validation
- [x] 2.2 Implement pure analyze, ingest, and MCP command builders using the existing CLI contract
- [x] 2.3 Implement recursive replay discovery with canonical-path de-duplication and selection diagnostics
- [x] 2.4 Implement canonical corpus/replay manifest loading, library warnings, and trusted report-path resolution
- [x] 2.5 Implement external runtime prerequisite checks with actionable results

## 3. Process Orchestration and IPC

- [x] 3.1 Implement an app-owned child-process runner with streamed timestamped logs and safe Windows process-tree termination
- [x] 3.2 Implement the per-replay analysis queue, cancellation, mixed outcomes, ingestion stage, and library refresh
- [x] 3.3 Implement single-instance MCP HTTP start, monitoring, connection details, logs, stop, and application-exit cleanup
- [x] 3.4 Register typed IPC handlers for dialogs, settings, validation, replay jobs, library, reports, and MCP lifecycle

## 4. React Product Experience

- [x] 4.1 Implement application navigation, status surfaces, and accessible responsive visual styling
- [x] 4.2 Implement replay file/folder import, pending selection management, and Analyze actions
- [x] 4.3 Implement aggregate progress, per-replay status, cancellation, and live log views
- [x] 4.4 Implement replay library metadata, warnings, refresh, and in-app/system report actions
- [x] 4.5 Implement settings editing for runtime/output/database/analysis/MCP values and prerequisite validation
- [x] 4.6 Implement MCP status, endpoint, logs, start, and stop controls

## 5. Verification and Productization

- [x] 5.1 Add focused unit tests for commands, paths/settings, replay discovery, manifests, and job state
- [x] 5.2 Add developer and user documentation covering local run, prerequisites, normal workflow, failures, and Windows installation
- [x] 5.3 Verify TypeScript, tests, production build, and Windows packaging configuration
- [x] 5.4 Exercise the fixture analyze/ingest/library flow when local StarCraft and ShieldBattery runtime prerequisites permit, documenting any external limitation

export const SETTINGS_VERSION = 2 as const;
export type RuntimeMode = "development" | "packaged";

export interface AppSettings {
  version: typeof SETTINGS_VERSION;
  runtimeRoot: string;
  starcraftPath: string;
  outputRoot: string;
  databasePath: string;
  bunExecutable: string;
  nodeExecutable: string;
  pnpmExecutable: string;
  pythonExecutable: string;
  replayExportSpeed: number;
  keepSnapshots: boolean;
  mcpHost: string;
  mcpPort: number;
  mcpPath: string;
}

export type CheckStatus = "pass" | "warning" | "fail";

export interface RuntimeCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  remediation?: string;
}

export interface RuntimeValidation {
  checkedAt: string;
  canAnalyze: boolean;
  canIngest: boolean;
  canStartMcp: boolean;
  checks: RuntimeCheck[];
}

export interface ReplaySelectionResult {
  replayPaths: string[];
  warnings: string[];
}

export type LogSource = "system" | "analyze" | "ingest" | "mcp";
export type LogStream = "info" | "stdout" | "stderr";

export interface ProcessLogEntry {
  id: number;
  timestamp: string;
  source: LogSource;
  stream: LogStream;
  message: string;
  replayPath?: string;
}

export type ReplayJobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type ProgressMode = "exact" | "estimated" | "indeterminate";

export type AnalysisPhase =
  | "queued"
  | "replay_export"
  | "timeline_analysis"
  | "finalizing_replay"
  | "ingest"
  | "cancelling";

export interface ProgressSnapshot {
  phase: AnalysisPhase;
  label: string;
  detail: string;
  percent: number | null;
  mode: ProgressMode;
  updatedAt: string;
}

export interface QueueProgress {
  completed: number;
  total: number;
  percent: number;
}

export interface ReplayJob {
  id: string;
  replayPath: string;
  filename: string;
  status: ReplayJobStatus;
  progress?: ProgressSnapshot;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number | null;
  error?: string;
}

export type AnalysisRunStatus =
  | "idle"
  | "running"
  | "ingesting"
  | "cancelling"
  | "succeeded"
  | "partial"
  | "failed"
  | "cancelled";

export interface AnalysisRunState {
  runId: string | null;
  status: AnalysisRunStatus;
  jobs: ReplayJob[];
  logs: ProcessLogEntry[];
  queueProgress: QueueProgress;
  currentJobId?: string | null;
  primaryProgress?: ProgressSnapshot;
  startedAt?: string;
  finishedAt?: string;
  ingestExitCode?: number | null;
  error?: string;
}

export interface AnalysisStartRequest {
  replayPaths: string[];
}

export interface ReplayPlayerView {
  owner: number;
  name: string;
  race: string;
}

export interface ReplayLibraryEntry {
  replayId: string;
  sourceFilename: string;
  matchup: string | null;
  map: string | null;
  durationSeconds: number | null;
  players: ReplayPlayerView[];
  reportNames: string[];
}

export interface ReplayLibrary {
  loadedAt: string;
  entries: ReplayLibraryEntry[];
  warnings: string[];
}

export type ReportOpenMode = "app" | "browser";

export interface ReportOpenRequest {
  replayId: string;
  reportName: string;
  mode: ReportOpenMode;
}

export type McpStatus = "stopped" | "starting" | "running" | "stopping" | "failed";

export interface McpState {
  status: McpStatus;
  pid?: number;
  endpoint?: string;
  startedAt?: string;
  stoppedAt?: string;
  exitCode?: number | null;
  error?: string;
  logs: ProcessLogEntry[];
}

export interface SettingsSaveResult {
  settings: AppSettings;
  validation: RuntimeValidation;
}

export interface AppBootstrap {
  runtimeMode: RuntimeMode;
  settings: AppSettings;
  settingsWarning?: string;
  validation: RuntimeValidation;
  analysis: AnalysisRunState;
  library: ReplayLibrary;
  mcp: McpState;
}

export interface DesktopApi {
  bootstrap(): Promise<AppBootstrap>;
  selectReplayFiles(): Promise<ReplaySelectionResult>;
  selectReplayFolder(): Promise<ReplaySelectionResult>;
  discoverDroppedReplayPaths(paths: string[]): Promise<ReplaySelectionResult>;
  getPathForDroppedFile(file: File): string;
  chooseRuntimeDirectory(): Promise<string | null>;
  chooseStarcraftDirectory(): Promise<string | null>;
  chooseOutputDirectory(): Promise<string | null>;
  chooseDatabasePath(): Promise<string | null>;
  saveSettings(settings: AppSettings): Promise<SettingsSaveResult>;
  validateRuntime(settings?: AppSettings): Promise<RuntimeValidation>;
  startAnalysis(request: AnalysisStartRequest): Promise<AnalysisRunState>;
  cancelAnalysis(): Promise<AnalysisRunState>;
  getAnalysisState(): Promise<AnalysisRunState>;
  refreshLibrary(): Promise<ReplayLibrary>;
  openReport(request: ReportOpenRequest): Promise<void>;
  startMcp(): Promise<McpState>;
  stopMcp(): Promise<McpState>;
  getMcpState(): Promise<McpState>;
  onAnalysisUpdate(listener: (state: AnalysisRunState) => void): () => void;
  onMcpUpdate(listener: (state: McpState) => void): () => void;
}

export const IPC_CHANNELS = {
  bootstrap: "desktop:bootstrap",
  selectReplayFiles: "desktop:select-replay-files",
  selectReplayFolder: "desktop:select-replay-folder",
  discoverDroppedReplayPaths: "desktop:discover-dropped-replay-paths",
  chooseRuntimeDirectory: "desktop:choose-runtime-directory",
  chooseStarcraftDirectory: "desktop:choose-starcraft-directory",
  chooseOutputDirectory: "desktop:choose-output-directory",
  chooseDatabasePath: "desktop:choose-database-path",
  saveSettings: "desktop:save-settings",
  validateRuntime: "desktop:validate-runtime",
  startAnalysis: "desktop:start-analysis",
  cancelAnalysis: "desktop:cancel-analysis",
  getAnalysisState: "desktop:get-analysis-state",
  analysisUpdate: "desktop:analysis-update",
  refreshLibrary: "desktop:refresh-library",
  openReport: "desktop:open-report",
  startMcp: "desktop:start-mcp",
  stopMcp: "desktop:stop-mcp",
  getMcpState: "desktop:get-mcp-state",
  mcpUpdate: "desktop:mcp-update"
} as const;

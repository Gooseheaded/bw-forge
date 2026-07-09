import {
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  type IpcMainInvokeEvent
} from "electron";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  IPC_CHANNELS,
  type AnalysisStartRequest,
  type AppBootstrap,
  type AppSettings,
  type ReplayLibrary,
  type ReportOpenRequest,
  type SettingsSaveResult
} from "../shared/contracts";
import { AnalysisManager } from "./analysis-manager";
import { discoverReplayPaths } from "./replay-discovery";
import { McpManager } from "./mcp-manager";
import { ReplayLibraryService } from "./replay-library";
import { SettingsStore } from "./settings-store";
import { assertNoRunningStarcraftProcess } from "./starcraft-process";
import { validateRuntime } from "./runtime-validation";
import { resolveRuntimeLayout } from "./runtime-layout";

export interface DesktopServices {
  getSettings: () => AppSettings;
  settingsStore: SettingsStore;
  settingsWarning?: string;
  setSettings: (settings: AppSettings) => void;
  analysis: AnalysisManager;
  mcp: McpManager;
  library: ReplayLibraryService;
  getLibrary: () => ReplayLibrary;
  setLibrary: (library: ReplayLibrary) => void;
}

export function registerDesktopIpc(services: DesktopServices): void {
  removeRegisteredHandlers();

  ipcMain.handle(IPC_CHANNELS.bootstrap, async (): Promise<AppBootstrap> => {
    const settings = services.getSettings();
    const runtimeMode = resolveRuntimeLayout(settings.runtimeRoot).kind;
    const [validation, library] = await Promise.all([
      validateRuntime(settings),
      services.library.load(settings.outputRoot)
    ]);
    services.setLibrary(library);
    return {
      runtimeMode,
      settings,
      ...(services.settingsWarning ? { settingsWarning: services.settingsWarning } : {}),
      validation,
      analysis: services.analysis.snapshot(),
      library,
      mcp: services.mcp.snapshot()
    };
  });

  ipcMain.handle(IPC_CHANNELS.selectReplayFiles, async () => {
    const result = await dialog.showOpenDialog({
      title: "Select Brood War replay files",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Brood War replays", extensions: ["rep"] }]
    });
    return result.canceled
      ? { replayPaths: [], warnings: [] }
      : discoverReplayPaths(result.filePaths);
  });

  ipcMain.handle(IPC_CHANNELS.selectReplayFolder, async () => {
    const result = await dialog.showOpenDialog({
      title: "Choose a folder with replays",
      properties: ["openDirectory"]
    });
    return result.canceled
      ? { replayPaths: [], warnings: [] }
      : discoverReplayPaths(result.filePaths);
  });

  ipcMain.handle(IPC_CHANNELS.discoverDroppedReplayPaths, async (_event, paths: string[]) => {
    return discoverReplayPaths(paths);
  });

  ipcMain.handle(IPC_CHANNELS.chooseRuntimeDirectory, async () => {
    const result = await dialog.showOpenDialog({
      title: "Choose project folder",
      defaultPath: services.getSettings().runtimeRoot,
      properties: ["openDirectory"]
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle(IPC_CHANNELS.chooseStarcraftDirectory, async () => {
    const result = await dialog.showOpenDialog({
      title: "Choose your StarCraft folder",
      defaultPath: services.getSettings().starcraftPath || undefined,
      properties: ["openDirectory"]
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle(IPC_CHANNELS.chooseOutputDirectory, async () => {
    const result = await dialog.showOpenDialog({
      title: "Choose where analyzed replays are saved",
      defaultPath: services.getSettings().outputRoot,
      properties: ["openDirectory", "createDirectory"]
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle(IPC_CHANNELS.chooseDatabasePath, async () => {
    const result = await dialog.showSaveDialog({
      title: "Choose replay database file",
      defaultPath: services.getSettings().databasePath,
      filters: [{ name: "SQLite database", extensions: ["sqlite", "db"] }]
    });
    return result.canceled ? null : (result.filePath ?? null);
  });

  ipcMain.handle(
    IPC_CHANNELS.saveSettings,
    async (_event, value: AppSettings): Promise<SettingsSaveResult> => {
      if (["starting", "running", "stopping"].includes(services.mcp.snapshot().status)) {
        throw new Error("Stop the MCP server before changing settings.");
      }
      if (["running", "ingesting", "cancelling"].includes(services.analysis.snapshot().status)) {
        throw new Error("Wait for the current analysis to finish before changing settings.");
      }
      const settings = await services.settingsStore.save(value);
      services.setSettings(settings);
      const library = await services.library.load(settings.outputRoot);
      services.setLibrary(library);
      return {
        settings,
        validation: await validateRuntime(settings)
      };
    }
  );

  ipcMain.handle(IPC_CHANNELS.validateRuntime, async (_event, value?: AppSettings) =>
    validateRuntime(value ?? services.getSettings())
  );

  ipcMain.handle(
    IPC_CHANNELS.startAnalysis,
    async (_event, request: AnalysisStartRequest) => {
      const selection = await discoverReplayPaths(request.replayPaths);
      if (!selection.replayPaths.length) {
        throw new Error(selection.warnings.join("\n") || "No usable replay files were selected.");
      }
      const validation = await validateRuntime(services.getSettings());
      if (!validation.canAnalyze) {
        throw new Error(formatValidationFailures(validation.checks));
      }
      await assertNoRunningStarcraftProcess();
      await mkdir(services.getSettings().outputRoot, { recursive: true });
      await mkdir(dirname(services.getSettings().databasePath), { recursive: true });
      return services.analysis.start({ replayPaths: selection.replayPaths });
    }
  );

  ipcMain.handle(IPC_CHANNELS.cancelAnalysis, () => services.analysis.cancel());
  ipcMain.handle(IPC_CHANNELS.getAnalysisState, () => services.analysis.snapshot());
  ipcMain.handle(IPC_CHANNELS.refreshLibrary, async () => {
    const library = await services.library.load(services.getSettings().outputRoot);
    services.setLibrary(library);
    return library;
  });
  ipcMain.handle(
    IPC_CHANNELS.openReport,
    async (event: IpcMainInvokeEvent, request: ReportOpenRequest) => {
      const reportPath = services.library.resolveTrustedReport(
        services.getSettings().outputRoot,
        request.replayId,
        request.reportName
      );
      if (request.mode === "browser") {
        const error = await shell.openPath(reportPath);
        if (error) {
          throw new Error(error);
        }
        return;
      }
      openReportWindow(event, reportPath);
    }
  );

  ipcMain.handle(IPC_CHANNELS.startMcp, async () => {
    const validation = await validateRuntime(services.getSettings());
    if (!validation.canStartMcp) {
      throw new Error(formatValidationFailures(validation.checks));
    }
    return services.mcp.start();
  });
  ipcMain.handle(IPC_CHANNELS.stopMcp, () => services.mcp.stop());
  ipcMain.handle(IPC_CHANNELS.getMcpState, () => services.mcp.snapshot());
}

export function broadcast(channel: string, value: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(channel, value);
    }
  }
}

function openReportWindow(event: IpcMainInvokeEvent, reportPath: string): void {
  const parent = BrowserWindow.fromWebContents(event.sender) ?? undefined;
  const reportWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    title: "Replay report",
    parent,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });
  reportWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  void reportWindow.loadFile(resolve(reportPath));
}

function formatValidationFailures(checks: Array<{ status: string; label: string; detail: string; remediation?: string }>): string {
  const failures = checks.filter((check) => check.status === "fail");
  return failures
    .map(
      (check) =>
        `${check.label}: ${check.detail}${check.remediation ? ` ${check.remediation}` : ""}`
    )
    .join("\n");
}

function removeRegisteredHandlers(): void {
  for (const channel of Object.values(IPC_CHANNELS)) {
    if (channel.endsWith("-update")) {
      continue;
    }
    ipcMain.removeHandler(channel);
  }
}

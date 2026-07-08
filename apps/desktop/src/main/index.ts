import { app, BrowserWindow } from "electron";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { IPC_CHANNELS, type AppSettings, type ReplayLibrary } from "../shared/contracts";
import { AnalysisManager } from "./analysis-manager";
import { broadcast, registerDesktopIpc } from "./ipc";
import { McpManager } from "./mcp-manager";
import { ReplayLibraryService } from "./replay-library";
import { createDefaultSettings, SettingsStore } from "./settings-store";

let mainWindow: BrowserWindow | null = null;
let analysisManager: AnalysisManager | null = null;
let mcpManager: McpManager | null = null;

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 980,
    minHeight: 680,
    show: false,
    backgroundColor: "#0b1017",
    title: "BW Forge",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  window.once("ready-to-show", () => window.show());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(join(__dirname, "../renderer/index.html"));
  }

  return window;
}

app.whenReady().then(async () => {
  const defaultSettings = await createDefaultSettings({
    documentsPath: app.getPath("documents"),
    runtimeRoot: inferRuntimeRoot()
  });
  const settingsStore = new SettingsStore(app.getPath("userData"), defaultSettings);
  const loadedSettings = await settingsStore.load();
  let settings: AppSettings = loadedSettings.settings;
  let libraryState: ReplayLibrary = {
    loadedAt: new Date().toISOString(),
    entries: [],
    warnings: []
  };
  const library = new ReplayLibraryService();
  const refreshLibrary = async (): Promise<void> => {
    libraryState = await library.load(settings.outputRoot);
  };
  analysisManager = new AnalysisManager({
    getSettings: () => settings,
    refreshLibrary,
    onUpdate: (state) => broadcast(IPC_CHANNELS.analysisUpdate, state)
  });
  mcpManager = new McpManager({
    getSettings: () => settings,
    onUpdate: (state) => broadcast(IPC_CHANNELS.mcpUpdate, state)
  });
  registerDesktopIpc({
    getSettings: () => settings,
    settingsStore,
    ...(loadedSettings.warning ? { settingsWarning: loadedSettings.warning } : {}),
    setSettings: (nextSettings) => {
      settings = nextSettings;
    },
    analysis: analysisManager,
    mcp: mcpManager,
    library,
    getLibrary: () => libraryState,
    setLibrary: (nextLibrary) => {
      libraryState = nextLibrary;
    }
  });

  mainWindow = createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", (event) => {
  if (!analysisManager && !mcpManager) {
    return;
  }
  event.preventDefault();
  const analysis = analysisManager;
  const mcp = mcpManager;
  analysisManager = null;
  mcpManager = null;
  void Promise.all([analysis?.dispose(), mcp?.dispose()]).finally(() => app.quit());
});

function inferRuntimeRoot(): string {
  if (process.env.BW_FORGE_RUNTIME_ROOT?.trim()) {
    return resolve(process.env.BW_FORGE_RUNTIME_ROOT);
  }
  const bundledRuntime = join(process.resourcesPath, "runtime");
  if (app.isPackaged && existsSync(bundledRuntime)) {
    return bundledRuntime;
  }
  return resolve(__dirname, "../../../..");
}

import { contextBridge, ipcRenderer, webUtils } from "electron";
import {
  IPC_CHANNELS,
  type AnalysisRunState,
  type AppSettings,
  type DesktopApi,
  type McpState
} from "../shared/contracts";

const api: DesktopApi = {
  bootstrap: () => ipcRenderer.invoke(IPC_CHANNELS.bootstrap),
  selectReplayFiles: () => ipcRenderer.invoke(IPC_CHANNELS.selectReplayFiles),
  selectReplayFolder: () => ipcRenderer.invoke(IPC_CHANNELS.selectReplayFolder),
  discoverDroppedReplayPaths: (paths) => ipcRenderer.invoke(IPC_CHANNELS.discoverDroppedReplayPaths, paths),
  getPathForDroppedFile: (file: File) => webUtils.getPathForFile(file),
  chooseRuntimeDirectory: () => ipcRenderer.invoke(IPC_CHANNELS.chooseRuntimeDirectory),
  chooseStarcraftDirectory: () => ipcRenderer.invoke(IPC_CHANNELS.chooseStarcraftDirectory),
  chooseOutputDirectory: () => ipcRenderer.invoke(IPC_CHANNELS.chooseOutputDirectory),
  chooseDatabasePath: () => ipcRenderer.invoke(IPC_CHANNELS.chooseDatabasePath),
  saveSettings: (settings: AppSettings) => ipcRenderer.invoke(IPC_CHANNELS.saveSettings, settings),
  validateRuntime: (settings?: AppSettings) => ipcRenderer.invoke(IPC_CHANNELS.validateRuntime, settings),
  startAnalysis: (request) => ipcRenderer.invoke(IPC_CHANNELS.startAnalysis, request),
  cancelAnalysis: () => ipcRenderer.invoke(IPC_CHANNELS.cancelAnalysis),
  getAnalysisState: () => ipcRenderer.invoke(IPC_CHANNELS.getAnalysisState),
  refreshLibrary: () => ipcRenderer.invoke(IPC_CHANNELS.refreshLibrary),
  openReport: (request) => ipcRenderer.invoke(IPC_CHANNELS.openReport, request),
  startMcp: () => ipcRenderer.invoke(IPC_CHANNELS.startMcp),
  stopMcp: () => ipcRenderer.invoke(IPC_CHANNELS.stopMcp),
  getMcpState: () => ipcRenderer.invoke(IPC_CHANNELS.getMcpState),
  onAnalysisUpdate: (listener: (state: AnalysisRunState) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: AnalysisRunState) => listener(state);
    ipcRenderer.on(IPC_CHANNELS.analysisUpdate, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.analysisUpdate, handler);
  },
  onMcpUpdate: (listener: (state: McpState) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: McpState) => listener(state);
    ipcRenderer.on(IPC_CHANNELS.mcpUpdate, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.mcpUpdate, handler);
  }
};

contextBridge.exposeInMainWorld("bwForge", api);

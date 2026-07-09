import { useEffect, useRef, useState } from "react";
import type {
  AnalysisRunState,
  AppBootstrap,
  AppSettings,
  McpState,
  ReplayLibrary,
  ReplaySelectionResult,
  RuntimeMode,
  RuntimeValidation
} from "../../shared/contracts";
import { getAnalysisCompletionEffects } from "./analysis-completion";
import { getAnalysisPrimaryProgressView } from "./analysis-progress-view";
import {
  getAnalyzeCompletionHeadline,
  getAnalyzeCompletionSummary,
  getAnalyzeNavStatus,
  getAnalyzeWorkflowState,
  getCancelledReplayPaths,
  getFailedReplayPaths,
  getReplayResultLabel,
  type AnalyzeWorkflowState
} from "./analyze-workflow";
import { hasDroppedFiles, normalizeDroppedReplayPaths } from "./analyze-drag-drop";
import { shouldHighlightLibraryNav } from "./library-nav-highlight";

type View = "analyze" | "library" | "mcp" | "settings";

const EMPTY_ANALYSIS: AnalysisRunState = {
  runId: null,
  status: "idle",
  jobs: [],
  logs: [],
  queueProgress: {
    completed: 0,
    total: 0,
    percent: 0
  },
  currentJobId: null
};

const EMPTY_LIBRARY: ReplayLibrary = {
  loadedAt: new Date(0).toISOString(),
  entries: [],
  warnings: []
};

const EMPTY_MCP: McpState = {
  status: "stopped",
  logs: []
};

export function App(): React.JSX.Element {
  const [view, setView] = useState<View>("analyze");
  const [bootstrap, setBootstrap] = useState<AppBootstrap | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisRunState>(EMPTY_ANALYSIS);
  const [library, setLibrary] = useState<ReplayLibrary>(EMPTY_LIBRARY);
  const [mcp, setMcp] = useState<McpState>(EMPTY_MCP);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [validation, setValidation] = useState<RuntimeValidation | null>(null);
  const [pendingReplays, setPendingReplays] = useState<string[]>([]);
  const [selectionWarnings, setSelectionWarnings] = useState<string[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>("bootstrap");
  const [dismissedCompletedRunId, setDismissedCompletedRunId] = useState<string | null>(null);
  const [libraryHasNewItems, setLibraryHasNewItems] = useState(false);
  const previousAnalysisRef = useRef<AnalysisRunState | null>(null);

  useEffect(() => {
    let active = true;
    const unsubscribeAnalysis = window.bwForge.onAnalysisUpdate((nextState) => {
      if (active) {
        setAnalysis(nextState);
      }
    });
    const unsubscribeMcp = window.bwForge.onMcpUpdate((nextState) => {
      if (active) {
        setMcp(nextState);
      }
    });

    window.bwForge
      .bootstrap()
      .then((result) => {
        if (!active) {
          return;
        }
        setBootstrap(result);
        setSettings(result.settings);
        setValidation(result.validation);
        setAnalysis(result.analysis);
        setLibrary(result.library);
        setMcp(result.mcp);
      })
      .catch((error: unknown) => {
        if (active) {
          setActionError(formatError(error));
        }
      })
      .finally(() => {
        if (active) {
          setBusyAction(null);
        }
      });

    return () => {
      active = false;
      unsubscribeAnalysis();
      unsubscribeMcp();
    };
  }, []);

  const runAction = async <T,>(
    name: string,
    action: () => Promise<T>,
    onSuccess?: (result: T) => void
  ): Promise<void> => {
    setActionError(null);
    setBusyAction(name);
    try {
      const result = await action();
      onSuccess?.(result);
    } catch (error) {
      setActionError(formatError(error));
    } finally {
      setBusyAction(null);
    }
  };

  const addSelection = (result: ReplaySelectionResult): void => {
    setPendingReplays((current) => uniquePaths([...current, ...result.replayPaths]));
    setSelectionWarnings(result.warnings);
  };

  const refreshLibrary = (triggeredByAnalysisCompletion = false): Promise<void> =>
    runAction("library", () => window.bwForge.refreshLibrary(), (nextLibrary) => {
      setLibrary(nextLibrary);
      if (
        shouldHighlightLibraryNav({
          triggeredByAnalysisCompletion,
          currentView: view
        })
      ) {
        setLibraryHasNewItems(true);
      }
    });

  const activeAnalysis = ["running", "ingesting", "cancelling"].includes(analysis.status);
  const analyzeNavStatus = getAnalyzeNavStatus({
    analysis,
    pendingReplays,
    dismissedCompletedRunId
  });
  const failedChecks = validation?.checks.filter((check) => check.status === "fail").length ?? 0;
  const warningChecks = validation?.checks.filter((check) => check.status === "warning").length ?? 0;
  const failedCheckIds = new Set(
    validation?.checks.filter((check) => check.status === "fail").map((check) => check.id) ?? []
  );
  const canPromptForStarcraft =
    failedCheckIds.has("starcraft-install") && failedCheckIds.size === 1;

  useEffect(() => {
    const effects = getAnalysisCompletionEffects(previousAnalysisRef.current, analysis);
    previousAnalysisRef.current = analysis;

    if (effects.clearQueue) {
      setPendingReplays([]);
      setSelectionWarnings([]);
    }
    if (effects.refreshLibrary) {
      void refreshLibrary(true);
    }
  }, [analysis]);

  useEffect(() => {
    if (view === "library" && libraryHasNewItems) {
      setLibraryHasNewItems(false);
    }
  }, [view, libraryHasNewItems]);

  const startAnalysisFlow = async (): Promise<void> => {
    setActionError(null);
    setDismissedCompletedRunId(null);

    if (!settings) {
      return;
    }

    if (canPromptForStarcraft) {
      setBusyAction("choose-starcraft");
      try {
        const chosenPath = await window.bwForge.chooseStarcraftDirectory();
        if (!chosenPath) {
          return;
        }

        const saveResult = await window.bwForge.saveSettings({
          ...settings,
          starcraftPath: chosenPath
        });
        setSettings(saveResult.settings);
        setValidation(saveResult.validation);
        void refreshLibrary();

        if (!saveResult.validation.canAnalyze) {
          return;
        }
      } catch (error) {
        setActionError(formatError(error));
        return;
      } finally {
        setBusyAction(null);
      }
    }

    await runAction(
      "analysis",
      () => window.bwForge.startAnalysis({ replayPaths: pendingReplays }),
      setAnalysis
    );
  };

  const dismissCompletedRun = (): void => {
    setDismissedCompletedRunId(analysis.runId);
  };

  const replacePendingReplays = (paths: string[]): void => {
    setPendingReplays(uniquePaths(paths));
    setSelectionWarnings([]);
  };

  if (!settings || !validation || busyAction === "bootstrap") {
    return (
      <div className="launch-screen">
        <div className="brand-mark" aria-hidden="true">BW</div>
        <p>Starting BW Forge…</p>
        {actionError ? <ErrorBanner message={actionError} /> : null}
      </div>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">BW</div>
          <div>
            <strong>BW Forge</strong>
            <span>Replay tools</span>
          </div>
        </div>

        <nav aria-label="Primary navigation">
          <NavButton active={view === "analyze"} onClick={() => setView("analyze")} label="Analyze" meta={analyzeNavStatus} />
          <NavButton active={view === "library"} highlight={libraryHasNewItems} onClick={() => setView("library")} label="Library" meta={`${library.entries.length} replays`} />
          <NavButton active={view === "mcp"} onClick={() => setView("mcp")} label="MCP server" meta={mcp.status} />
          <NavButton active={view === "settings"} onClick={() => setView("settings")} label="Settings" meta={failedChecks ? `${failedChecks} blocked` : warningChecks ? `${warningChecks} notes` : "Ready"} />
        </nav>

        <div className="sidebar-foot">
          <StatusDot status={validation.canAnalyze ? "ready" : "blocked"} />
          <div>
            <strong>{validation.canAnalyze ? "Ready" : "Setup needed"}</strong>
            <span>Last checked {formatTime(validation.checkedAt)}</span>
          </div>
        </div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">WINDOWS DESKTOP APP</p>
            <h1>{viewTitle(view)}</h1>
          </div>
          <div className="topbar-status">
            <span className={`state-pill state-${analysis.status}`}>{analysis.status}</span>
            <span className={`state-pill state-${mcp.status}`}>MCP {mcp.status}</span>
          </div>
        </header>

        {bootstrap?.settingsWarning ? (
          <Notice tone="warning">{bootstrap.settingsWarning}</Notice>
        ) : null}
        {actionError ? <ErrorBanner message={actionError} onDismiss={() => setActionError(null)} /> : null}

        <main className="content">
          {view === "analyze" ? (
            <AnalyzeView
              pendingReplays={pendingReplays}
              selectionWarnings={selectionWarnings}
              analysis={analysis}
              canAnalyze={validation.canAnalyze}
              canPromptForStarcraft={canPromptForStarcraft}
              busyAction={busyAction}
              onSelectFiles={() => void runAction("select-files", () => window.bwForge.selectReplayFiles(), addSelection)}
              onSelectFolder={() => void runAction("select-folder", () => window.bwForge.selectReplayFolder(), addSelection)}
              onDropReplayPaths={(paths) =>
                void runAction(
                  "drop-replays",
                  () => window.bwForge.discoverDroppedReplayPaths(paths),
                  addSelection
                )
              }
              onRemove={(path) => setPendingReplays((current) => current.filter((item) => item !== path))}
              onClear={() => {
                setPendingReplays([]);
                setSelectionWarnings([]);
              }}
              onAnalyze={() => void startAnalysisFlow()}
              onCancel={() => void runAction("cancel", () => window.bwForge.cancelAnalysis(), setAnalysis)}
              onOpenSettings={() => setView("settings")}
              workflowState={getAnalyzeWorkflowState({
                analysis,
                pendingReplays,
                dismissedCompletedRunId
              })}
              onViewLibrary={() => setView("library")}
              onAnalyzeMore={() => {
                replacePendingReplays([]);
                dismissCompletedRun();
              }}
              onRetryFailed={() => {
                replacePendingReplays(getFailedReplayPaths(analysis));
                dismissCompletedRun();
              }}
              onAnalyzeRemaining={() => {
                replacePendingReplays(getCancelledReplayPaths(analysis));
                dismissCompletedRun();
              }}
            />
          ) : null}

          {view === "library" ? (
            <LibraryView
              library={library}
              busy={busyAction === "library"}
              onRefresh={() => void refreshLibrary()}
              onOpen={(replayId, reportName) =>
                void runAction("report", () =>
                  window.bwForge.openReport({ replayId, reportName, mode: "browser" })
                )
              }
            />
          ) : null}

          {view === "mcp" ? (
            <McpView
              state={mcp}
              canStart={validation.canStartMcp}
              databasePath={settings.databasePath}
              busyAction={busyAction}
              onStart={() => void runAction("mcp-start", () => window.bwForge.startMcp(), setMcp)}
              onStop={() => void runAction("mcp-stop", () => window.bwForge.stopMcp(), setMcp)}
              onOpenSettings={() => setView("settings")}
            />
          ) : null}

          {view === "settings" ? (
            <SettingsView
              runtimeMode={bootstrap?.runtimeMode ?? "development"}
              settings={settings}
              validation={validation}
              busyAction={busyAction}
              onChange={setSettings}
              onChooseRuntime={() =>
                void runAction("choose-runtime", () => window.bwForge.chooseRuntimeDirectory(), (path) => {
                  if (path) setSettings((current) => current ? { ...current, runtimeRoot: path } : current);
                })
              }
              onChooseStarcraft={() =>
                void runAction("choose-starcraft", () => window.bwForge.chooseStarcraftDirectory(), (path) => {
                  if (path) setSettings((current) => current ? { ...current, starcraftPath: path } : current);
                })
              }
              onChooseOutput={() =>
                void runAction("choose-output", () => window.bwForge.chooseOutputDirectory(), (path) => {
                  if (path) setSettings((current) => current ? { ...current, outputRoot: path } : current);
                })
              }
              onChooseDatabase={() =>
                void runAction("choose-database", () => window.bwForge.chooseDatabasePath(), (path) => {
                  if (path) setSettings((current) => current ? { ...current, databasePath: path } : current);
                })
              }
              onValidate={() =>
                void runAction("validate", () => window.bwForge.validateRuntime(settings), setValidation)
              }
              onSave={() =>
                void runAction("save-settings", () => window.bwForge.saveSettings(settings), (result) => {
                  setSettings(result.settings);
                  setValidation(result.validation);
                  void refreshLibrary();
                })
              }
            />
          ) : null}
        </main>
      </div>
    </div>
  );
}

function AnalyzeView(props: {
  pendingReplays: string[];
  selectionWarnings: string[];
  analysis: AnalysisRunState;
  workflowState: AnalyzeWorkflowState;
  canAnalyze: boolean;
  canPromptForStarcraft: boolean;
  busyAction: string | null;
  onSelectFiles: () => void;
  onSelectFolder: () => void;
  onDropReplayPaths: (paths: string[]) => void;
  onRemove: (path: string) => void;
  onClear: () => void;
  onAnalyze: () => void;
  onCancel: () => void;
  onOpenSettings: () => void;
  onViewLibrary: () => void;
  onAnalyzeMore: () => void;
  onRetryFailed: () => void;
  onAnalyzeRemaining: () => void;
}): React.JSX.Element {
  const active = props.workflowState === "running";
  const [dropActive, setDropActive] = useState(false);
  const dragDepthRef = useRef(0);
  const acceptsDrop = props.workflowState !== "running";

  const clearDrop = (): void => {
    dragDepthRef.current = 0;
    setDropActive(false);
  };

  const handleDragEnter = (event: React.DragEvent<HTMLDivElement>): void => {
    if (!acceptsDrop || !hasDroppedFiles(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    dragDepthRef.current += 1;
    setDropActive(true);
  };

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>): void => {
    if (!acceptsDrop || !hasDroppedFiles(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDropActive(true);
  };

  const handleDragLeave = (event: React.DragEvent<HTMLDivElement>): void => {
    if (!acceptsDrop || !hasDroppedFiles(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setDropActive(false);
    }
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>): void => {
    if (!acceptsDrop || !hasDroppedFiles(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    const paths = normalizeDroppedReplayPaths(
      Array.from(event.dataTransfer.files, (file) => window.bwForge.getPathForDroppedFile(file))
    );
    clearDrop();
    if (paths.length > 0) {
      props.onDropReplayPaths(paths);
    }
  };

  return (
    <div
      className={["stack", "analyze-drop-zone", dropActive ? "analyze-drop-zone-active" : ""].filter(Boolean).join(" ")}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {dropActive ? (
        <div className="analyze-drop-overlay">
          <div className="empty-state">
            <strong>Drop replays to add them</strong>
            <span>Replay files and folders will be added to the analysis queue.</span>
          </div>
        </div>
      ) : null}
      {!props.canAnalyze && props.workflowState !== "running" ? (
        <Notice tone="warning">
          {props.canPromptForStarcraft
            ? <>Choose your StarCraft folder before starting analysis, or open Settings now. </>
            : <>Setup isn’t complete yet. Open Settings before starting analysis. </>}
          <button className="link-button" onClick={props.onOpenSettings}>Open Settings</button>
        </Notice>
      ) : null}

      {props.selectionWarnings.map((warning) => (
        <Notice key={warning} tone="warning">{warning}</Notice>
      ))}

      {props.workflowState === "empty" ? (
        <AnalyzeEmptyState
          active={active}
          onSelectFiles={props.onSelectFiles}
          onSelectFolder={props.onSelectFolder}
        />
      ) : null}

      {props.workflowState === "queue-review" ? (
        <AnalyzeQueueReview
          pendingReplays={props.pendingReplays}
          canAnalyze={props.canAnalyze}
          canPromptForStarcraft={props.canPromptForStarcraft}
          busyAction={props.busyAction}
          onSelectFiles={props.onSelectFiles}
          onSelectFolder={props.onSelectFolder}
          onRemove={props.onRemove}
          onClear={props.onClear}
          onAnalyze={props.onAnalyze}
        />
      ) : null}

      {props.workflowState === "running" ? (
        <AnalyzeRunning
          analysis={props.analysis}
          busyAction={props.busyAction}
          onCancel={props.onCancel}
        />
      ) : null}

      {props.workflowState === "complete" ? (
        <AnalyzeComplete
          analysis={props.analysis}
          onViewLibrary={props.onViewLibrary}
          onAnalyzeMore={props.onAnalyzeMore}
          onRetryFailed={props.onRetryFailed}
          onAnalyzeRemaining={props.onAnalyzeRemaining}
        />
      ) : null}
    </div>
  );
}

function AnalyzeEmptyState(props: {
  active: boolean;
  onSelectFiles: () => void;
  onSelectFolder: () => void;
}): React.JSX.Element {
  return (
    <section className="hero-panel analyze-empty-card">
      <div>
        <p className="eyebrow">ADD REPLAYS</p>
        <h2>Add replays</h2>
        <p>
          Drop Brood War replay files here or choose files from your computer.
          Replays are analyzed locally and added to your library.
        </p>
      </div>
      <div className="hero-actions">
        <button className="primary" onClick={props.onSelectFiles} disabled={props.active}>Choose replay files</button>
        <button className="secondary" onClick={props.onSelectFolder} disabled={props.active}>Choose folder</button>
      </div>
    </section>
  );
}

function AnalyzeQueueReview(props: {
  pendingReplays: string[];
  canAnalyze: boolean;
  canPromptForStarcraft: boolean;
  busyAction: string | null;
  onSelectFiles: () => void;
  onSelectFolder: () => void;
  onRemove: (path: string) => void;
  onClear: () => void;
  onAnalyze: () => void;
}): React.JSX.Element {
  return (
    <section className="panel analyze-state-card">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">QUEUE REVIEW</p>
          <h2>{props.pendingReplays.length} replay{props.pendingReplays.length === 1 ? "" : "s"} selected</h2>
        </div>
      </div>
      <div className="queue-toolbar">
        <button className="secondary" onClick={props.onSelectFiles}>Add more files</button>
        <button className="quiet" onClick={props.onSelectFolder}>Add folder</button>
        <button className="quiet" onClick={props.onClear}>Clear all</button>
      </div>
      <ReplayQueueList paths={props.pendingReplays} onRemove={props.onRemove} />
      <div className="panel-footer">
        <button
          className="primary"
          onClick={props.onAnalyze}
          disabled={
            !props.pendingReplays.length ||
            (!props.canAnalyze && !props.canPromptForStarcraft) ||
            props.busyAction === "analysis"
          }
        >
          {props.busyAction === "analysis"
            ? "Starting…"
            : props.canAnalyze
              ? `Analyze ${props.pendingReplays.length} replay${props.pendingReplays.length === 1 ? "" : "s"}`
              : props.canPromptForStarcraft
                ? "Choose StarCraft and start"
                : "Analyze selected replays"}
        </button>
      </div>
    </section>
  );
}

function AnalyzeRunning(props: {
  analysis: AnalysisRunState;
  busyAction: string | null;
  onCancel: () => void;
}): React.JSX.Element {
  const primaryProgress = getAnalysisPrimaryProgressView(props.analysis);
  const queueProgress = props.analysis.queueProgress;
  const doneCount = props.analysis.jobs.filter((job) => job.status === "succeeded").length;
  const failedCount = props.analysis.jobs.filter((job) => job.status === "failed").length;
  const inProgressCount = props.analysis.jobs.filter((job) => job.status === "running").length;
  const queuedCount = props.analysis.jobs.filter((job) => job.status === "queued").length;

  return (
    <div className="stack">
      <section className="panel analyze-state-card analyze-running-card">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">ANALYZING REPLAYS</p>
            <h2>Analyzing {props.analysis.jobs.length} replay{props.analysis.jobs.length === 1 ? "" : "s"}</h2>
            <p className="running-summary">
              {doneCount} complete · {inProgressCount} in progress · {queuedCount} queued · {failedCount} failed
            </p>
          </div>
          <span className={`state-pill state-${props.analysis.status}`}>{props.analysis.status}</span>
        </div>

        <div className="progress-meta">
          <div>
            <strong>{primaryProgress.currentReplayName ?? runLabel(props.analysis.status)}</strong>
            <span>{primaryProgress.detail}</span>
          </div>
          {primaryProgress.mode === "estimated" ? <span className="progress-badge">Estimated</span> : null}
        </div>
        <ProgressBar
          label={primaryProgress.percent === null ? primaryProgress.label : `${primaryProgress.percent}% complete`}
          percent={primaryProgress.percent}
        />
        <div className="sub-progress">
          <div className="sub-progress-row">
            <strong>Queue progress</strong>
            <span>{queueProgress.completed} of {queueProgress.total} complete</span>
          </div>
          <ProgressBar
            compact
            label={`${queueProgress.percent}% of selected replays complete`}
            percent={queueProgress.percent}
          />
        </div>
        <ReplayRunList jobs={props.analysis.jobs} />
        <div className="panel-footer">
          <button className="danger" onClick={props.onCancel} disabled={props.analysis.status === "cancelling" || props.busyAction === "cancel"}>
            {props.analysis.status === "cancelling" ? "Cancelling…" : "Cancel run"}
          </button>
        </div>
      </section>

      <LogPanel title="Activity log" logs={props.analysis.logs} collapsedByDefault />
    </div>
  );
}

function AnalyzeComplete(props: {
  analysis: AnalysisRunState;
  onViewLibrary: () => void;
  onAnalyzeMore: () => void;
  onRetryFailed: () => void;
  onAnalyzeRemaining: () => void;
}): React.JSX.Element {
  const failedReplayPaths = getFailedReplayPaths(props.analysis);
  const cancelledReplayPaths = getCancelledReplayPaths(props.analysis);
  const summary = getAnalyzeCompletionSummary(props.analysis);

  return (
    <div className="stack">
      <section className="panel analyze-state-card">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">RUN COMPLETE</p>
            <h2>{getAnalyzeCompletionHeadline(props.analysis)}</h2>
          </div>
          <span className={`state-pill state-${props.analysis.status}`}>{props.analysis.status}</span>
        </div>
        <div className="completion-metrics">
          {summary.map((item) => (
            <Metric key={item.label} value={item.value} label={item.detail ? `${item.label} ${item.detail}` : item.label} />
          ))}
        </div>
        <ReplayRunList jobs={props.analysis.jobs} terminal />
        <div className="completion-actions">
          <button className="secondary" onClick={props.onViewLibrary}>View library</button>
          {failedReplayPaths.length ? (
            <button className="quiet" onClick={props.onRetryFailed}>Retry failed</button>
          ) : null}
          {props.analysis.status === "cancelled" && cancelledReplayPaths.length ? (
            <button className="quiet" onClick={props.onAnalyzeRemaining}>Analyze remaining</button>
          ) : null}
          <button className="primary" onClick={props.onAnalyzeMore}>Analyze more replays</button>
        </div>
      </section>

      <LogPanel title="Activity log" logs={props.analysis.logs} collapsedByDefault />
    </div>
  );
}

function ReplayQueueList(props: {
  paths: string[];
  onRemove: (path: string) => void;
}): React.JSX.Element {
  return (
    <div className="file-list">
      {props.paths.map((path) => (
        <div className="file-row" key={path}>
          <div className="file-icon">REP</div>
          <div>
            <strong>{fileName(path)}</strong>
            <span title={path}>{path}</span>
          </div>
          <button className="icon-button" aria-label={`Remove ${fileName(path)}`} onClick={() => props.onRemove(path)}>×</button>
        </div>
      ))}
    </div>
  );
}

function ReplayRunList(props: {
  jobs: AnalysisRunState["jobs"];
  terminal?: boolean;
}): React.JSX.Element {
  return (
    <div className="job-list">
      {props.jobs.map((job) => (
        <div className="job-row" key={job.id}>
          <StatusDot status={job.status === "succeeded" ? "ready" : job.status === "failed" ? "blocked" : "working"} />
          <div>
            <strong>{job.filename}</strong>
            <span>{props.terminal ? getReplayResultLabel(job) : job.error ?? job.progress?.detail ?? job.progress?.label ?? job.status}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function LibraryView(props: {
  library: ReplayLibrary;
  busy: boolean;
  onRefresh: () => void;
  onOpen: (replayId: string, reportName: string) => void;
}): React.JSX.Element {
  return (
    <div className="stack">
      <section className="section-heading">
        <div>
          <p className="eyebrow">SAVED REPLAYS</p>
          <h2>Replay library</h2>
          <p>Your analyzed replays appear here.</p>
        </div>
        <button className="secondary" onClick={props.onRefresh} disabled={props.busy}>
          {props.busy ? "Refreshing…" : "Refresh"}
        </button>
      </section>

      {props.library.warnings.map((warning) => (
        <Notice tone="warning" key={warning}>{warning}</Notice>
      ))}

      <div className="library-grid">
        {props.library.entries.map((entry) => (
          <article className="replay-card" key={entry.replayId}>
            <div className="replay-card-top">
              <span className="matchup-badge">{entry.matchup ?? "Unknown"}</span>
              <span>{formatDuration(entry.durationSeconds)}</span>
            </div>
            <h3>{entry.sourceFilename}</h3>
            <code>{entry.replayId.slice(0, 16)}…</code>
            <div className="players">
              {entry.players.map((player) => (
                <div key={`${entry.replayId}-${player.owner}`}>
                  <span className={`race-chip race-${player.race.toLowerCase()}`}>{player.race.slice(0, 1).toUpperCase()}</span>
                  <strong>{player.name}</strong>
                  <span>{player.race}</span>
                </div>
              ))}
            </div>
            <div className="report-actions">
              {entry.reportNames.length ? (
                <button className="primary small" onClick={() => props.onOpen(entry.replayId, entry.reportNames[0])}>Open report</button>
              ) : (
                <span className="muted">No report yet</span>
              )}
            </div>
          </article>
        ))}
      </div>
      {!props.library.entries.length ? (
        <div className="panel"><EmptyState title="Your library is empty" body="Analyze a replay to add it here." /></div>
      ) : null}
    </div>
  );
}

function McpView(props: {
  state: McpState;
  canStart: boolean;
  databasePath: string;
  busyAction: string | null;
  onStart: () => void;
  onStop: () => void;
  onOpenSettings: () => void;
}): React.JSX.Element {
  const active = ["starting", "running", "stopping"].includes(props.state.status);
  return (
    <div className="stack">
      <section className="mcp-hero panel">
        <div className="server-orb"><span /></div>
        <div>
          <p className="eyebrow">MODEL CONTEXT PROTOCOL</p>
          <h2>Local replay facts, on demand.</h2>
          <p>Expose the selected SQLite corpus through the existing deterministic MCP server.</p>
        </div>
        <div className="server-control">
          <span className={`state-pill state-${props.state.status}`}>{props.state.status}</span>
          {active ? (
            <button className="danger" onClick={props.onStop} disabled={props.state.status === "stopping" || props.busyAction === "mcp-stop"}>Stop server</button>
          ) : (
            <button className="primary" onClick={props.onStart} disabled={!props.canStart || props.busyAction === "mcp-start"}>Start server</button>
          )}
        </div>
      </section>

      {!props.canStart ? (
        <Notice tone="warning">
          MCP needs a valid runtime and an existing corpus database.{" "}
          <button className="link-button" onClick={props.onOpenSettings}>Review Settings</button>
        </Notice>
      ) : null}

      <div className="detail-grid">
        <Detail label="Endpoint" value={props.state.endpoint ?? "Starts after validation"} mono />
        <Detail label="Database" value={props.databasePath} mono />
        <Detail label="Process ID" value={props.state.pid ? String(props.state.pid) : "—"} />
        <Detail label="Started" value={props.state.startedAt ? formatDateTime(props.state.startedAt) : "—"} />
      </div>
      {props.state.error ? <ErrorBanner message={props.state.error} /> : null}
      <LogPanel title="MCP server log" logs={props.state.logs} />
    </div>
  );
}

function SettingsView(props: {
  runtimeMode: RuntimeMode;
  settings: AppSettings;
  validation: RuntimeValidation;
  busyAction: string | null;
  onChange: (settings: AppSettings) => void;
  onChooseRuntime: () => void;
  onChooseStarcraft: () => void;
  onChooseOutput: () => void;
  onChooseDatabase: () => void;
  onValidate: () => void;
  onSave: () => void;
}): React.JSX.Element {
  const update = <K extends keyof AppSettings>(key: K, value: AppSettings[K]): void => {
    props.onChange({ ...props.settings, [key]: value });
  };
  const isPackagedRuntime = props.runtimeMode === "packaged";
  return (
    <div className="settings-layout">
      <div className="stack">
        <section className="panel form-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">{isPackagedRuntime ? "APP FILES & STORAGE" : "FILES & STORAGE"}</p>
              <h2>{isPackagedRuntime ? "Installed app settings" : "App settings"}</h2>
            </div>
          </div>
          {isPackagedRuntime ? (
            <Field label="Built-in app files">
              <div className="path-input">
                <input value={props.settings.runtimeRoot} readOnly />
              </div>
            </Field>
          ) : (
            <PathField label="Project folder" value={props.settings.runtimeRoot} onChange={(value) => update("runtimeRoot", value)} onBrowse={props.onChooseRuntime} />
          )}
          <PathField
            label="StarCraft installation"
            value={props.settings.starcraftPath}
            onChange={(value) => update("starcraftPath", value)}
            onBrowse={props.onChooseStarcraft}
          />
          <PathField label="Where analyzed replays are saved" value={props.settings.outputRoot} onChange={(value) => update("outputRoot", value)} onBrowse={props.onChooseOutput} />
          <PathField label="Replay database" value={props.settings.databasePath} onChange={(value) => update("databasePath", value)} onBrowse={props.onChooseDatabase} />
          {isPackagedRuntime ? (
            <Notice tone="info">
              BW Forge includes the files it needs to run. The only thing you need separately is an installed copy of StarCraft: Brood War.
            </Notice>
          ) : null}
        </section>

        <section className="panel form-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">ANALYSIS</p>
              <h2>Replay analysis</h2>
            </div>
          </div>
          <div className="form-grid">
            <Field label="Playback speed during analysis">
              <input type="number" min={1} value={props.settings.replayExportSpeed} onChange={(event) => update("replayExportSpeed", Number(event.target.value))} />
            </Field>
            <label className="toggle-field">
              <input type="checkbox" checked={props.settings.keepSnapshots} onChange={(event) => update("keepSnapshots", event.target.checked)} />
              <span><strong>Save extra troubleshooting files</strong><small>Keep extra files that can help troubleshoot analysis problems.</small></span>
            </label>
          </div>
          {!isPackagedRuntime ? (
            <details>
              <summary>Developer executable overrides</summary>
              <div className="form-grid top-gap">
                <Field label="Bun executable"><input value={props.settings.bunExecutable} onChange={(event) => update("bunExecutable", event.target.value)} /></Field>
                <Field label="Node executable"><input value={props.settings.nodeExecutable} onChange={(event) => update("nodeExecutable", event.target.value)} /></Field>
                <Field label="pnpm executable"><input value={props.settings.pnpmExecutable} onChange={(event) => update("pnpmExecutable", event.target.value)} /></Field>
                <Field label="Python executable (blank = auto)"><input value={props.settings.pythonExecutable} onChange={(event) => update("pythonExecutable", event.target.value)} /></Field>
              </div>
            </details>
          ) : null}
        </section>

        <section className="panel form-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">MCP HTTP</p>
              <h2>Connection</h2>
            </div>
          </div>
          <div className="form-grid three">
            <Field label="Host"><input value={props.settings.mcpHost} onChange={(event) => update("mcpHost", event.target.value)} /></Field>
            <Field label="Port"><input type="number" min={1} max={65535} value={props.settings.mcpPort} onChange={(event) => update("mcpPort", Number(event.target.value))} /></Field>
            <Field label="Path"><input value={props.settings.mcpPath} onChange={(event) => update("mcpPath", event.target.value)} /></Field>
          </div>
        </section>

        {isPackagedRuntime ? (
          <section className="panel form-panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">WHAT BW FORGE HANDLES</p>
                <h2>What BW Forge handles</h2>
              </div>
            </div>
            <div className="detail-grid">
              <Detail label="Included with BW Forge" value="Replay analysis tools, report viewer, replay database, and advanced integrations" />
              <Detail label="You provide" value="An installed copy of StarCraft: Brood War" />
            </div>
          </section>
        ) : null}

        <div className="settings-actions">
          <button className="secondary" onClick={props.onValidate} disabled={props.busyAction === "validate"}>Check setup</button>
          <button className="primary" onClick={props.onSave} disabled={props.busyAction === "save-settings"}>{props.busyAction === "save-settings" ? "Saving…" : "Save changes"}</button>
        </div>
      </div>

      <aside className="check-panel panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">{isPackagedRuntime ? "APP HEALTH" : "WHAT'S NEEDED"}</p>
            <h2>{isPackagedRuntime ? "Built-in app files status" : "Setup status"}</h2>
          </div>
        </div>
        <div className="check-list">
          {props.validation.checks.map((check) => (
            <div className={`check-row check-${check.status}`} key={check.id}>
              <StatusDot status={check.status === "pass" ? "ready" : check.status === "fail" ? "blocked" : "working"} />
              <div>
                <strong>{check.label}</strong>
                <span>{check.detail}</span>
                {check.remediation ? <small>{check.remediation}</small> : null}
              </div>
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}

function NavButton(props: { active: boolean; highlight?: boolean; onClick: () => void; label: string; meta: string }): React.JSX.Element {
  return <button className={["nav-button", props.active ? "active" : "", props.highlight ? "nav-button-highlight" : ""].filter(Boolean).join(" ")} onClick={props.onClick}><span>{props.label}{props.highlight ? <em className="nav-button-new">New</em> : null}</span><small>{props.meta}</small></button>;
}

function Notice(props: { tone: "warning" | "info"; children: React.ReactNode }): React.JSX.Element {
  return <div className={`notice notice-${props.tone}`}>{props.children}</div>;
}

function ErrorBanner(props: { message: string; onDismiss?: () => void }): React.JSX.Element {
  return <div className="error-banner" role="alert"><span>{props.message}</span>{props.onDismiss ? <button onClick={props.onDismiss} aria-label="Dismiss error">×</button> : null}</div>;
}

function EmptyState(props: { title: string; body: string }): React.JSX.Element {
  return <div className="empty-state"><div className="empty-symbol">+</div><strong>{props.title}</strong><span>{props.body}</span></div>;
}

function Metric(props: { value: number; label: string }): React.JSX.Element {
  return <div className="metric"><strong>{props.value}</strong><span>{props.label}</span></div>;
}

function ProgressBar(props: {
  label: string;
  percent: number | null;
  compact?: boolean;
}): React.JSX.Element {
  const className = [
    "progress-track",
    props.compact ? "progress-track-compact" : "",
    props.percent === null ? "progress-track-indeterminate" : ""
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={className} aria-label={props.label}>
      <div style={props.percent === null ? undefined : { width: `${props.percent}%` }} />
    </div>
  );
}

function StatusDot(props: { status: "ready" | "blocked" | "working" }): React.JSX.Element {
  return <span className={`status-dot status-${props.status}`} aria-hidden="true" />;
}

function LogPanel(props: {
  title: string;
  logs: AnalysisRunState["logs"] | McpState["logs"];
  collapsedByDefault?: boolean;
}): React.JSX.Element {
  const visibleLogs = props.logs.slice(-250);
  if (props.collapsedByDefault) {
    return (
      <details className="panel log-panel">
        <summary className="panel-heading log-summary">
          <div><p className="eyebrow">DETAILS</p><h2>{props.title}</h2></div>
          <span className="muted">{props.logs.length} lines</span>
        </summary>
        <div className="logs" role="log" aria-live="polite">
          {visibleLogs.map((log) => <div className={`log-line log-${log.stream}`} key={log.id}><time>{formatTime(log.timestamp)}</time><span>{log.source}</span><code>{log.message}</code></div>)}
          {!visibleLogs.length ? <span className="muted">Progress details will appear here.</span> : null}
        </div>
      </details>
    );
  }
  return (
    <section className="panel log-panel">
      <div className="panel-heading"><div><p className="eyebrow">DETAILS</p><h2>{props.title}</h2></div><span className="muted">{props.logs.length} lines</span></div>
      <div className="logs" role="log" aria-live="polite">
        {visibleLogs.map((log) => <div className={`log-line log-${log.stream}`} key={log.id}><time>{formatTime(log.timestamp)}</time><span>{log.source}</span><code>{log.message}</code></div>)}
        {!visibleLogs.length ? <span className="muted">Progress details will appear here.</span> : null}
      </div>
    </section>
  );
}

function Detail(props: { label: string; value: string; mono?: boolean }): React.JSX.Element {
  return <div className="detail"><span>{props.label}</span><strong className={props.mono ? "mono" : ""}>{props.value}</strong></div>;
}

function Field(props: { label: string; children: React.ReactNode }): React.JSX.Element {
  return <label className="field"><span>{props.label}</span>{props.children}</label>;
}

function PathField(props: { label: string; value: string; onChange: (value: string) => void; onBrowse: () => void }): React.JSX.Element {
  return <Field label={props.label}><div className="path-input"><input value={props.value} onChange={(event) => props.onChange(event.target.value)} /><button className="quiet" type="button" onClick={props.onBrowse}>Browse</button></div></Field>;
}

function uniquePaths(paths: string[]): string[] {
  const values = new Map<string, string>();
  for (const path of paths) values.set(path.toLowerCase(), path);
  return [...values.values()].sort((left, right) => left.localeCompare(right));
}

function fileName(path: string): string {
  return path.split(/[\\/]/u).pop() ?? path;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value));
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(new Date(value));
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return "Unknown duration";
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.round(seconds % 60);
  return `${minutes}:${String(remaining).padStart(2, "0")}`;
}

function runLabel(status: AnalysisRunState["status"]): string {
  const labels: Record<AnalysisRunState["status"], string> = {
    idle: "Ready to start",
    running: "Analyzing replays",
    ingesting: "Updating replay database",
    cancelling: "Stopping safely",
    succeeded: "Finished",
    partial: "Finished with some problems",
    failed: "Analysis failed",
    cancelled: "Run cancelled"
  };
  return labels[status];
}

function viewTitle(view: View): string {
  return { analyze: "Analyze replays", library: "Replay library", mcp: "MCP server", settings: "Settings" }[view];
}

import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type {
  AnalysisRunState,
  AnalysisStartRequest,
  AppSettings,
  ProcessLogEntry,
  ReplayJob
} from "../shared/contracts";
import { buildAnalyzeCommand, buildIngestCommand } from "./commands";
import {
  startChildProcess,
  type ChildProcessStarter,
  type RunningChild
} from "./child-process-runner";

const MAX_LOG_ENTRIES = 2_000;

export interface AnalysisManagerOptions {
  getSettings: () => AppSettings;
  onUpdate: (state: AnalysisRunState) => void;
  refreshLibrary: () => Promise<void>;
  startProcess?: ChildProcessStarter;
}

export class AnalysisManager {
  private state: AnalysisRunState = createIdleState();
  private activeChild: RunningChild | null = null;
  private cancelRequested = false;
  private logId = 0;
  private readonly startProcess: ChildProcessStarter;

  constructor(private readonly options: AnalysisManagerOptions) {
    this.startProcess = options.startProcess ?? startChildProcess;
  }

  snapshot(): AnalysisRunState {
    return structuredClone(this.state);
  }

  start(request: AnalysisStartRequest): AnalysisRunState {
    if (this.isActive()) {
      throw new Error("An analysis run is already active.");
    }
    if (!request.replayPaths.length) {
      throw new Error("Select at least one replay before starting analysis.");
    }

    const now = new Date().toISOString();
    this.cancelRequested = false;
    this.state = {
      runId: randomUUID(),
      status: "running",
      startedAt: now,
      jobs: request.replayPaths.map((replayPath) => ({
        id: randomUUID(),
        replayPath,
        filename: basename(replayPath),
        status: "queued"
      })),
      logs: []
    };
    this.addLog("system", "info", `Queued ${this.state.jobs.length} replay(s).`);
    this.emit();
    void this.execute();
    return this.snapshot();
  }

  async cancel(): Promise<AnalysisRunState> {
    if (!this.isActive()) {
      return this.snapshot();
    }
    this.cancelRequested = true;
    this.state.status = "cancelling";
    this.addLog("system", "info", "Cancellation requested.");
    for (const job of this.state.jobs) {
      if (job.status === "queued") {
        job.status = "cancelled";
        job.finishedAt = new Date().toISOString();
      }
    }
    this.emit();
    await this.activeChild?.terminate();
    return this.snapshot();
  }

  async dispose(): Promise<void> {
    this.cancelRequested = true;
    await this.activeChild?.terminate();
  }

  private async execute(): Promise<void> {
    const settings = this.options.getSettings();
    for (const job of this.state.jobs) {
      if (this.cancelRequested) {
        break;
      }
      await this.runReplay(job, settings);
    }

    if (this.cancelRequested) {
      this.finishCancelled();
      return;
    }

    const succeeded = this.state.jobs.filter((job) => job.status === "succeeded").length;
    if (succeeded === 0) {
      this.state.status = "failed";
      this.state.finishedAt = new Date().toISOString();
      this.state.error = "No replay analysis completed successfully; ingestion was not started.";
      this.addLog("system", "stderr", this.state.error);
      this.emit();
      return;
    }

    await this.runIngest(settings);
  }

  private async runReplay(job: ReplayJob, settings: AppSettings): Promise<void> {
    job.status = "running";
    job.startedAt = new Date().toISOString();
    this.addLog("analyze", "info", `Analyzing ${job.filename}`, job.replayPath);
    this.emit();

    const command = buildAnalyzeCommand(settings, job.replayPath);
    this.activeChild = this.startProcess(command, (output) => {
      this.addLog("analyze", output.stream, output.message, job.replayPath);
      this.emit();
    });
    const result = await this.activeChild.completion;
    this.activeChild = null;

    job.finishedAt = new Date().toISOString();
    job.exitCode = result.code;
    if (this.cancelRequested) {
      job.status = "cancelled";
      this.addLog("analyze", "info", `Cancelled ${job.filename}`, job.replayPath);
    } else if (result.spawnError) {
      job.status = "failed";
      job.error = result.spawnError;
      this.addLog("analyze", "stderr", result.spawnError, job.replayPath);
    } else if (result.code === 0) {
      job.status = "succeeded";
      this.addLog("analyze", "info", `Completed ${job.filename}`, job.replayPath);
    } else {
      job.status = "failed";
      job.error = `Analysis exited with code ${String(result.code)}${result.signal ? ` (${result.signal})` : ""}.`;
      this.addLog("analyze", "stderr", job.error, job.replayPath);
    }
    this.emit();
  }

  private async runIngest(settings: AppSettings): Promise<void> {
    this.state.status = "ingesting";
    this.addLog("ingest", "info", "Ingesting analyzed replay output into the corpus.");
    this.emit();

    const command = buildIngestCommand(settings);
    this.activeChild = this.startProcess(command, (output) => {
      this.addLog("ingest", output.stream, output.message);
      this.emit();
    });
    const result = await this.activeChild.completion;
    this.activeChild = null;
    this.state.ingestExitCode = result.code;

    if (this.cancelRequested) {
      this.finishCancelled();
      return;
    }
    if (result.spawnError || result.code !== 0) {
      this.state.status = "failed";
      this.state.error =
        result.spawnError ??
        `Corpus ingestion exited with code ${String(result.code)}${result.signal ? ` (${result.signal})` : ""}.`;
      this.addLog("ingest", "stderr", this.state.error);
    } else {
      const failed = this.state.jobs.filter((job) => job.status === "failed").length;
      this.state.status = failed > 0 ? "partial" : "succeeded";
      this.addLog(
        "ingest",
        "info",
        failed > 0
          ? `Corpus ingestion completed with ${failed} replay failure(s).`
          : "Corpus ingestion completed."
      );
      try {
        await this.options.refreshLibrary();
      } catch (error) {
        this.addLog("system", "stderr", `Library refresh failed: ${formatError(error)}`);
      }
    }
    this.state.finishedAt = new Date().toISOString();
    this.emit();
  }

  private finishCancelled(): void {
    for (const job of this.state.jobs) {
      if (job.status === "queued" || job.status === "running") {
        job.status = "cancelled";
        job.finishedAt = new Date().toISOString();
      }
    }
    this.state.status = "cancelled";
    this.state.finishedAt = new Date().toISOString();
    this.addLog("system", "info", "Analysis run cancelled.");
    this.emit();
  }

  private isActive(): boolean {
    return ["running", "ingesting", "cancelling"].includes(this.state.status);
  }

  private addLog(
    source: ProcessLogEntry["source"],
    stream: ProcessLogEntry["stream"],
    message: string,
    replayPath?: string
  ): void {
    const entry: ProcessLogEntry = {
      id: ++this.logId,
      timestamp: new Date().toISOString(),
      source,
      stream,
      message,
      ...(replayPath ? { replayPath } : {})
    };
    this.state.logs.push(entry);
    if (this.state.logs.length > MAX_LOG_ENTRIES) {
      this.state.logs.splice(0, this.state.logs.length - MAX_LOG_ENTRIES);
    }
  }

  private emit(): void {
    this.options.onUpdate(this.snapshot());
  }
}

function createIdleState(): AnalysisRunState {
  return {
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
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

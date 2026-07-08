import type {
  AppSettings,
  McpState,
  ProcessLogEntry
} from "../shared/contracts";
import { buildMcpCommand, mcpEndpoint } from "./commands";
import {
  startChildProcess,
  type ChildProcessStarter,
  type RunningChild
} from "./child-process-runner";

const MAX_MCP_LOG_ENTRIES = 1_000;

export interface McpManagerOptions {
  getSettings: () => AppSettings;
  onUpdate: (state: McpState) => void;
  startProcess?: ChildProcessStarter;
}

export class McpManager {
  private state: McpState = { status: "stopped", logs: [] };
  private child: RunningChild | null = null;
  private stopRequested = false;
  private logId = 0;
  private readonly startProcess: ChildProcessStarter;

  constructor(private readonly options: McpManagerOptions) {
    this.startProcess = options.startProcess ?? startChildProcess;
  }

  snapshot(): McpState {
    return structuredClone(this.state);
  }

  start(): McpState {
    if (this.child || ["starting", "running", "stopping"].includes(this.state.status)) {
      throw new Error("The MCP server is already running or changing state.");
    }
    const settings = this.options.getSettings();
    this.stopRequested = false;
    this.state = {
      status: "starting",
      endpoint: mcpEndpoint(settings),
      startedAt: new Date().toISOString(),
      logs: []
    };
    this.addLog("info", `Starting MCP at ${this.state.endpoint}`);
    this.emit();

    const command = buildMcpCommand(settings);
    this.child = this.startProcess(command, (output) => {
      this.addLog(output.stream, output.message);
      this.emit();
    });
    this.state.status = "running";
    if (this.child.pid) {
      this.state.pid = this.child.pid;
    }
    this.emit();
    void this.watchChild(this.child);
    return this.snapshot();
  }

  async stop(): Promise<McpState> {
    if (!this.child) {
      this.state.status = "stopped";
      this.emit();
      return this.snapshot();
    }
    this.stopRequested = true;
    this.state.status = "stopping";
    this.addLog("info", "Stopping MCP server.");
    this.emit();
    const child = this.child;
    await child.terminate();
    await child.completion;
    return this.snapshot();
  }

  async dispose(): Promise<void> {
    this.stopRequested = true;
    await this.child?.terminate();
  }

  private async watchChild(child: RunningChild): Promise<void> {
    const result = await child.completion;
    if (this.child !== child) {
      return;
    }
    this.child = null;
    this.state.pid = undefined;
    this.state.exitCode = result.code;
    this.state.stoppedAt = new Date().toISOString();
    if (this.stopRequested) {
      this.state.status = "stopped";
      this.addLog("info", "MCP server stopped.");
    } else {
      this.state.status = "failed";
      this.state.error =
        result.spawnError ??
        `MCP server exited with code ${String(result.code)}${result.signal ? ` (${result.signal})` : ""}.`;
      this.addLog("stderr", this.state.error);
    }
    this.emit();
  }

  private addLog(stream: ProcessLogEntry["stream"], message: string): void {
    this.state.logs.push({
      id: ++this.logId,
      timestamp: new Date().toISOString(),
      source: "mcp",
      stream,
      message
    });
    if (this.state.logs.length > MAX_MCP_LOG_ENTRIES) {
      this.state.logs.splice(0, this.state.logs.length - MAX_MCP_LOG_ENTRIES);
    }
  }

  private emit(): void {
    this.options.onUpdate(this.snapshot());
  }
}

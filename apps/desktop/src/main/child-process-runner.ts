import { spawn, type ChildProcess } from "node:child_process";
import type { ChildCommand } from "./commands";

export interface ChildOutput {
  stream: "stdout" | "stderr";
  message: string;
}

export interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  spawnError?: string;
}

export interface RunningChild {
  pid?: number;
  completion: Promise<ChildResult>;
  terminate(): Promise<void>;
}

export type ChildProcessStarter = (
  command: ChildCommand,
  onOutput: (output: ChildOutput) => void
) => RunningChild;

export const startChildProcess: ChildProcessStarter = (command, onOutput) => {
  const child = spawn(command.command, command.args, {
    cwd: command.cwd,
    env: command.env,
    windowsHide: true,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let exited = false;
  let resolveCompletion: (result: ChildResult) => void;
  const completion = new Promise<ChildResult>((resolvePromise) => {
    resolveCompletion = resolvePromise;
  });
  const stdout = createLineCollector("stdout", onOutput);
  const stderr = createLineCollector("stderr", onOutput);
  child.stdout.on("data", stdout.push);
  child.stderr.on("data", stderr.push);

  child.once("error", (error) => {
    if (exited) {
      return;
    }
    exited = true;
    stdout.flush();
    stderr.flush();
    resolveCompletion({
      code: null,
      signal: null,
      spawnError: formatSpawnError(command.command, error)
    });
  });
  child.once("close", (code, signal) => {
    if (exited) {
      return;
    }
    exited = true;
    stdout.flush();
    stderr.flush();
    resolveCompletion({ code, signal });
  });

  return {
    pid: child.pid,
    completion,
    terminate: async () => terminateOwnedProcess(child, () => exited)
  };
};

function createLineCollector(
  stream: "stdout" | "stderr",
  onOutput: (output: ChildOutput) => void
): { push: (chunk: Buffer) => void; flush: () => void } {
  let buffered = "";
  const emitLines = (flush: boolean): void => {
    const lines = buffered.split(/\r?\n/u);
    buffered = flush ? "" : (lines.pop() ?? "");
    for (const line of lines) {
      if (line.trim()) {
        onOutput({ stream, message: line });
      }
    }
    if (flush && buffered.trim()) {
      onOutput({ stream, message: buffered });
      buffered = "";
    }
  };
  return {
    push: (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      emitLines(false);
    },
    flush: () => emitLines(true)
  };
}

async function terminateOwnedProcess(
  child: Pick<ChildProcess, "kill" | "pid">,
  hasExited: () => boolean
): Promise<void> {
  if (hasExited()) {
    return;
  }
  if (process.platform === "win32" && child.pid) {
    await runTaskkill(child.pid);
    await waitForExit(hasExited, 1_500);
    return;
  }
  child.kill("SIGTERM");
  const exitedNormally = await waitForExit(hasExited, 1_500);
  if (exitedNormally || hasExited()) {
    return;
  }

  child.kill("SIGKILL");
  await waitForExit(hasExited, 1_000);
}

function waitForExit(hasExited: () => boolean, timeoutMs: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const deadline = Date.now() + timeoutMs;
    const interval = setInterval(() => {
      if (hasExited() || Date.now() >= deadline) {
        clearInterval(interval);
        resolvePromise(hasExited());
      }
    }, 50);
  });
}

function runTaskkill(pid: number): Promise<void> {
  return new Promise((resolvePromise) => {
    const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      shell: false,
      stdio: "ignore"
    });
    killer.once("error", () => resolvePromise());
    killer.once("close", () => resolvePromise());
  });
}

function formatSpawnError(executable: string, error: Error): string {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") {
    return `${executable} was not found. Check the executable setting and PATH. ${error.message}`;
  }
  return `${executable} could not be started: ${error.message}`;
}

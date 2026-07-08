import { spawn } from "node:child_process";

export interface RunningStarcraftProcess {
  pid: number;
  imageName: string;
}

export type TasklistRunner = () => Promise<string>;

export async function assertNoRunningStarcraftProcess(
  runTasklist: TasklistRunner = defaultTasklistRunner
): Promise<void> {
  const processes = await listRunningStarcraftProcesses(runTasklist);
  if (!processes.length) {
    return;
  }

  throw new Error(
    "Close StarCraft before starting analysis. BW Forge needs to start its own copy of the game."
  );
}

export async function listRunningStarcraftProcesses(
  runTasklist: TasklistRunner = defaultTasklistRunner
): Promise<RunningStarcraftProcess[]> {
  if (process.platform !== "win32") {
    return [];
  }

  const output = await runTasklist();
  return parseTasklistCsv(output);
}

export function parseTasklistCsv(output: string): RunningStarcraftProcess[] {
  const trimmed = output.trim();
  if (!trimmed || /^info:/iu.test(trimmed)) {
    return [];
  }

  return trimmed
    .split(/\r?\n/u)
    .map((line) => parseCsvLine(line))
    .filter((columns) => columns.length >= 2)
    .map(([imageName, pid]) => ({
      imageName,
      pid: Number.parseInt(pid, 10)
    }))
    .filter((processInfo) => processInfo.imageName.toLowerCase() === "starcraft.exe")
    .filter((processInfo) => Number.isInteger(processInfo.pid) && processInfo.pid > 0);
}

function defaultTasklistRunner(): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      "tasklist.exe",
      ["/FI", "IMAGENAME eq StarCraft.exe", "/FO", "CSV", "/NH"],
      {
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"]
      }
    );

    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.once("error", rejectPromise);
    child.once("close", (code) => {
      if (code === 0) {
        resolvePromise(output);
      } else {
        rejectPromise(new Error(`tasklist exited with code ${String(code)}`));
      }
    });
  });
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      values.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  values.push(current);
  return values.map((value) => value.trim());
}

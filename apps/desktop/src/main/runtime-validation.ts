import { access, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import type {
  AppSettings,
  RuntimeCheck,
  RuntimeValidation
} from "../shared/contracts";
import { validateDatabasePath, validateOutputRoot } from "./path-policy";
import { resolveRuntimeLayout } from "./runtime-layout";
import { validateStarcraftInstall } from "./starcraft-install";

export interface ExecutableProbe {
  executable: string;
  args: string[];
  cwd: string;
}

export type ProbeExecutable = (probe: ExecutableProbe) => Promise<string>;

export async function validateRuntime(
  settings: AppSettings,
  probeExecutable: ProbeExecutable = defaultProbeExecutable
): Promise<RuntimeValidation> {
  const checks: RuntimeCheck[] = [];
  const layout = resolveRuntimeLayout(settings.runtimeRoot);
  checks.push(
    process.platform === "win32"
      ? pass("platform", "Windows", "Replay analysis works on Windows.")
      : fail(
          "platform",
          "Windows",
          `Current platform is ${process.platform}. Replay analysis requires Windows.`,
          "Run the desktop application on Windows."
        )
  );

  const runtimeRoot = resolve(settings.runtimeRoot);
  checks.push(await checkStarcraftPath(settings.starcraftPath));
  checks.push(
    await checkPath(
      "runtime-root",
      layout.kind === "packaged" ? "Built-in app files" : "Project folder",
      runtimeRoot,
      layout.kind === "packaged"
        ? "The app's built-in files are missing. Reinstall BW Forge."
        : "Choose the project folder in Settings."
    )
  );
  if (layout.kind === "packaged") {
    checks.push(
      await checkPath(
        "runtime-manifest",
        "Built-in app files list",
        layout.manifestPath,
        "A required app file list is missing. Reinstall BW Forge."
      )
    );
    checks.push(
      await checkPath(
        "cli-entrypoint",
        "Main analysis program",
        layout.cliEntrypoint,
        "A required analysis file is missing. Reinstall BW Forge."
      )
    );
    checks.push(
      await checkPath(
        "corpus-runtime",
        "Replay database tools",
        layout.corpusCliEntrypoint,
        "Required replay database files are missing. Reinstall BW Forge."
      )
    );
    checks.push(
      await checkPath(
        "python-runtime",
        "Built-in Python",
        layout.pythonExecutable,
        "Built-in Python files are missing. Reinstall BW Forge."
      )
    );
    checks.push(
      await checkPath(
        "replay-reducer",
        "Replay analysis helper",
        layout.replayReducerScript,
        "A required replay analysis helper file is missing. Reinstall BW Forge."
      )
    );
    checks.push(
      await checkPath(
        "report-template",
        "Report template",
        layout.reportTemplate,
        "A required report file is missing. Reinstall BW Forge."
      )
    );
    checks.push(
      await checkPath(
        "shieldbattery-engine",
        "Replay playback engine",
        layout.replayEngineExecutable,
        "A required replay playback file is missing. Reinstall BW Forge."
      )
    );
    checks.push(
      await checkExecutable(
        "packaged-cli-self-check",
        "Built-in analysis check",
        {
          executable: process.execPath,
          args: [layout.cliEntrypoint],
          cwd: runtimeRoot
        },
        withExtraEnv(
          probeExecutable,
          {
            ELECTRON_RUN_AS_NODE: "1",
            BW_FORGE_RUNTIME_KIND: "packaged",
            BW_FORGE_NODE: process.execPath,
            BW_FORGE_PYTHON: layout.pythonExecutable,
            BW_FORGE_REPLAY_ENGINE_EXE: layout.replayEngineExecutable,
            BW_FORGE_REPLAY_ENGINE_CWD: layout.replayEngineWorkingDirectory
          }
        ),
        "The built-in analysis tools could not start. Reinstall BW Forge."
      )
    );
    checks.push(
      await checkExecutable(
        "python",
        "Built-in Python",
        { executable: layout.pythonExecutable, args: ["--version"], cwd: runtimeRoot },
        probeExecutable,
        "Built-in Python could not start. Reinstall BW Forge."
      )
    );
  } else {
    checks.push(
      await checkPath(
        "cli-entrypoint",
        "Main analysis program",
        layout.cliEntrypoint,
        "The project folder must contain apps/cli/src/main.ts."
      )
    );
    checks.push(
      await checkPath(
        "shieldbattery",
        "Replay playback engine",
        join(runtimeRoot, "third_party", "shieldbattery", "package.json"),
        "Set up the full bw-forge checkout, including third_party/shieldbattery."
      )
    );
    checks.push(
      await checkPath(
        "shieldbattery-dependencies",
        "Replay playback dependencies",
        join(runtimeRoot, "third_party", "shieldbattery", "node_modules"),
        "Run pnpm install in third_party/shieldbattery and its app workspace."
      )
    );
    checks.push(
      await checkPath(
        "corpus-runtime",
        "Replay database tools",
        join(runtimeRoot, "packages", "corpus-query", "node_modules", "tsx", "dist", "cli.mjs"),
        "Run pnpm install in packages/corpus-query."
      )
    );

    checks.push(
      await checkExecutable(
        "bun",
        "Bun",
        { executable: settings.bunExecutable, args: ["--version"], cwd: runtimeRoot },
        probeExecutable,
        "Install Bun or configure its executable in Settings."
      )
    );
    checks.push(
      await checkExecutable(
        "node",
        "Node.js",
        { executable: settings.nodeExecutable, args: ["--version"], cwd: runtimeRoot },
        probeExecutable,
        "Install Node.js 24 or configure its executable in Settings."
      )
    );
    checks.push(
      await checkExecutable(
        "pnpm",
        "pnpm",
        {
          executable: settings.pnpmExecutable,
          args: ["--version"],
          cwd: join(runtimeRoot, "third_party", "shieldbattery")
        },
        probeExecutable,
        "Install pnpm/Corepack or configure the pnpm executable in Settings."
      )
    );
    checks.push(await checkPython(settings, runtimeRoot, probeExecutable));
  }

  const outputValidation = validateOutputRoot(settings.outputRoot, runtimeRoot);
  checks.push(
    outputValidation.valid
      ? pass("output-path", "Saved replay location", resolve(settings.outputRoot))
      : fail(
          "output-path",
          "Saved replay location",
          outputValidation.message ?? "Invalid output directory.",
          "Choose a folder outside the app or project files."
        )
  );
  const databaseValidation = validateDatabasePath(settings.databasePath, runtimeRoot);
  checks.push(
    databaseValidation.valid
      ? pass("database-path", "Replay database", resolve(settings.databasePath))
      : fail(
          "database-path",
          "Replay database",
          databaseValidation.message ?? "Invalid database path.",
          "Choose a database file outside the app or project files."
        )
  );

  checks.push(await checkDatabase(settings.databasePath));

  const requiredAnalyzeChecks = new Set([
    "platform",
    "starcraft-install",
    "runtime-root",
    "cli-entrypoint",
    "corpus-runtime",
    "python",
    "output-path",
    "database-path",
    ...(layout.kind === "packaged"
      ? ["runtime-manifest", "replay-reducer", "report-template", "shieldbattery-engine", "packaged-cli-self-check"]
      : ["shieldbattery", "shieldbattery-dependencies", "bun", "node", "pnpm", "node"])
  ]);
  const requiredIngestChecks = new Set([
    "runtime-root",
    "cli-entrypoint",
    "corpus-runtime",
    "output-path",
    "database-path",
    ...(layout.kind === "packaged"
      ? ["runtime-manifest", "packaged-cli-self-check"]
      : ["bun", "node"])
  ]);
  return {
    checkedAt: new Date().toISOString(),
    canAnalyze: noFailures(checks, requiredAnalyzeChecks),
    canIngest: noFailures(checks, requiredIngestChecks),
    canStartMcp:
      noFailures(checks, requiredIngestChecks) &&
      checks.find((check) => check.id === "database-exists")?.status === "pass",
    checks
  };
}

async function checkPath(
  id: string,
  label: string,
  pathValue: string,
  remediation: string
): Promise<RuntimeCheck> {
  try {
    await access(pathValue);
    return pass(id, label, pathValue);
  } catch {
    return fail(id, label, `Missing: ${pathValue}`, remediation);
  }
}

async function checkExecutable(
  id: string,
  label: string,
  probe: ExecutableProbe,
  probeExecutable: ProbeExecutable,
  remediation: string
): Promise<RuntimeCheck> {
  try {
    const version = await probeExecutable(probe);
    return pass(id, label, version || probe.executable);
  } catch (error) {
    return fail(
      id,
      label,
      `${probe.executable} could not be executed: ${formatError(error)}`,
      remediation
    );
  }
}

async function checkPython(
  settings: AppSettings,
  runtimeRoot: string,
  probeExecutable: ProbeExecutable
): Promise<RuntimeCheck> {
  const probes: ExecutableProbe[] = settings.pythonExecutable
    ? [{ executable: settings.pythonExecutable, args: ["--version"], cwd: runtimeRoot }]
    : process.platform === "win32"
      ? [
          { executable: "py", args: ["-3", "--version"], cwd: runtimeRoot },
          { executable: "python", args: ["--version"], cwd: runtimeRoot },
          { executable: "python3", args: ["--version"], cwd: runtimeRoot }
        ]
      : [
          { executable: "python3", args: ["--version"], cwd: runtimeRoot },
          { executable: "python", args: ["--version"], cwd: runtimeRoot }
        ];

  for (const probe of probes) {
    try {
      const version = await probeExecutable(probe);
      return pass("python", "Python 3", version || probe.executable);
    } catch {
      // Try the next supported command.
    }
  }
  return fail(
    "python",
    "Python 3",
    "No supported Python 3 command could be executed.",
    "Install Python 3 or configure its executable in Settings."
  );
}

async function checkDatabase(databasePath: string): Promise<RuntimeCheck> {
  try {
    const fileStats = await stat(databasePath);
    return fileStats.isFile()
      ? pass("database-exists", "Replay database", resolve(databasePath))
      : warning("database-exists", "Replay database", "The selected path is not a file.");
  } catch {
    return warning(
      "database-exists",
      "Replay database",
      "No replay database exists yet. Analyze replays first before starting MCP."
    );
  }
}

async function checkStarcraftPath(starcraftPath: string): Promise<RuntimeCheck> {
  const trimmedPath = starcraftPath.trim();
  if (!trimmedPath) {
    return fail(
      "starcraft-install",
      "StarCraft installation",
      "No StarCraft: Brood War installation directory is configured.",
      "Choose your StarCraft folder in Settings."
    );
  }

  const validation = await validateStarcraftInstall(trimmedPath);
  if (validation.valid) {
    return pass("starcraft-install", "StarCraft installation", resolve(trimmedPath));
  }

  return fail(
    "starcraft-install",
    "StarCraft installation",
    `Missing required game files under ${resolve(trimmedPath)}: ${validation.missingFiles.join(", ")}`,
    "Choose the folder that contains x86\\StarCraft.exe and x86\\clientsdk.dll."
  );
}

function noFailures(checks: RuntimeCheck[], requiredIds: Set<string>): boolean {
  return checks.every((check) => !requiredIds.has(check.id) || check.status !== "fail");
}

function pass(id: string, label: string, detail: string): RuntimeCheck {
  return { id, label, status: "pass", detail };
}

function warning(id: string, label: string, detail: string): RuntimeCheck {
  return { id, label, status: "warning", detail };
}

function fail(
  id: string,
  label: string,
  detail: string,
  remediation: string
): RuntimeCheck {
  return { id, label, status: "fail", detail, remediation };
}

function defaultProbeExecutable(probe: ExecutableProbe): Promise<string> {
  return probeExecutableWithEnv(probe, {});
}

function probeExecutableWithEnv(
  probe: ExecutableProbe,
  extraEnv: NodeJS.ProcessEnv
): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const isWindowsScript =
      process.platform === "win32" && /\.(?:cmd|bat)$/iu.test(probe.executable);
    const executable = isWindowsScript ? "where.exe" : probe.executable;
    const args = isWindowsScript ? [probe.executable] : probe.args;
    const child = spawn(executable, args, {
      cwd: probe.cwd,
      env: {
        ...process.env,
        ...extraEnv
      },
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    const timeout = setTimeout(() => {
      child.kill();
      rejectPromise(new Error("version check timed out"));
    }, 5_000);
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectPromise(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolvePromise(output.trim());
      } else {
        rejectPromise(new Error(`exited with code ${String(code)}`));
      }
    });
  });
}

function withExtraEnv(
  probeExecutable: ProbeExecutable,
  extraEnv: NodeJS.ProcessEnv
): ProbeExecutable {
  return (probe) => {
    if (probeExecutable === defaultProbeExecutable) {
      return probeExecutableWithEnv(probe, extraEnv);
    }
    return probeExecutable(probe);
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

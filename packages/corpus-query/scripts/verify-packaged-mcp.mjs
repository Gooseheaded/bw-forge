import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { exec, execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const tarballArg = process.argv[2];
const tarballPath = tarballArg ? resolve(tarballArg) : await findLatestTarball();
const smokeRoot = resolve(".pack-smoke");
await mkdir(smokeRoot, { recursive: true });
const installRoot = await mkdtemp(join(smokeRoot, "pkg-"));

try {
  const installer = await runPackageInstall(tarballPath, installRoot);

  const packagedBinary = process.platform === "win32"
    ? join(installRoot, "node_modules", ".bin", "bw-replays-mcp.cmd")
    : join(installRoot, "node_modules", ".bin", "bw-replays-mcp");

  const transport = new StdioClientTransport(
    process.platform === "win32"
      ? {
          command: getWindowsCommandPath("cmd.exe", process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe"),
          args: ["/d", "/s", "/c", packagedBinary],
          cwd: installRoot,
          stderr: "pipe"
        }
      : {
          command: packagedBinary,
          args: [],
          cwd: installRoot,
          stderr: "pipe"
        }
  );
  const client = new Client({ name: "packaged-smoke-test", version: "1.0.0" }, { capabilities: {} });

  await client.connect(transport);
  try {
    const tools = await client.listTools();
    const infoResult = await client.callTool({
      name: "server_info",
      arguments: {}
    });

    const text = infoResult.content[0]?.type === "text" ? infoResult.content[0].text : "";
    console.log(
      JSON.stringify(
        {
          tarball_path: tarballPath,
          install_root: installRoot,
          installer,
          binary: packagedBinary,
          tool_count: tools.tools.length,
          server_info: infoResult.structuredContent,
          server_info_text: text
        },
        null,
        2
      )
    );
  } finally {
    await client.close();
  }
} finally {
  await cleanupInstallRoot(installRoot);
}

async function findLatestTarball() {
  const entries = await readdir(resolve("."));
  const tarballs = entries.filter((entry) => entry.endsWith(".tgz")).sort();
  const latest = tarballs.at(-1);
  if (!latest) {
    throw new Error("No .tgz tarball found in the current directory. Run `pnpm pack` first or pass a tarball path.");
  }
  return resolve(latest);
}

async function runPackageInstall(tarballPath, installRoot) {
  await writeFile(
    join(installRoot, "package.json"),
    JSON.stringify({
      name: "packaged-smoke-temp",
      private: true,
      version: "0.0.0"
    }, null, 2) + "\n",
    "utf8"
  );

  try {
    await installWithPnpmOffline(tarballPath, installRoot);
    return "pnpm-offline";
  } catch (error) {
    if (!shouldFallbackToNpm(error)) {
      throw error;
    }
  }

  await installWithNpm(tarballPath, installRoot);
  return "npm";
}

async function installWithNpm(tarballPath, installRoot) {
  if (process.platform === "win32") {
    await execFileAsync(getWindowsCommandPath("cmd.exe", process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe"), ["/d", "/s", "/c", "npm", "install", tarballPath], {
      cwd: installRoot
    });
    return;
  }

  await execFileAsync("npm", ["install", tarballPath], {
    cwd: installRoot
  });
}

async function installWithPnpmOffline(tarballPath, installRoot) {
  if (process.platform === "win32") {
    await execAsync(`"C:\\Program Files\\nodejs\\pnpm.cmd" add "${tarballPath}" --offline`, {
      cwd: installRoot
    });
    return;
  }

  await execFileAsync("pnpm", ["add", tarballPath, "--offline"], {
    cwd: installRoot
  });
}

function shouldFallbackToNpm(error) {
  if (!error || typeof error !== "object") {
    return false;
  }

  const message = [
    "message" in error && typeof error.message === "string" ? error.message : "",
    "stderr" in error && typeof error.stderr === "string" ? error.stderr : ""
  ].join("\n");

  return Boolean(
    message.includes("ENOENT") ||
    message.includes("is not recognized") ||
    message.includes("spawn")
  );
}

async function cleanupInstallRoot(installRoot) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(installRoot, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!isBusyError(error) || attempt === 9) {
        console.warn(`Warning: failed to remove smoke-test directory ${installRoot}: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      await delay(250);
    }
  }
}

function isBusyError(error) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "EBUSY");
}

function getWindowsCommandPath(commandName, fallbackPath) {
  void commandName;
  return fallbackPath;
}

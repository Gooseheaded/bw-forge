import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..", "..");
const DESKTOP_DIR = resolve(SCRIPT_DIR, "..");
const OUTPUT_ROOT = resolve(DESKTOP_DIR, ".runtime-build");
const CACHE_ROOT = resolve(DESKTOP_DIR, ".runtime-cache");
const ESBUILD_CANDIDATE_ROOTS = [
  resolve(REPO_ROOT, "node_modules", ".bun"),
  resolve(REPO_ROOT, "packages", "corpus-query", "node_modules", ".pnpm")
];
const PYTHON_EMBED_VERSION = "3.14.6";
const PYTHON_EMBED_ARCHIVE_NAME = `python-${PYTHON_EMBED_VERSION}-embed-amd64.zip`;
const PYTHON_EMBED_URL = `https://www.python.org/ftp/python/${PYTHON_EMBED_VERSION}/${PYTHON_EMBED_ARCHIVE_NAME}`;
const PYTHON_EMBED_SHA256 =
  "df901e84a896ff1ee720ad03377e0c8d8c2244fda79808aeeaff6316df1cb75c";

async function main() {
  await rm(OUTPUT_ROOT, { recursive: true, force: true });
  await mkdir(OUTPUT_ROOT, { recursive: true });
  await mkdir(CACHE_ROOT, { recursive: true });

  const esbuildExecutable = await findEsbuildExecutable();
  const buildTimestamp = new Date().toISOString();
  const embeddedPythonArchive = await ensureEmbeddedPythonArchive();
  await packageEmbeddedPython(embeddedPythonArchive);
  await packageScForgeTemplate();
  await packageReplayEngineRuntime();

  await bundleEntrypoint(esbuildExecutable, {
    entrypoint: resolve(REPO_ROOT, "apps", "cli", "src", "main.ts"),
    outfile: resolve(OUTPUT_ROOT, "apps", "cli", "src", "main.js"),
    format: "esm"
  });
  await copyFile(
    resolve(REPO_ROOT, "apps", "cli", "package.json"),
    resolve(OUTPUT_ROOT, "apps", "cli", "package.json")
  );

  await bundleEntrypoint(esbuildExecutable, {
    entrypoint: resolve(REPO_ROOT, "packages", "corpus-query", "src", "cli.ts"),
    outfile: resolve(OUTPUT_ROOT, "packages", "corpus-query", "dist", "cli.cjs"),
    format: "cjs"
  });
  await bundleEntrypoint(esbuildExecutable, {
    entrypoint: resolve(REPO_ROOT, "packages", "corpus-query", "src", "mcp", "server.ts"),
    outfile: resolve(OUTPUT_ROOT, "packages", "corpus-query", "dist", "mcp", "server.cjs"),
    format: "cjs"
  });
  await copyFile(
    resolve(REPO_ROOT, "packages", "corpus-query", "package.json"),
    resolve(OUTPUT_ROOT, "packages", "corpus-query", "package.json")
  );
  await writeJson(
    resolve(OUTPUT_ROOT, "packages", "corpus-query", "dist", "build-info.json"),
    { build_timestamp: buildTimestamp }
  );
  await mkdir(
    resolve(OUTPUT_ROOT, "packages", "legacy-replay-analysis"),
    { recursive: true }
  );
  await copyFile(
    resolve(REPO_ROOT, "packages", "legacy-replay-analysis", "replay_analysis.py"),
    resolve(
      OUTPUT_ROOT,
      "packages",
      "legacy-replay-analysis",
      "replay_analysis.py"
    )
  );

  await writeRuntimeManifest(buildTimestamp);
}

async function bundleEntrypoint(esbuildExecutable, options) {
  await mkdir(dirname(options.outfile), { recursive: true });
  await runCommand(esbuildExecutable, [
    options.entrypoint,
    "--bundle",
    "--platform=node",
    "--target=node24",
    `--format=${options.format}`,
    "--log-level=warning",
    `--outfile=${options.outfile}`
  ]);
  await stripShebang(options.outfile);
}

async function writeRuntimeManifest(buildTimestamp) {
  await writeJson(resolve(OUTPUT_ROOT, "manifest.json"), {
    schema_version: "bw-forge-runtime-manifest-v1",
    build_timestamp: buildTimestamp,
    runtime_version: JSON.parse(
      await readFile(resolve(REPO_ROOT, "package.json"), "utf8")
    ).version,
    files: await collectManifestFiles(OUTPUT_ROOT)
  });
}

async function collectManifestFiles(rootPath) {
  const results = [];
  const entries = await readdir(rootPath, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = resolve(rootPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await collectManifestFiles(absolutePath)));
      continue;
    }
    if (entry.isFile()) {
      if (absolutePath === resolve(OUTPUT_ROOT, "manifest.json")) {
        continue;
      }
      const fileStats = await stat(absolutePath);
      results.push({
        path: absolutePath.slice(OUTPUT_ROOT.length + 1).replace(/\\/gu, "/"),
        size: fileStats.size,
        sha256: await sha256File(absolutePath)
      });
    }
  }

  results.sort((left, right) => left.path.localeCompare(right.path));
  return results;
}

async function sha256File(pathValue) {
  const hash = createHash("sha256");
  hash.update(await readFile(pathValue));
  return hash.digest("hex");
}

async function findEsbuildExecutable() {
  for (const root of ESBUILD_CANDIDATE_ROOTS) {
    const executable = await searchForEsbuild(root);
    if (executable) {
      return executable;
    }
  }

  throw new Error("Could not locate a local esbuild executable.");
}

async function searchForEsbuild(root) {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const candidate = resolve(root, entry.name, "node_modules", ".bin", process.platform === "win32" ? "esbuild.exe" : "esbuild");
      try {
        const candidateStats = await stat(candidate);
        if (candidateStats.isFile()) {
          return candidate;
        }
      } catch {
        continue;
      }
    }
  } catch {
    return undefined;
  }

  return undefined;
}

async function runCommand(command, args) {
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: REPO_ROOT,
      stdio: "inherit",
      shell: false
    });

    child.once("error", rejectPromise);
    child.once("exit", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(new Error(`Command failed (${String(code)}): ${command} ${args.join(" ")}`));
    });
  });
}

async function writeJson(pathValue, value) {
  await mkdir(dirname(pathValue), { recursive: true });
  await writeFile(pathValue, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function ensureEmbeddedPythonArchive() {
  const archivePath = resolve(CACHE_ROOT, PYTHON_EMBED_ARCHIVE_NAME);
  if (!(await matchesSha256(archivePath, PYTHON_EMBED_SHA256))) {
    const response = await fetch(PYTHON_EMBED_URL);
    if (!response.ok) {
      throw new Error(`Python runtime download failed: ${response.status} ${response.statusText}`);
    }
    const payload = Buffer.from(await response.arrayBuffer());
    await writeFile(archivePath, payload);
  }

  const actualSha256 = await sha256File(archivePath);
  if (actualSha256 !== PYTHON_EMBED_SHA256) {
    throw new Error(
      `Python runtime checksum mismatch. Expected ${PYTHON_EMBED_SHA256}, got ${actualSha256}.`
    );
  }

  return archivePath;
}

async function packageEmbeddedPython(archivePath) {
  const targetDir = resolve(
    OUTPUT_ROOT,
    "python",
    `cpython-${PYTHON_EMBED_VERSION}-embed-amd64`
  );
  await rm(targetDir, { recursive: true, force: true });
  await mkdir(targetDir, { recursive: true });
  const archiveLiteral = toPowerShellLiteral(archivePath);
  const targetLiteral = toPowerShellLiteral(targetDir);
  await runCommand("powershell", [
    "-NoProfile",
    "-Command",
    `Expand-Archive -LiteralPath ${archiveLiteral} -DestinationPath ${targetLiteral} -Force`
  ]);
}

async function packageScForgeTemplate() {
  const templatePath = await ensureScForgeTemplateBuilt();
  const runtimeTemplatePath = resolve(
    OUTPUT_ROOT,
    "apps",
    "sc-forge",
    "dist",
    "build-order.single-file.html"
  );
  await mkdir(dirname(runtimeTemplatePath), { recursive: true });
  await copyFile(templatePath, runtimeTemplatePath);
}

async function ensureScForgeTemplateBuilt() {
  const builtTemplatePath = resolve(
    REPO_ROOT,
    "apps",
    "sc-forge",
    "dist",
    "build-order.single-file.html"
  );
  const sourceTemplatePath = resolve(REPO_ROOT, "apps", "sc-forge", "build-order.html");
  const overrideTemplatePath = resolve(REPO_ROOT, "apps", "sc-forge", "build-order.override.js");
  const builderPath = resolve(REPO_ROOT, "apps", "sc-forge", "build_single_file.js");
  const [builtStats, sourceStats, overrideStats] = await Promise.all([
    safeStat(builtTemplatePath),
    stat(sourceTemplatePath),
    stat(overrideTemplatePath)
  ]);

  const needsBuild =
    !builtStats ||
    builtStats.mtimeMs < sourceStats.mtimeMs ||
    builtStats.mtimeMs < overrideStats.mtimeMs;

  if (needsBuild) {
    await runCommand(process.execPath, [builderPath]);
  }

  return builtTemplatePath;
}

async function packageReplayEngineRuntime() {
  const sourceDir = resolve(
    REPO_ROOT,
    "third_party",
    "shieldbattery",
    "dist",
    "bw-forge-replay-engine",
    "win-unpacked"
  );
  const targetDir = resolve(
    OUTPUT_ROOT,
    "third_party",
    "shieldbattery",
    "dist",
    "bw-forge-replay-engine",
    "win-unpacked"
  );
  await stat(resolve(sourceDir, "BW Forge Replay Engine.exe"));
  await rm(targetDir, { recursive: true, force: true });
  await mkdir(dirname(targetDir), { recursive: true });
  await cp(sourceDir, targetDir, { recursive: true });
}

async function stripShebang(pathValue) {
  const contents = await readFile(pathValue, "utf8");
  if (!contents.startsWith("#!")) {
    return;
  }

  const normalized = contents.replace(/^#![^\r\n]*\r?\n/u, "");
  await writeFile(pathValue, normalized, "utf8");
}

async function matchesSha256(pathValue, expectedSha256) {
  try {
    return (await sha256File(pathValue)) === expectedSha256;
  } catch {
    return false;
  }
}

async function safeStat(pathValue) {
  try {
    return await stat(pathValue);
  } catch {
    return undefined;
  }
}

function toPowerShellLiteral(value) {
  return `'${value.replace(/'/gu, "''")}'`;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

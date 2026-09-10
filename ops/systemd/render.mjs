#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const UNIT_NAMES = ["bw-forge-watch.service", "bw-forge-worker.service", "bw-forge-mcp.service"];

export function renderEnvironment(config) {
  validateConfig(config);
  const values = {
    BW_FORGE_APP_ROOT: config.appRoot,
    BW_FORGE_CORPUS_ROOT: config.corpusRoot,
    BW_FORGE_DB: config.db,
    BW_FORGE_INBOX: config.inbox,
    BW_FORGE_BUN: config.bun,
    BW_FORGE_NODE: config.node,
    BW_FORGE_PYTHON: config.python,
    BW_FORGE_MCP_HOST: config.mcpHost,
    BW_FORGE_MCP_PORT: String(config.mcpPort),
    BW_FORGE_MCP_PATH: config.mcpPath,
    BW_FORGE_WATCH_STABILITY_MS: String(config.stabilityMs),
    BW_FORGE_WATCH_RECONCILE_SECONDS: String(config.reconcileSeconds)
  };
  return `${Object.entries(values).map(([key, value]) => `${key}=${environmentQuote(value)}`).join("\n")}\n`;
}

export async function renderUnits(config) {
  validateConfig(config);
  const replacements = {
    SERVICE_USER: config.user,
    APP_ROOT: systemdSetting(config.appRoot),
    ENV_FILE: systemdSetting(config.environmentFile),
    BUN_EXECUTABLE: systemdExecQuote(config.bun),
    CLI_ENTRYPOINT: systemdExecQuote(posix.join(config.appRoot, "apps/cli/src/main.ts"))
  };
  const units = {};
  for (const name of UNIT_NAMES) {
    let contents = await readFile(join(HERE, "units", `${name}.in`), "utf8");
    for (const [key, value] of Object.entries(replacements)) contents = contents.replaceAll(`@${key}@`, () => value);
    if (/@[A-Z_]+@/.test(contents)) throw new Error(`Unresolved placeholder in ${name}`);
    units[name] = contents;
  }
  units["bw-forge.target"] = await readFile(join(HERE, "units", "bw-forge.target"), "utf8");
  return units;
}

export async function writeBundle(config, outputDirectory) {
  if (!outputDirectory) throw new Error("Missing output directory");
  await mkdir(outputDirectory, { recursive: true });
  const units = await renderUnits(config);
  for (const [name, contents] of Object.entries(units)) await writeFile(join(outputDirectory, name), contents, { mode: 0o644 });
  await writeFile(join(outputDirectory, "bw-forge.env"), renderEnvironment(config), { mode: 0o640 });
  return { outputDirectory, files: [...Object.keys(units), "bw-forge.env"] };
}

export function systemdQuote(value) {
  rejectUnsafeText(value, "systemd value");
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
}

export function systemdSetting(value) {
  rejectUnsafeText(value, "systemd setting");
  return value.replaceAll("\\", "\\x5c").replaceAll(" ", "\\x20").replaceAll('"', "\\x22").replaceAll("'", "\\x27").replaceAll("%", "%%");
}

export function systemdExecQuote(value) {
  return systemdQuote(value).replaceAll("$", () => "$$");
}

export function environmentQuote(value) {
  rejectUnsafeText(value, "environment value");
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function validateConfig(config) {
  if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(config.user ?? "")) throw new Error("Invalid service user");
  for (const [name, value] of [["app root", config.appRoot], ["corpus root", config.corpusRoot], ["inbox", config.inbox],
    ["database", config.db], ["Bun executable", config.bun], ["Node executable", config.node], ["Python executable", config.python],
    ["environment file", config.environmentFile]]) {
    rejectUnsafeText(value, name);
    if (!posix.isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  }
  rejectUnsafeText(config.mcpHost, "MCP host");
  if (!/^[A-Za-z0-9_.:-]+$/.test(config.mcpHost)) throw new Error("MCP host contains unsupported characters");
  rejectUnsafeText(config.mcpPath, "MCP path");
  if (!config.mcpPath.startsWith("/")) throw new Error("MCP path must start with /");
  if (!Number.isSafeInteger(config.mcpPort) || config.mcpPort < 1 || config.mcpPort > 65535) throw new Error("MCP port must be 1..65535");
  if (!Number.isSafeInteger(config.stabilityMs) || config.stabilityMs < 0) throw new Error("stability must be a non-negative integer");
  if (!Number.isSafeInteger(config.reconcileSeconds) || config.reconcileSeconds < 1) throw new Error("reconcile seconds must be a positive integer");
}

function rejectUnsafeText(value, name) {
  if (typeof value !== "string" || !value || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`Invalid ${name}`);
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    if (!name.startsWith("--") || !argv[index + 1]) throw new Error(`Invalid renderer argument: ${name}`);
    values[name.slice(2)] = argv[++index];
  }
  const required = name => {
    if (!values[name]) throw new Error(`Missing --${name}`);
    return values[name];
  };
  return {
    outputDirectory: required("output-dir"),
    config: {
      user: required("user"), appRoot: required("app-root"), corpusRoot: required("corpus-root"), inbox: required("inbox"), db: required("db"),
      bun: required("bun"), node: required("node"), python: required("python"), environmentFile: values["environment-file"] ?? "/etc/bw-forge/bw-forge.env",
      mcpHost: values["mcp-host"] ?? "127.0.0.1", mcpPort: Number(values["mcp-port"] ?? "8089"), mcpPath: values["mcp-path"] ?? "/mcp",
      stabilityMs: Number(values["stability-ms"] ?? "1500"), reconcileSeconds: Number(values["reconcile-seconds"] ?? "60")
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { config, outputDirectory } = parseArgs(process.argv.slice(2));
    console.log(JSON.stringify(await writeBundle(config, outputDirectory)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

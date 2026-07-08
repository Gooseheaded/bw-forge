import { readdir, realpath, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import type { ReplaySelectionResult } from "../shared/contracts";

export async function discoverReplayPaths(paths: string[]): Promise<ReplaySelectionResult> {
  const replayPaths: string[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();

  for (const selectedPath of paths) {
    try {
      const pathStats = await stat(selectedPath);
      if (pathStats.isFile()) {
        if (extname(selectedPath).toLowerCase() !== ".rep") {
          warnings.push(`${selectedPath} is not a .rep file.`);
          continue;
        }
        await addReplay(selectedPath, replayPaths, seen);
        continue;
      }
      if (pathStats.isDirectory()) {
        const before = replayPaths.length;
        await walkReplayDirectory(selectedPath, replayPaths, seen, warnings);
        if (replayPaths.length === before) {
          warnings.push(`${selectedPath} contains no .rep files.`);
        }
        continue;
      }
      warnings.push(`${selectedPath} is not a regular file or directory.`);
    } catch (error) {
      warnings.push(`${selectedPath} could not be read: ${formatError(error)}`);
    }
  }

  replayPaths.sort((left, right) => left.localeCompare(right));
  return { replayPaths, warnings };
}

async function walkReplayDirectory(
  directoryPath: string,
  replayPaths: string[],
  seen: Set<string>,
  warnings: string[]
): Promise<void> {
  let entries;
  try {
    entries = await readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    warnings.push(`${directoryPath} could not be enumerated: ${formatError(error)}`);
    return;
  }

  for (const entry of entries) {
    const entryPath = resolve(directoryPath, entry.name);
    if (entry.isDirectory()) {
      await walkReplayDirectory(entryPath, replayPaths, seen, warnings);
    } else if (entry.isFile() && extname(entry.name).toLowerCase() === ".rep") {
      await addReplay(entryPath, replayPaths, seen);
    }
  }
}

async function addReplay(
  replayPath: string,
  replayPaths: string[],
  seen: Set<string>
): Promise<void> {
  const canonicalPath = await realpath(replayPath);
  const key = process.platform === "win32" ? canonicalPath.toLowerCase() : canonicalPath;
  if (!seen.has(key)) {
    seen.add(key);
    replayPaths.push(canonicalPath);
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

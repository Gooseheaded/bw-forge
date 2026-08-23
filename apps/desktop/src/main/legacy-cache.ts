import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";

export function obsoleteReplayEngineCachePath(
  localAppData = process.env.LOCALAPPDATA
): string | null {
  const root = localAppData?.trim();
  return root
    ? join(resolve(root), "BW Forge", "runtime-cache", "replay-engine")
    : null;
}

export async function removeObsoleteReplayEngineCache(
  localAppData = process.env.LOCALAPPDATA
): Promise<boolean> {
  const cachePath = obsoleteReplayEngineCachePath(localAppData);
  if (!cachePath) {
    return false;
  }
  await rm(cachePath, { recursive: true, force: true });
  return true;
}

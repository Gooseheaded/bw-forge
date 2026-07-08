import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

export async function discoverManifestPaths(rootPath: string): Promise<string[]> {
  const manifestPaths: string[] = [];

  async function walk(currentPath: string): Promise<void> {
    const entries = await readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = resolve(currentPath, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
        continue;
      }

      if (entry.isFile() && entry.name === "manifest.json") {
        manifestPaths.push(entryPath);
      }
    }
  }

  await walk(resolve(rootPath));
  manifestPaths.sort((left, right) => left.localeCompare(right));
  return manifestPaths;
}

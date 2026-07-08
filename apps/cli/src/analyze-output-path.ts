import { resolve } from "node:path";

export function assertSafeAnalyzeOutputRoot(outputRoot: string, repoRoot: string): void {
  const normalizedOutputRoot = normalizePathForCompare(outputRoot);
  const normalizedRepoRoot = normalizePathForCompare(repoRoot);

  if (normalizedOutputRoot === normalizedRepoRoot) {
    throw new Error(
      `Refusing to write analyze output to protected path ${outputRoot}. Use a dedicated directory such as .\\out or .\\tmp\\runs\\<name>.`
    );
  }

  for (const protectedPath of createProtectedAnalyzeOutputPaths(repoRoot)) {
    if (pathsEqual(normalizedOutputRoot, protectedPath)) {
      throw new Error(
        `Refusing to write analyze output to protected path ${outputRoot}. Use a dedicated directory such as .\\out or .\\tmp\\runs\\<name>.`
      );
    }
    if (isSubpath(normalizedOutputRoot, protectedPath)) {
      throw new Error(
        `Refusing to write analyze output inside protected source directory ${protectedPath}. Use a dedicated directory such as .\\out or .\\tmp\\runs\\<name>.`
      );
    }
  }
}

export function createProtectedAnalyzeOutputPaths(repoRoot: string): string[] {
  return [
    resolve(repoRoot, ".git"),
    resolve(repoRoot, ".beads"),
    resolve(repoRoot, ".codex"),
    resolve(repoRoot, "apps"),
    resolve(repoRoot, "docs"),
    resolve(repoRoot, "fixtures"),
    resolve(repoRoot, "node_modules"),
    resolve(repoRoot, "openspec"),
    resolve(repoRoot, "packages"),
    resolve(repoRoot, "third_party")
  ].map((pathValue) => normalizePathForCompare(pathValue));
}

function pathsEqual(left: string, right: string): boolean {
  return normalizePathForCompare(left) === normalizePathForCompare(right);
}

function isSubpath(candidate: string, basePath: string): boolean {
  const normalizedCandidate = normalizePathForCompare(candidate);
  const normalizedBase = normalizePathForCompare(basePath);
  return normalizedCandidate.startsWith(`${normalizedBase}\\`);
}

function normalizePathForCompare(pathValue: string): string {
  return resolve(pathValue).replace(/\//gu, "\\").replace(/\\+$/u, "").toLowerCase();
}


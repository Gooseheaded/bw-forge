import { isAbsolute, relative, resolve } from "node:path";

const PROTECTED_RUNTIME_PATHS = [
  ".git",
  ".beads",
  ".codex",
  "apps",
  "docs",
  "fixtures",
  "node_modules",
  "openspec",
  "packages",
  "third_party"
] as const;

export interface PathValidationResult {
  valid: boolean;
  message?: string;
}

export function normalizePath(pathValue: string): string {
  return resolve(pathValue).replace(/[\\/]+$/u, "").toLowerCase();
}

export function isPathWithin(candidate: string, parent: string): boolean {
  const relativePath = relative(resolve(parent), resolve(candidate));
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

export function validateOutputRoot(outputRoot: string, runtimeRoot: string): PathValidationResult {
  if (!outputRoot.trim()) {
    return { valid: false, message: "Choose an analysis output directory." };
  }
  if (!runtimeRoot.trim()) {
    return { valid: false, message: "Choose a bw-forge runtime directory." };
  }

  const normalizedOutput = normalizePath(outputRoot);
  const normalizedRuntime = normalizePath(runtimeRoot);
  if (normalizedOutput === normalizedRuntime) {
    return {
      valid: false,
      message: "Analysis output cannot be the bw-forge runtime directory."
    };
  }

  for (const protectedRelativePath of PROTECTED_RUNTIME_PATHS) {
    const protectedPath = resolve(runtimeRoot, protectedRelativePath);
    if (isPathWithin(outputRoot, protectedPath)) {
      return {
        valid: false,
        message: `Analysis output cannot be inside the protected runtime path ${protectedPath}.`
      };
    }
  }

  return { valid: true };
}

export function validateDatabasePath(
  databasePath: string,
  runtimeRoot: string
): PathValidationResult {
  if (!databasePath.trim()) {
    return { valid: false, message: "Choose a corpus database path." };
  }

  const normalizedDatabase = normalizePath(databasePath);
  const normalizedRuntime = normalizePath(runtimeRoot);
  if (
    normalizedDatabase === normalizedRuntime ||
    isPathWithin(databasePath, resolve(runtimeRoot, ".git")) ||
    isPathWithin(databasePath, resolve(runtimeRoot, "apps")) ||
    isPathWithin(databasePath, resolve(runtimeRoot, "packages")) ||
    isPathWithin(databasePath, resolve(runtimeRoot, "third_party"))
  ) {
    return {
      valid: false,
      message: "The corpus database cannot be stored inside a protected runtime source directory."
    };
  }

  return { valid: true };
}

export function ensurePathWithin(candidate: string, parent: string, label: string): string {
  const resolvedCandidate = resolve(candidate);
  if (!isPathWithin(resolvedCandidate, parent)) {
    throw new Error(`${label} resolves outside the configured output directory.`);
  }
  return resolvedCandidate;
}

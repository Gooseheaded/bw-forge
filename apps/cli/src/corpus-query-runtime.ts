import { stat } from "node:fs/promises";
import { resolve } from "node:path";

/** Node arguments shared by checkout and packaged corpus-query launchers. */
export async function corpusQueryRuntimeArgs(
  packageDir: string,
  entrypoint: "cli" | "mcp/server",
  entrypointName: string
): Promise<string[]> {
  const dist = resolve(packageDir, "dist", `${entrypoint}.js`);
  if (await isFile(dist)) return [dist];
  // Desktop packaging emits CommonJS bundles instead of the package's tsc output.
  const packagedDist = resolve(packageDir, "dist", `${entrypoint}.cjs`);
  if (await isFile(packagedDist)) return [packagedDist];

  const tsx = resolve(packageDir, "node_modules", "tsx", "dist", "cli.mjs");
  if (await isFile(tsx)) return [tsx, resolve(packageDir, "src", `${entrypoint}.ts`)];
  throw new Error(`Missing imported corpus-query ${entrypointName} runtime. Expected ${dist}, ${packagedDist}, or ${tsx}.`);
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

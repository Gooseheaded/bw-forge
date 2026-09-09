import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { corpusQueryRuntimeArgs } from "./corpus-query-runtime.js";

for (const entrypoint of ["cli", "mcp/server"] as const) {
  test(`${entrypoint}: built .js wins with or without source runtime`, async () => {
    const root = await mkdtemp(join(tmpdir(), "bw-launcher-"));
    try {
      const dist = join(root, "dist", `${entrypoint}.js`);
      const packagedDist = join(root, "dist", `${entrypoint}.cjs`);
      const tsx = join(root, "node_modules/tsx/dist/cli.mjs");
      await mkdir(dirname(dist), { recursive: true });
      await writeFile(packagedDist, "");
      expect(await corpusQueryRuntimeArgs(root, entrypoint, entrypoint)).toEqual([packagedDist]);
      await writeFile(dist, "");
      // Standard .js output takes priority even if an old bundle is present.
      expect(await corpusQueryRuntimeArgs(root, entrypoint, entrypoint)).toEqual([dist]);
      await mkdir(dirname(tsx), { recursive: true });
      await writeFile(tsx, "");
      // Source checkout: dist still wins when tsx is also installed.
      expect(await corpusQueryRuntimeArgs(root, entrypoint, entrypoint)).toEqual([dist]);
      await rm(dist);
      expect(await corpusQueryRuntimeArgs(root, entrypoint, entrypoint)).toEqual([packagedDist]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`${entrypoint}: absent dist falls back to the existing tsx file`, async () => {
    const root = await mkdtemp(join(tmpdir(), "bw-launcher-"));
    try {
      const tsx = join(root, "node_modules/tsx/dist/cli.mjs");
      await mkdir(dirname(tsx), { recursive: true });
      // Use the installed tsx runtime against a real TypeScript entrypoint.
      const installedTsx = new URL("../../../packages/corpus-query/node_modules/tsx/dist/cli.mjs", import.meta.url);
      await writeFile(tsx, `import ${JSON.stringify(installedTsx.href)};`);
      const source = join(root, "src", `${entrypoint}.ts`);
      await mkdir(dirname(source), { recursive: true });
      await writeFile(source, 'const message: string = "tsx fallback running"; console.log(message);');
      const args = await corpusQueryRuntimeArgs(root, entrypoint, entrypoint);
      expect(args).toEqual([
        tsx, join(root, "src", `${entrypoint}.ts`)
      ]);
      const result = await promisify(execFile)("node", args, { windowsHide: true });
      expect(result.stdout.trim()).toBe("tsx fallback running");
      await rm(tsx);
      await expect(corpusQueryRuntimeArgs(root, entrypoint, entrypoint)).rejects.toThrow("Missing imported corpus-query");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

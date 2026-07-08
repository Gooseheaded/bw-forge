import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const packageJson = JSON.parse(await BunLikeRead("package.json"));
const outputPath = resolve("dist/build-info.json");

const buildInfo = {
  package_name: packageJson.name,
  package_version: packageJson.version,
  build_timestamp: new Date().toISOString()
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(buildInfo, null, 2) + "\n", "utf8");

async function BunLikeRead(path) {
  const { readFile } = await import("node:fs/promises");
  return readFile(path, "utf8");
}

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface StagedAnalysisOptions {
  replayPath: string;
  outputRoot: string;
  workDirectory: string;
}

/** Adapter to the existing analyzer CLI. No bwsim or reducer implementation lives here. */
export async function runExistingAnalyzer(options: StagedAnalysisOptions): Promise<void> {
  const entry = fileURLToPath(new URL("../../../apps/cli/src/main.ts", import.meta.url));
  const snapshots = join(options.workDirectory, "telemetry");
  await mkdir(snapshots, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.versions.bun ? process.execPath : "bun", [entry, "analyze",
      options.replayPath, "--out", options.outputRoot, "--keep-snapshots", "--snapshot-dir", snapshots], {
      windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: process.env
    });
    let errors = "";
    child.stdout.on("data", data => process.stderr.write(data));
    child.stderr.on("data", data => { errors = (errors + data.toString()).slice(-16384); process.stderr.write(data); });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve() : reject(new Error(`Analyzer failed (${code}): ${errors.trim()}`)));
  });
}

/** Record the actual selected producer inputs for new analyses, not guessed historical versions. */
export async function existingAnalyzerSpecification(): Promise<Record<string, unknown>> {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const hash = async (path: string) => createHash("sha256").update(await readFile(join(root, path))).digest("hex");
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const provenance = JSON.parse(await readFile(join(root, "third_party/bwsim/provenance.json"), "utf8"));
  const inputs: Record<string, string> = {};
  for (const path of ["apps/cli/src/main.ts", "apps/cli/src/bwsim-backend.ts", "apps/cli/src/bwsim-exporter.ts",
    "third_party/bwsim/dist/index.js", "packages/legacy-replay-analysis/replay_analysis.py"]) {
    inputs[path] = await hash(path);
  }
  // The CLI prefers a built exporter if one exists; include it when selected.
  try { inputs["apps/cli/src/bwsim-exporter.js"] = await hash("apps/cli/src/bwsim-exporter.js"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return {
    bw_forge_version: pkg.version,
    reducer_version: inputs["packages/legacy-replay-analysis/replay_analysis.py"],
    bwsim_version: provenance.package.version,
    bwsim_wasm_sha256: await hash("third_party/bwsim/bwsim_wasm.bwforge.wasm"),
    asset_pack_sha256: await hash("third_party/bwsim/sim.pack.gz"),
    telemetry_contract: "legacy-complete-dictionaries-v1",
    settings: { backend: "bundled-bwsim", frame_duration_ms: 42, producer_files: inputs }
  };
}

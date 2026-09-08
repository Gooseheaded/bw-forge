import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ingestReplayAnalysis } from "./index.js";

test("shared Python core: sparse regressions and transactional single-replay ingestion", () => {
  const runtime = process.env.BW_FORGE_PYTHON ?? (process.platform === "win32" ? "py" : "python3");
  const args = runtime === "py" ? ["-3"] : [];
  const result = spawnSync(runtime, [...args, "-m", "unittest", "discover", "-s",
    fileURLToPath(new URL("../tests", import.meta.url)), "-v"], { encoding: "utf8", windowsHide: true });
  if (result.error) throw result.error;
  expect(result.status, result.stderr).toBe(0);
}, 60_000);

test("typed API propagates an invalid manifest failure", async () => {
  await expect(ingestReplayAnalysis({ dbPath: "unused-v2.sqlite", replayManifestPath: "missing-v2-manifest.json" }))
    .rejects.toThrow();
});

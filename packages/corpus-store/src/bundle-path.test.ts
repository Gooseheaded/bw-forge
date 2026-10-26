import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("relocated bundle resolves Python store through BW_FORGE_REPO_ROOT", async () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const temp = await mkdtemp(join(tmpdir(), "bw-bundle-path-"));
  try {
    const fixture = join(temp, "fixture");
    const python = process.env.BW_FORGE_PYTHON ?? (process.platform === "win32" ? "py" : "python3");
    const generated = spawnSync(python, [...(python === "py" ? ["-3"] : []),
      fileURLToPath(new URL("../tests/publication_fixture.py", import.meta.url)), fixture], { encoding: "utf8", windowsHide: true });
    if (generated.error) throw generated.error;
    expect(generated.status, generated.stderr).toBe(0);
    const manifest = join(fixture, "replay-manifest.json");
    const probe = join(temp, "probe.ts");
    await writeFile(probe, `
import { prepareReplayAnalysis } from ${JSON.stringify(join(root, "packages/corpus-store/src/index.ts"))};
import { enqueueReplay } from ${JSON.stringify(join(root, "packages/corpus-store/src/jobs.ts"))};
import { readReplayMetadata } from ${JSON.stringify(join(root, "packages/corpus-store/src/replay-metadata.ts"))};
const prepared = await prepareReplayAnalysis(process.argv[2]);
const metadata = await readReplayMetadata(process.argv[3]);
const queued = await enqueueReplay({replayPath:process.argv[3],corpusRoot:process.argv[4],dbPath:process.argv[5]});
console.log(JSON.stringify({sha:prepared.replaySha256,map:metadata.mapName,status:queued.status}));
`);
    const bundle = join(temp, "relocated.js");
    const built = spawnSync(process.execPath, ["build", probe, "--target=bun", "--packages=bundle", `--outfile=${bundle}`], { cwd: root, encoding: "utf8", windowsHide: true });
    expect(built.status, built.stderr).toBe(0);
    const run = spawnSync(process.execPath, [bundle, manifest, join(root, "fixtures/replays/191104,(4)KnockOut1.4.rep"), join(temp, "corpus"), join(temp, "corpus/db/corpus.sqlite")], {
      cwd: temp, encoding: "utf8", windowsHide: true,
      env: { ...process.env, BW_FORGE_REPO_ROOT: root },
    });
    expect(run.status, run.stderr).toBe(0);
    const result = JSON.parse(run.stdout.trim());
    expect(result.sha).toMatch(/^[0-9a-f]{64}$/);
    expect(result.map).toBeTruthy();
    expect(result.status).toBe("queued");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}, 30000);

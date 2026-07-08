import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ReplayLibraryService } from "../src/main/replay-library";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("canonical replay library", () => {
  test("loads metadata and only resolves declared reports", async () => {
    const root = await createCorpus();
    const service = new ReplayLibraryService();
    const library = await service.load(root);
    expect(library.warnings).toEqual([]);
    expect(library.entries).toEqual([
      expect.objectContaining({
        replayId: "replay-1",
        sourceFilename: "game.rep",
        matchup: "ZvT",
        reportNames: ["legacy/game.html"],
        players: [
          { owner: 0, name: "Alpha", race: "zerg" },
          { owner: 1, name: "Beta", race: "terran" }
        ]
      })
    ]);
    expect(
      service.resolveTrustedReport(root, "replay-1", "legacy/game.html")
    ).toBe(join(root, "replays", "replay-1", "legacy", "game.html"));
    expect(() =>
      service.resolveTrustedReport(root, "replay-1", "../../outside.html")
    ).toThrow("not declared");
  });

  test("keeps valid entries when another manifest is malformed", async () => {
    const root = await createCorpus(true);
    const service = new ReplayLibraryService();
    const library = await service.load(root);
    expect(library.entries).toHaveLength(1);
    expect(library.warnings.some((warning) => warning.includes("replay-bad"))).toBe(true);
  });
});

async function createCorpus(includeMalformed = false): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bw-forge-desktop-library-"));
  temporaryRoots.push(root);
  const replayRoot = join(root, "replays", "replay-1");
  await mkdir(join(replayRoot, "legacy"), { recursive: true });
  await writeFile(join(replayRoot, "legacy", "game.html"), "<html></html>");
  await writeFile(
    join(replayRoot, "replay-manifest.json"),
    JSON.stringify({
      schema_version: "bw-forge-replay-manifest-v1",
      replay_id: "replay-1",
      source: { filename: "game.rep" },
      legacy: { html_files: ["legacy/game.html"] },
      replay_analysis: { matchup: "ZvT", map: null, duration_seconds: 510 },
      players: [
        { owner: 0, name: "Alpha", race: "zerg" },
        { owner: 1, name: "Beta", race: "terran" }
      ]
    })
  );
  const replays = [
    {
      replay_id: "replay-1",
      replay_manifest_path: "replays/replay-1/replay-manifest.json"
    }
  ];
  if (includeMalformed) {
    const malformedRoot = join(root, "replays", "replay-bad");
    await mkdir(malformedRoot, { recursive: true });
    await writeFile(join(malformedRoot, "replay-manifest.json"), "{invalid");
    replays.push({
      replay_id: "replay-bad",
      replay_manifest_path: "replays/replay-bad/replay-manifest.json"
    });
  }
  await writeFile(
    join(root, "corpus-manifest.json"),
    JSON.stringify({ schema_version: "bw-forge-corpus-manifest-v1", replays })
  );
  return root;
}

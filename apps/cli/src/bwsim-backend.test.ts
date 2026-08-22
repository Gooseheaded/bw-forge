import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, test } from "bun:test";
import type { BwsimPlayer, BwsimReplayHeader, BwsimUnit } from "../../../third_party/bwsim/dist/index.js";

import {
  BWSIM_TIMELINE_SCHEMA,
  UNIT_NAMES,
  captureBwsimSnapshot,
  exportBwsimTimeline,
  findStandalonePlayerLeaveFrame,
  resolveBwsimTermination
} from "./bwsim-backend.js";

const repoRoot = resolve(import.meta.dir, "..", "..", "..");
const runtimeRoot = resolve(repoRoot, "third_party", "bwsim");
const replayPath = resolve(
  repoRoot,
  "howdidilosethis",
  "replays",
  "44b77091c689e59a4657215aff6bd281d6329dca73e4b6e1c7e9670117461ec6",
  "raw",
  "LastReplay.rep"
);

describe("vendored headless-bwsim", () => {
  test("pins the known release artifact hashes", async () => {
    expect(await sha256(resolve(runtimeRoot, "bwsim_wasm.wasm"))).toBe(
      "b321eb4f274d2602be1ccdf3cefa72b0ba934e2025d76d7c25379a18af4d1226"
    );
    expect(await sha256(resolve(runtimeRoot, "bwsim_wasm.bwforge.wasm"))).toBe(
      "aec4109937e4d1efefa921cf4fef8bfd2febc772809a026510ff1a6e88ca9a7d"
    );
    expect(await sha256(resolve(runtimeRoot, "sim.pack.gz"))).toBe(
      "32f8cc3561e11d2756a579dc54675e0758e94c15b9f767a66a1ba533a9856a44"
    );
    const provenance = JSON.parse(await readFile(resolve(runtimeRoot, "provenance.json"), "utf8"));
    expect(provenance.package.version).toBe("0.1.3");
  });

  test("loads the tracked golden replay with the patched runtime", async () => {
    const script = `
      import { Bwsim } from ${JSON.stringify(pathToFileURL(resolve(runtimeRoot, "dist", "index.js")).href)};
      const simulation = await Bwsim.create({
        wasmPath: ${JSON.stringify(resolve(runtimeRoot, "bwsim_wasm.bwforge.wasm"))},
        assetPackPath: ${JSON.stringify(resolve(runtimeRoot, "sim.pack.gz"))}
      });
      await simulation.loadReplay(${JSON.stringify(replayPath)});
      if (simulation.currentFrame() !== 0 || simulation.replayHeader()?.frameCount !== 32937) process.exit(2);
      if (simulation.step(1) !== 1 || simulation.units().length === 0) process.exit(3);
    `;
    await execFilePromise("node", ["--input-type=module", "--eval", script]);
  }, 30_000);
});

describe("bwsim legacy timeline adapter", () => {
  test("writes monotonic frames 1 through the inclusive terminal frame", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bw-forge-bwsim-test-"));
    const snapshotPath = join(tempDir, "timeline.jsonl");
    let frame = 0;
    const marine = unit({ index: 5, type: 0, owner: 3 });
    try {
      const result = await exportBwsimTimeline({
        replayPath: "fixture.rep",
        snapshotPath,
        runtime: { wasmPath: "unused", assetPackPath: "unused" },
        createSimulation: async () => ({
          loadReplay: async () => {},
          replayHeader: () => ({ ...header(3, "Terran Player", 1), frameCount: 3 }),
          replayData: () => undefined,
          currentFrame: () => frame,
          step: (count: number) => frame += count,
          ...simulation([marine], new Map([[5, 0x1234_0005]]))
        })
      });
      const snapshots = (await readFile(snapshotPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(result).toMatchObject({ firstFrame: 1, terminalFrame: 3, framesEmitted: 3 });
      expect(snapshots.map((snapshot) => snapshot.frame)).toEqual([1, 2, 3]);
      expect(snapshots.every((snapshot) => snapshot.schema_version === BWSIM_TIMELINE_SCHEMA)).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("uses generation IDs, normalizes supply, omits Scanner Sweep, and reconstructs deaths", () => {
    const marine = unit({ index: 5, type: 0, owner: 3 });
    const scannerSweep = unit({ index: 9, type: 33, owner: 3 });
    const first = captureBwsimSnapshot(
      simulation([marine, scannerSweep], new Map([[5, 0x1234_0005], [9, 0x7777_0009]])),
      header(3, "Terran Player", 1),
      new Map()
    );
    expect(first.owners["3"]).toMatchObject({
      name: "Terran Player",
      minerals: 50,
      gas: 0,
      supply_current: 5,
      supply_max: 10,
      workers_alive: 4,
      unit_counts: { marine: 1 }
    });
    expect(first.owners["3"]).not.toHaveProperty("gathered_minerals");
    expect(first.owners["3"]!.units[0]!.id).toBe(0x1234_0005);
    expect(first.owners["3"]!.units[0]!.id).not.toBe(marine.index);
    expect(first.owners["3"]!.unit_counts).not.toHaveProperty("scanner_sweep");

    const second = captureBwsimSnapshot(
      simulation([], new Map()),
      header(3, "Terran Player", 1),
      first.currentUnits
    );
    expect(second.deaths).toHaveLength(1);
    expect(second.deaths[0]).toMatchObject({ id: 0x1234_0005, owner: 3, unit_type: "marine" });
  });

  test("emits five-slot queues and explicit building morph targets", () => {
    const hatchery = unit({
      index: 11,
      type: 131,
      owner: 0,
      completed: true,
      totalBuildTime: 1800,
      remainingBuildTime: 1700,
      researchKind: 2,
      researchId: 3
    });
    const captured = captureBwsimSnapshot(
      simulation([hatchery], new Map([[11, 0xabcd_000b]]), new Map([[11, [132, 41, 41, 42, 45]]])),
      header(0, "Zerg Player", 0),
      new Map()
    );
    expect(captured.owners["0"]!.units[0]).toMatchObject({
      build_queue_unit_ids: [132, 41, 41, 42, 45],
      morphing_building: true,
      morph_target_unit_type_id: 132,
      morph_target_unit_type: "lair",
      build_time: 1700,
      remaining_build_time: 1700,
      upgrade_in_progress: 3
    });
  });

  test("recognizes the accepted standalone PlayerLeave+1 termination heuristic", () => {
    const drpl = new Uint8Array(660);
    const view = new DataView(drpl.buffer);
    view.setUint32(641, 5, true);
    view.setUint8(645, 3);
    drpl.set([0, 0x57, 1], 646);
    expect(findStandalonePlayerLeaveFrame(drpl, 66)).toBe(5);
    expect(resolveBwsimTermination(66, drpl)).toEqual({ frame: 6, reason: "player-leave" });
    expect(resolveBwsimTermination(32_937)).toEqual({ frame: 32_937, reason: "header" });
    expect(resolveBwsimTermination(50_000)).toEqual({ frame: 43_200, reason: "safety-cap" });
  });

  test("keeps the reducer's complete DAT name table", () => {
    expect(BWSIM_TIMELINE_SCHEMA).toBe("sb-unit-timeline-v2");
    expect(UNIT_NAMES).toHaveLength(228);
    expect(UNIT_NAMES[33]).toBe("scanner_sweep");
    expect(UNIT_NAMES[131]).toBe("hatchery");
  });
});

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function execFilePromise(command: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(command, args, (error) => error ? rejectPromise(error) : resolvePromise());
  });
}

function header(owner: number, name: string, race: number): BwsimReplayHeader {
  return {
    frameCount: 100,
    mapName: "Test Map",
    players: Array.from({ length: 12 }, (_, slot) => ({
      slot,
      name: slot === owner ? name : "",
      playerId: slot,
      controller: slot === owner ? 2 : 0,
      race: slot === owner ? race : 0,
      force: 0
    }))
  };
}

function simulation(
  units: readonly BwsimUnit[],
  ids: ReadonlyMap<number, number>,
  queues: ReadonlyMap<number, readonly number[]> = new Map()
) {
  const players: BwsimPlayer[] = Array.from({ length: 12 }, (_, owner) => ({
    owner,
    minerals: owner === 3 || owner === 0 ? 50 : 0,
    gas: 0,
    usedSupplyRaw: [9, 9, 9],
    maxSupplyRaw: [20, 20, 20],
    completedWorkers: 4,
    actions: 0
  }));
  return {
    players: () => players,
    units: () => units,
    unitInstanceId: (index: number) => ids.get(index) ?? null,
    unitBuildQueue: (index: number) => queues.get(index) ?? []
  };
}

function unit(overrides: Partial<BwsimUnit> & Pick<BwsimUnit, "index" | "type" | "owner">): BwsimUnit {
  return {
    completed: false,
    hidden: false,
    x: 100,
    y: 200,
    hpRaw: 2560,
    maxHpRaw: 2560,
    hp: 10,
    maxHp: 10,
    shieldsRaw: 0,
    maxShieldsRaw: 0,
    energyRaw: 0,
    kills: 0,
    remainingBuildTime: 0,
    totalBuildTime: 0,
    resources: 0,
    firstQueuedUnitType: 0xffff,
    facingX: 0,
    facingY: 0,
    targetX: 0,
    targetY: 0,
    researchKind: 0,
    researchLevel: 0,
    researchId: 0,
    researchRemaining: 0,
    ...overrides
  };
}

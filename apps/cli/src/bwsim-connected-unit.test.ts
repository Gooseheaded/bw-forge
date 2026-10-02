import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, test } from "bun:test";

const repoRoot = resolve(import.meta.dir, "..", "..", "..");
const runtimeRoot = resolve(repoRoot, "third_party", "bwsim");
const wasmPath = process.env.BWSIM_WASM_PATH ?? resolve(runtimeRoot, "bwsim_wasm.bwforge.wasm");
const assetPackPath = resolve(runtimeRoot, "sim.pack.gz");
const replayPath = resolve(repoRoot, "fixtures", "replays", "191104,(4)KnockOut1.4.rep");

describe("bwsim connected-unit wrapper", () => {
  test("requires and exposes the connected-unit Wasm export", async () => {
    const script = `
      import { readFile } from "node:fs/promises";
      const bytes = await readFile(${JSON.stringify(resolve(runtimeRoot, "bwsim_wasm.wasm"))});
      const result = await WebAssembly.instantiate(bytes, {});
      if (typeof result.instance.exports.bw_unit_connected_unit_id !== "function") process.exit(1);
    `;
    await execFilePromise("node", ["--input-type=module", "--eval", script]);
  });

  test("normalizes the zero sentinel and resolves a Larva parent by ordinary unit ID", async () => {
    const script = `
      import assert from "node:assert/strict";
      import { Bwsim } from ${JSON.stringify(pathToFileURL(resolve(runtimeRoot, "dist", "index.js")).href)};
      const simulation = await Bwsim.create({
        wasmPath: ${JSON.stringify(wasmPath)},
        assetPackPath: ${JSON.stringify(assetPackPath)}
      });
      await simulation.loadReplay(${JSON.stringify(replayPath)});
      simulation.stepTo(1);

      const unconnected = simulation.units().find((unit) =>
        unit.type !== 35 && simulation.connectedUnitId(unit.index) === null
      );
      assert.ok(unconnected);
      assert.equal(simulation.connectedUnitId(unconnected.index), null);

      const larva = simulation.units().find((unit) => unit.type === 35);
      assert.ok(larva);
      const parentId = simulation.connectedUnitId(larva.index);
      assert.notEqual(parentId, null);

      const parent = simulation.units().find((unit) => simulation.unitInstanceId(unit.index) === parentId);
      assert.ok(parent);
      assert.ok([131, 132, 133].includes(parent.type));
      assert.equal(parent.owner, larva.owner);

      // The API takes the live HUD index. Passing the generation-bearing packed
      // ID must not be treated as an equivalent input.
      const larvaId = simulation.unitInstanceId(larva.index);
      assert.notEqual(larvaId, null);
      assert.notEqual(simulation.connectedUnitId(larvaId), parentId);
    `;
    await execFilePromise("node", ["--input-type=module", "--eval", script]);
  });
});

function execFilePromise(command: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(command, args, (error) => error ? rejectPromise(error) : resolvePromise());
  });
}

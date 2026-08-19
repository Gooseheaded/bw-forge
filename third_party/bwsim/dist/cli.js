#!/usr/bin/env node
import { resolve } from "node:path";
import { Bwsim } from "./bwsim.js";
async function main() {
    const [replayArg = "LastReplay.rep", packArg = "sim.pack.gz", wasmArg = "bwsim_wasm.bwforge.wasm",] = process.argv.slice(2);
    const sim = await Bwsim.create({
        wasmPath: resolve(wasmArg),
        assetPackPath: resolve(packArg),
    });
    if (sim.assetCount !== 1044) {
        throw new Error(`expected the proven 1,044 assets, got ${sim.assetCount}`);
    }
    await sim.loadReplay(resolve(replayArg));
    const replay = sim.replayData();
    if (replay === undefined)
        throw new Error("replay bytes were not retained");
    if (sim.currentFrame() !== 0) {
        throw new Error(`expected initial frame 0, got ${sim.currentFrame()}`);
    }
    const header = sim.replayHeader();
    if (header === undefined)
        throw new Error("replay header is unavailable");
    sim.step(100);
    if (sim.currentFrame() !== 100) {
        throw new Error(`expected frame 100 after step, got ${sim.currentFrame()}`);
    }
    const units = sim.units();
    const unitSample = units.slice(0, 5).map((unit) => ({
        ...unit,
        instanceId: sim.unitInstanceId(unit.index),
    }));
    console.log({
        assets: sim.assetCount,
        rawReplayBytes: replay.raw.byteLength,
        drplBytes: replay.drpl.byteLength,
        replayEndFrame: header.frameCount,
        mapName: header.mapName,
        frame: sim.currentFrame(),
        playerSample: sim.players().filter((player) => header.players[player.owner]?.name !== ""),
        unitCount: units.length,
        unitSample,
    });
}
main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
//# sourceMappingURL=cli.js.map
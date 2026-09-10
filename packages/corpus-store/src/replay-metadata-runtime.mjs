#!/usr/bin/env node
import { resolve } from "node:path";
import { stat } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Bwsim } from "../../../third_party/bwsim/dist/index.js";

const REPLAY_ID_BYTES = 4;
// bwsim exposes DRPL as the 4-byte Replay ID followed by the decompressed
// Header section. Header +0x08 is the replay-declared Unix start time (u32 LE).
const HEADER_START_TIME_OFFSET = REPLAY_ID_BYTES + 0x08;
const MINIMUM_DECODED_BYTES = HEADER_START_TIME_OFFSET + 4;
const validReplayIds = new Set(["reRS", "seRS"]);

export async function extractReplayMetadata(paths) {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  let simulation;
  const results = [];
  for (const path of paths) {
    try {
      if ((await stat(path)).size < 32) throw new Error("replay is too short to contain a decoded header");
      simulation ??= await Bwsim.create({
        wasmPath: resolve(root, "third_party/bwsim/bwsim_wasm.bwforge.wasm"),
        assetPackPath: resolve(root, "third_party/bwsim/sim.pack.gz")
      });
      await simulation.loadReplay(path);
      const replay = simulation.replayData();
      const header = simulation.replayHeader();
      if (!replay || !header || replay.drpl.byteLength < MINIMUM_DECODED_BYTES) {
        throw new Error("headless-bwsim did not expose a complete decoded replay header");
      }
      const decoded = replay.drpl;
      const replayId = new TextDecoder("ascii").decode(decoded.subarray(0, REPLAY_ID_BYTES));
      if (!validReplayIds.has(replayId)) throw new Error(`unsupported decoded replay ID: ${replayId}`);
      const view = new DataView(decoded.buffer, decoded.byteOffset, decoded.byteLength);
      if (view.getUint32(REPLAY_ID_BYTES + 1, true) !== header.frameCount) {
        throw new Error("decoded replay header frame count mismatch");
      }
      const declared = view.getUint32(HEADER_START_TIME_OFFSET, true);
      results.push({ path, playedAtUnixSeconds: declared === 0 ? null : declared, error: null });
    } catch (error) {
      results.push({ path, playedAtUnixSeconds: null, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    let body = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) body += chunk;
    const input = JSON.parse(body);
    if (!Array.isArray(input) || input.some(path => typeof path !== "string" || !path)) throw new Error("Expected a JSON array of replay paths");
    process.stdout.write(`${JSON.stringify(await extractReplayMetadata(input))}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

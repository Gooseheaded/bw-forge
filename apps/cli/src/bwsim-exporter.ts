#!/usr/bin/env node
import { exportBwsimTimeline } from "./bwsim-backend.ts";

const replayPath = requiredOption("--replay");
const snapshotPath = requiredOption("--out");
const wasmPath = requiredOption("--wasm");
const assetPackPath = requiredOption("--asset-pack");

const result = await exportBwsimTimeline({
  replayPath,
  snapshotPath,
  runtime: { wasmPath, assetPackPath }
});

console.log(
  `[bwsim] emitted frames ${result.firstFrame}..${result.terminalFrame} ` +
  `(${result.framesEmitted}, ${result.termination}) in ${(result.elapsedMilliseconds / 1000).toFixed(2)}s`
);

function requiredOption(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) {
    throw new Error(`Missing required option ${name}`);
  }
  return value;
}

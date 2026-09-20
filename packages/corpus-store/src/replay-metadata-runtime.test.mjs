import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { extractReplayMetadata } from "./replay-metadata-runtime.mjs";

function decoded(frameCount=120,timestamp=1234567890){
  const bytes=new Uint8Array(32);bytes.set(new TextEncoder().encode("reRS"));
  const view=new DataView(bytes.buffer);view.setUint32(5,frameCount,true);view.setUint32(12,timestamp,true);return bytes;
}

test("metadata runtime preserves accepted decoded map text, rejects blank names, and never steps simulation",async()=>{
  const maps=new Map([["decorated.rep","  Decorated Map  "],["empty.rep",""],["blank.rep"," \t "],["wide.rep","x".repeat(32)]]);
  let current="",stepCalls=0;
  const simulation={
    async loadReplay(path){current=path;},replayData(){return {drpl:decoded()};},
    replayHeader(){return {frameCount:120,mapName:maps.get(current),players:[]};},step(){stepCalls++;}
  };
  const result=await extractReplayMetadata([...maps.keys()],{stat:async()=>({size:64}),createSimulation:async()=>simulation});
  expect(result.map(row=>row.mapName)).toEqual(["  Decorated Map  ",null,null,"x".repeat(32)]);
  expect(result.map(row=>row.playedAtUnixSeconds)).toEqual([1234567890,1234567890,1234567890,1234567890]);
  expect(stepCalls).toBe(0);
});

test("metadata runtime preserves batch order and isolates a malformed replay from its neighbors",async()=>{
  let current="";
  const simulation={
    async loadReplay(path){current=path;if(path==="bad.rep")throw new Error("malformed fixture");},
    replayData(){return {drpl:decoded()};},replayHeader(){return {frameCount:120,mapName:`Map ${current}`,players:[]};}
  };
  const result=await extractReplayMetadata(["first.rep","bad.rep","last.rep"],{
    stat:async()=>({size:64}),createSimulation:async()=>simulation});
  expect(result.map(row=>row.path)).toEqual(["first.rep","bad.rep","last.rep"]);
  expect(result.map(row=>row.mapName)).toEqual(["Map first.rep",null,"Map last.rep"]);
  expect(result[1].error).toContain("malformed fixture");expect(result[2].error).toBeNull();
});

test("vendored map-name decoding remains fixed-width UTF-8 with NUL termination and control stripping",async()=>{
  const source=await readFile(fileURLToPath(new URL("../../../third_party/bwsim/dist/bwsim.js",import.meta.url)),"utf8");
  expect(source).toContain("mapName: readFixedString(view, 4, 32)");
  expect(source).toContain("const terminator = bytes.indexOf(0)");
  expect(source).toContain('new TextDecoder().decode(content).replace(/[\\x00-\\x1f\\x7f]/g, "")');
});

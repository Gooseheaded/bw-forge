import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { metadataFromScrepDocument, readReplayMetadata, readReplayMetadataBatch, SCREP_RUNTIME } from "./replay-metadata.js";

const repo=fileURLToPath(new URL("../../../",import.meta.url));
const fixture=join(repo,"fixtures/replays/191104,(4)KnockOut1.4.rep");
const temporary:string[]=[];
afterEach(async()=>{for(const path of temporary.splice(0))await rm(path,{recursive:true,force:true});});

test("pinned screp integration returns the established map and exact replay timestamp without bwsim",async()=>{
  const metadata=await readReplayMetadata(fixture);
  expect(metadata).toEqual({playedAtUnixSeconds:1775408548,mapName:"KnockOut 1.4"});
  expect(SCREP_RUNTIME.version).toBe("v1.13.4");
  const source=await readFile(fileURLToPath(new URL("./replay-metadata.ts",import.meta.url)),"utf8");
  expect(source).not.toContain("third_party/bwsim");
  expect(source).not.toContain("replay-metadata-runtime");
  expect(source).not.toContain(".wasm");
},{timeout:10000});

test("both offline screp executables match their pinned integrity values",async()=>{
  for(const runtime of Object.values(SCREP_RUNTIME.platforms)){
    const bytes=await readFile(join(repo,...runtime.relativePath.split("/")));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(runtime.sha256);
  }
});

test("screp JSON uses nonblank MapData.Name before Header.Map and preserves accepted decoded text",()=>{
  expect(metadataFromScrepDocument({Header:{StartTime:"2026-04-05T19:02:28+02:00",Map:"Header Map"},MapData:{Name:"Map Data Name 1.4"}}))
    .toEqual({playedAtUnixSeconds:1775408548,mapName:"Map Data Name 1.4"});
  expect(metadataFromScrepDocument({Header:{StartTime:"1970-01-01T00:00:00Z",Map:"  Header Map  "},MapData:{Name:" \t\u0000 "}}))
    .toEqual({playedAtUnixSeconds:null,mapName:"  Header Map  "});
  expect(metadataFromScrepDocument({Header:{StartTime:null,Map:" \t\u0000 "},MapData:null}))
    .toEqual({playedAtUnixSeconds:null,mapName:null});
  expect(metadataFromScrepDocument({Header:{StartTime:"2026-04-05T17:02:28Z",Map:"\u0007KnockOut \u00051.4"},MapData:null}).mapName)
    .toBe("KnockOut 1.4");
});

test("screp batch preserves input order and isolates a malformed replay",async()=>{
  const root=await mkdtemp(join(tmpdir(),"bw-screp-metadata-"));temporary.push(root);
  const malformed=join(root,"malformed.rep");await writeFile(malformed,"not a replay");
  const results=await readReplayMetadataBatch([fixture,malformed,fixture]);
  expect(results.map(result=>result.path)).toEqual([fixture,malformed,fixture]);
  expect(results.map(result=>result.mapName)).toEqual(["KnockOut 1.4",null,"KnockOut 1.4"]);
  expect(results.map(result=>result.playedAtUnixSeconds)).toEqual([1775408548,null,1775408548]);
  expect(results[0]?.error).toBeNull();expect(results[1]?.error).toContain("Failed to parse replay");expect(results[2]?.error).toBeNull();
},{timeout:10000});

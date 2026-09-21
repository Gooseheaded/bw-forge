#!/usr/bin/env bun
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { readReplayMetadataBatch } from "../packages/corpus-store/src/replay-metadata.js";

const corpusRoot=resolve(requiredOption("--corpus-root"));
const limit=integerOption("--limit",100);
const replayRoot=join(corpusRoot,"replays"),paths:string[]=[];
for(const prefix of (await readdir(replayRoot,{withFileTypes:true})).filter(entry=>entry.isDirectory()&&/^[0-9a-f]{2}$/u.test(entry.name)).sort((a,b)=>a.name.localeCompare(b.name))){
  for(const file of (await readdir(join(replayRoot,prefix.name),{withFileTypes:true})).filter(entry=>entry.isFile()&&/^[0-9a-f]{64}\.rep$/u.test(entry.name)).sort((a,b)=>a.name.localeCompare(b.name))){
    paths.push(join(replayRoot,prefix.name,file.name));if(paths.length===limit)break;
  }
  if(paths.length===limit)break;
}
const started=performance.now(),results=await readReplayMetadataBatch(paths),wallSeconds=(performance.now()-started)/1000;
const successful=results.filter(result=>result.error===null),unknown=successful.filter(result=>result.mapName===null);
console.log(JSON.stringify({attempted:paths.length,successful:successful.length,failed:results.length-successful.length,
  unknownMaps:unknown.length,wallSeconds,replaysPerSecond:successful.length/wallSeconds,
  mapsPerMinute:(successful.length-unknown.length)*60/wallSeconds,errors:results.filter(result=>result.error!==null)},null,2));

function requiredOption(name:string){const index=process.argv.indexOf(name);if(index<0||!process.argv[index+1])throw new Error(`${name} is required`);return process.argv[index+1]!;}
function integerOption(name:string,fallback:number){const index=process.argv.indexOf(name);if(index<0)return fallback;const value=Number(process.argv[index+1]);
  if(!Number.isSafeInteger(value)||value<1)throw new Error(`${name} must be a positive integer`);return value;}

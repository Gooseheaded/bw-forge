import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runStore } from "./index.js";
import { readReplayMetadataBatch } from "./replay-metadata.js";

interface ChronologyRow { replaySha256:string; playedAtUnixSeconds:number|null }
export interface BackfillPlayedAtError { replaySha256:string; path:string; message:string }
export interface BackfillPlayedAtResult {
  examined:number; updated:number; alreadyPresent:number; unavailable:number; errors:BackfillPlayedAtError[];
}

async function sha256(path:string):Promise<string>{
  const digest=createHash("sha256");for await(const chunk of createReadStream(path))digest.update(chunk);return digest.digest("hex");
}

/** Backfill only NULL replay chronology from verified SHA-derived canonical bytes. */
export async function backfillReplayPlayedAt(options:{corpusRoot:string;dbPath:string}):Promise<BackfillPlayedAtResult>{
  const root=await realpath(resolve(options.corpusRoot));
  const listed=await runStore<{replays:ChronologyRow[]}>(["replays","list","--db",resolve(options.dbPath)]);
  const missing=listed.replays.filter(row=>row.playedAtUnixSeconds===null),errors:BackfillPlayedAtError[]=[];
  const verified:Array<{row:ChronologyRow;path:string}>=[];
  for(const row of missing){
    const path=join(root,"replays",row.replaySha256.slice(0,2),`${row.replaySha256}.rep`);
    try{
      const entry=await lstat(path);if(!entry.isFile()||entry.isSymbolicLink())throw new Error("canonical replay is not a regular file");
      if(await sha256(path)!==row.replaySha256)throw new Error("canonical replay SHA256 mismatch");
      verified.push({row,path});
    }catch(error){errors.push({replaySha256:row.replaySha256,path,message:error instanceof Error?error.message:String(error)});}
  }
  const values:Array<{replaySha256:string;playedAtUnixSeconds:number}>=[];
  if(verified.length){
    try{
      const extracted=await readReplayMetadataBatch(verified.map(item=>item.path));
      extracted.forEach((result,index)=>{
        const item=verified[index]!;
        if(result.error||result.playedAtUnixSeconds===null)errors.push({replaySha256:item.row.replaySha256,path:item.path,
          message:result.error??"replay header contains no declared timestamp"});
        else values.push({replaySha256:item.row.replaySha256,playedAtUnixSeconds:result.playedAtUnixSeconds});
      });
    }catch(error){
      for(const item of verified)errors.push({replaySha256:item.row.replaySha256,path:item.path,message:error instanceof Error?error.message:String(error)});
    }
  }
  const update=values.length?await runStore<{updated:number}>(["replays","update-missing","--db",resolve(options.dbPath),"--payload",JSON.stringify({values})]):{updated:0};
  return {examined:listed.replays.length,updated:update.updated,alreadyPresent:listed.replays.length-missing.length,
    unavailable:missing.length-update.updated,errors};
}

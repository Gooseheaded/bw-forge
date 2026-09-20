import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runStore } from "./index.js";
import { readReplayMetadataBatch, type ReplayMetadataResult } from "./replay-metadata.js";

interface MapNameRow { replaySha256:string; mapName:string|null }
export interface BackfillMapNameError { replaySha256:string; path:string; message:string }
export interface BackfillMapNamesResult {
  examined:number; updated:number; alreadyPresent:number; unavailable:number; errors:BackfillMapNameError[];
}
export interface MapNameBackfillDependencies {
  readMetadataBatch?:(paths:string[])=>Promise<ReplayMetadataResult[]>;
  beforeUpdate?:()=>Promise<void>;
}

async function sha256(path:string):Promise<string>{
  const digest=createHash("sha256");for await(const chunk of createReadStream(path))digest.update(chunk);return digest.digest("hex");
}

/** Fill only missing map names from SHA-verified canonical replay headers. */
export async function backfillReplayMapNames(options:{corpusRoot:string;dbPath:string},
  dependencies:MapNameBackfillDependencies={}):Promise<BackfillMapNamesResult>{
  const root=await realpath(resolve(options.corpusRoot));
  const listed=await runStore<{replays:MapNameRow[]}>(["replays","list","--db",resolve(options.dbPath)]);
  const missing=listed.replays.filter(row=>row.mapName===null||row.mapName.trim()===""),errors:BackfillMapNameError[]=[];
  const verified:Array<{row:MapNameRow;path:string}>=[];
  for(const row of missing){
    if(!/^[0-9a-f]{64}$/.test(row.replaySha256)){
      errors.push({replaySha256:row.replaySha256,path:"",message:"invalid replay SHA256"});continue;
    }
    const path=join(root,"replays",row.replaySha256.slice(0,2),`${row.replaySha256}.rep`);
    try{
      const entry=await lstat(path);if(!entry.isFile()||entry.isSymbolicLink())throw new Error("canonical replay is not a regular non-symlink file");
      if(await sha256(path)!==row.replaySha256)throw new Error("canonical replay SHA256 mismatch");
      verified.push({row,path});
    }catch(error){errors.push({replaySha256:row.replaySha256,path,message:error instanceof Error?error.message:String(error)});}
  }
  const values:Array<{replaySha256:string;mapName:string}>=[];
  if(verified.length){
    try{
      const extracted=await (dependencies.readMetadataBatch??readReplayMetadataBatch)(verified.map(item=>item.path));
      if(extracted.length!==verified.length)throw new Error("replay metadata batch result count mismatch");
      extracted.forEach((result,index)=>{
        const item=verified[index]!;
        if(result.error||result.mapName===null||result.mapName.trim()==="")errors.push({replaySha256:item.row.replaySha256,path:item.path,
          message:result.error??"replay header contains no nonblank map name"});
        else values.push({replaySha256:item.row.replaySha256,mapName:result.mapName});
      });
    }catch(error){
      for(const item of verified)errors.push({replaySha256:item.row.replaySha256,path:item.path,message:error instanceof Error?error.message:String(error)});
    }
  }
  await dependencies.beforeUpdate?.();
  const update=values.length?await runStore<{updated:number;preserved:number}>(["replays","update-missing-map-names","--db",resolve(options.dbPath),
    "--payload",JSON.stringify({values})]):{updated:0,preserved:0};
  return {examined:listed.replays.length,updated:update.updated,
    alreadyPresent:listed.replays.length-missing.length+update.preserved,
    unavailable:missing.length-update.updated-update.preserved,errors};
}

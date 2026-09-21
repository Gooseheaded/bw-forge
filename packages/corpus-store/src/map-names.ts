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
export const MAP_NAME_BACKFILL_DEFAULTS={batchSize:25} as const;

async function sha256(path:string):Promise<string>{
  const digest=createHash("sha256");for await(const chunk of createReadStream(path))digest.update(chunk);return digest.digest("hex");
}

/** Fill only missing map names from SHA-verified canonical replay headers. Each
 * bounded chunk gets a fresh metadata subprocess and commits before the next. */
export async function backfillReplayMapNames(options:{corpusRoot:string;dbPath:string;batchSize?:number},
  dependencies:MapNameBackfillDependencies={}):Promise<BackfillMapNamesResult>{
  const batchSize=options.batchSize??MAP_NAME_BACKFILL_DEFAULTS.batchSize;
  if(!Number.isSafeInteger(batchSize)||batchSize<1)throw new Error("batchSize must be a positive integer");
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
  let updated=0,preserved=0;
  const readMetadata=dependencies.readMetadataBatch??readReplayMetadataBatch;
  for(let offset=0;offset<verified.length;offset+=batchSize){
    const batch=verified.slice(offset,offset+batchSize),values:Array<{replaySha256:string;mapName:string}>=[];
    try{
      const extracted=await readMetadata(batch.map(item=>item.path));
      if(extracted.length!==batch.length)throw new Error("replay metadata batch result count mismatch");
      extracted.forEach((result,index)=>{
        const item=batch[index]!;
        if(result.error||result.mapName===null||result.mapName.trim()==="")errors.push({replaySha256:item.row.replaySha256,path:item.path,
          message:result.error??"replay header contains no nonblank map name"});
        else values.push({replaySha256:item.row.replaySha256,mapName:result.mapName});
      });
    }catch(error){
      for(const item of batch)errors.push({replaySha256:item.row.replaySha256,path:item.path,message:error instanceof Error?error.message:String(error)});
      continue;
    }
    if(values.length){
      await dependencies.beforeUpdate?.();
      const result=await runStore<{updated:number;preserved:number}>(["replays","update-missing-map-names","--db",resolve(options.dbPath),
        "--payload",JSON.stringify({values})]);
      updated+=result.updated;preserved+=result.preserved;
    }
  }
  return {examined:listed.replays.length,updated,
    alreadyPresent:listed.replays.length-missing.length+preserved,
    unavailable:missing.length-updated-preserved,errors};
}

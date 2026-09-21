import { afterEach,expect,test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFile,mkdir,mkdtemp,readFile,rm,symlink,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename,dirname,join } from "node:path";
import { fileURLToPath } from "node:url";
import { ingestReplayAnalysis } from "./index.js";
import { enqueueReplay } from "./jobs.js";
import { backfillReplayMapNames } from "./map-names.js";
import { readReplayMetadataBatch } from "./replay-metadata.js";

const repo=fileURLToPath(new URL("../../../",import.meta.url));
const replayFixture=join(repo,"fixtures/replays/191104,(4)KnockOut1.4.rep"),expectedMap="KnockOut 1.4";
const temporary:string[]=[];
afterEach(async()=>{for(const path of temporary.splice(0))await rm(path,{recursive:true,force:true});});
async function temp(){const path=await mkdtemp(join(tmpdir(),"bw-map-names-"));temporary.push(path);return path;}
const digest=(bytes:Uint8Array|string)=>createHash("sha256").update(bytes).digest("hex");
function rows(dbPath:string,sql:string){const db=new Database(dbPath,{readonly:true});try{return db.query(sql).all();}finally{db.close();}}
function execute(dbPath:string,sql:string,params:unknown[]=[]){const db=new Database(dbPath);try{db.query(sql).run(...params as never[]);}finally{db.close();}}
function tableState(dbPath:string,table:string){
  const exists=rows(dbPath,`SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name='${table}'`).length>0;
  return exists?JSON.stringify(rows(dbPath,`SELECT * FROM ${table} ORDER BY 1`)):null;
}
async function analysisFixture(root:string,replayPath?:string,mapName:string|null=null){
  const output=join(root,"analysis");
  const python=process.env.BW_FORGE_PYTHON??(process.platform==="win32"?"py":"python3");
  const generated=spawnSync(python,[...(python==="py"?["-3"]:[]),fileURLToPath(new URL("../tests/publication_fixture.py",import.meta.url)),output],{encoding:"utf8",windowsHide:true});
  if(generated.error)throw generated.error;expect(generated.status,generated.stderr).toBe(0);
  if(replayPath)await copyFile(replayPath,join(output,"raw.rep"));
  const raw=await readFile(join(output,"raw.rep")),sha=digest(raw),manifestPath=join(output,"replay-manifest.json"),legacyPath=join(output,"manifest.json");
  const manifest=JSON.parse(await readFile(manifestPath,"utf8"));manifest.replay_id=sha;manifest.replay_analysis.map=mapName;
  const legacy=JSON.parse(await readFile(legacyPath,"utf8"));legacy.replay_id=sha;legacy.map=null;
  await writeFile(manifestPath,JSON.stringify(manifest));await writeFile(legacyPath,JSON.stringify(legacy));
  return {manifestPath,legacyPath,sha};
}
async function seedMissingReplays(corpusRoot:string,dbPath:string,count:number,prefix:string){
  const seeded:Array<{sha:string;path:string}>=[];
  for(let index=0;index<count;index++){
    const bytes=`${prefix}-${index}`,sha=digest(bytes),path=join(corpusRoot,"replays",sha.slice(0,2),`${sha}.rep`);
    await mkdir(dirname(path),{recursive:true});await writeFile(path,bytes);seeded.push({sha,path});
  }
  const db=new Database(dbPath),insert=db.query("INSERT INTO replays(sha256,byte_size,raw_relative_path,first_seen_at_ms,map_name,played_at_unix_s) VALUES (?,?,?,?,NULL,NULL)");
  try{db.transaction(()=>{for(const item of seeded)insert.run(item.sha,0,"ignored/untrusted.rep",1);})();}finally{db.close();}
  return seeded.sort((a,b)=>a.sha<b.sha?-1:a.sha>b.sha?1:0);
}

test("real replay metadata and registration expose the replay-declared map without disturbing chronology",async()=>{
  const root=await temp(),source=join(root,"source.rep"),corpusRoot=join(root,"corpus"),dbPath=join(corpusRoot,"db/corpus.sqlite"),bad=join(root,"bad.rep");
  await copyFile(replayFixture,source);await writeFile(bad,"not a replay");
  const metadata=await readReplayMetadataBatch([source,bad,source]);
  expect(metadata.map(row=>row.mapName)).toEqual([expectedMap,null,expectedMap]);expect(metadata[1]!.error).toBeString();
  const first=await enqueueReplay({replayPath:source,corpusRoot,dbPath});expect(first.mapName).toBe(expectedMap);expect(first.playedAtUnixSeconds).toBeNumber();
  expect(rows(dbPath,"SELECT map_name FROM replays")).toEqual([{map_name:expectedMap}]);
  execute(dbPath,"UPDATE replays SET map_name=NULL");await enqueueReplay({replayPath:source,corpusRoot,dbPath});
  expect(rows(dbPath,"SELECT map_name FROM replays")).toEqual([{map_name:expectedMap}]);
  execute(dbPath,"UPDATE replays SET map_name='Established Map'");await enqueueReplay({replayPath:source,corpusRoot,dbPath});
  expect(rows(dbPath,"SELECT map_name FROM replays")).toEqual([{map_name:"Established Map"}]);
  const artifacts=await analysisFixture(root,source,null),before=await readFile(artifacts.manifestPath);
  await ingestReplayAnalysis({dbPath,replayManifestPath:artifacts.manifestPath});
  expect(rows(dbPath,"SELECT map_name FROM replays")).toEqual([{map_name:"Established Map"}]);
  expect(await readFile(artifacts.manifestPath)).toEqual(before);
},{timeout:60000});

test("direct manifest ingest fills a missing useful map and never overwrites an established map",async()=>{
  const root=await temp(),dbPath=join(root,"corpus.sqlite"),artifacts=await analysisFixture(root,undefined,null);
  await ingestReplayAnalysis({dbPath,replayManifestPath:artifacts.manifestPath});
  expect(rows(dbPath,"SELECT map_name FROM replays")).toEqual([{map_name:null}]);
  const manifest=JSON.parse(await readFile(artifacts.manifestPath,"utf8"));manifest.replay_analysis.map="Manifest Map";
  await writeFile(artifacts.manifestPath,JSON.stringify(manifest));await ingestReplayAnalysis({dbPath,replayManifestPath:artifacts.manifestPath});
  expect(rows(dbPath,"SELECT map_name FROM replays")).toEqual([{map_name:"Manifest Map"}]);
  manifest.replay_analysis.map="Different Manifest Map";await writeFile(artifacts.manifestPath,JSON.stringify(manifest));
  await ingestReplayAnalysis({dbPath,replayManifestPath:artifacts.manifestPath});
  expect(rows(dbPath,"SELECT map_name FROM replays")).toEqual([{map_name:"Manifest Map"}]);
},{timeout:30000});

test("100+ missing maps use bounded default batches and checkpoint each chunk before the next runtime",async()=>{
  const root=await temp(),corpusRoot=join(root,"corpus"),dbPath=join(corpusRoot,"db/corpus.sqlite"),source=join(root,"source.rep");await copyFile(replayFixture,source);
  await enqueueReplay({replayPath:source,corpusRoot,dbPath});const seeded=await seedMissingReplays(corpusRoot,dbPath,105,"bounded");
  const calls:string[][]=[];
  const result=await backfillReplayMapNames({corpusRoot,dbPath},{readMetadataBatch:async paths=>{
    const index=calls.length,expected=seeded.slice(index*25,index*25+25).map(item=>item.path);
    expect(paths).toEqual(expected);expect(paths.length).toBeLessThanOrEqual(25);
    expect(rows(dbPath,"SELECT replay_id FROM replays WHERE map_name IS NOT NULL AND trim(map_name)<>''")).toHaveLength(1+index*25);
    calls.push([...paths]);return paths.map(path=>({path,playedAtUnixSeconds:null,mapName:`Map ${basename(path,".rep")}`,error:null}));
  }});
  expect(calls.map(call=>call.length)).toEqual([25,25,25,25,5]);
  expect(result).toMatchObject({examined:106,updated:105,alreadyPresent:1,unavailable:0,errors:[]});
  expect(result.updated+result.alreadyPresent+result.unavailable).toBe(result.examined);
  let rerunCalls=0;const second=await backfillReplayMapNames({corpusRoot,dbPath},{readMetadataBatch:async()=>{rerunCalls++;throw new Error("must not run");}});
  expect(second).toMatchObject({examined:106,updated:0,alreadyPresent:106,unavailable:0,errors:[]});expect(rerunCalls).toBe(0);
},{timeout:60000});

test("whole-batch failure preserves earlier checkpoints, continues later batches, and rerun resumes only failures",async()=>{
  const root=await temp(),corpusRoot=join(root,"corpus"),dbPath=join(corpusRoot,"db/corpus.sqlite"),source=join(root,"source.rep");await copyFile(replayFixture,source);
  await enqueueReplay({replayPath:source,corpusRoot,dbPath});const seeded=await seedMissingReplays(corpusRoot,dbPath,60,"failure");let calls=0;
  const first=await backfillReplayMapNames({corpusRoot,dbPath,batchSize:20},{readMetadataBatch:async paths=>{
    const index=calls++;expect(paths).toEqual(seeded.slice(index*20,index*20+20).map(item=>item.path));
    expect(rows(dbPath,"SELECT replay_id FROM replays WHERE map_name IS NOT NULL AND trim(map_name)<>''")).toHaveLength(index===0?1:21);
    if(index===1)throw new Error("injected whole-batch failure");
    return paths.map(path=>({path,playedAtUnixSeconds:null,mapName:`Map ${basename(path)}`,error:null}));
  }});
  expect(calls).toBe(3);expect(first).toMatchObject({examined:61,updated:40,alreadyPresent:1,unavailable:20});expect(first.errors).toHaveLength(20);
  expect(first.updated+first.alreadyPresent+first.unavailable).toBe(first.examined);
  const failed=seeded.slice(20,40);expect(rows(dbPath,"SELECT sha256 FROM replays WHERE map_name IS NULL ORDER BY sha256")).toEqual(failed.map(item=>({sha256:item.sha})));
  const resumedCalls:string[][]=[];const resumed=await backfillReplayMapNames({corpusRoot,dbPath,batchSize:20},{readMetadataBatch:async paths=>{
    resumedCalls.push([...paths]);return paths.map(path=>({path,playedAtUnixSeconds:null,mapName:"Recovered Map",error:null}));
  }});
  expect(resumedCalls).toEqual([failed.map(item=>item.path)]);expect(resumed).toMatchObject({examined:61,updated:20,alreadyPresent:41,unavailable:0,errors:[]});
  const complete=await backfillReplayMapNames({corpusRoot,dbPath,batchSize:20});expect(complete).toMatchObject({examined:61,updated:0,alreadyPresent:61,unavailable:0,errors:[]});
},{timeout:60000});

test("map backfill verifies canonical bytes, isolates failures, changes only missing replay metadata, and is idempotent",async()=>{
  const root=await temp(),corpusRoot=join(root,"corpus"),dbPath=join(corpusRoot,"db/corpus.sqlite"),source=join(root,"source.rep");await copyFile(replayFixture,source);
  const registered=await enqueueReplay({replayPath:source,corpusRoot,dbPath}),artifacts=await analysisFixture(root,source,null);
  await ingestReplayAnalysis({dbPath,replayManifestPath:artifacts.manifestPath});
  execute(dbPath,"UPDATE replays SET map_name='   ',raw_relative_path='ignored/untrusted.rep' WHERE sha256=?",[registered.replaySha256]);
  const entries:Array<{sha:string;kind:"missing"|"mismatch"|"malformed"|"directory"|"known"}>=[
    {sha:"a".repeat(64),kind:"missing"},{sha:"b".repeat(64),kind:"mismatch"},{sha:digest("not a replay"),kind:"malformed"},
    {sha:"d".repeat(64),kind:"directory"},{sha:"e".repeat(64),kind:"known"}];
  for(const entry of entries){
    const path=join(corpusRoot,"replays",entry.sha.slice(0,2),`${entry.sha}.rep`);await mkdir(dirname(path),{recursive:true});
    if(entry.kind==="mismatch")await writeFile(path,"wrong bytes");else if(entry.kind==="malformed")await writeFile(path,"not a replay");else if(entry.kind==="directory")await mkdir(path);
    execute(dbPath,"INSERT INTO replays(sha256,byte_size,raw_relative_path,first_seen_at_ms,map_name,played_at_unix_s) VALUES (?,?,?,?,?,NULL)",
      [entry.sha,0,"deliberately/untrusted.rep",1,entry.kind==="known"?"Known Map":null]);
  }
  const linkBytes="symlink replay",linkSha=digest(linkBytes),linkTarget=join(root,"link-target.rep"),linkPath=join(corpusRoot,"replays",linkSha.slice(0,2),`${linkSha}.rep`);
  let linked=false;await writeFile(linkTarget,linkBytes);await mkdir(dirname(linkPath),{recursive:true});
  try{await symlink(linkTarget,linkPath,"file");linked=true;execute(dbPath,"INSERT INTO replays(sha256,byte_size,raw_relative_path,first_seen_at_ms,map_name,played_at_unix_s) VALUES (?,?,?,?,NULL,NULL)",[linkSha,linkBytes.length,"ignored.rep",1]);}
  catch(error){if(!(["EPERM","EACCES"] as unknown[]).includes((error as NodeJS.ErrnoException).code))throw error;}
  const protectedTables=["analysis_runs","current_analyses","analysis_publications","analysis_jobs","analysis_job_attempts","replay_sources"];
  const before=Object.fromEntries(protectedTables.map(table=>[table,tableState(dbPath,table)]));
  const manifestBefore=await readFile(artifacts.manifestPath),legacyBefore=await readFile(artifacts.legacyPath),replayBefore=await readFile(registered.canonicalReplayPath);
  const result=await backfillReplayMapNames({corpusRoot,dbPath});
  expect(result.updated).toBe(1);expect(result.alreadyPresent).toBe(1);expect(result.unavailable).toBe(4+(linked?1:0));expect(result.errors).toHaveLength(result.unavailable);
  expect(rows(dbPath,"SELECT map_name FROM replays WHERE sha256='"+registered.replaySha256+"'")).toEqual([{map_name:expectedMap}]);
  const cli=await Bun.$`${process.execPath} ${join(repo,"apps/cli/src/main.ts")} replays backfill-map-names --corpus-root ${corpusRoot} --db ${dbPath} --batch-size 2`.quiet();
  const second=JSON.parse(cli.stdout.toString());expect(second.updated).toBe(0);expect(second.alreadyPresent).toBe(2);
  for(const table of protectedTables)expect(tableState(dbPath,table)).toBe(before[table]);
  expect(await readFile(artifacts.manifestPath)).toEqual(manifestBefore);expect(await readFile(artifacts.legacyPath)).toEqual(legacyBefore);
  expect(await readFile(registered.canonicalReplayPath)).toEqual(replayBefore);
  expect(rows(dbPath,"PRAGMA integrity_check")).toEqual([{integrity_check:"ok"}]);expect(rows(dbPath,"PRAGMA foreign_key_check")).toEqual([]);
},{timeout:60000});

test("map backfill rejects blank decoded names and a racing established value wins",async()=>{
  const root=await temp(),corpusRoot=join(root,"corpus"),dbPath=join(corpusRoot,"db/corpus.sqlite"),source=join(root,"source.rep");await copyFile(replayFixture,source);
  const registered=await enqueueReplay({replayPath:source,corpusRoot,dbPath});execute(dbPath,"UPDATE replays SET map_name=NULL");
  const blank=await backfillReplayMapNames({corpusRoot,dbPath},{readMetadataBatch:async paths=>paths.map(path=>({path,playedAtUnixSeconds:null,mapName:"  ",error:null}))});
  expect(blank.updated).toBe(0);expect(blank.unavailable).toBe(1);expect(rows(dbPath,"SELECT map_name FROM replays")).toEqual([{map_name:null}]);
  const raced=await backfillReplayMapNames({corpusRoot,dbPath},{beforeUpdate:async()=>execute(dbPath,"UPDATE replays SET map_name='Concurrent Map' WHERE sha256=?",[registered.replaySha256])});
  expect(raced.updated).toBe(0);expect(raced.alreadyPresent).toBe(1);expect(raced.unavailable).toBe(0);
  expect(rows(dbPath,"SELECT map_name FROM replays")).toEqual([{map_name:"Concurrent Map"}]);
  await expect(backfillReplayMapNames({corpusRoot,dbPath,batchSize:0})).rejects.toThrow("positive integer");
},{timeout:30000});

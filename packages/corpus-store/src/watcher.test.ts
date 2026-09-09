import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getCorpusSummary } from "../../corpus-query/src/analytics/discovery.js";
import type { Database as QueryDatabase } from "../../corpus-query/src/db/sqlite.js";
import { ingestReplayAnalysis } from "./index.js";
import { createAnalysisWorker, enqueueReplay, type WorkerDependencies } from "./jobs.js";
import { createReplayPublisher, type PublicationDependencies } from "./publication.js";
import { createReplayWatcher, type ReplayWatcherDependencies } from "./watcher.js";

let temp:string,fixture:string,corpusRoot:string,dbPath:string,inbox:string;
const replayBytes=Buffer.from("replay"),replaySha=createHash("sha256").update(replayBytes).digest("hex");
beforeEach(async()=>{
  temp=await mkdtemp(join(tmpdir(),"bw-watch-test-"));fixture=join(temp,"fixture");corpusRoot=join(temp,"corpus");dbPath=join(corpusRoot,"db","corpus.sqlite");inbox=join(temp,"inbox");
  await mkdir(inbox,{recursive:true});
  const runtime=process.env.BW_FORGE_PYTHON??(process.platform==="win32"?"py":"python3");
  const result=spawnSync(runtime,[...(runtime==="py"?["-3"]:[]),fileURLToPath(new URL("../tests/publication_fixture.py",import.meta.url)),fixture],{encoding:"utf8",windowsHide:true});
  if(result.error)throw result.error;expect(result.status,result.stderr).toBe(0);
});
afterEach(async()=>{await rm(temp,{recursive:true,force:true});});
const options=(extra:Record<string,unknown>={})=>({paths:[inbox],corpusRoot,dbPath,stabilityMs:20,reconcileMs:5000,...extra});
function rows<T extends Record<string,unknown>=Record<string,unknown>>(sql:string,params:unknown[]=[]){const db=new BunDatabase(dbPath,{readonly:true});try{return db.query(sql).all(...params as never[]) as T[];}finally{db.close();}}
async function waitFor(check:()=>boolean|Promise<boolean>,message:string,timeout=5000){const end=Date.now()+timeout;while(Date.now()<end){try{if(await check())return;}catch{/* producer may still be creating the DB/file */}await Bun.sleep(20);}throw new Error(message);}
function publisher(){const dependencies:PublicationDependencies={specification:async()=>({bw_forge_version:"watch-fixture",reducer_version:"watch-fixture"}),ingest:ingestReplayAnalysis,
  analyze:async({outputRoot,replayPath})=>{const dest=join(outputRoot,"replays",replaySha);await cp(fixture,dest,{recursive:true});await copyFile(replayPath,join(dest,"raw.rep"));
    const manifestPath=join(dest,"replay-manifest.json"),manifest=JSON.parse(await readFile(manifestPath,"utf8"));manifest.legacy.html_files=["report.html"];
    await writeFile(join(dest,"report.html"),"<html>watch fixture</html>");await writeFile(manifestPath,JSON.stringify(manifest));}};
  return createReplayPublisher(dependencies);}
function worker(){const dependencies:WorkerDependencies={analyze:publisher(),log:()=>{}};return createAnalysisWorker(dependencies);}

test("watch once filters candidates, handles .REP, and recurses only when requested",async()=>{
  await copyFile(join(fixture,"raw.rep"),join(inbox,"one.rep"));await writeFile(join(inbox,"TWO.REP"),"second replay");await writeFile(join(inbox,"notes.txt"),"ignore");
  await mkdir(join(inbox,"nested"));await writeFile(join(inbox,"nested","three.rep"),"third replay");
  const first=await createReplayWatcher().once(options());
  expect(first).toMatchObject({discovered:2,queued:2,alreadyActive:0,alreadyIndexed:0,deferred:0,errors:[]});
  expect(rows("SELECT count(*) n FROM replays")).toEqual([{n:2}]);
  expect(await readFile(join(inbox,"one.rep"))).toEqual(replayBytes);
  const recursive=await createReplayWatcher().once(options({recursive:true}));
  expect(recursive).toMatchObject({discovered:3,queued:1,alreadyActive:2,errors:[]});
  expect(rows("SELECT count(*) n FROM replays")).toEqual([{n:3}]);
});

test("startup reconciliation distinguishes active and indexed without changing identities",async()=>{
  await copyFile(join(fixture,"raw.rep"),join(inbox,"game.rep"));const watcher=createReplayWatcher();
  expect((await watcher.once(options())).queued).toBe(1);
  const writeDb=new BunDatabase(dbPath);writeDb.exec("INSERT INTO canonical_players(player_key,display_name,created_at_ms,updated_at_ms) VALUES ('watch-player','Watch Player',1,1)");writeDb.close();
  expect(await watcher.once(options())).toMatchObject({queued:0,alreadyActive:1});
  await worker().once({corpusRoot,dbPath,workerId:"watch-worker",leaseMs:300,heartbeatMs:50});
  expect(await watcher.once(options())).toMatchObject({queued:0,alreadyActive:0,alreadyIndexed:1});
  expect(rows("SELECT player_key,display_name FROM canonical_players")).toEqual([{player_key:"watch-player",display_name:"Watch Player"}]);
  expect(rows("SELECT count(*) n FROM analysis_jobs")).toEqual([{n:1}]);
});

test("growing files defer, stable files register, and disappearing candidates are benign",async()=>{
  const growing=join(inbox,"growing.rep");await writeFile(growing,"part");
  setTimeout(()=>void writeFile(growing,"part plus more"),25);
  const deferred=await createReplayWatcher().once(options({stabilityMs:80}));
  expect(deferred).toMatchObject({discovered:1,queued:0,deferred:1,errors:[]});
  expect((await createReplayWatcher().once(options({stabilityMs:20}))).queued).toBe(1);
  const vanishing=join(inbox,"vanishing.rep");await writeFile(vanishing,"soon gone");setTimeout(()=>void rm(vanishing),20);
  const removed=await createReplayWatcher().once(options({stabilityMs:60}));
  expect(removed.deferred).toBe(1);expect(removed.errors).toEqual([]);
  const recheckDir=join(temp,"recheck-inbox"),changing=join(recheckDir,"changing.rep"),observed:string[]=[],logs:string[]=[];await mkdir(recheckDir);await writeFile(changing,"first");
  const enqueue=(async(input:Parameters<typeof enqueueReplay>[0])=>{observed.push(await readFile(input.replayPath,"utf8"));return {
    status:"queued",replaySha256:"b".repeat(64),canonicalReplayPath:"managed.rep",rawReused:false,job:{jobKey:"job_rechecked"}
  } as Awaited<ReturnType<typeof enqueueReplay>>;}) as typeof enqueueReplay;
  const controller=new AbortController(),running=createReplayWatcher({enqueue,log:line=>logs.push(line)}).run({...options({paths:[recheckDir],stabilityMs:80}),signal:controller.signal});
  await waitFor(()=>logs.some(line=>line.includes("candidate waiting")),"changing candidate readiness");await writeFile(changing,"finished bytes");
  await waitFor(()=>observed.length===1,"changed candidate recheck");controller.abort();await running;expect(observed).toEqual(["finished bytes"]);
});

test("watch run detects live writes and atomic partial-to-replay renames",async()=>{
  const controller=new AbortController(),logs:string[]=[];
  const running=createReplayWatcher({enqueue:enqueueReplay,log:line=>logs.push(line)}).run({...options(),signal:controller.signal});
  try{
    await waitFor(()=>logs.some(line=>line.includes("startup scan complete")),"watcher startup");
    await copyFile(join(fixture,"raw.rep"),join(inbox,"live.rep"));
    await waitFor(()=>existsSync(dbPath)&&rows<{n:number}>("SELECT count(*) n FROM analysis_jobs")[0]?.n===1,"live replay queue");
    await writeFile(join(inbox,"rename.rep.partial"),"rename replay");await Bun.sleep(60);
    expect(rows("SELECT count(*) n FROM analysis_jobs")).toEqual([{n:1}]);
    await rename(join(inbox,"rename.rep.partial"),join(inbox,"rename.rep"));
    await waitFor(()=>rows<{n:number}>("SELECT count(*) n FROM analysis_jobs")[0]?.n===2,"renamed replay queue");
    expect(await readFile(join(inbox,"rename.rep"),"utf8")).toBe("rename replay");
  }finally{controller.abort();}
  const result=await running;
  expect(result.status).toBe("stopped");expect(logs.join("\n")).toContain("candidate detected");expect(logs.join("\n")).toContain("shutting down");
});

test("duplicate paths, replacement bytes, and racing watchers preserve SHA identity and provenance",async()=>{
  const a=join(inbox,"a.rep"),b=join(inbox,"b.rep");await copyFile(join(fixture,"raw.rep"),a);await copyFile(a,b);
  const [left,right]=await Promise.all([createReplayWatcher().once(options()),createReplayWatcher().once(options())]);
  expect(left.queued+right.queued).toBe(1);
  expect(rows("SELECT count(*) n FROM replays")).toEqual([{n:1}]);expect(rows("SELECT count(*) n FROM analysis_jobs")).toEqual([{n:1}]);
  expect(rows("SELECT source_ref FROM replay_sources ORDER BY source_ref")).toEqual([{source_ref:a},{source_ref:b}]);
  expect(rows("SELECT DISTINCT source_kind FROM replay_sources")).toEqual([{source_kind:"filesystem"}]);
  await writeFile(a,"different replay bytes");const replaced=await createReplayWatcher().once(options());expect(replaced.queued).toBe(1);
  expect(rows("SELECT count(*) n FROM replays")).toEqual([{n:2}]);expect(rows("SELECT count(*) n FROM analysis_jobs")).toEqual([{n:2}]);
  expect(rows("SELECT source_ref FROM replay_sources WHERE source_ref=?",[a])).toHaveLength(2);
  expect((await readdir(join(corpusRoot,"replays"))).length).toBe(2);
});

test("a registration error is isolated and does not terminate the live watcher",async()=>{
  const calls:string[]=[],logs:string[]=[];
  const enqueue=(async(input:Parameters<typeof enqueueReplay>[0])=>{calls.push(input.replayPath);if(input.replayPath.endsWith("bad.rep"))throw Object.assign(new Error("permission denied"),{code:"EACCES"});
    return {status:"queued",replaySha256:"a".repeat(64),canonicalReplayPath:"managed.rep",rawReused:false,job:{jobKey:"job_good"}} as Awaited<ReturnType<typeof enqueueReplay>>;}) as typeof enqueueReplay;
  const controller=new AbortController();const run=createReplayWatcher({enqueue,log:line=>logs.push(line)}).run({...options(),signal:controller.signal});
  await waitFor(()=>logs.some(line=>line.includes("startup scan complete")),"watcher startup");
  await writeFile(join(inbox,"bad.rep"),"bad");await writeFile(join(inbox,"good.rep"),"good");
  await waitFor(()=>calls.some(path=>path.endsWith("good.rep")),"good candidate after bad");controller.abort();const result=await run;
  expect(result.queued).toBe(1);expect(result.errors.some(error=>error.path.endsWith("bad.rep")&&error.message.includes("permission denied"))).toBe(true);
  expect(logs.join("\n")).toContain("registration error");
});

test("shutdown cancels pending readiness without starting registration",async()=>{
  await writeFile(join(inbox,"pending.rep"),"pending");const calls:string[]=[],logs:string[]=[];
  const enqueue=(async(input:Parameters<typeof enqueueReplay>[0])=>{calls.push(input.replayPath);throw new Error("must not enqueue");}) as typeof enqueueReplay;
  const controller=new AbortController(),running=createReplayWatcher({enqueue,log:line=>logs.push(line)}).run({...options({stabilityMs:5000}),signal:controller.signal});
  await waitFor(()=>logs.some(line=>line.includes("candidate waiting")),"pending readiness");const started=Date.now();controller.abort();
  const result=await running;expect(result.status).toBe("stopped");expect(Date.now()-started).toBeLessThan(1000);expect(calls).toEqual([]);
});

test("watcher rejects managed corpus paths and CLI once accepts repeatable paths",async()=>{
  await mkdir(join(corpusRoot,"replays"),{recursive:true});
  await expect(createReplayWatcher().once({...options(),paths:[join(temp,"missing")]})).rejects.toThrow();
  const notDirectory=join(temp,"not-a-directory");await writeFile(notDirectory,"file");
  await expect(createReplayWatcher().once({...options(),paths:[notDirectory]})).rejects.toThrow("not a directory");
  await expect(createReplayWatcher().once({...options(),paths:[corpusRoot]})).rejects.toThrow("overlaps managed corpus");
  await expect(createReplayWatcher().once({...options(),paths:[join(corpusRoot,"replays")]})).rejects.toThrow("overlaps managed corpus");
  const second=join(temp,"second-inbox");await mkdir(second);await copyFile(join(fixture,"raw.rep"),join(inbox,"one.rep"));await writeFile(join(second,"two.rep"),"second CLI replay");
  const repo=fileURLToPath(new URL("../../../",import.meta.url)),main=join(repo,"apps/cli/src/main.ts");
  const result=spawnSync(process.execPath,[main,"watch","once","--path",inbox,"--path",second,"--corpus-root",corpusRoot,"--db",dbPath,"--stability-ms","10"],
    {cwd:repo,encoding:"utf8",windowsHide:true,env:process.env});
  expect(result.status,result.stderr).toBe(0);expect(JSON.parse(result.stdout)).toMatchObject({discovered:2,queued:2,errors:[]});
  // Bun on Windows cannot receive POSIX signals; the cross-platform abort path
  // is exercised by the live watcher test.
  if(process.platform!=="win32"){
    const idle=join(temp,"idle-inbox");await mkdir(idle);
    const child=spawn(process.execPath,[main,"watch","run","--path",idle,"--corpus-root",corpusRoot,"--db",dbPath,"--stability-ms","10","--reconcile-seconds","1"],
      {cwd:repo,windowsHide:true,env:process.env,stdio:["ignore","pipe","pipe"]});
    let stdout="",stderr="";child.stdout.setEncoding("utf8").on("data",data=>stdout+=data);child.stderr.setEncoding("utf8").on("data",data=>stderr+=data);
    await waitFor(()=>stderr.includes("startup scan complete"),"CLI watcher startup");child.kill("SIGTERM");
    const exit=await new Promise<number|null>((done,reject)=>{child.once("error",reject);child.once("exit",done);});
    expect(exit).toBe(0);expect(JSON.parse(stdout).status).toBe("stopped");expect(stderr).toContain("shutting down");
  }
});

test("watcher to queue to worker remains durable after source deletion and becomes queryable",async()=>{
  const source=join(inbox,"end-to-end.rep");await copyFile(join(fixture,"raw.rep"),source);
  const watched=await createReplayWatcher().once(options());expect(watched.queued).toBe(1);await rm(source);
  const worked=await worker().once({corpusRoot,dbPath,workerId:"e2e-worker",leaseMs:300,heartbeatMs:50});expect(worked.status).toBe("succeeded");
  const queryDb=new BunDatabase(dbPath,{readonly:true});const adapter=queryAdapter(queryDb);
  const summary=getCorpusSummary(adapter,{});queryDb.close();expect(summary.replayCount).toBe(1);expect(summary.dataAvailability).toEqual({
    buildOrderEvents:true,economySamples:true,supplySamples:true,unitCountSamples:true,deathEvents:true});
  expect(rows("SELECT status,result_analysis_id FROM analysis_jobs")).toEqual([{status:"succeeded",result_analysis_id:1}]);
  expect(rows("PRAGMA integrity_check")).toEqual([{integrity_check:"ok"}]);expect(rows("PRAGMA foreign_key_check")).toEqual([]);
});

function queryAdapter(database:BunDatabase):QueryDatabase{return {
  run(sql,params){if(params===undefined)database.exec(sql);else database.query(sql).run(...(Array.isArray(params)?params:[params]) as never[]);},
  prepare(sql){const statement=database.query(sql);let data:Record<string,unknown>[]=[],index=-1;return {
    bind(values=[]){data=statement.all(...(Array.isArray(values)?values:[values]) as never[]) as Record<string,unknown>[];index=-1;},
    step(){index++;return index<data.length;},getAsObject(){return data[index]??{};},reset(){index=-1;},free(){}
  };},close(){database.close();}
};}

import { afterEach,beforeEach,expect,test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { spawn,spawnSync } from "node:child_process";
import { copyFile,cp,mkdtemp,readFile,readdir,rm,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createReplayPublisher,type PublicationDependencies } from "./publication.js";
import { ingestReplayAnalysis } from "./index.js";
import { claimAnalysisJob,createAnalysisWorker,enqueueReplay,heartbeatAnalysisJob,listAnalysisJobs,
  retryAnalysisJob,showAnalysisJob,type WorkerDependencies } from "./jobs.js";

let temp:string,fixture:string,corpusRoot:string,dbPath:string,source:string,calls:number;
const replaySha=createHash("sha256").update("replay").digest("hex");
beforeEach(async()=>{
  temp=await mkdtemp(join(tmpdir(),"bw-jobs-test-"));fixture=join(temp,"fixture");corpusRoot=join(temp,"corpus");dbPath=join(corpusRoot,"db","corpus.sqlite");
  const runtime=process.env.BW_FORGE_PYTHON??(process.platform==="win32"?"py":"python3");
  const result=spawnSync(runtime,[...(runtime==="py"?["-3"]:[]),fileURLToPath(new URL("../tests/publication_fixture.py",import.meta.url)),fixture],{encoding:"utf8",windowsHide:true});
  if(result.error)throw result.error;expect(result.status,result.stderr).toBe(0);source=join(fixture,"raw.rep");calls=0;
});
afterEach(async()=>{await rm(temp,{recursive:true,force:true});});
function rows(sql:string,params:unknown[]=[]){const db=new Database(dbPath,{readonly:true});try{return db.query(sql).all(...params as never[]);}finally{db.close();}}
function publisher(specification="jobs-fixture"){
  const dependencies:PublicationDependencies={specification:async()=>({bw_forge_version:"fixture",reducer_version:specification}),ingest:ingestReplayAnalysis,
    analyze:async({outputRoot,replayPath})=>{calls++;const dest=join(outputRoot,"replays",replaySha);await cp(fixture,dest,{recursive:true});
      await copyFile(replayPath,join(dest,"raw.rep"));
      const manifestPath=join(dest,"replay-manifest.json"),manifest=JSON.parse(await readFile(manifestPath,"utf8"));manifest.legacy.html_files=["report.html"];
      await writeFile(join(dest,"report.html"),"<html>queue fixture</html>");await writeFile(manifestPath,JSON.stringify(manifest));}};
  return createReplayPublisher(dependencies);
}
function worker(publish=publisher(),logs:string[]=[]){const dependencies:WorkerDependencies={analyze:publish,log:m=>logs.push(m)};return createAnalysisWorker(dependencies);}
const enqueue=(extra:Partial<Parameters<typeof enqueueReplay>[0]>={})=>enqueueReplay({replayPath:source,corpusRoot,dbPath,...extra});

test("enqueue owns canonical bytes, source can disappear, and worker once succeeds",async()=>{
  const queued=await enqueue();expect(queued.status).toBe("queued");expect(queued.rawReused).toBe(false);
  expect(queued.canonicalReplayPath).toBe(join(corpusRoot,"replays",replaySha.slice(0,2),`${replaySha}.rep`));
  expect(await readdir(join(corpusRoot,"replays",replaySha.slice(0,2)))).toEqual([`${replaySha}.rep`]);
  await rm(source);const logs:string[]=[];const result=await worker(publisher(),logs).once({corpusRoot,dbPath,workerId:"worker-one",leaseMs:300,heartbeatMs:50});
  expect(result.status).toBe("succeeded");expect(result.analysisKey).toBeString();
  const shown=await showAnalysisJob(dbPath,queued.job!.jobKey);expect(shown.job.resultAnalysisId).toBeNumber();expect(shown.job.resultAnalysisKey).toBe(String(result.analysisKey));
  expect(rows("SELECT analysis_id FROM current_analyses")).toEqual([{analysis_id:shown.job.resultAnalysisId}]);
  expect(logs.join("\n")).toContain(`claimed ${queued.job!.jobKey}`);expect(logs.join("\n")).toContain("analysis start");expect(logs.join("\n")).toContain("succeeded");
});

test("duplicate registrations deduplicate raw/job while distinct sources preserve provenance",async()=>{
  const first=await enqueue();const second=await enqueue();expect(second.status).toBe("already-queued");expect(second.job!.jobKey).toBe(first.job!.jobKey);expect(second.rawReused).toBe(true);
  expect(second.sourceRecorded).toBe(false);
  const other=join(temp,"another-name.rep");await cp(source,other);const third=await enqueue({replayPath:other});expect(third.status).toBe("already-queued");
  expect(third.sourceRecorded).toBe(true);
  expect(rows("SELECT count(*) n FROM replays")).toEqual([{n:1}]);expect(rows("SELECT count(*) n FROM analysis_jobs")).toEqual([{n:1}]);
  expect(rows("SELECT source_ref FROM replay_sources ORDER BY source_ref")).toHaveLength(2);
  expect((await showAnalysisJob(dbPath,first.job!.jobKey)).job.sources).toHaveLength(2);
});

test("mismatching managed replay content is rejected and never overwritten",async()=>{
  const first=await enqueue();await writeFile(first.canonicalReplayPath,"tampered canonical bytes");
  await expect(enqueue()).rejects.toThrow("Canonical replay content mismatch");
  expect(await readFile(first.canonicalReplayPath,"utf8")).toBe("tampered canonical bytes");
  expect(rows("SELECT count(*) n FROM analysis_jobs")).toEqual([{n:1}]);
});

test("indexed replay is not queued unless forced and force cannot duplicate active work",async()=>{
  await enqueue();await worker().once({corpusRoot,dbPath,workerId:"worker",leaseMs:300,heartbeatMs:50});
  const db=new Database(dbPath);db.exec("UPDATE replays SET played_at_unix_s=123");db.close();
  expect((await enqueue()).status).toBe("already-indexed");
  const forced=await enqueue({force:true});expect(forced.status).toBe("queued");
  const duplicate=await enqueue({force:true});expect(duplicate.status).toBe("already-queued");expect(duplicate.job!.jobKey).toBe(forced.job!.jobKey);
  expect(rows("SELECT count(*) n FROM analysis_jobs")).toEqual([{n:2}]);
  await worker().once({corpusRoot,dbPath,workerId:"reanalysis",leaseMs:300,heartbeatMs:50});
  expect(rows("SELECT played_at_unix_s FROM replays")).toEqual([{played_at_unix_s:123}]);
});

test("explicit analyzer failure is retained and retry preserves attempt history",async()=>{
  const queued=await enqueue();const logs:string[]=[];
  const failed=await worker(async()=>{throw Object.assign(new Error("bad replay"),{code:"BAD_REPLAY"});},logs)
    .once({corpusRoot,dbPath,workerId:"failure-worker",leaseMs:300,heartbeatMs:50});
  expect(failed.status).toBe("failed");let shown=(await showAnalysisJob(dbPath,queued.job!.jobKey)).job;
  expect(shown.lastError).toMatchObject({message:"bad replay",code:"BAD_REPLAY"});expect(shown.attempts).toMatchObject([{attemptNumber:1,outcome:"failed"}]);
  expect((await retryAnalysisJob(dbPath,shown.jobKey)).status).toBe("queued");
  const succeeded=await worker().once({corpusRoot,dbPath,workerId:"retry-worker",leaseMs:300,heartbeatMs:50});expect(succeeded.status).toBe("succeeded");
  shown=(await showAnalysisJob(dbPath,shown.jobKey)).job;expect(shown.attemptCount).toBe(2);expect(shown.attempts).toMatchObject([{outcome:"failed"},{outcome:"succeeded"}]);
  expect(logs.join("\n")).toContain("failed");
});

test("claim is exclusive, live heartbeat prevents reclaim, and expired lease is recovered",async()=>{
  await enqueue();const [a,b]=await Promise.all([claimAnalysisJob(dbPath,"worker-a",500),claimAnalysisJob(dbPath,"worker-b",500)]);
  const claimed=[a,b].find(r=>r.status==="claimed")!,idle=[a,b].find(r=>r.status==="idle")!;expect(claimed).toBeTruthy();expect(idle).toBeTruthy();
  const owner=claimed.job!.workerId!;await Bun.sleep(350);await heartbeatAnalysisJob(dbPath,claimed.job!.jobKey,owner,500);await Bun.sleep(250);
  expect((await claimAnalysisJob(dbPath,"worker-c",500)).status).toBe("idle");await Bun.sleep(300);
  const recovered=await claimAnalysisJob(dbPath,"worker-c",500);expect(recovered.status).toBe("claimed");expect(recovered.recoveredExpiredLease).toBe(true);expect(recovered.job!.attemptCount).toBe(2);
  expect((await showAnalysisJob(dbPath,recovered.job!.jobKey)).job.attempts).toMatchObject([{outcome:"abandoned"},{outcome:"running"}]);
});

test("maximum attempts converts an expired crash to failed without a spin loop",async()=>{
  const queued=await enqueue({maxAttempts:1});await claimAnalysisJob(dbPath,"crashed",40);await Bun.sleep(70);
  expect((await claimAnalysisJob(dbPath,"next",40)).status).toBe("idle");const shown=(await showAnalysisJob(dbPath,queued.job!.jobKey)).job;
  expect(shown.status).toBe("failed");expect(shown.attemptCount).toBe(1);expect(shown.lastError).toMatchObject({code:"LEASE_EXPIRED_MAX_ATTEMPTS"});
});

test("publication-before-bookkeeping crash is reclaimed and idempotently succeeds",async()=>{
  const queued=await enqueue({maxAttempts:3}),publish=publisher();await claimAnalysisJob(dbPath,"crashed-after-publish",50);
  const durable=await publish({replayPath:queued.canonicalReplayPath,corpusRoot,dbPath});expect(durable.ingest.status).toBe("indexed");await Bun.sleep(80);
  const recovered=await worker(publish).once({corpusRoot,dbPath,workerId:"recovery",leaseMs:300,heartbeatMs:50});
  expect(recovered.status).toBe("succeeded");expect(recovered.artifactsReused).toBe(true);expect(recovered.analysisKey).toBe(durable.analysisKey);
  expect(calls).toBe(2);expect(rows("SELECT count(*) n FROM analysis_runs")).toEqual([{n:1}]);
  expect((await showAnalysisJob(dbPath,queued.job!.jobKey)).job.attempts).toMatchObject([{outcome:"abandoned"},{outcome:"succeeded"}]);
});

test("priority ordering, inspection filters, and idle run shutdown",async()=>{
  const first=await enqueue({priority:1});const secondSource=join(temp,"second.rep");await writeFile(secondSource,"second replay");
  const second=await enqueueReplay({replayPath:secondSource,corpusRoot,dbPath,priority:5});
  expect((await claimAnalysisJob(dbPath,"order",300)).job!.jobKey).toBe(second.job!.jobKey);
  expect((await listAnalysisJobs(dbPath,{status:"queued",limit:1})).jobs.map(j=>j.jobKey)).toEqual([first.job!.jobKey]);
  // Use a separate empty corpus so run is actually idle.
  const idleRoot=join(temp,"idle"),idleDb=join(idleRoot,"db","corpus.sqlite"),controller=new AbortController(),logs:string[]=[];
  setTimeout(()=>controller.abort(),80);const result=await worker(publisher(),logs).run({corpusRoot:idleRoot,dbPath:idleDb,workerId:"idle-worker",pollMs:25,signal:controller.signal});
  expect(result).toEqual({status:"stopped",workerId:"idle-worker"});expect(logs).toEqual(["[worker idle-worker] started","[worker idle-worker] stopped"]);
});

test("queue operations preserve telemetry, identity mappings, current pointer and integrity",async()=>{
  await enqueue();await worker().once({corpusRoot,dbPath,workerId:"worker",leaseMs:300,heartbeatMs:50});
  const db=new Database(dbPath);db.exec("INSERT INTO canonical_players(player_key,display_name,created_at_ms,updated_at_ms) VALUES ('p','P',1,1)");db.close();
  const evidence=JSON.stringify({current:rows("SELECT * FROM current_analyses"),economy:rows("SELECT * FROM economy_changes"),identity:rows("SELECT * FROM canonical_players")});
  const forced=await enqueue({force:true});expect((await listAnalysisJobs(dbPath)).jobs.length).toBe(2);expect((await showAnalysisJob(dbPath,forced.job!.jobKey)).job.status).toBe("queued");
  expect(JSON.stringify({current:rows("SELECT * FROM current_analyses"),economy:rows("SELECT * FROM economy_changes"),identity:rows("SELECT * FROM canonical_players")})).toBe(evidence);
  expect(rows("PRAGMA integrity_check")).toEqual([{integrity_check:"ok"}]);expect(rows("PRAGMA foreign_key_check")).toEqual([]);
});

test("jobs CLI inspects and retries while worker run starts idle and stops on SIGTERM",async()=>{
  const queued=await enqueue();await worker(async()=>{throw new Error("CLI retry fixture");}).once({corpusRoot,dbPath,workerId:"failure",leaseMs:300,heartbeatMs:50});
  const repo=fileURLToPath(new URL("../../../",import.meta.url)),main=join(repo,"apps/cli/src/main.ts");
  const cli=(args:string[])=>{const result=spawnSync(process.execPath,[main,...args],{cwd:repo,encoding:"utf8",windowsHide:true,env:process.env});
    expect(result.status,result.stderr).toBe(0);return JSON.parse(result.stdout);};
  expect(cli(["jobs","show",queued.job!.jobKey,"--db",dbPath]).job.status).toBe("failed");
  expect(cli(["jobs","list","--db",dbPath,"--status","failed","--limit","1"]).jobs).toHaveLength(1);
  expect(cli(["jobs","retry",queued.job!.jobKey,"--db",dbPath]).status).toBe("queued");

  // Windows process termination does not deliver POSIX SIGTERM to Bun. The
  // cross-platform AbortSignal behavior is covered by the idle API test above.
  if(process.platform==="win32")return;
  const idleRoot=join(temp,"cli-idle"),idleDb=join(idleRoot,"db","corpus.sqlite");
  const child=spawn(process.execPath,[main,"worker","run","--corpus-root",idleRoot,"--db",idleDb,"--worker-id","cli-idle","--poll-ms","25"],
    {cwd:repo,windowsHide:true,env:process.env,stdio:["ignore","pipe","pipe"]});
  let stdout="",stderr="";child.stdout.setEncoding("utf8").on("data",d=>stdout+=d);child.stderr.setEncoding("utf8").on("data",d=>stderr+=d);
  await new Promise<void>((resolvePromise,reject)=>{const deadline=setTimeout(()=>reject(new Error(`worker did not start: ${stderr}`)),5000);
    const inspect=()=>{if(stderr.includes("[worker cli-idle] started")){clearTimeout(deadline);resolvePromise();}else setTimeout(inspect,10);};inspect();});
  child.kill("SIGTERM");const exit=await new Promise<number|null>((resolvePromise,reject)=>{child.once("error",reject);child.once("exit",resolvePromise);});
  expect(exit).toBe(0);expect(JSON.parse(stdout)).toEqual({status:"stopped",workerId:"cli-idle"});expect(stderr).toContain("[worker cli-idle] stopped");
});

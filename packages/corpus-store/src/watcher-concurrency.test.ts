import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import type { FSWatcher } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { enqueueReplay } from "./jobs.js";
import { createReplayWatcher, WATCH_DEFAULTS } from "./watcher.js";

let temp:string,corpusRoot:string,dbPath:string,inbox:string;
beforeEach(async()=>{
  temp=await mkdtemp(join(tmpdir(),"bw-watch-concurrency-test-"));corpusRoot=join(temp,"corpus");dbPath=join(corpusRoot,"db","corpus.sqlite");inbox=join(temp,"inbox");
  await mkdir(inbox,{recursive:true});
});
afterEach(async()=>{await rm(temp,{recursive:true,force:true});});

const options=(extra:Record<string,unknown>={})=>({paths:[inbox],corpusRoot,dbPath,stabilityMs:0,reconcileMs:5000,...extra});
async function waitFor(check:()=>boolean|Promise<boolean>,message:string,timeout=10000){const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await Bun.sleep(10);}throw new Error(message);}
const fakeQueued=(path:string)=>({status:"queued",replaySha256:createHash("sha256").update(path).digest("hex"),canonicalReplayPath:"managed.rep",rawReused:false,
  job:{jobKey:`job_${createHash("sha256").update(path).digest("hex")}`}} as Awaited<ReturnType<typeof enqueueReplay>>);
async function replaySet(directory:string,count:number,prefix="startup"){
  await Promise.all(Array.from({length:count},(_,index)=>writeFile(join(directory,`${prefix}-${String(index).padStart(3,"0")}.rep`),`replay ${index}`)));
}
async function startupConcurrency(registrationConcurrency:number|undefined,count=105){
  await replaySet(inbox,count);let active=0,max=0,calls=0;const logs:string[]=[];
  const enqueue=(async(input:Parameters<typeof enqueueReplay>[0])=>{calls++;active++;max=Math.max(max,active);try{await Bun.sleep(5);return fakeQueued(input.replayPath);}finally{active--;}}) as typeof enqueueReplay;
  const controller=new AbortController(),running=createReplayWatcher({enqueue,log:line=>logs.push(line)}).run({...options({
    ...(registrationConcurrency===undefined?{}:{registrationConcurrency})}),signal:controller.signal});
  await waitFor(()=>logs.some(line=>line.includes("startup scan complete")),"bounded startup scan");controller.abort();await running;
  return {max,calls,logs};
}

test("large startup scans use the bounded default registration concurrency",async()=>{
  const observed=await startupConcurrency(undefined);
  expect(WATCH_DEFAULTS.registrationConcurrency).toBe(4);expect(observed.max).toBe(4);expect(observed.calls).toBe(105);
  expect(observed.logs[0]).toContain("registrationConcurrency=4");
});

test("registration concurrency 1 serializes a large startup scan",async()=>{
  const observed=await startupConcurrency(1);expect(observed.max).toBe(1);expect(observed.calls).toBe(105);
});

test("registration concurrency 4 admits exactly four startup registrations",async()=>{
  const observed=await startupConcurrency(4);expect(observed.max).toBe(4);expect(observed.calls).toBe(105);
});

test("event bursts during startup reconciliation share the gate and abort drops queued registrations",async()=>{
  await replaySet(inbox,2,"initial");let active=0,max=0,calls=0;const releases:(()=>void)[]=[],logs:string[]=[];
  const enqueue=(async(input:Parameters<typeof enqueueReplay>[0])=>{calls++;active++;max=Math.max(max,active);await new Promise<void>(done=>releases.push(done));active--;return fakeQueued(input.replayPath);}) as typeof enqueueReplay;
  const controller=new AbortController(),running=createReplayWatcher({enqueue,log:line=>logs.push(line)}).run({...options({registrationConcurrency:2}),signal:controller.signal});
  await waitFor(()=>active===2,"two admitted startup registrations");await replaySet(inbox,40,"event");
  await waitFor(()=>logs.some(line=>line.includes("candidate detected")&&line.includes("event-")),"filesystem event burst");
  await Bun.sleep(50);expect(max).toBe(2);expect(calls).toBe(2);
  const started=Date.now();controller.abort();for(const release of releases.splice(0))release();const result=await running;
  expect(result.status).toBe("stopped");expect(Date.now()-started).toBeLessThan(1000);expect(calls).toBe(2);
  await Bun.sleep(50);expect(calls).toBe(2);
});

test("multiple roots and recursive directories cannot multiply the global bound",async()=>{
  const second=join(temp,"second-root"),nestedA=join(inbox,"nested"),nestedB=join(second,"nested");
  await mkdir(nestedA);await mkdir(nestedB,{recursive:true});await Promise.all([replaySet(inbox,20,"a"),replaySet(nestedA,20,"na"),replaySet(second,20,"b"),replaySet(nestedB,20,"nb")]);
  let active=0,max=0,calls=0;const logs:string[]=[];
  const enqueue=(async(input:Parameters<typeof enqueueReplay>[0])=>{calls++;active++;max=Math.max(max,active);try{await Bun.sleep(4);return fakeQueued(input.replayPath);}finally{active--;}}) as typeof enqueueReplay;
  const controller=new AbortController(),running=createReplayWatcher({enqueue,log:line=>logs.push(line)}).run({...options({paths:[inbox,second],recursive:true,registrationConcurrency:3}),signal:controller.signal});
  await waitFor(()=>logs.some(line=>line.includes("startup scan complete")),"recursive multi-root startup");controller.abort();await running;
  expect(calls).toBe(80);expect(max).toBe(3);
});

test("repeated events for an active path do not register it in parallel",async()=>{
  const path=join(inbox,"same.rep");await writeFile(path,"first");let active=0,max=0,calls=0;let release!:()=>void;
  const enqueue=(async(input:Parameters<typeof enqueueReplay>[0])=>{calls++;active++;max=Math.max(max,active);await new Promise<void>(done=>release=done);active--;return fakeQueued(input.replayPath);}) as typeof enqueueReplay;
  const controller=new AbortController(),running=createReplayWatcher({enqueue,log:()=>{}}).run({...options({registrationConcurrency:4}),signal:controller.signal});
  await waitFor(()=>active===1,"active registration");for(let index=0;index<5;index++)await writeFile(path,`change ${index}`);
  await Bun.sleep(50);expect(calls).toBe(1);expect(max).toBe(1);controller.abort();release();await running;expect(calls).toBe(1);
});

test("registration failures release slots and later candidates proceed",async()=>{
  await replaySet(inbox,24);let active=0,max=0,calls=0;const logs:string[]=[];
  const enqueue=(async(input:Parameters<typeof enqueueReplay>[0])=>{const call=calls++;active++;max=Math.max(max,active);try{await Bun.sleep(3);if(call%2===0)throw new Error("fixture failure");return fakeQueued(input.replayPath);}finally{active--;}}) as typeof enqueueReplay;
  const controller=new AbortController(),running=createReplayWatcher({enqueue,log:line=>logs.push(line)}).run({...options({registrationConcurrency:4}),signal:controller.signal});
  await waitFor(()=>logs.some(line=>line.includes("startup scan complete")),"startup after registration errors");controller.abort();const result=await running;
  expect(calls).toBe(24);expect(max).toBe(4);expect(result.queued).toBe(12);expect(result.errors).toHaveLength(12);
});

test("watch once remains sequential even when registration concurrency is configured",async()=>{
  await replaySet(inbox,20);let active=0,max=0;
  const enqueue=(async(input:Parameters<typeof enqueueReplay>[0])=>{active++;max=Math.max(max,active);try{await Bun.sleep(2);return fakeQueued(input.replayPath);}finally{active--;}}) as typeof enqueueReplay;
  const result=await createReplayWatcher({enqueue,log:()=>{}}).once(options({registrationConcurrency:4}));
  expect(result.queued).toBe(20);expect(max).toBe(1);
});

test("periodic reconciliation continues after startup",async()=>{
  let calls=0;const logs:string[]=[];
  const enqueue=(async(input:Parameters<typeof enqueueReplay>[0])=>{calls++;return fakeQueued(input.replayPath);}) as typeof enqueueReplay;
  const silentWatcher={on(){return this;},close(){}} as unknown as FSWatcher;
  const watchDirectory=(()=>silentWatcher) as unknown as typeof import("node:fs").watch;
  const controller=new AbortController(),running=createReplayWatcher({enqueue,log:line=>logs.push(line),watchDirectory}).run({...options({reconcileMs:100}),signal:controller.signal});
  await waitFor(()=>logs.some(line=>line.includes("startup scan complete")),"empty startup scan");await writeFile(join(inbox,"periodic.rep"),"periodic replay");
  await waitFor(()=>calls===1,"periodic reconciliation registration");controller.abort();await running;expect(calls).toBe(1);
});

test("watcher and CLI reject invalid registration concurrency values",async()=>{
  for(const value of [0,-1,1.5,Number.NaN]){
    await expect(createReplayWatcher().once(options({registrationConcurrency:value}))).rejects.toThrow("registrationConcurrency must be an integer of at least 1");
  }
  const repo=fileURLToPath(new URL("../../../",import.meta.url)),main=join(repo,"apps/cli/src/main.ts");
  for(const value of ["0","-1","1.5","invalid"]){
    const result=spawnSync(process.execPath,[main,"watch","once","--path",inbox,"--corpus-root",corpusRoot,"--db",dbPath,"--registration-concurrency",value],
      {cwd:repo,encoding:"utf8",windowsHide:true,env:process.env});
    expect(result.status).not.toBe(0);expect(result.stderr).toMatch(/registration-concurrency must be an integer|registrationConcurrency must be an integer of at least 1/);
  }
});

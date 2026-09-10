import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { resolve, join } from "node:path";
import { stat } from "node:fs/promises";
import { analyzeAndPublishReplay, registerCanonicalReplay, type PublishedReplayAnalysisResult } from "./publication.js";
import { runStore } from "./index.js";

export const JOB_DEFAULTS = {
  maxAttempts: 3,
  leaseMs: 60_000,
  heartbeatMs: 20_000,
  pollMs: 1_000,
  listLimit: 100
} as const;

export type JobStatus = "queued" | "running" | "succeeded" | "failed";
export interface AnalysisJob {
  jobKey:string; replaySha256:string; status:JobStatus; priority:number;
  createdAtMs:number; availableAtMs:number; startedAtMs:number|null; finishedAtMs:number|null;
  attemptCount:number; maxAttempts:number; workerId:string|null; leaseExpiresAtMs:number|null;
  lastHeartbeatAtMs:number|null; resultAnalysisId:number|null; resultAnalysisKey:string|null;
  lastError:{name?:string;message:string;stack?:string;code?:string}|null; canonicalRelativePath:string;
  attempts?:unknown[]; sources?:unknown[];
}
type JobResult = {status:string;job?:AnalysisJob;[key:string]:unknown};

async function command<T>(dbPath:string,operation:string,payload:Record<string,unknown>={}):Promise<T>{
  return runStore<T>(["jobs",operation,"--db",resolve(dbPath),"--payload",JSON.stringify(payload)]);
}

export async function enqueueReplay(options:{
  replayPath:string;corpusRoot:string;dbPath:string;priority?:number;force?:boolean;maxAttempts?:number;
  sourceKind?:string;sourceRef?:string;
}):Promise<JobResult & {replaySha256:string;canonicalReplayPath:string;rawReused:boolean}>{
  const priority=options.priority??0,maxAttempts=options.maxAttempts??JOB_DEFAULTS.maxAttempts;
  if(!Number.isSafeInteger(priority))throw new Error("priority must be an integer");
  if(!Number.isSafeInteger(maxAttempts)||maxAttempts<1)throw new Error("maxAttempts must be a positive integer");
  const registered=await registerCanonicalReplay(options);
  const result=await command<JobResult>(options.dbPath,"enqueue",{
    sha256:registered.replaySha256,byte_size:registered.byteSize,raw_relative_path:registered.canonicalRelativePath,
    played_at_unix_s:registered.playedAtUnixSeconds,
    source_kind:options.sourceKind??"manual",source_ref:resolve(options.sourceRef??options.replayPath),
    priority,force:options.force??false,max_attempts:maxAttempts
  });
  return {...result,replaySha256:registered.replaySha256,canonicalReplayPath:registered.canonicalReplayPath,rawReused:registered.reused,
    playedAtUnixSeconds:registered.playedAtUnixSeconds,metadataError:registered.metadataError};
}

export const listAnalysisJobs=(dbPath:string,options:{status?:JobStatus;limit?:number}={})=>{
  const limit=options.limit??JOB_DEFAULTS.listLimit;
  if(!Number.isSafeInteger(limit)||limit<1||limit>500)throw new Error("limit must be an integer from 1 to 500");
  return command<{jobs:AnalysisJob[]}>(dbPath,"list",{...options,limit});
};
export const showAnalysisJob=(dbPath:string,jobKey:string)=>command<{job:AnalysisJob}>(dbPath,"show",{job_key:jobKey});
export const retryAnalysisJob=(dbPath:string,jobKey:string)=>command<JobResult>(dbPath,"retry",{job_key:jobKey});
export const claimAnalysisJob=(dbPath:string,workerId:string,leaseMs:number=JOB_DEFAULTS.leaseMs)=>
  command<JobResult>(dbPath,"claim",{worker_id:workerId,lease_ms:leaseMs});
export const heartbeatAnalysisJob=(dbPath:string,jobKey:string,workerId:string,leaseMs:number=JOB_DEFAULTS.leaseMs)=>
  command<JobResult>(dbPath,"heartbeat",{job_key:jobKey,worker_id:workerId,lease_ms:leaseMs});
export const succeedAnalysisJob=(dbPath:string,jobKey:string,workerId:string,analysisId:number)=>
  command<JobResult>(dbPath,"succeed",{job_key:jobKey,worker_id:workerId,analysis_id:analysisId});
export const failAnalysisJob=(dbPath:string,jobKey:string,workerId:string,error:unknown)=>
  command<JobResult>(dbPath,"fail",{job_key:jobKey,worker_id:workerId,error:errorSummary(error)});

export function createWorkerId():string{return `${hostname()}:${process.pid}:${randomUUID().slice(0,8)}`;}
export interface WorkerDependencies {
  analyze:(options:{replayPath:string;corpusRoot:string;dbPath?:string})=>Promise<PublishedReplayAnalysisResult>;
  log:(message:string)=>void;
}
const defaultDependencies:WorkerDependencies={analyze:analyzeAndPublishReplay,log:message=>process.stderr.write(`${message}\n`)};

export function createAnalysisWorker(dependencies:WorkerDependencies=defaultDependencies){
  async function once(options:{corpusRoot:string;dbPath:string;workerId:string;leaseMs?:number;heartbeatMs?:number}):Promise<JobResult>{
    const leaseMs=options.leaseMs??JOB_DEFAULTS.leaseMs,heartbeatMs=options.heartbeatMs??Math.min(JOB_DEFAULTS.heartbeatMs,Math.floor(leaseMs/3));
    if(leaseMs<30||heartbeatMs<10||heartbeatMs>=leaseMs)throw new Error("heartbeatMs must be at least 10 and less than leaseMs");
    const claimed=await claimAnalysisJob(options.dbPath,options.workerId,leaseMs);
    if(claimed.status==="idle")return claimed;
    const job=claimed.job!;
    dependencies.log(`[worker ${options.workerId}] claimed ${job.jobKey} replay=${job.replaySha256} attempt=${job.attemptCount}${claimed.recoveredExpiredLease?" recovered=expired-lease":""}`);
    const expected=resolve(options.corpusRoot,"replays",job.replaySha256.slice(0,2),`${job.replaySha256}.rep`);
    const recorded=resolve(options.corpusRoot,job.canonicalRelativePath);
    let heartbeatFailure:unknown, inFlight:Promise<void>|undefined;
    const beat=()=>{if(inFlight)return;inFlight=heartbeatAnalysisJob(options.dbPath,job.jobKey,options.workerId,leaseMs)
      .then(()=>undefined).catch(error=>{heartbeatFailure=error;}).finally(()=>{inFlight=undefined;});};
    const timer=setInterval(beat,heartbeatMs);
    let publicationSucceeded=false;
    try{
      if(recorded!==expected||(await stat(expected)).isFile()!==true)throw new Error("Job canonical replay path does not match corpus root and SHA");
      dependencies.log(`[worker ${options.workerId}] analysis start ${job.jobKey}`);
      const analysis=await dependencies.analyze({replayPath:expected,corpusRoot:options.corpusRoot,dbPath:options.dbPath});
      publicationSucceeded=true;
      clearInterval(timer);if(inFlight)await inFlight;
      if(heartbeatFailure)throw heartbeatFailure;
      const completed=await succeedAnalysisJob(options.dbPath,job.jobKey,options.workerId,analysis.ingest.analysisId);
      dependencies.log(`[worker ${options.workerId}] succeeded ${job.jobKey} analysis=${analysis.analysisKey}`);
      return {...completed,analysisKey:analysis.analysisKey,artifactsReused:analysis.artifactsReused};
    }catch(error){
      clearInterval(timer);if(inFlight)await inFlight;
      if(heartbeatFailure){dependencies.log(`[worker ${options.workerId}] lease heartbeat lost ${job.jobKey}: ${errorSummary(heartbeatFailure).message}`);throw heartbeatFailure;}
      // Publication may already be durable. Leave the lease to expire so an
      // at-least-once retry can reuse it and perform success bookkeeping.
      if(publicationSucceeded){dependencies.log(`[worker ${options.workerId}] success bookkeeping lost ${job.jobKey}: ${errorSummary(error).message}`);throw error;}
      try{
        const failed=await failAnalysisJob(options.dbPath,job.jobKey,options.workerId,error);
        dependencies.log(`[worker ${options.workerId}] failed ${job.jobKey}: ${errorSummary(error).message}`);
        return failed;
      }catch(bookkeeping){
        dependencies.log(`[worker ${options.workerId}] failure bookkeeping lost ${job.jobKey}: ${errorSummary(bookkeeping).message}`);
        throw bookkeeping;
      }
    }
  }
  return {once,async run(options:{corpusRoot:string;dbPath:string;workerId:string;pollMs?:number;leaseMs?:number;heartbeatMs?:number;signal?:AbortSignal}){
    const poll=options.pollMs??JOB_DEFAULTS.pollMs;if(!Number.isSafeInteger(poll)||poll<25)throw new Error("pollMs must be at least 25");
    dependencies.log(`[worker ${options.workerId}] started`);
    while(!options.signal?.aborted){const result=await once(options);if(result.status==="idle")await delay(poll,options.signal);}
    dependencies.log(`[worker ${options.workerId}] stopped`);return {status:"stopped",workerId:options.workerId};
  }};
}

function errorSummary(error:unknown){const e=error as {name?:string;message?:string;stack?:string;code?:string};
  return {name:e?.name??"Error",message:e?.message??String(error),...(e?.code?{code:e.code}:{}),...(e?.stack?{stack:e.stack.slice(0,8192)}:{})};}
function delay(ms:number,signal?:AbortSignal){return new Promise<void>(resolvePromise=>{
  if(signal?.aborted)return resolvePromise();const timer=setTimeout(done,ms);
  function done(){clearTimeout(timer);signal?.removeEventListener("abort",done);resolvePromise();}signal?.addEventListener("abort",done,{once:true});
});}

import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
const main=join(import.meta.dir,"main.ts");
function python():string{
  if(process.env.BW_FORGE_PYTHON)return process.env.BW_FORGE_PYTHON;
  const embedded=join(homedir(),".cache","codex-runtimes","codex-primary-runtime","dependencies","python","python.exe");
  return process.platform==="win32"&&existsSync(embedded)?embedded:"python3";
}
function run(args:string[]){return spawnSync(process.execPath,[main,"identities","import",...args],{
  cwd:join(import.meta.dir,"../../.."),encoding:"utf8",windowsHide:true,env:{...process.env,BW_FORGE_PYTHON:python()}});}

test("identities import CLI dry-runs and atomically writes a complete catalog",async()=>{
  const root=await mkdtemp(join(tmpdir(),"bw-identities-cli-"));roots.push(root);
  const base=join(root,"identities.json"),input=join(root,"aliases.csv"),output=join(root,"next.json");
  await writeFile(base,JSON.stringify({schema_version:"bw-forge-identities-v1",players:[
    {key:"jaedong",display_name:"Jaedong",aliases:[]}],overrides:[],groups:[],scopes:[]}));
  await writeFile(input,"player_key,display_name,namespace,alias\njaedong,Jaedong,legacy-unknown,July\n");
  const dry=run([input,"--base",base,"--output",output,"--format","csv","--dry-run"]);
  expect(dry.status).toBe(0);expect(JSON.parse(dry.stdout)).toMatchObject({status:"dry-run",aliasesAdded:1,conflicts:0});
  expect(existsSync(output)).toBe(false);
  const write=run([input,"--base",base,"--output",output]);
  expect(write.status).toBe(0);expect(JSON.parse(write.stdout).status).toBe("written");
  expect(JSON.parse(await readFile(output,"utf8")).players[0].aliases).toEqual([{namespace:"legacy-unknown",name:"July"}]);
});

test("identities import CLI returns structured conflicts and writes nothing",async()=>{
  const root=await mkdtemp(join(tmpdir(),"bw-identities-cli-conflict-"));roots.push(root);
  const base=join(root,"identities.json"),input=join(root,"aliases.json"),output=join(root,"next.json");
  await writeFile(base,JSON.stringify({schema_version:"bw-forge-identities-v1",players:[],overrides:[],groups:[],scopes:[]}));
  await writeFile(input,JSON.stringify([{player_key:"typo",namespace:"legacy-unknown",alias:"July"}]));
  const result=run([input,"--base",base,"--output",output,"--dry-run"]),payload=JSON.parse(result.stdout);
  expect(result.status).toBe(2);expect(payload).toMatchObject({status:"dry-run",conflicts:1});
  expect(payload.conflictDetails[0].type).toBe("unknown_player");expect(result.stderr).toContain("Unknown canonical player_key");
  expect(existsSync(output)).toBe(false);
});

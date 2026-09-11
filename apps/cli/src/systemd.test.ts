import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { chmod, chown, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo=fileURLToPath(new URL("../../../",import.meta.url));
const renderer=join(repo,"ops/systemd/render.mjs"),installer=join(repo,"ops/systemd/install.sh");
const temporary:string[]=[];
afterEach(async()=>{for(const path of temporary.splice(0))await rm(path,{recursive:true,force:true});});

function rendererArgs(output:string,extra:string[]=[]){return [renderer,"--output-dir",output,"--user","replay-user",
  "--app-root","/srv/BW Forge/app $stable%v7","--corpus-root","/srv/BW Forge/corpus data","--inbox","/srv/BW Forge/inbox one",
  "--db","/srv/BW Forge/corpus data/db/corpus.sqlite","--bun","/usr/local/bin/bun","--node","/usr/local/bin/node","--python","/usr/bin/python3",...extra];}
function run(command:string,args:string[],cwd=repo){return spawnSync(command,args,{cwd,encoding:"utf8",windowsHide:true});}
async function temp(prefix:string){const path=await mkdtemp(join(tmpdir(),prefix));temporary.push(path);return path;}
async function unitFiles(directory:string){const result:Record<string,Buffer>={};for(const name of ["bw-forge-watch.service","bw-forge-worker.service","bw-forge-mcp.service","bw-forge-reports-index.service","bw-forge-reports-index.timer","bw-forge.target"])result[name]=await readFile(join(directory,name));return result;}
async function files(directory:string):Promise<Record<string,Buffer>>{return {...await unitFiles(directory),"bw-forge.env":await readFile(join(directory,"bw-forge.env"))};}

test("systemd renderer emits safe centralized configuration and independent services",async()=>{
  const output=await temp("bw-systemd-render-");let result=run(process.env.BW_FORGE_NODE??"node",rendererArgs(output));
  expect(result.status,result.stderr).toBe(0);const first=await files(output);
  const env=first["bw-forge.env"].toString(),watch=first["bw-forge-watch.service"].toString(),worker=first["bw-forge-worker.service"].toString(),mcp=first["bw-forge-mcp.service"].toString(),target=first["bw-forge.target"].toString();
  const reports=first["bw-forge-reports-index.service"].toString(),timer=first["bw-forge-reports-index.timer"].toString();
  expect(env).toContain('BW_FORGE_APP_ROOT="/srv/BW Forge/app $stable%v7"');
  expect(env).toContain('BW_FORGE_MCP_HOST="127.0.0.1"');expect(env).toContain('BW_FORGE_MCP_PORT="8089"');expect(env).toContain('BW_FORGE_MCP_PATH="/mcp"');
  for(const unit of [watch,worker,mcp]){
    expect(unit).toContain("User=replay-user");expect(unit).not.toContain("User=root");
    expect(unit).toContain('WorkingDirectory=/srv/BW\\x20Forge/app\\x20$stable%%v7');expect(unit).toContain('EnvironmentFile=/etc/bw-forge/bw-forge.env');
    expect(unit).toContain("Restart=on-failure");expect(unit).not.toContain("Restart=always");expect(unit).toContain("RestartSec=2s");
    expect(unit).toContain("KillSignal=SIGTERM");expect(unit).toContain("NoNewPrivileges=true");expect(unit).toContain("PrivateTmp=true");expect(unit).toContain("UMask=0027");
    expect(unit).toContain("StandardOutput=journal");expect(unit).toContain("PartOf=bw-forge.target");expect(unit).not.toContain("network-online.target");
  }
  expect(watch).toContain('"/usr/local/bin/bun" "/srv/BW Forge/app $$stable%%v7/apps/cli/src/main.ts" watch run --path ${BW_FORGE_INBOX}');
  expect(worker).toContain("worker run --corpus-root ${BW_FORGE_CORPUS_ROOT} --db ${BW_FORGE_DB}");expect(worker).toContain("TimeoutStopSec=15min");
  expect(mcp).toContain("mcp --db ${BW_FORGE_DB} --transport http --host ${BW_FORGE_MCP_HOST} --port ${BW_FORGE_MCP_PORT} --path ${BW_FORGE_MCP_PATH}");
  expect(reports).toContain("User=replay-user");expect(reports).toContain("Type=oneshot");expect(reports).toContain("UMask=0022");
  expect(reports).toContain('reports index --db ${BW_FORGE_DB} --analyses-root "/srv/BW Forge/corpus data/analyses"');expect(reports).not.toContain("Restart=");
  expect(timer).toContain("OnUnitActiveSec=1min");expect(timer).toContain("Persistent=true");expect(timer).toContain("PartOf=bw-forge.target");
  expect(target).toContain("bw-forge-reports-index.timer");
  expect(target).toContain("Wants=bw-forge-watch.service bw-forge-worker.service bw-forge-mcp.service");expect(target).toContain("WantedBy=multi-user.target");
  result=run(process.env.BW_FORGE_NODE??"node",rendererArgs(output));expect(result.status,result.stderr).toBe(0);expect(await files(output)).toEqual(first);
});

test("renderer rejects unsafe configuration",async()=>{
  for(const extra of [["--user","bad/user"],["--user","-root"],["--mcp-host","bad host"],["--mcp-port","0"],["--mcp-path","relative"],["--stability-ms","-1"],["--app-root","relative"]]){
    const output=await temp("bw-systemd-invalid-");const result=run(process.env.BW_FORGE_NODE??"node",rendererArgs(output,extra));expect(result.status).not.toBe(0);
  }
});

test("installer shell is syntactically valid",()=>{
  const result=run("bash",["-n","ops/systemd/install.sh"]);
  if(result.error&&(result.error as NodeJS.ErrnoException).code==="ENOENT")return;
  expect(result.status,result.stderr).toBe(0);
  const missing=run("bash",["ops/systemd/install.sh"]);expect(missing.status).not.toBe(0);expect(missing.stderr).toContain("--user is required");
},15000);

test("Linux staged installer validates inputs and is idempotent without touching Corpus",async()=>{
  if(process.platform!=="linux")return;
  const root=await temp("bw-systemd-install-"),app=join(root,"app root"),corpus=join(root,"corpus"),inbox=join(root,"inbox"),db=join(corpus,"db","corpus.sqlite"),dest=join(root,"stage");
  await mkdir(join(app,"apps/cli/src"),{recursive:true});await writeFile(join(app,"apps/cli/src/main.ts"),"// fixture\n");await mkdir(dirname(db),{recursive:true});await mkdir(join(corpus,"analyses"));await mkdir(inbox);
  const corpusDb=new Database(db);corpusDb.exec("CREATE TABLE analysis_jobs(job_key TEXT);INSERT INTO analysis_jobs VALUES ('queued');CREATE TABLE canonical_players(player_key TEXT);INSERT INTO canonical_players VALUES ('goose');CREATE TABLE analysis_runs(analysis_key TEXT);INSERT INTO analysis_runs VALUES ('analysis');CREATE TABLE economy_changes(frame INTEGER);INSERT INTO economy_changes VALUES (42)");corpusDb.close();
  let user=run("id",["-un"]).stdout.trim();if(user==="root")user="nobody";
  if(run("id",[user]).status!==0)return;
  if(run("id",["-u"]).stdout.trim()==="0"){
    await chmod(root,0o755);for(const path of [app,corpus,join(corpus,"analyses"),inbox]){const ids=run("id",["-u",user]).stdout.trim(),group=run("id",["-g",user]).stdout.trim();await chown(path,Number(ids),Number(group));}
    await chown(join(app,"apps"),Number(run("id",["-u",user]).stdout.trim()),Number(run("id",["-g",user]).stdout.trim()));
    await chown(join(app,"apps/cli"),Number(run("id",["-u",user]).stdout.trim()),Number(run("id",["-g",user]).stdout.trim()));
    await chown(join(app,"apps/cli/src"),Number(run("id",["-u",user]).stdout.trim()),Number(run("id",["-g",user]).stdout.trim()));
    await chown(join(app,"apps/cli/src/main.ts"),Number(run("id",["-u",user]).stdout.trim()),Number(run("id",["-g",user]).stdout.trim()));
    await chown(join(corpus,"db"),Number(run("id",["-u",user]).stdout.trim()),Number(run("id",["-g",user]).stdout.trim()));await chown(db,Number(run("id",["-u",user]).stdout.trim()),Number(run("id",["-g",user]).stdout.trim()));
  }
  const which=(name:string)=>run("sh",["-c",`command -v ${name}`]).stdout.trim(),bun=which("bun"),node=which("node"),python=which("python3");if(!bun||!node||!python)return;
  const base=[installer,"--destdir",dest,"--user",user,"--app-root",app,"--corpus-root",corpus,"--inbox",inbox,"--db",db,"--bun",bun,"--node",node,"--python",python];
  expect(run("bash",[installer,"--destdir",dest,"--user","definitely-no-such-user","--app-root",app,"--corpus-root",corpus,"--inbox",inbox,"--db",db,"--bun",bun,"--node",node,"--python",python]).status).not.toBe(0);
  expect(run("bash",base.map(value=>value===user?"root":value)).status).not.toBe(0);
  expect(run("bash",base.map(value=>value===app?join(root,"missing-app"):value)).status).not.toBe(0);
  expect(run("bash",base.map(value=>value===corpus?join(root,"missing-corpus"):value)).status).not.toBe(0);
  expect(run("bash",base.map(value=>value===db?join(root,"missing.sqlite"):value)).status).not.toBe(0);
  expect(run("bash",base.map(value=>value===bun?join(root,"missing-bun"):value)).status).not.toBe(0);
  const before=await readFile(db),success=run("bash",base);expect(success.status,success.stderr).toBe(0);const installed=await unitFiles(join(dest,"etc/systemd/system"));const environment=await readFile(join(dest,"etc/bw-forge/bw-forge.env"));
  expect(await readFile(db)).toEqual(before);expect((await stat(join(dest,"etc/bw-forge/bw-forge.env"))).isFile()).toBe(true);
  const again=run("bash",base);expect(again.status,again.stderr).toBe(0);expect(await unitFiles(join(dest,"etc/systemd/system"))).toEqual(installed);expect(await readFile(join(dest,"etc/bw-forge/bw-forge.env"))).toEqual(environment);expect(await readFile(db)).toEqual(before);
  const createdInbox=join(root,"created-inbox"),createArgs=base.map(value=>value===inbox?createdInbox:value);
  expect(run("bash",createArgs).status).not.toBe(0);const created=run("bash",[...createArgs,"--create-inbox"]);expect(created.status,created.stderr).toBe(0);expect((await stat(createdInbox)).isDirectory()).toBe(true);
});

test("systemd-analyze accepts rendered units when available",async()=>{
  if(process.platform!=="linux"||run("sh",["-c","command -v systemd-analyze"]).status!==0)return;
  const output=await temp("bw-systemd-verify-"),app=join(output,"app");await mkdir(join(app,"apps/cli/src"),{recursive:true});await writeFile(join(app,"apps/cli/src/main.ts"),"// fixture\n");
  const args=[renderer,"--output-dir",output,"--user","nobody","--app-root",app,"--corpus-root","/tmp/corpus","--inbox","/tmp/inbox","--db","/tmp/corpus/db/corpus.sqlite","--bun","/bin/echo","--node","/usr/bin/node","--python","/usr/bin/python3"];
  expect(run(process.env.BW_FORGE_NODE??"node",args).status).toBe(0);const units=["bw-forge-watch.service","bw-forge-worker.service","bw-forge-mcp.service","bw-forge-reports-index.service","bw-forge-reports-index.timer","bw-forge.target"].map(name=>join(output,name));
  const verified=run("systemd-analyze",["verify",...units]);expect(verified.status,verified.stderr).toBe(0);
});

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createStaticReportIndexGenerator, filterReportRows, generateStaticReportIndex, sortReportRows,
  type StaticReportRow } from "../src/reports/staticIndex.js";
import { openDatabase } from "../src/db/sqlite.js";
import { ensureSchema } from "../src/db/schema.js";

const repo=fileURLToPath(new URL("../../../",import.meta.url));
async function fixture(count:number){
  const root=await mkdtemp(join(tmpdir(),"bw-report-index-"));
  const python=process.env.BW_FORGE_PYTHON??(process.platform==="win32"?"py":"python3");
  const result=spawnSync(python,[...(python==="py"?["-3"]:[]),fileURLToPath(new URL("fixtures/reports.py",import.meta.url)),root,String(count)],{encoding:"utf8",windowsHide:true});
  if(result.error)throw result.error;assert.equal(result.status,0,result.stderr);
  return {...JSON.parse(result.stdout) as {dbPath:string;analysesRoot:string;firstReplay:string;firstCurrent:number;historicalId:number;historicalKey:string},root,
    async [Symbol.asyncDispose](){await rm(root,{recursive:true,force:true});}};
}
function embedded(html:string):StaticReportRow[]{const match=/<script id="report-data" type="application\/json">([^]*?)<\/script>/.exec(html);assert.ok(match);return JSON.parse(match[1]!);}

test("28 current analyses render once with chronology, identities, safe relative reports, and offline controls",async()=>{
  await using f=await fixture(28);const before=await readFile(f.dbPath),result=await generateStaticReportIndex(f),html=await readFile(result.output,"utf8"),rows=embedded(html);
  assert.deepEqual({status:result.status,replays:result.replays,available:result.reportsAvailable,unavailable:result.reportsUnavailable},
    {status:"updated",replays:28,available:26,unavailable:2});assert.equal(rows.length,28);
  assert.equal(rows.at(-1)!.playedAt,null);assert.ok(rows.slice(0,-1).every((row,index,array)=>index===0||array[index-1]!.playedAtUnixSeconds!>=row.playedAtUnixSeconds!));
  assert.equal(rows[0]!.year,rows[0]!.playedAt!.slice(0,4));assert.notEqual(rows[0]!.playedAtUnixSeconds,9999999999);
  const first=rows.find(row=>row.replaySha256===f.firstReplay)!;assert.match(first.map,/Map/);assert.equal(first.participants[0]!.name,"Canonical </script> & <b>");
  assert.match(first.participantsDisplay,/Canonical .* \(Z\) vs Player 0-1 \(T\)/);assert.equal(first.racePair,"Z vs T");
  assert.equal(rows.find(row=>row.replaySha256.endsWith("03"))!.participants.length,3);assert.equal(rows.find(row=>row.replaySha256.endsWith("04"))!.participantsDisplay,"Participants unavailable");
  for(const row of rows.filter(row=>row.reportHref)){assert.match(row.reportHref!,/^\.\//);assert.ok(!row.reportHref!.includes("\\"));assert.ok(!row.reportHref!.includes("/srv/bw-forge"));
    const path=fileURLToPath(new URL(row.reportHref!,pathToFileURL(result.output)));assert.equal((await stat(path)).isFile(),true);assert.ok(path.startsWith(f.analysesRoot));}
  assert.match(first.reportHref!,/%20/);assert.equal(result.warnings.length,2);assert.ok(result.warnings.some(w=>/outside analyses root/.test(w.message)));assert.ok(result.warnings.some(w=>/ENOENT|no such file/i.test(w.message)));
  assert.ok(!html.includes("</script><svg"));assert.ok(!html.includes("<img src=x"));assert.ok(!html.includes("Canonical </script>"));assert.match(html,/\\u003c\/script\\u003e/);
  for(const forbidden of ["https://","http://","fetch(","XMLHttpRequest","WebSocket","src=\"//"])assert.ok(!html.includes(forbidden));
  for(const expected of ["Content-Security-Policy","report-data","type=\"search\"","id=\"player\"","id=\"map\"","id=\"year\"","id=\"racePair\"","id=\"reset\"","id=\"resultCount\"","data-sort=\"played\""])assert.ok(html.includes(expected));
  assert.deepEqual(await readFile(f.dbPath),before);
});

test("pure client filtering and sorting cover search, player, map, year, pairing, reset basis, and unknown dates",async()=>{
  await using f=await fixture(28);const rows=embedded(await readFile((await generateStaticReportIndex(f)).output,"utf8"));const first=rows.find(row=>row.replaySha256===f.firstReplay)!;
  for(const filters of [{search:f.firstReplay.slice(0,20)},{search:"canonical"},{player:first.participants[0]!.name},{map:first.map},{year:first.year},{racePair:first.racePair}])assert.ok(filterReportRows(rows,filters).includes(first));
  assert.equal(filterReportRows(rows,{search:"definitely absent"}).length,0);assert.equal(filterReportRows(rows,{}).length,28);
  const newest=sortReportRows(rows,"played","desc");assert.notEqual(newest[0]!.playedAt,null);assert.equal(newest.at(-1)!.playedAt,null);
  assert.deepEqual(sortReportRows(rows,"map","asc").map(row=>row.map),[...rows.map(row=>row.map)].sort((a,b)=>a.localeCompare(b)));
});

test("empty catalog and missing participant metadata degrade to raw names and a valid empty index",async()=>{
  await using f=await fixture(2);const db=new DatabaseSync(f.dbPath);db.exec("DELETE FROM participation_identity_overrides;DELETE FROM canonical_players");db.close();
  const rows=embedded(await readFile((await generateStaticReportIndex(f)).output,"utf8"));assert.match(rows.find(row=>row.replaySha256===f.firstReplay)!.participants[0]!.name,/^Raw /);
  await using empty=await fixture(0);const result=await generateStaticReportIndex(empty),html=await readFile(result.output,"utf8");assert.equal(result.replays,0);assert.equal(result.reportsAvailable,0);assert.deepEqual(embedded(html),[]);assert.match(html,/Dates unavailable/);
});

test("one current analysis produces exactly one replay row",async()=>{
  await using f=await fixture(1);const result=await generateStaticReportIndex(f),rows=embedded(await readFile(result.output,"utf8"));
  assert.equal(result.replays,1);assert.equal(result.reportsAvailable,1);assert.equal(rows.length,1);assert.equal(rows[0]!.replaySha256,f.firstReplay);
});

test("current pointer changes update one row while historical reports remain untouched",async()=>{
  await using f=await fixture(8);const first=await generateStaticReportIndex(f),beforeRows=embedded(await readFile(first.output,"utf8"));assert.equal(beforeRows.length,8);const oldHref=beforeRows.find(row=>row.replaySha256===f.firstReplay)!.reportHref;
  const historicalPath=join(f.analysesRoot,f.firstReplay,f.historicalKey,"old report.html"),historicalBytes=await readFile(historicalPath);
  const db=new DatabaseSync(f.dbPath);db.prepare("UPDATE current_analyses SET analysis_id=? WHERE replay_id=1").run(f.historicalId);db.close();
  const changed=await generateStaticReportIndex(f),afterRows=embedded(await readFile(changed.output,"utf8"));assert.equal(changed.status,"updated");assert.equal(afterRows.length,8);
  const newHref=afterRows.find(row=>row.replaySha256===f.firstReplay)!.reportHref;assert.notEqual(newHref,oldHref);assert.match(newHref!,/old%20report\.html$/);assert.deepEqual(await readFile(historicalPath),historicalBytes);
});

test("identical generation is byte-stable/no-op and atomic failure preserves the prior index",async()=>{
  await using f=await fixture(8);const first=await generateStaticReportIndex(f),bytes=await readFile(first.output),modified=(await stat(first.output)).mtimeMs;
  const same=await generateStaticReportIndex(f);assert.equal(same.status,"no-op");assert.deepEqual(await readFile(first.output),bytes);assert.equal((await stat(first.output)).mtimeMs,modified);
  const db=new DatabaseSync(f.dbPath);db.prepare("UPDATE replays SET map_name='changed' WHERE replay_id=1").run();db.close();
  const failing=createStaticReportIndexGenerator({beforeReplace:async(temporary,output)=>{assert.deepEqual(await readFile(output),bytes);assert.ok((await readFile(temporary)).length>bytes.length/2);throw new Error("injected replacement failure");}});
  await assert.rejects(failing(f),/injected replacement failure/);assert.deepEqual(await readFile(first.output),bytes);assert.ok(!(await readdir(f.analysesRoot)).some(name=>name.endsWith(".tmp")));
  const changed=await generateStaticReportIndex(f);assert.equal(changed.status,"updated");assert.notDeepEqual(await readFile(first.output),bytes);
});

test("bw-forge reports index CLI emits structured JSON and a second invocation is no-op",async()=>{
  await using f=await fixture(8);const cli=join(repo,"apps/cli/src/main.ts"),runtime=process.env.BW_FORGE_BUN;
  const run=()=>runtime?spawnSync(runtime,[cli,"reports","index","--db",f.dbPath,"--analyses-root",f.analysesRoot],{cwd:repo,encoding:"utf8",windowsHide:true}):
    spawnSync(process.execPath,[join(repo,"packages/corpus-query/node_modules/tsx/dist/cli.mjs"),cli,"reports","index","--db",f.dbPath,"--analyses-root",f.analysesRoot],{cwd:repo,encoding:"utf8",windowsHide:true});
  const first=run();assert.equal(first.status,0,first.stderr);assert.equal(JSON.parse(first.stdout).status,"updated");assert.match(first.stderr,/\[reports\] unavailable/);
  const second=run();assert.equal(second.status,0,second.stderr);assert.equal(JSON.parse(second.stdout).status,"no-op");
});

test("legacy Corpus remains byte-identical and is rejected explicitly",async()=>{
  const root=await mkdtemp(join(tmpdir(),"bw-report-v1-"));try{const dbPath=join(root,"v1.sqlite"),analysesRoot=join(root,"analyses");
    const {db}=await openDatabase(dbPath);ensureSchema(db);db.close();await mkdir(analysesRoot);const before=await readFile(dbPath);
    await assert.rejects(generateStaticReportIndex({dbPath,analysesRoot}),/Corpus v2/);assert.deepEqual(await readFile(dbPath),before);
  }finally{await rm(root,{recursive:true,force:true});}
});

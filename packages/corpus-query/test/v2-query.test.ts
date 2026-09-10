import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp,readFile,rm } from "node:fs/promises";
import { join,resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { openDatabase } from "../src/db/sqlite.js";
import type { Database } from "../src/db/sqlite.js";
import { scope as v2Scope, supply } from "../src/query/v2.js";
import { ensureSchema } from "../src/db/schema.js";
import { detectCorpusBackend,sqlRows } from "../src/db/backend.js";
import * as query from "../src/query/query.js";
import * as discovery from "../src/analytics/discovery.js";
import * as compositions from "../src/analytics/compositions.js";
import * as timing from "../src/analytics/buildTimings.js";
import { getDeathSummary } from "../src/analytics/deaths.js";
import { getPlayerReplayCard } from "../src/analytics/replayCard.js";
import { describeSchema,getSchemaNotes } from "../src/sql/schemaDescription.js";
import { listQueryExamples } from "../src/sql/queryExamples.js";
import { validateReadonlySql } from "../src/sql/readonlySql.js";
import { createReplayCorpusMcpServer } from "../src/mcp/tools.js";

async function fixture(options:{unknownSecond?:boolean;preM8?:boolean}={}) {
  const root=await mkdtemp(join(tmpdir(),"corpus-v2-query-"));
  const python=process.env.BW_FORGE_PYTHON??(process.platform==="win32"?"py":"python3");
  const result=spawnSync(python,[...(python==="py"?["-3"]:[]),fileURLToPath(new URL("./fixtures/v2.py",import.meta.url)),root,
    ...(options.unknownSecond?["--unknown-second"]:[]),...(options.preM8?["--pre-m8"]:[])],{encoding:"utf8",windowsHide:true});
  if(result.error)throw result.error;
  assert.equal(result.status,0,result.stderr);
  const data=JSON.parse(result.stdout) as {dbPath:string;replayIds:string[]};
  const {db}=await openDatabase(data.dbPath,{readOnly:true});
  return {...data,root,db,async [Symbol.asyncDispose](){db.close();await rm(root,{recursive:true,force:true});}};
}

test("strong backend markers distinguish v1, v2 and invalid prototype",async()=>{
  await using f=await fixture();
  assert.equal(detectCorpusBackend(f.db),"v2");
  const {db}=await openDatabase(join(f.root,"v1.sqlite"));
  try{ensureSchema(db);assert.equal(detectCorpusBackend(db),"v1");}finally{db.close();}
  const {db:bad}=await openDatabase(join(f.root,"bad.sqlite"));
  try{bad.run("PRAGMA user_version=2");assert.throws(()=>detectCorpusBackend(bad),/marker/);}finally{bad.close();}
});
test("v2 discovery, occurrences and current-only observations",async()=>{
  await using f=await fixture();
  const summary=discovery.getCorpusSummary(f.db,{});
  assert.equal(summary.replayCount,2);assert.equal(summary.playerCount,2);
  assert.deepEqual(summary.matchups,[{matchup:"ZvT",replayCount:2}]);
  assert.equal(summary.maps.length,2);assert.ok(Object.values(summary.dataAvailability).every(Boolean));
  assert.equal(discovery.listPlayers(f.db,{}).players.length,2);
  assert.equal(discovery.listMatchups(f.db,{}).matchups[0]?.playerRows,4);
  assert.equal(query.findReplays(f.db,{player:"player"}).length,2);
  assert.equal(query.findReplays(f.db,{replay_ids:[f.replayIds[0]! ]})[0]?.players.length,2);
  assert.equal(discovery.searchBuildItems(f.db,{query:"pool"}).matches[0]?.count,8);
  assert.equal(discovery.listBuildItems(f.db,{}).items.some(i=>i.name==="old_marker"),false);
  assert.equal(discovery.listUnitTypes(f.db,{}).units.some(i=>i.name==="obsolete"),false);
  assert.equal(sqlRows(f.db,"SELECT count(*) AS n FROM analysis_runs")[0]?.n,3);
  const filters={player:"Player",replay_ids:[f.replayIds[0]!],item:"spawning_pool"};
  assert.equal(query.listBuildEvents(f.db,filters).length,2);
  const first=query.findFirstEvent(f.db,filters)[0]!.event as any;
  assert.equal(first.time_seconds,1);assert.equal(first.frame,null);assert.equal(first.frame_min,24);assert.equal(first.frame_max,47);
  assert.equal((query.findNthEvent(f.db,{...filters,n:2})[0]!.event as any).occurrence,1);
  assert.equal(query.findNthEvent(f.db,{...filters,n:3})[0]!.event,null);
});
test("played-at chronology is UTC, half-open, shared across query layers, and indexed",async()=>{
  await using f=await fixture();
  const all=query.findReplays(f.db,{} as any) as any[];
  assert.deepEqual(all.map(row=>[row.playedAtUnixSeconds,row.playedAt]),[
    [1735689600,"2025-01-01T00:00:00Z"],[1767225600,"2026-01-01T00:00:00Z"]]);
  const y2025={played_from:"2025-01-01",played_before:"2026-01-01"};
  assert.deepEqual((query.findReplays(f.db,y2025) as any[]).map(row=>row.replay_id),[f.replayIds[0]]);
  assert.equal(query.findReplays(f.db,{played_from:"2026-01-01",played_before:"2027-01-01"}).length,1);
  assert.equal(query.findReplays(f.db,{played_before:"2025-01-01"}).length,0);
  assert.equal(query.findReplays(f.db,{played_from:"2025-01-01T01:00:00+01:00",played_before:"2025-01-02T00:00:00Z"}).length,1);
  for(const value of ["2025","01/01/2025","2025-02-30","2025-02-30T00:00:00Z","2025-01-01T00:00:00","2025-01-01 00:00:00Z"])
    assert.throws(()=>query.findReplays(f.db,{played_from:value}),/played|RFC3339/i);
  assert.throws(()=>query.findReplays(f.db,{played_from:"2026-01-01",played_before:"2025-01-01"}),/earlier/);
  assert.equal(query.getEconomyAtOrBefore(f.db,{player:"Player",at:.042,...y2025})[0]?.sample?.minerals,77);
  const economy2025=compositions.getEconomyDistribution(f.db,{player:"Player",timeSeconds:.042,...y2025});
  const economy2026=compositions.getEconomyDistribution(f.db,{player:"Player",timeSeconds:.042,played_from:"2026-01-01",played_before:"2027-01-01"});
  assert.deepEqual([economy2025.sampleSize,economy2025.minerals?.mean,economy2026.sampleSize,economy2026.minerals?.mean],[1,77,1,97]);
  assert.equal(discovery.getCorpusSummary(f.db,y2025).replayCount,1);
  const card=getPlayerReplayCard(f.db,{player:"Player",replayId:f.replayIds[0]!}) as any;
  assert.equal(card.playedAt,"2025-01-01T00:00:00Z");assert.equal(card.playedAtUnixSeconds,1735689600);
  const years=sqlRows(f.db,`SELECT strftime('%Y',played_at_unix_s,'unixepoch') AS year,count(*) AS n FROM replays GROUP BY year ORDER BY year`);
  assert.deepEqual(years.map(row=>({...row})),[{year:"2025",n:1},{year:"2026",n:1}]);
  assert.match(JSON.stringify(sqlRows(f.db,"EXPLAIN QUERY PLAN SELECT replay_id FROM replays WHERE played_at_unix_s>=1735689600 AND played_at_unix_s<1767225600")),/replays_by_played_at/);
});
test("unknown chronology is retained for unfiltered queries and excluded from bounded ranges",async()=>{
  await using f=await fixture({unknownSecond:true});
  const all=query.findReplays(f.db,{}) as any[];assert.equal(all.length,2);assert.equal(all[1]!.playedAt,null);
  assert.equal(query.findReplays(f.db,{played_from:"2025-01-01",played_before:"2026-01-01"}).length,1);
  assert.equal(query.findReplays(f.db,{played_from:"2026-01-01"}).length,0);
});
test("pre-chronology v2 databases stay byte-identical and readable through the read-only backend",async()=>{
  await using f=await fixture({preM8:true});const before=await readFile(f.dbPath);
  assert.equal(query.findReplays(f.db,{}).length,2);
  assert.equal(query.findReplays(f.db,{played_from:"2025-01-01"}).length,0);
  const server=createReplayCorpusMcpServer(),client=new Client({name:"pre-m8-test",version:"1"});const [a,b]=InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a),server.connect(b)]);
  try{
    const summary=await client.callTool({name:"get_corpus_summary",arguments:{db_path:f.dbPath}});assert.equal((summary.structuredContent as any).replayCount,2);
    const dated=await client.callTool({name:"find_replays",arguments:{db_path:f.dbPath,played_from:"2025-01-01"}});assert.equal((dated.structuredContent as any).count,0);
  }finally{await client.close();await server.close();}
  assert.deepEqual(await readFile(f.dbPath),before);
});
test("sparse economy and unit semantics: zeros, domain, coverage and boundaries",async()=>{
  await using f=await fixture();const filters={player:"Player",replay_ids:[f.replayIds[0]!]};
  const economy=(at:number)=>query.getEconomyAtOrBefore(f.db,{...filters,at})[0] as any;
  assert.equal(economy(.042).sample.minerals,77);assert.equal(economy(.084).sample.workers,null);
  assert.equal(economy(.126).sample.minerals,60);assert.equal(economy(.21).sample.minerals,60);
  assert.equal(economy(0).availability,"before_coverage");assert.equal(economy(.168).availability,"gap");assert.equal(economy(100).availability,"after_coverage");
  const unit=(at:number,name="zergling")=>query.getUnitCountAtOrBefore(f.db,{...filters,unit:name,at})[0] as any;
  assert.equal(unit(.042).sample.count,2);assert.equal(unit(.084).sample.count,0);assert.equal(unit(.126).sample.count,0);assert.equal(unit(.21).sample.count,1);
  assert.equal(unit(.084,"carrier").availability,"unobserved");assert.equal(unit(.084,"carrier").sample,null);
  assert.equal(unit(.084,"marine").sample.count,0);
  assert.equal(unit(0).sample,null);assert.equal(unit(1).sample,null);
  const events=query.getDeathsBetween(f.db,{...filters,from:.084,to:.084})[0]!.deaths;
  assert.equal(events.length,2);assert.equal(events[0]!.frame,2);
  assert.equal(query.getDeathsBetween(f.db,{...filters,from:.085,to:1})[0]!.deaths.length,0);
});
test("v2 aggregate timing, economy, composition, deaths and replay card",async()=>{
  await using f=await fixture();
  const event=timing.getEventTimingDistribution(f.db,{player:"Player",item:"spawning_pool",n:2});
  assert.equal(event.sampleSize,2);assert.equal(event.seconds?.median,1);
  const before=timing.countReplaysWithEventBeforeEvent(f.db,{player:"Player",firstItem:"spawning_pool",secondItem:"zergling"});
  assert.equal(before.matchCount,2);
  const uncertain=timing.countReplaysWithEventBeforeEvent(f.db,{player:"Player",firstItem:"spawning_pool",secondItem:"spawning_pool",secondN:2}) as any;
  assert.equal(uncertain.uncertainCount,2);assert.equal(uncertain.sampleSize,0);
  const economy=compositions.getEconomyDistribution(f.db,{player:"Player",timeSeconds:.042});
  assert.equal(economy.minerals?.mean,87);assert.equal(economy.sampleSize,2);
  assert.equal(compositions.getEconomyDistribution(f.db,{player:"Player",timeSeconds:.168}).sampleSize,0);
  const comp=compositions.getCompositionSnapshot(f.db,{player:"Player",timeSeconds:.084,units:["zergling","carrier"]}) as any;
  assert.equal(comp.units.zergling.mean,0);assert.equal(comp.units.carrier,undefined);assert.equal(comp.unknownCounts.carrier,2);
  const losses=getDeathSummary(f.db,{player:"Player",startSeconds:.084,endSeconds:.084});
  assert.equal(losses.lost[0]?.count,4);assert.equal(losses.killed[0]?.count,4);
  const card=getPlayerReplayCard(f.db,{player:"Player",replayId:f.replayIds[0]!});
  assert.equal(card.replayId,f.replayIds[0]);assert.equal(card.player.name,"Player");assert.equal(card.opponent.name,"Enemy");
  assert.equal(card.economyBenchmarks?.[0]?.workers,null);assert.equal(card.buildAnchors?.[0]?.item,"spawning_pool");
});
test("v2 SQL description and executable examples teach sparse/current semantics",async()=>{
  await using f=await fixture();
  const schema=describeSchema(f.db,{includeIndexes:true});
  assert.ok(schema.joinHints.some(h=>h.right==="current_analyses"));assert.ok(!schema.joinHints.some(h=>h.right==="players"));
  const notes=JSON.stringify(getSchemaNotes("all","v2"));
  for(const word of ["sha256","observation_id","UNKNOWN","explicit zero","current","coverage","immutable"])assert.match(notes.toLowerCase(),new RegExp(word.toLowerCase()));
  for(const example of listQueryExamples("all",50,"v2").examples){assert.ok(validateReadonlySql(example.sql).allowed);sqlRows(f.db,example.sql);}
  const plan=sqlRows(f.db,"EXPLAIN QUERY PLAN SELECT count FROM unit_count_changes WHERE observation_id=1 AND unit_type_id=1 AND frame>=1 AND frame<=2 ORDER BY frame DESC LIMIT 1");
  assert.match(JSON.stringify(plan),/PRIMARY KEY/);
  assert.throws(()=>f.db.run("DELETE FROM replays"),/readonly/i);
});

test("actual sparse backend statements use indexed lookups and supply tuple coverage",async()=>{
  await using f=await fixture();const observed:Record<string,string[]>={};
  const watched:Database={run:(sql,params)=>f.db.run(sql,params),close:()=>{},prepare(sql){
    const statement=f.db.prepare(sql);
    return {bind(params){
      for(const table of ["economy_changes","unit_count_changes","death_events"]) {
        if(sql.includes(`FROM ${table}`)) {
          const plan=sqlRows(f.db,`EXPLAIN QUERY PLAN ${sql}`,params as unknown[]);
          (observed[table]??=[]).push(JSON.stringify(plan));
        }
      }
      statement.bind(params);
    },step:()=>statement.step(),getAsObject:()=>statement.getAsObject(),reset:()=>statement.reset(),free:()=>statement.free()};
  }};
  const filters={player:"Player",replay_ids:[f.replayIds[0]!]};
  query.getEconomyAtOrBefore(watched,{...filters,at:.084});
  query.getUnitCountAtOrBefore(watched,{...filters,unit:"zergling",at:.084});
  query.getDeathsBetween(watched,{...filters,from:.084,to:.084});
  for(const table of ["economy_changes","unit_count_changes","death_events"]) {
    assert.ok(observed[table]?.length,table);
    for(const plan of observed[table]!)assert.match(plan,/SEARCH.*(?:PRIMARY KEY|INDEX)/);
  }
  const row=v2Scope(f.db,{player:"Player",replayIds:[f.replayIds[0]!]})[0]!;
  assert.equal(supply(f.db,row,.084).sample?.current,8);
  assert.equal(supply(f.db,row,.126).sample?.current,10);
  assert.equal(supply(f.db,row,.168).sample,null);
});

test("shared MCP tools and resources execute on v2 and reject v1-only operations",async()=>{
  await using f=await fixture();const before=await readFile(f.dbPath);
  const server=createReplayCorpusMcpServer(),client=new Client({name:"v2-test",version:"1"});
  const [a,b]=InMemoryTransport.createLinkedPair();await Promise.all([client.connect(a),server.connect(b)]);
  try {
    const call=async(name:string,args:Record<string,unknown>={})=>{const result=await client.callTool({name,arguments:{db_path:f.dbPath,...args}});assert.notEqual(result.isError,true,JSON.stringify(result));return result.structuredContent as any;};
    assert.equal((await call("get_corpus_summary")).replayCount,2);
    assert.equal((await call("server_info")).corpus_backend,"v2");
    for(const [name,args] of [
      ["list_players",{}],["list_matchups",{}],["list_build_items",{}],["search_build_items",{query:"pool"}],["list_unit_types",{}],
      ["find_first_event",{player:"Player",item:"spawning_pool"}],
      ["find_nth_event",{player:"Player",item:"spawning_pool",n:2}],
      ["list_build_events",{player:"Player"}],
      ["get_event_timing_distribution",{player:"Player",item:"spawning_pool"}],
      ["count_replays_with_event_before_event",{player:"Player",firstItem:"spawning_pool",secondItem:"zergling"}],
      ["get_economy_distribution",{player:"Player",timeSeconds:.042}],
      ["get_death_summary",{player:"Player",startSeconds:.084,endSeconds:.084}],
      ["get_player_replay_card",{player:"Player",replayId:f.replayIds[0]}],
      ["describe_schema",{}],["validate_readonly_sql",{sql:"SELECT sha256 FROM replays"}]
    ] as [string,Record<string,unknown>][]) await call(name,args);
    assert.equal((await call("find_replays",{player:"Player"})).count,2);
    const dated=await call("find_replays",{player:"Player",played_from:"2025-01-01",played_before:"2026-01-01"});
    assert.equal(dated.count,1);assert.equal(dated.results[0].playedAt,"2025-01-01T00:00:00Z");
    assert.equal((await call("get_economy_distribution",{player:"Player",timeSeconds:.042,played_from:"2025-01-01",played_before:"2026-01-01"})).sampleSize,1);
    const zero=await call("get_unit_count",{player:"Player",unit:"zergling",at_seconds:.084});
    assert.equal(zero.results[0].sample.count,0);
    await call("get_economy",{player:"Player",at_seconds:.042});
    await call("get_deaths",{player:"Player",from_seconds:.084,to_seconds:.084});
    await call("get_composition_snapshot",{player:"Player",timeSeconds:.084});
    assert.match(JSON.stringify(await call("get_schema_notes")),/observation_id/);
    assert.match(JSON.stringify(await call("list_query_examples")),/current_analyses/);
    const sql=await call("execute_readonly_sql",{sql:"SELECT sha256 FROM replays ORDER BY sha256",maxRows:1});
    assert.equal(sql.rowCount,1);assert.equal(sql.truncated,true);
    const denied=await client.callTool({name:"execute_readonly_sql",arguments:{db_path:f.dbPath,sql:"DELETE FROM replays"}});assert.equal(denied.isError,true);
    const ingest=await client.callTool({name:"ingest_corpus",arguments:{db_path:f.dbPath,analysis_output_root:f.root}});assert.equal(ingest.isError,true);assert.match(JSON.stringify(ingest),/NOT_SUPPORTED_FOR_CORPUS_V2/);
    for(const name of ["execute_query_plan","export_query_plan_zip"]){const rejected=await client.callTool({name,arguments:{db_path:f.dbPath,plan:{},html_root:f.root,out_path:join(f.root,"out.zip")}});
      assert.equal(rejected.isError,true);assert.match(JSON.stringify(rejected),/NOT_SUPPORTED_FOR_CORPUS_V2/);}
    const resource=await client.readResource({uri:`bw_replay://unit_count?db_path=${encodeURIComponent(f.dbPath)}&player=Player&unit=zergling&time=0.084`});
    assert.equal(JSON.parse((resource.contents[0] as any).text).results[0].sample.count,0);
    const datedResource=await client.readResource({uri:`bw_replay://economy?db_path=${encodeURIComponent(f.dbPath)}&player=Player&time=0.042&played_from=2025-01-01&played_before=2026-01-01`});
    assert.equal(JSON.parse((datedResource.contents[0] as any).text).results.length,1);
    const info=await client.readResource({uri:`bw_replay://server_info?db_path=${encodeURIComponent(f.dbPath)}`});
    assert.equal(JSON.parse((info.contents[0] as any).text).corpus_backend,"v2");
  }finally{await client.close();await server.close();}
  assert.deepEqual(await readFile(f.dbPath),before);
});

test("bw-forge mcp --db v2 starts the shared stdio server",{timeout:30000},async()=>{
  await using f=await fixture();
  const repo=fileURLToPath(new URL("../../../",import.meta.url));
  const transport=new StdioClientTransport({command:process.env.BW_FORGE_BUN??"bun",args:[join(repo,"apps/cli/src/main.ts"),"mcp","--db",f.dbPath],cwd:repo,stderr:"pipe"});
  const client=new Client({name:"v2-cli-smoke",version:"1"});
  try{await client.connect(transport);const info=await client.callTool({name:"server_info",arguments:{}});
    assert.equal((info.structuredContent as any).corpus_backend,"v2");
    const summary=await client.callTool({name:"get_corpus_summary",arguments:{}});assert.equal((summary.structuredContent as any).replayCount,2);
    const economy=await client.callTool({name:"get_economy",arguments:{player:"Player",at_seconds:.042}});assert.notEqual(economy.isError,true);
  }finally{await client.close();await transport.close();}
});

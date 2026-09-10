import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { openDatabase } from "../src/db/sqlite.js";
import { sqlRows } from "../src/db/backend.js";
import { ensureSchema } from "../src/db/schema.js";
import * as query from "../src/query/query.js";
import { scope } from "../src/query/v2.js";
import * as discovery from "../src/analytics/discovery.js";
import * as economy from "../src/analytics/compositions.js";
import * as builds from "../src/analytics/buildTimings.js";
import { getDeathSummary } from "../src/analytics/deaths.js";
import { getPlayerReplayCard } from "../src/analytics/replayCard.js";
import * as identities from "../src/identity/catalog.js";
import { normalizeName } from "../src/identity/casefold.js";
import { createReplayCorpusMcpServer } from "../src/mcp/tools.js";
import { describeSchema, getSchemaNotes } from "../src/sql/schemaDescription.js";
import { listQueryExamples } from "../src/sql/queryExamples.js";

function python(args:string[]) {
  const command=process.env.BW_FORGE_PYTHON??(process.platform==="win32"?"py":"python3");
  const result=spawnSync(command,[...(command==="py"?["-3"]:[]),...args],{encoding:"utf8",windowsHide:true});
  if(result.error)throw result.error;
  assert.equal(result.status,0,result.stderr);
  return result.stdout;
}
async function fixture() {
  const root=await mkdtemp(join(tmpdir(),"bw-identities-"));
  const data=JSON.parse(python([fileURLToPath(new URL("fixtures/v2.py",import.meta.url)),root,"--identities"])) as {dbPath:string;replayIds:string[]};
  const config={schema_version:"bw-forge-identities-v1",players:[
    {key:"goose",display_name:"Gooseheaded",aliases:[{namespace:"legacy-unknown",name:"Gooseheaded"},{namespace:"legacy-unknown",name:"G00se"}]},
    {key:"firstlaw",display_name:"FirstLaw",aliases:[{namespace:"legacy-unknown",name:"FirstLaw"}]},
    {key:"archive",display_name:"Archived Person",aliases:[]}
  ],overrides:[] as Array<{replay_sha256:string;owner:number;player:string}>,
  groups:[{key:"friends",display_name:"Friends",players:["firstlaw"]},{key:"me",display_name:"Me",players:["goose"]},{key:"empty",display_name:"Empty",players:[]}],
  scopes:[
    {key:"my-zvt",display_name:"My ZvT",self:{players:["goose"],groups:[]},opponent:{players:[],groups:["friends"]},filters:{race:"zerg",opponent_race:"terran",matchup:"ZvT",map:"Map0"},replay_sha256:[]},
    {key:"all-mine",display_name:"All mine",self:{players:[],groups:["me"]},opponent:{players:[],groups:[]},filters:{},replay_sha256:[]},
    {key:"second",display_name:"Second replay",self:{players:["goose"],groups:[]},opponent:{players:[],groups:[]},filters:{played_from:"2026-01-01",played_before:"2027-01-01T00:00:00Z"},replay_sha256:[data.replayIds[1]!]}
  ]};
  const configPath=join(root,"identities.json");
  const admin=fileURLToPath(new URL("../../corpus-store/python/store.py",import.meta.url));
  const apply=async()=>{await writeFile(configPath,JSON.stringify(config));return JSON.parse(python([admin,"identities","--db",data.dbPath,"--config",configPath]));};
  await apply();
  const {db}=await openDatabase(data.dbPath,{readOnly:true});
  return {...data,root,db,config,configPath,apply,admin,async [Symbol.asyncDispose](){db.close();await rm(root,{recursive:true,force:true});}};
}

test("canonical keys/display names expand aliases; raw alias and unresolved player still work",async()=>{
  await using f=await fixture();
  for(const player of ["goose","Gooseheaded"]){
    const rows=query.getEconomyAtOrBefore(f.db,{player,at:.042});
    assert.equal(rows.length,2);assert.deepEqual(rows.map(r=>r.sample?.minerals),[77,97]);
    assert.ok(rows.every(r=>(r as any).canonicalPlayerKey==="goose"));
  }
  assert.equal(scope(f.db,{player:"G00se"}).length,1);
  const unresolved=scope(f.db,{player:"Dex"});assert.equal(unresolved.length,1);assert.equal(unresolved[0]!.identityResolution,"unresolved");
  // Unmapped replay names remain raw evidence.
  assert.equal(unresolved[0]!.canonicalPlayerKey,null);
  assert.equal(scope(f.db,{player:"Gooseheaded"})[0]!.observedName,"Gooseheaded");
});

test("canonical list_players and all sparse aggregates use current aliases exactly once",async()=>{
  await using f=await fixture();
  const players=discovery.listPlayers(f.db,{}).players;
  const goose=players.find(p=>p.name==="Gooseheaded")!;assert.equal(goose.replayCount,2);
  assert.deepEqual((goose as any).observedNames,["G00se","Gooseheaded"]);
  assert.equal(players.length,3);
  const filter={player:"goose"};
  const ec=economy.getEconomyDistribution(f.db,{...filter,timeSeconds:.042});assert.equal(ec.sampleSize,2);assert.equal(ec.minerals.mean,87);
  const comp=economy.getCompositionSnapshot(f.db,{...filter,timeSeconds:.084,units:["zergling"]});
  assert.equal(comp.sampleSize,2);assert.equal(comp.units.zergling!.mean,0);
  const timing=builds.getEventTimingDistribution(f.db,{...filter,item:"spawning_pool"});assert.equal(timing.sampleSize,2);
  assert.equal(query.listBuildEvents(f.db,{...filter}).length,6);
  assert.equal(query.findNthEvent(f.db,{...filter,item:"spawning_pool",n:2}).length,2);
  assert.equal(query.listBuildEvents(f.db,{...filter,item:"old_marker"}).length,0);
  const deaths=getDeathSummary(f.db,{...filter,startSeconds:.084,endSeconds:.084});assert.equal(deaths.sampleSize,2);assert.equal(deaths.lost[0]!.count,4);
  const card=getPlayerReplayCard(f.db,{...filter,replayId:f.replayIds[1]});assert.equal((card.player as any).observedName,"G00se");
  assert.equal(sqlRows(f.db,"SELECT count(*) AS n FROM analysis_runs")[0]!.n,3);
  f.config.overrides.push({replay_sha256:f.replayIds[0]!,owner:1,player:"goose"});await f.apply();
  // Two aliases/slots for the same canonical player in one replay still count that replay once.
  assert.equal(discovery.listPlayers(f.db,{}).players.find(p=>p.name==="Gooseheaded")!.replayCount,2);
});

test("group and scope role OR, dimension AND, narrowing, empty groups and SHA restrictions",async()=>{
  await using f=await fixture();
  assert.equal(scope(f.db,{player_group:"me"}).length,2);
  assert.equal(scope(f.db,{opponent_group:"friends"}).length,1);
  assert.equal(scope(f.db,{player_group:"empty"}).length,0);
  assert.equal(scope(f.db,{scope:"my-zvt"}).length,1);
  assert.equal(scope(f.db,{player:"goose",opponent:"firstlaw",player_group:"me",opponent_group:"friends",matchup:"ZvT",
    race:"zerg",opponentRace:"terran",map:"Map0",played_from:"2025-01-01",played_before:"2026-01-01"}).length,1);
  assert.equal(scope(f.db,{scope:"all-mine"}).length,2);
  assert.equal(scope(f.db,{scope:"my-zvt",map:"Map1"}).length,0);
  assert.equal(scope(f.db,{scope:"my-zvt",race:"terran"}).length,0);
  assert.equal(scope(f.db,{scope:"my-zvt",matchup:"TvZ"}).length,0);
  assert.equal(scope(f.db,{scope:"my-zvt",player:"G00se"}).length,0);
  assert.deepEqual(scope(f.db,{scope:"second"}).map(r=>r.replay_id),[f.replayIds[1]]);
  assert.equal(scope(f.db,{scope:"second",replayIds:[f.replayIds[0]!]}).length,0);
  assert.equal(scope(f.db,{scope:"second",played_before:"2026-01-01"}).length,0);
  assert.deepEqual((identities.listScopes(f.db).scopes.find(s=>s.scopeKey==="second") as any).filters,
    {played_from:"2026-01-01",played_before:"2027-01-01T00:00:00Z"});
  assert.throws(()=>scope(f.db,{scope:"missing"}),/Unknown query scope/);
  assert.throws(()=>scope(f.db,{player_group:"missing"}),/Unknown player group/);
  f.config.scopes[1]!.self.players=["firstlaw"];
  await f.apply(); // OR: firstlaw directly, goose through the me group.
  assert.equal(scope(f.db,{scope:"all-mine"}).length,3);
  f.config.scopes[1]!.opponent.players=["goose"];
  await f.apply();
  assert.equal(scope(f.db,{scope:"all-mine"}).length,1);
  assert.equal(scope(f.db,{scope:"all-mine"})[0]!.observedName,"FirstLaw");
});

test("overrides win and catalog changes take effect without ingest or telemetry writes",async()=>{
  await using f=await fixture();
  const before=sqlRows(f.db,"SELECT * FROM participations"),current=sqlRows(f.db,"SELECT * FROM current_analyses");
  f.config.overrides.push({replay_sha256:f.replayIds[1]!,owner:0,player:"firstlaw"});await f.apply();
  assert.equal(scope(f.db,{player:"goose"}).length,1);
  const override=scope(f.db,{player:"firstlaw"}).find(r=>r.self_owner===0)!;
  assert.equal(override.observedName,"G00se");assert.equal(override.identityResolution,"override");
  assert.equal(identities.getPlayerIdentity(f.db,"G00se").player?.playerKey,"firstlaw");
  assert.deepEqual(sqlRows(f.db,"SELECT * FROM participations"),before);assert.deepEqual(sqlRows(f.db,"SELECT * FROM current_analyses"),current);
  f.config.overrides=[];f.config.players[0]!.display_name="Renamed Goose";await f.apply();
  assert.equal(scope(f.db,{player:"Renamed Goose"}).length,2);
  assert.equal(scope(f.db,{player:"goose"}).length,2);
  assert.equal((await f.apply()).status,"no-op");
});

test("namespace matching, ambiguity and Python casefold semantics",async()=>{
  await using f=await fixture();
  assert.equal(normalizeName("Straße Σς ﬀ İ"),"strasse σσ ff i̇");
  // Simulate replay metadata from a distinct namespace, before taking the test evidence snapshot.
  const {db}=await openDatabase(f.dbPath);
  db.run("UPDATE participations SET name_namespace='ladder' WHERE observed_name='G00se'");db.close();
  assert.equal(scope(f.db,{player:"goose"}).length,1);
  assert.equal(scope(f.db,{player:"G00se"})[0]!.identityResolution,"unresolved");
  f.config.players[0]!.aliases.push({namespace:"ladder",name:"G00se"});await f.apply();
  assert.equal(scope(f.db,{player:"goose"}).length,2);
  f.config.players[1]!.display_name="Gooseheaded";await f.apply();
  assert.throws(()=>scope(f.db,{player:"Gooseheaded"}),/Ambiguous player selector/);
  assert.equal(scope(f.db,{player:"goose"}).length,2);
});

test("unresolved identical spellings in separate namespaces remain distinct and ambiguous",async()=>{
  await using f=await fixture();
  const {db}=await openDatabase(f.dbPath);
  // Model two unknown namespaces using the same observed spelling in the fixture only.
  db.run("UPDATE participations SET observed_name='Shared',observed_name_key='shared',name_namespace=CASE WHEN owner=0 THEN 'one' ELSE 'two' END");
  db.close();
  const players=discovery.listPlayers(f.db,{}).players;
  assert.equal(players.length,2);assert.ok(players.every(p=>p.name==="Shared"&&p.replayCount===2));
  assert.throws(()=>scope(f.db,{player:"Shared"}),/Ambiguous player selector/);
});

test("pre-identity v2 remains readable and exposes an empty catalog without migration",async()=>{
  await using f=await fixture();
  const {db}=await openDatabase(f.dbPath);
  for(const table of ["analysis_job_attempts","analysis_jobs","replay_sources","scope_players","scope_groups","scope_replays","player_group_members","participation_identity_overrides","player_aliases","query_scopes","player_groups","canonical_players","corpus_migrations"])db.run(`DROP TABLE ${table}`);
  db.close();
  const bytes=await readFile(f.dbPath);
  assert.equal(query.getEconomyAtOrBefore(f.db,{player:"G00se",at:.042}).length,1);
  assert.deepEqual(identities.listCanonicalPlayers(f.db),{players:[]});
  assert.deepEqual(await readFile(f.dbPath),bytes);
  await f.apply();assert.equal(scope(f.db,{player:"goose"}).length,2);
  assert.equal(sqlRows(f.db,"PRAGMA integrity_check")[0]!.integrity_check,"ok");assert.deepEqual(sqlRows(f.db,"PRAGMA foreign_key_check"),[]);
});

test("read-only MCP discovery, scoped analytics/resources, and structured v1 rejection",async()=>{
  await using f=await fixture();
  const before=await readFile(f.dbPath),server=createReplayCorpusMcpServer(),client=new Client({name:"identities-test",version:"1"});
  const [a,b]=InMemoryTransport.createLinkedPair();await Promise.all([client.connect(a),server.connect(b)]);
  try {
    for(const name of ["list_canonical_players","get_player_identity","list_player_groups","list_scopes"]){
      const result=await client.callTool({name,arguments:{db_path:f.dbPath,...(name==="get_player_identity"?{player:"goose"}:{})}});
      assert.notEqual(result.isError,true,JSON.stringify(result));assert.match(JSON.stringify(result),/goose|friends/);
    }
    const result=await client.callTool({name:"get_economy_distribution",arguments:{db_path:f.dbPath,scope:"my-zvt",player:"goose",timeSeconds:.042}});
    assert.notEqual(result.isError,true,JSON.stringify(result));assert.equal((result.structuredContent as any).sampleSize,1);
    const primitive=await client.callTool({name:"get_economy",arguments:{db_path:f.dbPath,scope:"second",player:"goose",at_seconds:.042}});
    assert.equal((primitive.structuredContent as any).count,1);
    for(const [name,extra] of [
      ["get_corpus_summary",{}],["list_players",{}],["list_matchups",{}],["list_build_items",{}],["search_build_items",{query:"pool"}],["list_unit_types",{}],
      ["find_replays",{}],["find_first_event",{item:"spawning_pool"}],["find_nth_event",{item:"spawning_pool",n:2}],["list_build_events",{}],
      ["get_unit_count",{unit:"zergling",at_seconds:.084}],["get_deaths",{from_seconds:.084,to_seconds:.084}],
      ["get_event_timing_distribution",{item:"spawning_pool"}],["count_replays_with_event_before_event",{firstItem:"spawning_pool",secondItem:"zergling"}],
      ["get_composition_snapshot",{timeSeconds:.084}],["get_death_summary",{startSeconds:.084,endSeconds:.084}],
      ["get_player_replay_card",{replayId:f.replayIds[0]}]
    ] as [string,Record<string,unknown>][]) {
      const good=await client.callTool({name,arguments:{db_path:f.dbPath,player:"goose",scope:"my-zvt",...extra}});
      assert.notEqual(good.isError,true,JSON.stringify(good));
      const invalid=await client.callTool({name,arguments:{db_path:f.dbPath,player:"goose",scope:"nonexistent",...extra}});
      assert.equal(invalid.isError,true,`${name} must propagate the shared scope filter`);
    }
    const resource=await client.readResource({uri:`bw_replay://economy?db_path=${encodeURIComponent(f.dbPath)}&player=goose&scope=second&time=0.042`});
    assert.equal(JSON.parse((resource.contents[0] as any).text).count,1);
    const {db:v1}=await openDatabase(join(f.root,"v1.sqlite"));ensureSchema(v1);v1.close();
    for(const name of ["list_canonical_players","get_player_identity","list_player_groups","list_scopes"]){
      const rejected=await client.callTool({name,arguments:{db_path:join(f.root,"v1.sqlite"),player:"goose"}});
      assert.equal(rejected.isError,true);assert.match(JSON.stringify(rejected),/NOT_SUPPORTED_FOR_CORPUS_V1/);
    }
  } finally {await client.close();await server.close();}
  assert.deepEqual(await readFile(f.dbPath),before);
});

test("CLI apply/export round trip and bw-forge MCP scoped canonical-player smoke",{timeout:30000},async()=>{
  await using f=await fixture();
  const repo=fileURLToPath(new URL("../../../",import.meta.url));
  const cli=(args:string[])=>{
    const result=spawnSync(process.execPath,[join(repo,"packages/corpus-query/node_modules/tsx/dist/cli.mjs"),join(repo,"apps/cli/src/main.ts"),"identities",...args,"--db",f.dbPath],{encoding:"utf8",windowsHide:true});
    assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);
  };
  const exported=cli(["export"]);
  const roundtrip=join(f.root,"roundtrip.json");await writeFile(roundtrip,JSON.stringify(exported));
  const before=await readFile(f.dbPath);
  assert.equal(cli(["apply",roundtrip]).status,"no-op");
  assert.deepEqual(cli(["export"]),exported);
  assert.deepEqual(await readFile(f.dbPath),before);
  const transport=new StdioClientTransport({command:process.env.BW_FORGE_BUN??"bun",args:[join(repo,"apps/cli/src/main.ts"),"mcp","--db",f.dbPath],cwd:repo,stderr:"pipe"});
  const client=new Client({name:"identity-smoke",version:"1"});
  try {
    await client.connect(transport);
    const result=await client.callTool({name:"get_economy_distribution",arguments:{player:"goose",scope:"my-zvt",timeSeconds:.042}});
    assert.notEqual(result.isError,true,JSON.stringify(result));assert.equal((result.structuredContent as any).sampleSize,1);
    assert.equal((result.structuredContent as any).minerals.mean,77);
  } finally {await client.close();await transport.close();}
});

test("identity SQL guidance and catalog queries preserve read-only sparse storage",async()=>{
  await using f=await fixture();
  const before=await readFile(f.dbPath);
  const schema=describeSchema(f.db,{});
  assert.match(JSON.stringify(schema),/canonical_players|scope_groups/);
  assert.match(JSON.stringify(getSchemaNotes("all","v2")),/COALESCE\(override.player_id, alias.player_id\)/);
  for(const e of listQueryExamples("all",50,"v2").examples)sqlRows(f.db,e.sql);
  assert.equal(identities.listCanonicalPlayers(f.db).players.length,3);
  assert.equal(identities.listScopes(f.db).scopes.length,3);
  const plan=sqlRows(f.db,"EXPLAIN QUERY PLAN SELECT * FROM player_aliases WHERE name_namespace=? AND observed_name_key=?",["legacy-unknown","g00se"]);
  assert.match(JSON.stringify(plan),/SEARCH.*PRIMARY KEY/);
  assert.deepEqual(await readFile(f.dbPath),before);
});

import type { Database } from "../db/sqlite.js";
import { sqlRows } from "../db/backend.js";
import * as q from "../query/v2.js";
import { normalizeCorpusFilters, replayScopeFiltersPayload, clampListLimit, clampExampleLimit, type CorpusFilterInput } from "./filters.js";
import { summarizeNumbers } from "./stats.js";
import { formatSecondsClock as clock } from "./time.js";
import type * as discovery from "./legacy_discovery.js";
import type * as timing from "./legacy_buildTimings.js";
import type * as compositions from "./legacy_compositions.js";
import type * as deaths from "./legacy_deaths.js";
import type * as cards from "./legacy_replayCard.js";

function rows(db:Database,input:CorpusFilterInput) { return q.uniqueScope(q.scope(db,normalizeCorpusFilters(input))); }
function payload(input:CorpusFilterInput) {return replayScopeFiltersPayload(normalizeCorpusFilters(input));}
function example(r:q.Scope) {return {replayId:r.replay_id,filename:r.source_replay_filename,player:r.player_name,opponent:r.opponent_name,...q.identityMetadata(r)};}
function groupedReplays(scope:q.Scope[],field:"matchup"|"map") {
  const sets=new Map<string,Set<string>>();
  for(const r of scope){const key=r[field]||"unknown";const set=sets.get(key)??new Set<string>();set.add(r.replay_id);sets.set(key,set);}
  return [...sets].map(([name,set])=>({name,replayCount:set.size})).sort((a,b)=>b.replayCount-a.replayCount||a.name.localeCompare(b.name));
}
function counts(db:Database,scope:q.Scope[],table:"build_events"|"unit_count_changes"|"death_events") {
  const map=new Map<string,{count:number;replays:Set<string>}>();
  for(const r of scope) for(const value of sqlRows(db,`SELECT u.unit_key,count(*) AS n FROM ${table} t
    JOIN unit_types u USING(unit_type_id) WHERE t.observation_id=? GROUP BY u.unit_key`,[r.observation_id])) {
    const name=String(value.unit_key), entry=map.get(name)??{count:0,replays:new Set<string>()};
    entry.count+=Number(value.n);entry.replays.add(r.replay_id);map.set(name,entry);
  }
  return map;
}
export function getCorpusSummary(db:Database,input:CorpusFilterInput):discovery.CorpusSummaryResult {
  const scope=rows(db,input),races=new Map<string,number>();
  for(const r of scope)races.set(r.player_race,(races.get(r.player_race)??0)+1);
  const present=(table:string)=>scope.some(r=>sqlRows(db,`SELECT 1 FROM ${table} WHERE observation_id=? LIMIT 1`,[r.observation_id]).length>0);
  return {filters:payload(input),replayCount:new Set(scope.map(r=>r.replay_id)).size,playerCount:new Set(scope.map(q.identityKey)).size,
    matchups:groupedReplays(scope,"matchup").map(x=>({matchup:x.name,replayCount:x.replayCount})),
    maps:groupedReplays(scope,"map").map(x=>({map:x.name,replayCount:x.replayCount})),
    races:[...races].map(([race,playerRows])=>({race,playerRows})),dataAvailability:{buildOrderEvents:present("build_events"),economySamples:present("economy_changes"),
      supplySamples:present("supply_changes"),unitCountSamples:present("unit_count_changes"),deathEvents:present("death_events")}};
}
export function listPlayers(db:Database,input:Parameters<typeof discovery.listPlayers>[1]):discovery.PlayerListResult {
  const groups=new Map<string,q.Scope[]>();
  for(const row of rows(db,input)){const key=q.identityKey(row);const group=groups.get(key)??[];group.push(row);groups.set(key,group);}
  return {filters:payload(input),players:[...groups.values()].map(group=>{return {
    name:group[0]!.canonicalPlayerName??group[0]!.player_name,...q.identityMetadata(group[0]!),
    observedNames:[...new Set(group.map(r=>r.observedName))].sort(),identityResolutions:[...new Set(group.map(r=>r.identityResolution))].sort(),
    races:[...new Set(group.map(r=>r.player_race))].sort(),replayCount:new Set(group.map(r=>r.replay_id)).size,
    matchups:groupedReplays(group,"matchup").map(x=>({matchup:x.name,replayCount:x.replayCount}))};})
    .sort((a,b)=>b.replayCount-a.replayCount||a.name.localeCompare(b.name)).slice(0,clampListLimit(input.limit))};
}
export function listMatchups(db:Database,input:Parameters<typeof discovery.listMatchups>[1]):discovery.MatchupListResult {
  const scope=rows(db,input);return {filters:payload(input),matchups:groupedReplays(scope,"matchup").map(x=>({matchup:x.name,replayCount:x.replayCount,
    playerRows:scope.filter(r=>(r.matchup??"unknown")===x.name).length})).slice(0,clampListLimit(input.limit))};
}
export function listBuildItems(db:Database,input:Parameters<typeof discovery.listBuildItems>[1]):discovery.BuildItemListResult {
  return {filters:payload(input),items:[...counts(db,rows(db,input),"build_events")].map(([name,c])=>({name,count:c.count,replayCount:c.replays.size}))
    .sort((a,b)=>b.replayCount-a.replayCount||a.name.localeCompare(b.name)).slice(0,clampListLimit(input.limit))};
}
export function searchBuildItems(db:Database,input:Parameters<typeof discovery.searchBuildItems>[1]):discovery.BuildItemSearchResult {
  const matches=[...counts(db,rows(db,input),"build_events")].filter(([name])=>name.toLowerCase().includes(input.query.trim().toLowerCase()))
    .map(([name,c])=>({name,count:c.count,replayCount:c.replays.size})).sort((a,b)=>b.replayCount-a.replayCount||a.name.localeCompare(b.name));
  return {query:input.query,filters:payload(input),matches:matches.slice(0,clampListLimit(input.limit))};
}
export function listUnitTypes(db:Database,input:Parameters<typeof discovery.listUnitTypes>[1]):discovery.UnitTypeListResult {
  const scope=rows(db,input),source=input.source??"both",units=source==="deaths"?new Map():counts(db,scope,"unit_count_changes"),dead=source==="unit_counts"?new Map():counts(db,scope,"death_events");
  return {source,filters:payload(input),units:[...new Set<string>([...units.keys(),...dead.keys()])].map(name=>({name,unitCountSampleCount:Number(units.get(name)?.count??0),deathEventCount:Number(dead.get(name)?.count??0)}))
    .sort((a,b)=>(b.unitCountSampleCount+b.deathEventCount)-(a.unitCountSampleCount+a.deathEventCount)||a.name.localeCompare(b.name)).slice(0,clampListLimit(input.limit))};
}

export function getEventTimingDistribution(db:Database,input:Parameters<typeof timing.getEventTimingDistribution>[1]) {
  const values=rows(db,input).flatMap(r=>{const e=q.builds(db,r,input.item,undefined,undefined,input.n??1)[0];
    if(!e||(input.startSeconds!==undefined&&e.time_seconds<input.startSeconds)||(input.endSeconds!==undefined&&e.time_seconds>input.endSeconds))return [];
    return [{...example(r),race:r.player_race,matchup:r.matchup,timeSeconds:e.time_seconds,time:clock(e.time_seconds),timing_basis:e.timing_basis,
      frame:e.frame,frame_min:e.frame_min,frame_max:e.frame_max,time_min_seconds:e.time_min_seconds,time_max_seconds:e.time_max_seconds}];});
  const summary=summarizeNumbers(values.map(v=>v.timeSeconds));
  return {filters:{...payload(input),item:input.item,n:input.n??1},sampleSize:values.length,seconds:summary,
    times:summary?{min:clock(summary.min),p25:clock(summary.p25),median:clock(summary.median),p75:clock(summary.p75),max:clock(summary.max)}:null,
    examples:values.sort((a,b)=>a.timeSeconds-b.timeSeconds||a.replayId.localeCompare(b.replayId)).slice(0,clampExampleLimit(input.limitExamples)),
    hints:["Statistics use recorded build timestamps; legacy second-floor timings retain frame bounds and are not exact frames."]};
}
export function countReplaysWithEventBeforeEvent(db:Database,input:Parameters<typeof timing.countReplaysWithEventBeforeEvent>[1]) {
  const matches=[], nonMatches=[], uncertain=[];let missingFirstCount=0,missingSecondCount=0;
  for(const r of rows(db,input)) {
    const a=q.builds(db,r,input.firstItem,undefined,undefined,input.firstN??1)[0],b=q.builds(db,r,input.secondItem,undefined,undefined,input.secondN??1)[0];
    if(!a)missingFirstCount++;if(!b)missingSecondCount++;if(!a||!b)continue;
    const value={...example(r),firstTimeSeconds:a.time_seconds,secondTimeSeconds:b.time_seconds,firstTime:clock(a.time_seconds),secondTime:clock(b.time_seconds),deltaSeconds:b.time_seconds-a.time_seconds};
    if(a.occurrence===b.occurrence)nonMatches.push(value);else if(a.frame_max<b.frame_min)matches.push(value);else if(a.frame_min>=b.frame_max)nonMatches.push(value);else uncertain.push(value);
  }
  const sampleSize=matches.length+nonMatches.length,limit=clampExampleLimit(input.limitExamples);
  return {filters:payload(input),condition:{first:{item:input.firstItem,n:input.firstN??1},second:{item:input.secondItem,n:input.secondN??1}},sampleSize,
    matchCount:matches.length,percentage:sampleSize?Number((100*matches.length/sampleSize).toFixed(1)):0,missingFirstCount,missingSecondCount,
    uncertainCount:uncertain.length,uncertainExamples:uncertain.slice(0,limit),examples:matches.slice(0,limit),nonMatches:nonMatches.slice(0,limit)};
}
export function getEconomyDistribution(db:Database,input:Parameters<typeof compositions.getEconomyDistribution>[1]) {
  const scope=rows(db,input),values=scope.flatMap(r=>{const s=q.economy(db,r,input.timeSeconds).sample;return s?[{...example(r),workers:s.workers,minerals:s.minerals,gas:s.gas}]:[];});
  return {filters:{...payload(input),timeSeconds:input.timeSeconds,time:clock(input.timeSeconds)},sampleSize:values.length,unknownCount:scope.length-values.length,
    workers:summarizeNumbers(values.flatMap(v=>v.workers===null?[]:[v.workers])),minerals:summarizeNumbers(values.map(v=>v.minerals)),gas:summarizeNumbers(values.map(v=>v.gas)),
    examples:values.slice(0,clampExampleLimit(input.limitExamples))};
}
export function getCompositionSnapshot(db:Database,input:Parameters<typeof compositions.getCompositionSnapshot>[1]) {
  const scope=rows(db,input),requested=input.units?.map(name=>name.trim()).filter(Boolean),names=requested?.length?[...new Set(requested)]:[...new Set(scope.flatMap(r=>q.domain(db,r).map(t=>String(t.unit_key))))].sort();
  const collected=new Map(names.map(n=>[n,[] as number[]])),unknownCounts=Object.fromEntries(names.map(n=>[n,0]));
  let sampleSize=0;const examples=[];
  for(const r of scope) {
    const units:Record<string,number>={},availability:Record<string,string>={};let known=false;
    for(const name of names){const s=q.unit(db,r,name,input.timeSeconds);availability[name]=s.availability;
      if(s.sample){units[name]=s.sample.count;collected.get(name)!.push(s.sample.count);known=true;}else unknownCounts[name]!++;}
    if(known)sampleSize++;
    if(examples.length<clampExampleLimit(input.limitExamples))examples.push({...example(r),time:clock(input.timeSeconds),units,availability});
  }
  const units:Record<string,NonNullable<ReturnType<typeof summarizeNumbers>>>={};
  for(const [name,values] of collected){const summary=summarizeNumbers(values);if(summary)units[name]=summary;}
  return {filters:{...payload(input),timeSeconds:input.timeSeconds,time:clock(input.timeSeconds)},sampleSize,units,
    unitSampleSizes:Object.fromEntries([...collected].map(([name,values])=>[name,values.length])),unknownCounts,examples};
}
function lossCounts(db:Database,row:q.Scope,from:number,to:number):Record<string,number> {
  const first=q.frameAt(row,from),lo=q.seconds(row,first)<from-1e-10?first+1:first;
  return Object.fromEntries(sqlRows(db,`SELECT u.unit_key,count(*) AS n FROM death_events d JOIN unit_types u USING(unit_type_id)
    WHERE observation_id=? AND frame>=? AND frame<=? GROUP BY u.unit_key`,[row.observation_id,lo,q.frameAt(row,to)]).map(x=>[String(x.unit_key),Number(x.n)]));
}
export function getDeathSummary(db:Database,input:Parameters<typeof deaths.getDeathSummary>[1]) {
  if(!Number.isFinite(input.startSeconds)||!Number.isFinite(input.endSeconds)||input.startSeconds>input.endSeconds)throw new Error("Invalid death time interval");
  const allScope=q.scope(db,normalizeCorpusFilters(input)),scope=q.uniqueScope(allScope),lost=new Map<string,number>(),killed=new Map<string,number>(),examples=[];
  for(const r of scope) {
    const own=lossCounts(db,r,input.startSeconds,input.endSeconds),enemy:Record<string,number>={};
    for(const opponent of allScope.filter(p=>p.observation_id===r.observation_id&&p.opponent_observation_id!==null)) {
      for(const [name,count] of Object.entries(lossCounts(db,{...opponent,observation_id:opponent.opponent_observation_id!},input.startSeconds,input.endSeconds)))enemy[name]=(enemy[name]??0)+count;
    }
    for(const [name,count]of Object.entries(own))lost.set(name,(lost.get(name)??0)+count);
    for(const [name,count]of Object.entries(enemy))killed.set(name,(killed.get(name)??0)+count);
    if(examples.length<clampExampleLimit(input.limitExamples))examples.push({...example(r),lost:own,killed:enemy});
  }
  const summary=(map:Map<string,number>)=>[...map].map(([unit,count])=>({unit,count,perReplayMean:scope.length?Number((count/scope.length).toFixed(2)):0})).sort((a,b)=>b.count-a.count||a.unit.localeCompare(b.unit));
  return {filters:{...payload(input),startSeconds:input.startSeconds,endSeconds:input.endSeconds,start:clock(input.startSeconds),end:clock(input.endSeconds)},sampleSize:scope.length,
    lost:summary(lost),killed:summary(killed),examples,coverage_basis:"observations_only",notes:["Counts are recorded death events, not proof of complete interval coverage. Killed means opponent losses, not attributed kills."]};
}
export function getPlayerReplayCard(db:Database,input:Parameters<typeof cards.getPlayerReplayCard>[1]) {
  const row=rows(db,{...input,...(input.replayId?{replayIds:[input.replayId]}:{})}).find(r=>!input.filenameContains||r.source_replay_filename?.toLowerCase().includes(input.filenameContains.toLowerCase()));
  if(!row)throw new Error(`No replay/player row found for player "${input.player}".`);
  const anchors:Record<string,string[]>={zerg:["hatchery","spawning_pool","extractor","lair","spire","hydralisk_den","evolution_chamber","hive"],
    terran:["supply_depot","barracks","refinery","factory","academy","engineering_bay","starport","science_facility"],
    protoss:["pylon","gateway","forge","assimilator","cybernetics_core","citadel_of_adun","stargate","robotics_facility"]};
  const actual=[...counts(db,[row],"build_events").keys()];
  const buildAnchors=(anchors[row.player_race]??[]).flatMap(name=>{const label=actual.find(x=>x.toLowerCase().replaceAll(" ","_")===name);if(!label)return[];
    const e=q.builds(db,row,label,undefined,undefined,1)[0]!;return [{item:label,n:1,time:clock(e.time_seconds),timing_basis:e.timing_basis,frame_min:e.frame_min,frame_max:e.frame_max}];});
  const economyBenchmarks=[300,420].map(t=>{const s=q.economy(db,row,t);return {time:clock(t),workers:s.sample?.workers??null,availability:s.availability};});
  const death=getDeathSummary(db,{...input,player:row.canonicalPlayerKey??row.player_name,replayIds:[row.replay_id],startSeconds:420,endSeconds:540});
  return {replayId:row.replay_id,filename:row.source_replay_filename,map:row.map??"unknown",duration:row.duration_seconds===null?"unknown":clock(row.duration_seconds),
    duration_basis:"processed_end_frame",player:{name:row.player_name,race:row.player_race,...q.identityMetadata(row)},opponent:{name:row.opponent_name,race:row.opponent_race},matchup:row.matchup,
    ...(input.includeBuildAnchors===false?{}:{buildAnchors}),...(input.includeEconomyBenchmarks===false?{}:{economyBenchmarks}),
    ...(input.includeCombatSummary===false?{}:{combatSummary:[{window:"07:00-09:00",lost:death.examples[0]?.lost??{},killed:death.examples[0]?.killed??{},coverage_basis:"observations_only"}]})};
}

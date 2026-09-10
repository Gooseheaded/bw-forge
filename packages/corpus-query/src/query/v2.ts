import { basename } from "node:path";
import type { Database } from "../db/sqlite.js";
import { sqlRows } from "../db/backend.js";
import type { CorpusFilterInput, ReplayScopeRow } from "../analytics/filters.js";
import type { PerspectiveFilters, ReplayFilters, BuildEventFilters } from "./query.js";
import { hasIdentities, identityJoins, identitySelect, identityConditions } from "../identity/catalog.js";
import { formatPlayedAt, normalizeCorpusFilters, playedAtBoundaryUnixSeconds } from "../analytics/filters.js";

export interface Scope extends ReplayScopeRow {
  observation_id: number;
  opponent_observation_id: number | null;
  spec_id: number;
  clock_num: number;
  clock_den: number;
  manifest_path: string;
  observedName: string;
  observedNameKey: string;
  nameNamespace: string;
  canonicalPlayerKey: string | null;
  canonicalPlayerName: string | null;
  identityResolution: string;
  played_at_unix_s: number | null;
  playedAt: string | null;
  opponentCanonicalPlayerKey: string | null;
  opponentCanonicalPlayerName: string | null;
  opponentIdentityResolution: string;
}
const nullable = (value: unknown): string | null => value == null ? null : String(value);

export function scope(db: Database, filters: { [K in keyof CorpusFilterInput]?: CorpusFilterInput[K] | undefined }): Scope[] {
  const published = sqlRows(db, "SELECT 1 FROM sqlite_schema WHERE name='analysis_publications'").length > 0;
  const identities = hasIdentities(db);
  const chronology = sqlRows(db,"PRAGMA table_info(replays)").some(row=>row.name==="played_at_unix_s");
  const normalized=normalizeCorpusFilters(filters as unknown as CorpusFilterInput);
  const conditions: string[] = [];
  const args: unknown[] = [];
  if (identities) identityConditions(db,filters,conditions,args,chronology);
  else if(filters.scope || filters.player_group || filters.opponent_group) throw new Error("Identity catalog is not installed; use identities apply first");
  for (const [value, column] of [[identities ? undefined : filters.player,"p.observed_name"], [filters.race,"p.race"],
    [identities ? undefined : filters.opponent,"enemy.observed_name"], [filters.opponentRace,"enemy.race"], [filters.matchup,"matchup"]]) {
    if (value) { conditions.push(`${column} = ? COLLATE NOCASE`); args.push(value); }
  }
  if (filters.map) {
    if (filters.map.toLowerCase() === "unknown") conditions.push("(r.map_name IS NULL OR trim(r.map_name)='')");
    else { conditions.push("r.map_name = ? COLLATE NOCASE"); args.push(filters.map); }
  }
  if (filters.replayIds?.length) {
    conditions.push(`r.sha256 IN (${filters.replayIds.map(() => "?").join(",")})`); args.push(...filters.replayIds);
  }
  for(const [value,operator] of [[normalized.played_from,">="],[normalized.played_before,"<"]] as const){
    if(value){if(!chronology)conditions.push("0");else{conditions.push(`r.played_at_unix_s ${operator} ?`);args.push(playedAtBoundaryUnixSeconds(value));}}
  }
  const replaySource=chronology&&conditions.some(condition=>condition.includes("r.played_at_unix_s"))
    ? "replays r INDEXED BY replays_by_played_at" : "replays r";
  return sqlRows(db, `SELECT r.sha256 AS replay_id,r.map_name AS map,
    ${chronology?"r.played_at_unix_s":"NULL"} AS played_at_unix_s,
    (SELECT group_concat(initial,'v') FROM (SELECT upper(substr(pp.race,1,1)) AS initial FROM participations pp
      JOIN analysis_participations pa ON pa.participation_id=pp.participation_id AND pa.analysis_id=a.analysis_id
      WHERE pp.replay_id=r.replay_id ORDER BY pp.owner)) AS matchup,
    ${published ? "pub.raw_replay_path" : "NULL"} AS source_replay_path,
    ${published ? "pub.replay_manifest_path" : "NULL"} AS manifest_path,
    a.processed_end_frame*s.frame_duration_num_ms/(1000.0*s.frame_duration_den) AS duration_seconds,
    p.owner AS self_owner,p.observed_name AS player_name,p.race AS player_race,
    p.observed_name_key,p.name_namespace,
    ${identities ? identitySelect("p","self_")+","+identitySelect("enemy","enemy_") : "NULL AS self_key,NULL AS self_display,'unresolved' AS self_resolution,NULL AS enemy_key,NULL AS enemy_display,'unresolved' AS enemy_resolution"},
    enemy.owner AS opponent_owner,enemy.observed_name AS opponent_name,enemy.race AS opponent_race,
    ap.observation_id,ep.observation_id AS opponent_observation_id,s.spec_id,
    s.frame_duration_num_ms AS clock_num,s.frame_duration_den AS clock_den
    FROM ${replaySource} JOIN current_analyses ca ON ca.replay_id=r.replay_id
    JOIN analysis_runs a ON a.analysis_id=ca.analysis_id AND a.replay_id=r.replay_id AND a.status='indexed'
    JOIN analysis_specs s ON s.spec_id=a.spec_id
    JOIN analysis_participations ap ON ap.analysis_id=a.analysis_id AND ap.replay_id=r.replay_id
    JOIN participations p ON p.participation_id=ap.participation_id
    LEFT JOIN analysis_participations ep ON ep.analysis_id=a.analysis_id AND ep.participation_id<>p.participation_id
    LEFT JOIN participations enemy ON enemy.participation_id=ep.participation_id
    ${identities ? identityJoins("p","self_")+identityJoins("enemy","enemy_") : ""}
    ${published ? "LEFT JOIN analysis_publications pub ON pub.analysis_id=a.analysis_id" : ""}
    ${conditions.length ? "WHERE " + conditions.join(" AND ") : ""}
    ORDER BY r.sha256,p.owner,enemy.owner`, args).map(r => ({
      replay_id: String(r.replay_id), matchup: nullable(r.matchup), map: nullable(r.map),
      played_at_unix_s:r.played_at_unix_s==null?null:Number(r.played_at_unix_s),playedAt:formatPlayedAt(r.played_at_unix_s==null?null:Number(r.played_at_unix_s)),
      source_replay_path: nullable(r.source_replay_path), source_replay_filename: r.source_replay_path ? basename(String(r.source_replay_path)) : null,
      duration_seconds: r.duration_seconds == null ? null : Number(r.duration_seconds), manifest_path: String(r.manifest_path ?? ""),
      self_owner: Number(r.self_owner),player_name: String(r.player_name),player_race: String(r.player_race),
      observedName:String(r.player_name),observedNameKey:String(r.observed_name_key),nameNamespace:String(r.name_namespace),
      canonicalPlayerKey:nullable(r.self_key),canonicalPlayerName:nullable(r.self_display),identityResolution:String(r.self_resolution),
      opponentCanonicalPlayerKey:nullable(r.enemy_key),opponentCanonicalPlayerName:nullable(r.enemy_display),opponentIdentityResolution:String(r.enemy_resolution),
      opponent_owner: r.opponent_owner == null ? null : Number(r.opponent_owner),opponent_name: nullable(r.opponent_name),opponent_race: nullable(r.opponent_race),
      observation_id: Number(r.observation_id),opponent_observation_id: r.opponent_observation_id == null ? null : Number(r.opponent_observation_id),
      spec_id: Number(r.spec_id),clock_num: Number(r.clock_num),clock_den: Number(r.clock_den)
    }));
}

export function uniqueScope(rows: Scope[]): Scope[] {
  return [...new Map(rows.map(r => [r.observation_id,r])).values()];
}
export function seconds(row: Scope, frame: number): number { return frame*row.clock_num/(1000*row.clock_den); }
export function frameAt(row: Scope, time: number): number {
  if (!Number.isFinite(time)) throw new Error("Time must be finite");
  // Tolerate only floating-point roundoff at exact source-frame boundaries.
  const value = time*1000*row.clock_den/row.clock_num;
  const nearest = Math.round(value);
  return Math.abs(value-nearest) < 1e-9 ? nearest : Math.floor(value);
}
export type Availability = "known" | "before_coverage" | "after_coverage" | "gap" | "unobserved";
export function coverage(db: Database, row: Scope, stream: string, time: number) {
  const frame = frameAt(row,time);
  const segment = sqlRows(db, `SELECT start_frame,end_frame,basis FROM stream_coverage
    WHERE observation_id=? AND stream=? AND start_frame<=? ORDER BY start_frame DESC LIMIT 1`, [row.observation_id,stream,frame])[0];
  let availability: Availability = "known";
  if (!segment) availability = "before_coverage";
  else if (frame > Number(segment.end_frame)) availability = sqlRows(db,
    "SELECT 1 FROM stream_coverage WHERE observation_id=? AND stream=? AND start_frame>? LIMIT 1", [row.observation_id,stream,frame]).length ? "gap" : "after_coverage";
  else if (segment.basis === "observations_only") availability = "unobserved";
  return { frame, segment, availability };
}
export function economy(db: Database, row: Scope, time: number) {
  const c = coverage(db,row,"economy",time);
  if (c.availability !== "known") return { availability: c.availability, sample: null };
  const s = sqlRows(db, `SELECT * FROM economy_changes WHERE observation_id=? AND frame>=? AND frame<=? ORDER BY frame DESC LIMIT 1`,
    [row.observation_id,c.segment!.start_frame,c.frame])[0];
  if (!s) throw new Error("Covered economy segment has no baseline");
  return { availability: c.availability, sample: { frame: Number(s.frame),time_seconds: seconds(row,Number(s.frame)),
    minerals: Number(s.minerals),gas: Number(s.gas),workers: s.workers == null ? null : Number(s.workers),
    gathered_minerals: s.gathered_minerals == null ? null : Number(s.gathered_minerals),gathered_gas: s.gathered_gas == null ? null : Number(s.gathered_gas) } };
}
export function domain(db: Database,row: Scope) {
  return sqlRows(db,"SELECT u.unit_type_id,u.unit_key FROM analysis_unit_domain d JOIN unit_types u USING(unit_type_id) WHERE d.spec_id=?",[row.spec_id]);
}
export function unit(db: Database, row: Scope, name: string, time: number) {
  const c = coverage(db,row,"composition",time);
  if (c.availability !== "known") return { availability: c.availability, sample: null };
  const type = sqlRows(db,`SELECT u.unit_type_id,u.unit_key FROM analysis_unit_domain d JOIN unit_types u USING(unit_type_id)
    WHERE d.spec_id=? AND u.unit_key=? COLLATE NOCASE`,[row.spec_id,name])[0];
  if (!type) return { availability: "unobserved" as Availability, sample: null };
  const s = sqlRows(db, `SELECT frame,count FROM unit_count_changes WHERE observation_id=? AND unit_type_id=?
    AND frame>=? AND frame<=? ORDER BY frame DESC LIMIT 1`,[row.observation_id,type.unit_type_id,c.segment!.start_frame,c.frame])[0];
  return { availability: "known" as Availability, sample: { time_seconds: seconds(row,Number(s?.frame ?? c.segment!.start_frame)),
    frame: Number(s?.frame ?? c.segment!.start_frame),unit_type: String(type.unit_key),count: Number(s?.count ?? 0),
    basis: s ? "explicit_change" : "complete_baseline_absence" } };
}
export function supply(db: Database,row: Scope,time: number) {
  const c=coverage(db,row,"supply",time);
  if(c.availability!=="known") return {availability:c.availability,sample:null};
  const s=sqlRows(db,"SELECT frame,current,max FROM supply_changes WHERE observation_id=? AND frame>=? AND frame<=? ORDER BY frame DESC LIMIT 1",
    [row.observation_id,c.segment!.start_frame,c.frame])[0];
  return {availability:s ? "known" : "unobserved",sample:s ? {...s,time_seconds:seconds(row,Number(s.frame))} : null};
}
export function builds(db: Database,row: Scope,item?: string,from?: number,to?: number,n?: number) {
  const conditions=["b.observation_id=?"], args:unknown[]=[row.observation_id];
  if(item) {conditions.push("u.unit_key=? COLLATE NOCASE");args.push(item);}
  // Filter on recorded coarse time; preserve bounds so clients cannot mistake it for exact timing.
  if(from!==undefined){conditions.push("b.time_seconds>=?");args.push(from);}
  if(to!==undefined){conditions.push("b.time_seconds<=?");args.push(to);}
  if(n!==undefined && (!Number.isInteger(n)||n<1)) throw new Error("n must be a positive integer");
  if(n!==undefined) args.push(n-1);
  return sqlRows(db,`SELECT b.*,u.unit_key FROM build_events b JOIN unit_types u USING(unit_type_id)
    WHERE ${conditions.join(" AND ")} ORDER BY b.time_seconds,b.occurrence ${n===undefined ? "" : "LIMIT 1 OFFSET ?"}`,args)
    .map(b=>({time_seconds:Number(b.time_seconds),supply_used:null,supply_max:null,item:String(b.unit_key),raw_line:String(b.raw_line),
      occurrence:Number(b.occurrence),frame:b.frame==null?null:Number(b.frame),timing_basis:String(b.timing_basis),
      frame_min:Number(b.frame_min),frame_max:Number(b.frame_max),time_min_seconds:seconds(row,Number(b.frame_min)),time_max_seconds:seconds(row,Number(b.frame_max))}));
}
export function deaths(db: Database,row: Scope,from: number,to: number) {
  if(!Number.isFinite(from)||!Number.isFinite(to)||from>to)throw new Error("Invalid death time interval");
  const first=frameAt(row,from), lower=seconds(row,first)<from-1e-10?first+1:first;
  return sqlRows(db,`SELECT d.*,u.unit_key FROM death_events d JOIN unit_types u USING(unit_type_id)
    WHERE observation_id=? AND frame>=? AND frame<=? ORDER BY frame,occurrence`,[row.observation_id,lower,frameAt(row,to)])
    .map(d=>({frame:Number(d.frame),time_seconds:seconds(row,Number(d.frame)),dead_owner:Number(d.dead_owner),unit_type:String(d.unit_key),category:String(d.category)}));
}

function targets(db: Database,filters: PerspectiveFilters) {
  const rows=scope(db,{...filters,replayIds:filters.replay_ids});
  return filters.as === "enemy" ? rows.filter(r=>r.opponent_observation_id!==null).map(r=>({ ...r,
    observation_id:r.opponent_observation_id!, target_owner:r.opponent_owner!,target_name:r.opponent_name! })) :
    uniqueScope(rows).map(r=>({...r,target_owner:r.self_owner,target_name:r.player_name}));
}
function identity(row: Scope & {target_owner:number;target_name:string}) {
  return { replay_id:row.replay_id,source_replay_filename:row.source_replay_filename,source_replay_path:row.source_replay_path,
    self_owner:row.self_owner,target_owner:row.target_owner,player_name:row.player_name,target_name:row.target_name,matchup:row.matchup,
    playedAt:row.playedAt,playedAtUnixSeconds:row.played_at_unix_s,
    ...identityMetadata(row),targetObservedName:row.target_name,
    targetCanonicalPlayerKey:row.target_owner===row.self_owner?row.canonicalPlayerKey:row.opponentCanonicalPlayerKey,
    targetCanonicalPlayerName:row.target_owner===row.self_owner?row.canonicalPlayerName:row.opponentCanonicalPlayerName,
    targetIdentityResolution:row.target_owner===row.self_owner?row.identityResolution:row.opponentIdentityResolution };
}
export function identityMetadata(row:Scope) {
  return {observedName:row.observedName,nameNamespace:row.nameNamespace,canonicalPlayerKey:row.canonicalPlayerKey,
    canonicalPlayerName:row.canonicalPlayerName,identityResolution:row.identityResolution};
}
export function identityKey(row:Scope):string { return row.canonicalPlayerKey ? `canonical:${row.canonicalPlayerKey}` : JSON.stringify([row.nameNamespace,row.observedNameKey]); }
export function findReplays(db:Database,filters:ReplayFilters) {
  const selected=scope(db,{...filters,replayIds:filters.replay_ids});
  return [...new Map(selected.map(r=>[r.replay_id,r])).values()].map(r=>({replay_id:r.replay_id,
    source_replay_filename:r.source_replay_filename,source_replay_path:r.source_replay_path,matchup:r.matchup,map:r.map,
    duration_seconds:r.duration_seconds,manifest_path:r.manifest_path,playedAt:r.playedAt,playedAtUnixSeconds:r.played_at_unix_s,
    players:uniqueScope(scope(db,{replayIds:[r.replay_id]})).map(p=>({owner:p.self_owner,name:p.player_name,race:p.player_race,...identityMetadata(p),
      zip_path:sqlRows(db,"SELECT name FROM sqlite_schema WHERE name='analysis_artifact_locations'").length ? String(sqlRows(db,
        `SELECT l.artifact_path FROM analysis_artifact_locations l JOIN current_analyses ca ON ca.analysis_id=l.analysis_id
          JOIN replays rr ON rr.replay_id=ca.replay_id WHERE rr.sha256=? AND l.artifact_key=?`,[r.replay_id,`player/${p.self_owner}/player.json`])[0]?.artifact_path??""):""}))}));
}
export function findFirstEvent(db:Database,filters:PerspectiveFilters&{item:string}) {return targets(db,filters).map(r=>({...identity(r),event:builds(db,r,filters.item,undefined,undefined,1)[0]??null}));}
export function findNthEvent(db:Database,filters:PerspectiveFilters&{item:string;n:number}) {return targets(db,filters).map(r=>({...identity(r),n:filters.n,event:builds(db,r,filters.item,undefined,undefined,filters.n)[0]??null}));}
export function listBuildEvents(db:Database,filters:BuildEventFilters) {return targets(db,filters).flatMap(r=>builds(db,r,filters.item,filters.from,filters.to).map(event=>({...identity(r),event})));}
export function getEconomyAtOrBefore(db:Database,filters:PerspectiveFilters&{at:number}) {return targets(db,filters).map(r=>({...identity(r),...economy(db,r,filters.at)}));}
export function getUnitCountAtOrBefore(db:Database,filters:PerspectiveFilters&{unit:string;at:number}) {return targets(db,filters).map(r=>({...identity(r),...unit(db,r,filters.unit,filters.at)}));}
export function getDeathsBetween(db:Database,filters:PerspectiveFilters&{from:number;to:number}) {return targets(db,filters).map(r=>({...identity(r),deaths:deaths(db,r,filters.from,filters.to),coverage_basis:"observations_only"}));}

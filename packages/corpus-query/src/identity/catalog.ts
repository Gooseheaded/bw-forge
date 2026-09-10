import type { Database } from "../db/sqlite.js";
import { detectCorpusBackend, sqlRows } from "../db/backend.js";
import { normalizeName } from "./casefold.js";

export interface IdentityFilters { player_group?: string; opponent_group?: string; scope?: string }
export function hasIdentities(db: Database): boolean {
  return sqlRows(db, "SELECT 1 FROM sqlite_schema WHERE name='canonical_players' AND type='table'").length > 0;
}
export function requireIdentityBackend(db: Database): void {
  if (detectCorpusBackend(db) !== "v2") throw Object.assign(new Error("Identity discovery is only supported for Corpus v2"),
    {code:"NOT_SUPPORTED_FOR_CORPUS_V1",backend:"v1"});
}
export function identityJoins(participant: string, prefix: string): string {
  return `LEFT JOIN participation_identity_overrides ${prefix}override ON ${prefix}override.participation_id=${participant}.participation_id
    LEFT JOIN player_aliases ${prefix}alias ON ${prefix}alias.name_namespace=${participant}.name_namespace AND ${prefix}alias.observed_name_key=${participant}.observed_name_key
    LEFT JOIN canonical_players ${prefix}canonical ON ${prefix}canonical.player_id=coalesce(${prefix}override.player_id,${prefix}alias.player_id)`;
}
export function identitySelect(participant: string, prefix: string): string {
  return `${prefix}canonical.player_key AS ${prefix}key,${prefix}canonical.display_name AS ${prefix}display,
    CASE WHEN ${prefix}override.player_id IS NOT NULL THEN 'override' WHEN ${prefix}alias.player_id IS NOT NULL THEN 'alias' ELSE 'unresolved' END AS ${prefix}resolution`;
}
export function assertNormalizer(db: Database): void {
  if (sqlRows(db,"SELECT name_normalizer FROM corpus_metadata")[0]?.name_normalizer !== "python-casefold-v1")
    throw new Error("Unsupported corpus name normalizer");
}

/** Resolve textual ambiguity over participation-scale identity metadata, never telemetry. */
export function playerSelector(db: Database, value: string): { playerId?: number; rawKey?: string; resolvedPlayerId?: number } {
  assertNormalizer(db);
  const normalized = normalizeName(value);
  const players = sqlRows(db,"SELECT player_id,player_key,display_name FROM canonical_players")
    .filter(p=>normalizeName(String(p.player_key))===normalized || normalizeName(String(p.display_name))===normalized);
  const raw = sqlRows(db,`SELECT DISTINCT p.name_namespace,c.player_id FROM participations p
    LEFT JOIN participation_identity_overrides o USING(participation_id)
    LEFT JOIN player_aliases a ON a.name_namespace=p.name_namespace AND a.observed_name_key=p.observed_name_key
    LEFT JOIN canonical_players c ON c.player_id=coalesce(o.player_id,a.player_id)
    WHERE p.observed_name_key=?`,[normalized]);
  const identities = new Set([...players.map(p=>`player:${p.player_id}`),
    ...raw.map(p=>p.player_id==null ? `raw:${p.name_namespace}:${normalized}` : `player:${p.player_id}`)]);
  if (identities.size>1) throw Object.assign(new Error(`Ambiguous player selector "${value}"; use an unambiguous player key or a curated scope`),{code:"AMBIGUOUS_PLAYER_SELECTOR"});
  if (players.length===1) return {playerId:Number(players[0]!.player_id)};
  const resolved=raw.find(r=>r.player_id!=null);
  return {rawKey:normalized,...(resolved ? {resolvedPlayerId:Number(resolved.player_id)} : {})};
}

export function identityConditions(db:Database, filters:{[K in keyof IdentityFilters]?: string | undefined} & {player?:string | undefined;opponent?:string | undefined}, conditions:string[], args:unknown[], chronologyAvailable=true): void {
  for(const [value,p,prefix] of [[filters.player,"p","self_"],[filters.opponent,"enemy","enemy_"]] as const) {
    if(!value)continue;
    const selector=playerSelector(db,value);
    if(selector.playerId!==undefined){conditions.push(`${prefix}canonical.player_id=?`);args.push(selector.playerId);}
    else {conditions.push(`${p}.observed_name_key=?`);args.push(selector.rawKey);}
  }
  const groupId=(key:string)=>{
    const row=sqlRows(db,"SELECT group_id FROM player_groups WHERE group_key=?",[key])[0];
    if(!row)throw new Error(`Unknown player group: ${key}`);return row.group_id;
  };
  for(const [value,prefix] of [[filters.player_group,"self_"],[filters.opponent_group,"enemy_"]] as const) {
    if(value){conditions.push(`${prefix}canonical.player_id IN (SELECT player_id FROM player_group_members WHERE group_id=?)`);args.push(groupId(value));}
  }
  if(!filters.scope)return;
  const scope=sqlRows(db,"SELECT scope_id,filters_json FROM query_scopes WHERE scope_key=?",[filters.scope])[0];
  if(!scope)throw new Error(`Unknown query scope: ${filters.scope}`);
  for(const [role,prefix] of [["self","self_"],["opponent","enemy_"]] as const) {
    const constrained=sqlRows(db,"SELECT 1 FROM scope_players WHERE scope_id=? AND role=? UNION ALL SELECT 1 FROM scope_groups WHERE scope_id=? AND role=? LIMIT 1",[scope.scope_id,role,scope.scope_id,role]).length;
    if(constrained){conditions.push(`${prefix}canonical.player_id IN (
      SELECT player_id FROM scope_players WHERE scope_id=? AND role=? UNION
      SELECT m.player_id FROM scope_groups g JOIN player_group_members m USING(group_id) WHERE g.scope_id=? AND g.role=?)`);
      args.push(scope.scope_id,role,scope.scope_id,role);}
  }
  const stored=JSON.parse(String(scope.filters_json)) as Record<string,string>;
  for(const [field,column] of [["race","p.race"],["opponent_race","enemy.race"],["matchup","matchup"],["map","r.map_name"]]) {
    if(stored[field!]){
      if(field==="map" && stored[field]!.toLowerCase()==="unknown")conditions.push("(r.map_name IS NULL OR trim(r.map_name)='')");
      else{conditions.push(`${column}=? COLLATE NOCASE`);args.push(stored[field!]);}
    }
  }
  for(const [field,operator] of [["played_from",">="],["played_before","<"]] as const){
    if(stored[field]){
      if(!chronologyAvailable)conditions.push("0");
      else{
        const timestamp=Date.parse(stored[field]!)/1000;
        if(!Number.isFinite(timestamp))throw new Error(`Invalid ${field} in query scope ${filters.scope}`);
        conditions.push(`r.played_at_unix_s ${operator} ?`);args.push(timestamp);
      }
    }
  }
  if(sqlRows(db,"SELECT 1 FROM scope_replays WHERE scope_id=? LIMIT 1",[scope.scope_id]).length){
    conditions.push("r.sha256 IN (SELECT replay_sha256 FROM scope_replays WHERE scope_id=?)");args.push(scope.scope_id);
  }
}

export function listCanonicalPlayers(db:Database) {
  requireIdentityBackend(db);if(!hasIdentities(db))return {players:[]};
  return {players:sqlRows(db,"SELECT player_key AS playerKey,display_name AS displayName FROM canonical_players ORDER BY player_key")};
}
export function getPlayerIdentity(db:Database, player:string) {
  requireIdentityBackend(db);if(!hasIdentities(db))return {player:null};
  const selector=playerSelector(db,player);
  const resolvedId=selector.playerId??selector.resolvedPlayerId;
  const rows=resolvedId!==undefined ? sqlRows(db,"SELECT * FROM canonical_players WHERE player_id=?",[resolvedId]) :
    sqlRows(db,"SELECT DISTINCT c.* FROM player_aliases a JOIN canonical_players c USING(player_id) WHERE a.observed_name_key=?",[selector.rawKey]);
  if(rows.length>1)throw new Error(`Ambiguous player selector: ${player}`);
  const p=rows[0];if(!p)return {player:null};
  return {player:{playerKey:p.player_key,displayName:p.display_name,
    aliases:sqlRows(db,"SELECT name_namespace AS namespace,alias_name AS name FROM player_aliases WHERE player_id=? ORDER BY name_namespace,observed_name_key",[p.player_id]),
    groups:sqlRows(db,"SELECT group_key AS groupKey FROM player_groups JOIN player_group_members USING(group_id) WHERE player_id=? ORDER BY group_key",[p.player_id]),
    overrides:sqlRows(db,"SELECT r.sha256 AS replaySha256,p.owner FROM participation_identity_overrides o JOIN participations p USING(participation_id) JOIN replays r USING(replay_id) WHERE o.player_id=? ORDER BY r.sha256,p.owner",[p.player_id])}};
}
export function listPlayerGroups(db:Database) {
  requireIdentityBackend(db);if(!hasIdentities(db))return {groups:[]};
  return {groups:sqlRows(db,"SELECT * FROM player_groups ORDER BY group_key").map(g=>({groupKey:g.group_key,displayName:g.display_name,
    players:sqlRows(db,"SELECT player_key FROM player_group_members JOIN canonical_players USING(player_id) WHERE group_id=? ORDER BY player_key",[g.group_id]).map(p=>p.player_key)}))};
}
export function listScopes(db:Database) {
  requireIdentityBackend(db);if(!hasIdentities(db))return {scopes:[]};
  return {scopes:sqlRows(db,"SELECT * FROM query_scopes ORDER BY scope_key").map(s=>({scopeKey:s.scope_key,displayName:s.display_name,filters:JSON.parse(String(s.filters_json)),
    ...Object.fromEntries(["self","opponent"].map(role=>[role,{
      players:sqlRows(db,"SELECT player_key FROM scope_players JOIN canonical_players USING(player_id) WHERE scope_id=? AND role=? ORDER BY player_key",[s.scope_id,role]).map(p=>p.player_key),
      groups:sqlRows(db,"SELECT group_key FROM scope_groups JOIN player_groups USING(group_id) WHERE scope_id=? AND role=? ORDER BY group_key",[s.scope_id,role]).map(g=>g.group_key)}])),
    replaySha256:sqlRows(db,"SELECT replay_sha256 FROM scope_replays WHERE scope_id=? ORDER BY replay_sha256",[s.scope_id]).map(r=>r.replay_sha256)}))};
}

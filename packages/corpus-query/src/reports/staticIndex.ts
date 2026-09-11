import { randomUUID } from "node:crypto";
import { chmod, lstat, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { openDatabase } from "../db/sqlite.js";
import { detectCorpusBackend, sqlRows } from "../db/backend.js";
import { hasIdentities, identityJoins, identitySelect } from "../identity/catalog.js";
import { formatPlayedAt } from "../analytics/filters.js";

export interface ReportParticipant {
  owner:number;
  name:string;
  observedName:string;
  race:string;
}

export interface StaticReportRow {
  replaySha256:string;
  analysisKey:string;
  playedAtUnixSeconds:number|null;
  playedAt:string|null;
  playedDisplay:string;
  year:string;
  map:string;
  participants:ReportParticipant[];
  participantsDisplay:string;
  racePair:string;
  reportHref:string|null;
  reportUnavailableReason:string|null;
}

export interface StaticReportIndexResult {
  status:"updated"|"no-op";
  output:string;
  replays:number;
  reportsAvailable:number;
  reportsUnavailable:number;
  earliestPlayedAt:string|null;
  latestPlayedAt:string|null;
  distinctMaps:number;
  distinctPlayers:number;
  distinctYears:number;
  warnings:Array<{replaySha256:string;analysisKey:string;message:string}>;
}

export interface StaticReportIndexOptions {dbPath:string;analysesRoot:string}
export interface StaticReportIndexDependencies {beforeReplace?:(temporaryPath:string,outputPath:string)=>Promise<void>}

type CurrentRow={replay_sha256:unknown;analysis_key:unknown;analysis_id:unknown;played_at_unix_s:unknown;map_name:unknown;
  owner:unknown;observed_name:unknown;race:unknown;self_display:unknown;replay_manifest_path:unknown};

/** Generate the disposable, offline view of current accepted report artifacts. */
export function createStaticReportIndexGenerator(dependencies:StaticReportIndexDependencies={}) {
  return async function generateStaticReportIndex(options:StaticReportIndexOptions):Promise<StaticReportIndexResult>{
    const root=await realpath(resolve(options.analysesRoot));
    const rootInfo=await lstat(root);if(!rootInfo.isDirectory())throw new Error("Analyses root is not a directory");
    const output=join(root,"index.html");
    const {rows,warnings}=await currentReportRows(resolve(options.dbPath),root);
    const html=renderStaticReportIndex(rows);
    let status:StaticReportIndexResult["status"]="updated";
    try{const outputInfo=await lstat(output);if(!outputInfo.isSymbolicLink()&&outputInfo.isFile()&&await readFile(output,"utf8")===html)status="no-op";}
    catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
    if(status==="updated")await replaceAtomically(output,html,dependencies);
    const timestamps=rows.flatMap(row=>row.playedAtUnixSeconds===null?[]:[row.playedAtUnixSeconds]);
    const playerNames=new Set(rows.flatMap(row=>row.participants.map(player=>player.name)));
    return {status,output,replays:rows.length,reportsAvailable:rows.filter(row=>row.reportHref).length,
      reportsUnavailable:rows.filter(row=>!row.reportHref).length,
      earliestPlayedAt:timestamps.length?formatPlayedAt(Math.min(...timestamps)):null,
      latestPlayedAt:timestamps.length?formatPlayedAt(Math.max(...timestamps)):null,
      distinctMaps:new Set(rows.map(row=>row.map)).size,distinctPlayers:playerNames.size,
      distinctYears:new Set(rows.flatMap(row=>row.year?[row.year]:[])).size,warnings};
  };
}

export const generateStaticReportIndex=createStaticReportIndexGenerator();

async function currentReportRows(dbPath:string,root:string):Promise<{rows:StaticReportRow[];warnings:StaticReportIndexResult["warnings"]}>{
  const {db}=await openDatabase(dbPath,{readOnly:true});
  let raw:CurrentRow[];
  try{
    if(detectCorpusBackend(db)!=="v2")throw Object.assign(new Error("Static report indexes require Corpus v2"),{code:"NOT_SUPPORTED_FOR_CORPUS_V1"});
    const identities=hasIdentities(db),chronology=sqlRows(db,"PRAGMA table_info(replays)").some(row=>row.name==="played_at_unix_s");
    const publications=sqlRows(db,"SELECT 1 FROM sqlite_schema WHERE type='table' AND name='analysis_publications'").length>0;
    raw=sqlRows(db,`SELECT r.sha256 AS replay_sha256,a.analysis_key,a.analysis_id,
      ${chronology?"r.played_at_unix_s":"NULL"} AS played_at_unix_s,r.map_name,
      p.owner,p.observed_name,p.race,
      ${identities?identitySelect("p","self_"):"NULL AS self_key,NULL AS self_display,'unresolved' AS self_resolution"},
      ${publications?"pub.replay_manifest_path":"NULL"} AS replay_manifest_path
      FROM replays r JOIN current_analyses ca ON ca.replay_id=r.replay_id
      JOIN analysis_runs a ON a.analysis_id=ca.analysis_id AND a.replay_id=r.replay_id AND a.status='indexed'
      LEFT JOIN analysis_participations ap ON ap.analysis_id=a.analysis_id AND ap.replay_id=r.replay_id
      LEFT JOIN participations p ON p.participation_id=ap.participation_id
      ${identities?identityJoins("p","self_"):""}
      ${publications?"LEFT JOIN analysis_publications pub ON pub.analysis_id=a.analysis_id":""}
      ORDER BY r.sha256,p.owner`) as CurrentRow[];
  }finally{db.close();}
  const grouped=new Map<string,CurrentRow[]>();for(const row of raw){const key=String(row.replay_sha256);const group=grouped.get(key)??[];group.push(row);grouped.set(key,group);}
  const rows:StaticReportRow[]=[],warnings:StaticReportIndexResult["warnings"]=[];
  for(const [replaySha256,group] of grouped){
    const first=group[0]!,analysisKey=String(first.analysis_key),timestamp=first.played_at_unix_s==null?null:Number(first.played_at_unix_s);
    const report=await resolveReport(root,{replaySha256,analysisKey,manifestPath:first.replay_manifest_path==null?null:String(first.replay_manifest_path)});
    if(!report.href)warnings.push({replaySha256,analysisKey,message:report.reason!});
    const participants=group.filter(row=>row.owner!==null).map(row=>({owner:Number(row.owner),
      name:row.self_display==null?String(row.observed_name):String(row.self_display),observedName:String(row.observed_name),race:String(row.race)}));
    const playedAt=formatPlayedAt(timestamp);
    rows.push({replaySha256,analysisKey,playedAtUnixSeconds:timestamp,playedAt,
      playedDisplay:playedAt?playedAt.slice(0,16).replace("T"," "):"Unknown",year:playedAt?.slice(0,4)??"",
      map:first.map_name==null||String(first.map_name).trim()===""?"Unknown":String(first.map_name),participants,
      participantsDisplay:participantLabel(participants),racePair:racePair(participants),reportHref:report.href,
      reportUnavailableReason:report.href?null:report.reason!});
  }
  rows.sort((left,right)=>(right.playedAtUnixSeconds??-1)-(left.playedAtUnixSeconds??-1)||left.replaySha256.localeCompare(right.replaySha256));
  return {rows,warnings};
}

async function resolveReport(root:string,input:{replaySha256:string;analysisKey:string;manifestPath:string|null}):Promise<{href:string|null;reason:string|null}>{
  try{
    if(!input.manifestPath)return {href:null,reason:"current analysis has no publication manifest"};
    const manifestCandidate=resolve(input.manifestPath);
    const manifestReal=await realpath(manifestCandidate);
    if(!contained(root,manifestReal))throw new Error("publication manifest is outside analyses root");
    const manifestInfo=await lstat(manifestCandidate);if(!manifestInfo.isFile()||manifestInfo.isSymbolicLink())throw new Error("publication manifest is not a regular file");
    const manifest=JSON.parse(await readFile(manifestReal,"utf8")) as {replay_id?:unknown;publication?:{format?:unknown};legacy?:{html_files?:unknown}};
    if(manifest.replay_id!==input.replaySha256)throw new Error("publication manifest replay identity mismatch");
    if(manifest.publication?.format!=="bw-forge-publication-v1")throw new Error("unsupported publication manifest");
    if(!Array.isArray(manifest.legacy?.html_files)||!manifest.legacy.html_files.length)throw new Error("publication manifest has no HTML report");
    const failures:string[]=[];
    for(const value of [...manifest.legacy.html_files].sort((a,b)=>String(a)<String(b)?-1:String(a)>String(b)?1:0)){
      try{
        if(typeof value!=="string"||!value||isAbsolute(value)||extname(value).toLowerCase()!==".html")throw new Error("invalid HTML artifact path");
        const candidate=resolve(dirname(manifestReal),value),actual=await realpath(candidate);
        if(!contained(root,actual))throw new Error("HTML artifact is outside analyses root");
        const info=await lstat(candidate);if(!info.isFile()||info.isSymbolicLink())throw new Error("HTML artifact is not a regular file");
        const path=relative(root,actual);if(!path||path.split(sep).includes(".."))throw new Error("invalid relative HTML artifact path");
        return {href:`./${path.split(sep).map(encodeURIComponent).join("/")}`,reason:null};
      }catch(error){failures.push(error instanceof Error?error.message:String(error));}
    }
    throw new Error(failures.join("; ")||"HTML report unavailable");
  }catch(error){return {href:null,reason:error instanceof Error?error.message:String(error)};}
}

function contained(root:string,path:string):boolean {const rel=relative(root,path);return rel===""||(!rel.startsWith(`..${sep}`)&&rel!==".."&&!isAbsolute(rel));}
function raceCode(race:string):string {return ({zerg:"Z",terran:"T",protoss:"P",unknown:"?"} as Record<string,string>)[race.toLowerCase()]??(race.slice(0,1).toUpperCase()||"?");}
function participantLabel(players:ReportParticipant[]):string {if(!players.length)return "Participants unavailable";const labels=players.map(p=>`${p.name} (${raceCode(p.race)})`);return players.length===2?labels.join(" vs "):labels.join(", ");}
function racePair(players:ReportParticipant[]):string {return players.length?players.map(p=>raceCode(p.race)).join(" vs "):"Unknown";}

async function replaceAtomically(output:string,content:string,dependencies:StaticReportIndexDependencies):Promise<void>{
  const temporary=join(dirname(output),`.${basename(output)}.${randomUUID()}.tmp`);
  try{await writeFile(temporary,content,{encoding:"utf8",mode:0o644,flag:"wx"});await dependencies.beforeReplace?.(temporary,output);await rename(temporary,output);await chmod(output,0o644);}
  finally{try{await unlink(temporary);}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}}
}

export function filterReportRows(rows:StaticReportRow[],filters:{search?:string;player?:string;map?:string;year?:string;racePair?:string}):StaticReportRow[]{
  const search=filters.search?.trim().toLocaleLowerCase()??"";
  return rows.filter(row=>(!search||[row.replaySha256,row.map,row.racePair,...row.participants.flatMap(p=>[p.name,p.observedName])].join("\n").toLocaleLowerCase().includes(search))&&
    (!filters.player||row.participants.some(p=>p.name===filters.player))&&(!filters.map||row.map===filters.map)&&
    (!filters.year||row.year===filters.year)&&(!filters.racePair||row.racePair===filters.racePair));
}

export function sortReportRows(rows:StaticReportRow[],key:"played"|"map"|"players"|"racePair"|"replay",direction:"asc"|"desc"):StaticReportRow[]{
  const value=(row:StaticReportRow):string|number=>key==="played"?(row.playedAtUnixSeconds??(direction==="asc"?Number.MAX_SAFE_INTEGER:-1)):
    key==="map"?row.map:key==="players"?row.participantsDisplay:key==="racePair"?row.racePair:row.replaySha256;
  return [...rows].sort((a,b)=>{const av=value(a),bv=value(b),comparison=typeof av==="number"&&typeof bv==="number"?av-bv:String(av).localeCompare(String(bv));return (direction==="asc"?comparison:-comparison)||a.replaySha256.localeCompare(b.replaySha256);});
}

export function renderStaticReportIndex(rows:StaticReportRow[]):string {
  const data=JSON.stringify(rows).replaceAll("&","\\u0026").replaceAll("<","\\u003c").replaceAll(">","\\u003e").replaceAll("\u2028","\\u2028").replaceAll("\u2029","\\u2029");
  const known=rows.filter(row=>row.playedAt);const range=known.length?`${known.at(-1)!.playedAt!.slice(0,10)} → ${known[0]!.playedAt!.slice(0,10)}`:"Dates unavailable";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
<title>BW Forge replay reports</title><style>${STYLE}</style></head><body>
<main><header><div><h1>Replay reports</h1><p class="summary">${rows.length} replays · ${rows.filter(row=>row.reportHref).length} reports · ${range}</p></div><p class="hint">Current accepted analyses · replay-declared UTC dates</p></header>
<section class="filters" aria-label="Replay filters"><label>Search<input id="search" type="search" placeholder="Player, map, race, SHA"></label><label>Player<select id="player"><option value="">All players</option></select></label><label>Race pairing<select id="racePair"><option value="">All pairings</option></select></label><label>Map<select id="map"><option value="">All maps</option></select></label><label>Year<select id="year"><option value="">All years</option></select></label><button id="reset" type="button">Clear filters</button></section>
<div class="table-head"><strong id="resultCount"></strong><span>Click a heading to sort</span></div><div class="table-wrap"><table><thead><tr><th><button data-sort="played">Played</button></th><th><button data-sort="map">Map</button></th><th><button data-sort="players">Players</button></th><th><button data-sort="racePair">Race pairing</button></th><th>Report</th></tr></thead><tbody id="rows"></tbody></table></div>
<noscript>This index needs local JavaScript for its embedded search and table rendering. No network access is used.</noscript>
</main><script id="report-data" type="application/json">${data}</script><script>${CLIENT}</script></body></html>
`;
}

const STYLE=`:root{color-scheme:light dark;--bg:#f5f6f7;--panel:#fff;--text:#202428;--muted:#667078;--line:#d9dde1;--accent:#245ea8}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}main{max-width:1400px;margin:auto;padding:24px}header{display:flex;justify-content:space-between;gap:24px;align-items:end;margin-bottom:18px}h1{font-size:24px;margin:0 0 3px}.summary,.hint{color:var(--muted);margin:0}.filters{display:grid;grid-template-columns:minmax(180px,2fr) repeat(4,minmax(120px,1fr)) auto;gap:10px;align-items:end;background:var(--panel);border:1px solid var(--line);padding:12px;border-radius:8px}.filters label{display:grid;gap:4px;color:var(--muted);font-size:12px}input,select,.filters>button{height:36px;border:1px solid var(--line);border-radius:5px;background:var(--panel);color:var(--text);padding:0 9px}.filters>button{cursor:pointer}.table-head{display:flex;justify-content:space-between;color:var(--muted);margin:16px 2px 7px}.table-wrap{overflow:auto;background:var(--panel);border:1px solid var(--line);border-radius:8px}table{width:100%;border-collapse:collapse;white-space:nowrap}th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--line)}th{font-size:12px;color:var(--muted)}th button{border:0;background:none;color:inherit;font:inherit;font-weight:700;padding:0;cursor:pointer}tbody tr:last-child td{border-bottom:0}.map,.players{white-space:normal;min-width:180px}a{color:var(--accent);font-weight:650}.unavailable{color:var(--muted)}@media(max-width:850px){main{padding:12px}.filters{grid-template-columns:1fr 1fr}.filters label:first-child{grid-column:1/-1}header{display:block}.hint{margin-top:4px}}@media(prefers-color-scheme:dark){:root{--bg:#151719;--panel:#1d2023;--text:#e8ebed;--muted:#a5adb3;--line:#363b40;--accent:#78aeef}}`;

const CLIENT=`(()=>{"use strict";const all=JSON.parse(document.getElementById("report-data").textContent),body=document.getElementById("rows"),count=document.getElementById("resultCount"),controls={search:document.getElementById("search"),player:document.getElementById("player"),racePair:document.getElementById("racePair"),map:document.getElementById("map"),year:document.getElementById("year")};let sortKey="played",sortDirection="desc";const text=(tag,value,className)=>{const node=document.createElement(tag);node.textContent=value;if(className)node.className=className;return node},values=(name,source)=>[...new Set(all.flatMap(source).filter(Boolean))].sort((a,b)=>a.localeCompare(b)).forEach(value=>{const option=text("option",value);option.value=value;controls[name].append(option)});values("player",row=>row.participants.map(p=>p.name));values("racePair",row=>[row.racePair]);values("map",row=>[row.map]);values("year",row=>[row.year]);const refresh=()=>{const search=controls.search.value.trim().toLocaleLowerCase();let selected=all.filter(row=>(!search||[row.replaySha256,row.map,row.racePair,...row.participants.flatMap(p=>[p.name,p.observedName])].join("\n").toLocaleLowerCase().includes(search))&&(!controls.player.value||row.participants.some(p=>p.name===controls.player.value))&&(!controls.racePair.value||row.racePair===controls.racePair.value)&&(!controls.map.value||row.map===controls.map.value)&&(!controls.year.value||row.year===controls.year.value));const value=row=>sortKey==="played"?(row.playedAtUnixSeconds??(sortDirection==="asc"?Number.MAX_SAFE_INTEGER:-1)):sortKey==="map"?row.map:sortKey==="players"?row.participantsDisplay:sortKey==="racePair"?row.racePair:row.replaySha256;selected.sort((a,b)=>{const av=value(a),bv=value(b),c=typeof av==="number"?av-bv:String(av).localeCompare(String(bv));return(sortDirection==="asc"?c:-c)||a.replaySha256.localeCompare(b.replaySha256)});body.replaceChildren();for(const row of selected){const tr=document.createElement("tr"),played=text("td",row.playedDisplay);if(row.playedAt)played.title=row.playedAt;tr.append(played,text("td",row.map,"map"),text("td",row.participantsDisplay,"players"),text("td",row.racePair));const report=document.createElement("td");if(row.reportHref){const link=text("a","Open report");link.href=row.reportHref;report.append(link)}else{const unavailable=text("span","Unavailable","unavailable");unavailable.title=row.reportUnavailableReason||"Report unavailable";report.append(unavailable)}tr.append(report);body.append(tr)}count.textContent=selected.length+" of "+all.length+" replays"};Object.values(controls).forEach(control=>control.addEventListener("input",refresh));document.getElementById("reset").addEventListener("click",()=>{Object.values(controls).forEach(control=>control.value="");sortKey="played";sortDirection="desc";refresh()});document.querySelectorAll("[data-sort]").forEach(button=>button.addEventListener("click",()=>{const key=button.dataset.sort;sortDirection=sortKey===key&&sortDirection==="asc"?"desc":"asc";sortKey=key;refresh()}));refresh()})();`;

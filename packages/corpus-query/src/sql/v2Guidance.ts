import type { QueryExample } from "./queryExamples.js";
import type { SchemaJoinHint, SchemaNotesResult } from "./schemaDescription.js";

export const V2_PURPOSES:Record<string,string>={
  corpus_migrations:"Additive v2 revisions; major markers stay 2. Revision 1 adds identities and revision 2 adds analysis jobs.",
  replay_sources:"Operational provenance for canonically registered replay bytes; multiple source references may identify one replay.",
  analysis_jobs:"Persistent queued/running/succeeded/failed analysis work with priority, leases, attempts and optional indexed result. It is not the current-analysis pointer.",
  analysis_job_attempts:"Compact claim history, including failed work and workers abandoned through lease expiry.",
  canonical_players:"User-curated canonical identities. player_key is durable; display_name can change.",
  player_aliases:"Exact (name_namespace, observed_name_key) mapping to player_id, normalized with corpus_metadata.name_normalizer. Never infer aliases.",
  participation_identity_overrides:"Explicit identity override for a participation; takes precedence over aliases. Configure by replay SHA256 + owner.",
  player_groups:"User-curated named groups; group_key is the stable external identifier.",
  player_group_members:"Many-to-many group membership of canonical players.",
  query_scopes:"Named typed cohorts, scope_key plus JSON race/opponent_race/matchup/map constraints; never arbitrary SQL.",
  scope_players:"Canonical player selectors by scope and self/opponent role.",
  scope_groups:"Canonical group selectors by scope and self/opponent role; union with same-role players.",
  scope_replays:"Optional replay SHA256 restrictions for a scope, independent of integer replay IDs.",
  replays:"Stable external identity is sha256; integer replay_id is internal. map_name is observed metadata.",
  participations:"Stable replay-local participation for (replay_id,owner). observed_name is a raw name, not a canonical identity.",
  analysis_specs:"Immutable fingerprint, unit domain and rational frame clock (num_ms/den).",
  analysis_runs:"Analysis history; normal queries must select only the current indexed run.",
  current_analyses:"Accepted current analysis pointer for each replay.",
  analysis_participations:"Links a stable participation to an analysis-specific observation_id.",
  economy_changes:"Sparse full tuples. Latest change within the covering segment; no carry across gaps or beyond coverage.",
  unit_count_changes:"Sparse per-unit changes including explicit zero transitions.",
  analysis_unit_domain:"Units observable under a spec; units outside this domain are UNKNOWN, never implicit zero.",
  unit_types:"Compact dictionary for unit/build item names.",
  stream_coverage:"Inclusive frame segments and evidence basis; observations_only does not prove complete state or absence.",
  build_events:"Individual occurrences with frame bounds and legacy timing uncertainty; frame may be NULL.",
  supply_changes:"Sparse full current/max supply tuple changes.",
  death_events:"Individual frame events for observed losses; opponent losses do not prove killer attribution.",
  analysis_artifacts:"Logical artifact/checksum inventory; ZIP member and semantic-manifest hashes need not equal container hashes.",
  analysis_publications:"Immutable published manifest and canonical raw replay paths (optional before publication).",
  analysis_artifact_locations:"Published physical file paths and optional ZIP member names (optional before publication).",
  corpus_metadata:"Strong v2 schema marker: schema_version=2, purpose=corpus-store, user_version=2."
};
export const V2_JOINS:SchemaJoinHint[]=[
  {left:"participations",right:"participation_identity_overrides",on:["participation_id"]},
  {left:"participations",right:"player_aliases",on:["name_namespace","observed_name_key"]},
  {left:"player_aliases",right:"canonical_players",on:["player_id"]},
  {left:"participation_identity_overrides",right:"canonical_players",on:["player_id"]},
  {left:"player_group_members",right:"canonical_players",on:["player_id"]},
  {left:"player_group_members",right:"player_groups",on:["group_id"]},
  {left:"scope_players",right:"query_scopes",on:["scope_id"]},
  {left:"scope_groups",right:"query_scopes",on:["scope_id"]},
  {left:"scope_replays",right:"query_scopes",on:["scope_id"]},
  {left:"replays",right:"current_analyses",on:["replay_id"]},
  {left:"current_analyses",right:"analysis_runs",on:["analysis_id","replay_id"]},
  {left:"analysis_runs",right:"analysis_specs",on:["spec_id"]},
  {left:"analysis_runs",right:"analysis_participations",on:["analysis_id","replay_id"]},
  {left:"participations",right:"analysis_participations",on:["participation_id","replay_id"]},
  ...["economy_changes","unit_count_changes","build_events","supply_changes","death_events","stream_coverage"].map(left=>({left,right:"analysis_participations",on:["observation_id"]})),
  {left:"analysis_specs",right:"analysis_unit_domain",on:["spec_id"]},
  {left:"analysis_unit_domain",right:"unit_types",on:["unit_type_id"]}
];
export const V2_NOTES:SchemaNotesResult["notes"]=[
  {topic:"joins",title:"Corpus v2 current observations and identity",bullets:["Use replays.sha256 as external replay identity, not internal INTEGER IDs.",
    "Join replays -> current_analyses -> indexed analysis_runs -> analysis_participations -> stable participations. Never mix historical runs.",
    "Telemetry uses observation_id and stays replay-local. Never rewrite participations or duplicate telemetry for canonical players.",
    "After additive migration revision 1, LEFT JOIN overrides by participation_id and aliases by namespace + observed_name_key. Resolve canonical player_id with COALESCE(override.player_id, alias.player_id). Otherwise retain unresolved raw identity (namespace + key).",
    "Stable external player_key/group_key/scope_key are user-curated. Canonical display names or keys expand aliases; raw alias filters remain usable. Ambiguous selectors are errors.",
    "Scope self/opponent players and groups are OR within a role; roles, other dimensions, replay SHA restrictions, and explicit query filters are AND. Empty selector dimensions are unconstrained; a selected empty group matches nobody.",
    "Pre-identity v2 databases remain readable by raw names. Apply the identity catalog through the CLI to migrate; MCP never writes or migrates."]},
  {topic:"timings",title:"Rational frame clock and uncertainty",bullets:["Seconds = frame * analysis_specs.frame_duration_num_ms / (1000 * frame_duration_den).",
    "Convert seconds to the applicable frame before sparse range lookups. processed_end_frame is an observed endpoint, not proof of complete replay duration.",
    "Build time_seconds may be legacy second-floor time; frame=NULL with frame_min/frame_max is uncertain, not exact."]},
  {topic:"economy",title:"Sparse full tuples and coverage",bullets:["First locate an inclusive stream_coverage segment for economy. Select the latest tuple at/before the requested frame inside that segment.",
    "Before, after and between coverage segments are UNKNOWN. Never densify or carry state across a gap. Supply uses the same tuple-change principle."]},
  {topic:"unit_counts",title:"UNKNOWN versus ZERO",bullets:["Respect composition coverage and analysis_unit_domain for the current spec.",
    "Outside the unit domain is UNKNOWN. Inside the domain with complete coverage, absent changes imply baseline zero; explicit zero must stay zero.",
    "Use the latest unit change inside the covering segment, including zero transitions. observations_only does not imply baseline absence.",
    "Composition aggregate unknownCounts and unitSampleSizes disclose missing evidence; unknown observations are excluded from numeric statistics."]},
  {topic:"build_order",title:"Build occurrences",bullets:["Preserve occurrence ordering and repeated items. Coarse time filters use the recorded timestamp and return uncertainty bounds.",
    "Event comparisons with overlapping bounds are uncertain and excluded from definite-match percentages."]},
  {topic:"deaths",title:"Individual observed deaths",bullets:["Count individual death_events within inclusive frame ranges; do not deduplicate simultaneous events.",
    "Counts represent observed events. Missing events do not prove an interval is complete. Killed is opponent losses, not killer attribution."]},
  {topic:"paths",title:"Immutable publication metadata",bullets:["analysis_publications and analysis_artifact_locations reference immutable published files and canonical raw replays.",
    "Unpublished 2A databases can lack these optional tables; paths may be unavailable. Logical analysis_artifacts checksums include uncompressed ZIP members.",
    "ingest_corpus, execute_query_plan and export_query_plan_zip are v1-only for now. Use analyze-v2/ingest-v2 for v2 ingestion."]}
];
const current=`FROM replays r JOIN current_analyses ca ON ca.replay_id=r.replay_id
JOIN analysis_runs a ON a.analysis_id=ca.analysis_id AND a.status='indexed'
JOIN analysis_specs s ON s.spec_id=a.spec_id
JOIN analysis_participations ap ON ap.analysis_id=a.analysis_id
JOIN participations p ON p.participation_id=ap.participation_id`;
export const V2_EXAMPLES:QueryExample[]=[
  {topic:"players",title:"Current effective canonical identities with raw evidence",sql:`SELECT r.sha256,p.owner,p.observed_name,p.name_namespace,c.player_key,c.display_name,
CASE WHEN o.player_id IS NOT NULL THEN 'override' WHEN al.player_id IS NOT NULL THEN 'alias' ELSE 'unresolved' END AS identity_resolution
${current}
LEFT JOIN participation_identity_overrides o ON o.participation_id=p.participation_id
LEFT JOIN player_aliases al ON al.name_namespace=p.name_namespace AND al.observed_name_key=p.observed_name_key
LEFT JOIN canonical_players c ON c.player_id=coalesce(o.player_id,al.player_id)
ORDER BY r.sha256,p.owner LIMIT 50`,notes:["Requires additive identity revision 1. LEFT JOIN retains unresolved names. Never update raw participations; telemetry remains on ap.observation_id."]},
  {topic:"players",title:"Named scopes and their canonical group selectors",sql:`SELECT s.scope_key,s.display_name,s.filters_json,g.role,pg.group_key,c.player_key
FROM query_scopes s LEFT JOIN scope_groups g USING(scope_id) LEFT JOIN player_groups pg USING(group_id)
LEFT JOIN player_group_members gm USING(group_id) LEFT JOIN canonical_players c USING(player_id)
ORDER BY s.scope_key,g.role,pg.group_key,c.player_key LIMIT 50`,notes:["Requires additive identity revision 1. Union role group members with scope_players; AND self/opponent, filters_json dimensions, scope_replays and explicit query filters. An empty selector dimension is unconstrained."]},
  {topic:"players",title:"Current replay participants by external SHA",sql:`SELECT r.sha256,p.owner,p.observed_name,p.race ${current} ORDER BY r.sha256,p.owner LIMIT 50`,notes:["Raw player names; stable participations joined to current observations."]},
  {topic:"matchups",title:"Current matchup participants and maps",sql:`SELECT r.sha256,r.map_name,group_concat(p.race,' vs ') AS races ${current} GROUP BY r.sha256,r.map_name LIMIT 50`,notes:["Race composition from current participating slots; no v1 matchup column."]},
  {topic:"build_timings",title:"Current build occurrences with uncertainty",sql:`SELECT r.sha256,p.observed_name,u.unit_key,b.occurrence,b.time_seconds,b.frame,b.frame_min,b.frame_max,b.timing_basis ${current} JOIN build_events b ON b.observation_id=ap.observation_id JOIN unit_types u ON u.unit_type_id=b.unit_type_id ORDER BY r.sha256,b.time_seconds,b.occurrence LIMIT 50`,notes:["Legacy second-floor times are not exact frames."]},
  {topic:"economy",title:"Covered sparse economy at 0.084 seconds",sql:`SELECT r.sha256,p.observed_name,e.frame,e.minerals,e.gas,e.workers ${current}
JOIN stream_coverage c ON c.observation_id=ap.observation_id AND c.stream='economy' AND c.basis<>'observations_only'
 AND 0.084*1000*s.frame_duration_den/s.frame_duration_num_ms BETWEEN c.start_frame AND c.end_frame
JOIN economy_changes e ON e.observation_id=ap.observation_id AND e.frame=(SELECT max(x.frame) FROM economy_changes x
 WHERE x.observation_id=ap.observation_id AND x.frame>=c.start_frame AND x.frame<=0.084*1000*s.frame_duration_den/s.frame_duration_num_ms) LIMIT 50`,notes:["No row means unknown/outside coverage. No dense expansion."]},
  {topic:"composition",title:"Covered in-domain composition including zero at frame 2",sql:`SELECT r.sha256,p.observed_name,u.unit_key,coalesce((SELECT x.count FROM unit_count_changes x
 WHERE x.observation_id=ap.observation_id AND x.unit_type_id=u.unit_type_id AND x.frame>=c.start_frame AND x.frame<=2 ORDER BY x.frame DESC LIMIT 1),0) AS count
${current} JOIN stream_coverage c ON c.observation_id=ap.observation_id AND c.stream='composition' AND c.basis<>'observations_only' AND 2 BETWEEN c.start_frame AND c.end_frame
JOIN analysis_unit_domain d ON d.spec_id=s.spec_id JOIN unit_types u ON u.unit_type_id=d.unit_type_id LIMIT 50`,notes:["Zero is valid only within domain and complete coverage. Explicit zero overrides prior positives."]},
  {topic:"deaths",title:"Current individual deaths in frame interval",sql:`SELECT r.sha256,p.observed_name,d.frame,u.unit_key,d.category ${current} JOIN death_events d ON d.observation_id=ap.observation_id JOIN unit_types u ON u.unit_type_id=d.unit_type_id WHERE d.frame BETWEEN 0 AND 100 ORDER BY r.sha256,d.frame,d.occurrence LIMIT 50`,notes:["Observed losses, not complete interval coverage or killer attribution."]},
  {topic:"event_sequences",title:"Definitely ordered build occurrences",sql:`SELECT r.sha256,p.observed_name,b1.occurrence,b2.occurrence ${current} JOIN build_events b1 ON b1.observation_id=ap.observation_id JOIN build_events b2 ON b2.observation_id=ap.observation_id AND b1.frame_max<b2.frame_min LIMIT 50`,notes:["Overlapping uncertainty bounds do not prove event order."]},
  {topic:"replay_cards",title:"Current replay card metadata",sql:`SELECT r.sha256,r.map_name,p.observed_name,p.race,a.processed_end_frame,s.frame_duration_num_ms,s.frame_duration_den ${current} LIMIT 50`,notes:["Published locations are optional; processed endpoint is not guaranteed full duration."]}
];

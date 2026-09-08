-- Corpus store v2. Only initialize an empty database; never migrate v1.
PRAGMA foreign_keys = ON;
PRAGMA user_version = 2;
CREATE TABLE corpus_metadata (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 schema_version INTEGER NOT NULL CHECK(schema_version=2),
 corpus_uuid TEXT NOT NULL UNIQUE, created_at_ms INTEGER NOT NULL,
 name_normalizer TEXT NOT NULL, purpose TEXT NOT NULL CHECK(purpose='corpus-store')
) STRICT;
CREATE TABLE replays (
 replay_id INTEGER PRIMARY KEY, sha256 TEXT NOT NULL UNIQUE
 CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
 byte_size INTEGER NOT NULL CHECK(byte_size>=0), raw_relative_path TEXT,
 first_seen_at_ms INTEGER NOT NULL, map_name TEXT
) STRICT;
CREATE TABLE participations (
 participation_id INTEGER PRIMARY KEY, replay_id INTEGER NOT NULL REFERENCES replays,
 owner INTEGER NOT NULL CHECK(owner>=0), observed_name TEXT NOT NULL,
 observed_name_key TEXT NOT NULL, name_namespace TEXT NOT NULL,
 race TEXT NOT NULL CHECK(race IN ('zerg','terran','protoss','unknown')),
 UNIQUE(replay_id,owner), UNIQUE(participation_id,replay_id)
) STRICT;
CREATE TABLE analysis_specs (
 spec_id INTEGER PRIMARY KEY, fingerprint_sha256 TEXT NOT NULL UNIQUE,
 bw_forge_version TEXT NOT NULL, bwsim_version TEXT, bwsim_wasm_sha256 TEXT,
 asset_pack_sha256 TEXT, reducer_version TEXT NOT NULL,
 artifact_format TEXT NOT NULL, telemetry_contract TEXT NOT NULL,
 settings_json TEXT NOT NULL, frame_duration_num_ms INTEGER NOT NULL CHECK(frame_duration_num_ms>0),
 frame_duration_den INTEGER NOT NULL CHECK(frame_duration_den>0),
 origin TEXT NOT NULL CHECK(origin IN ('native','legacy_import')), created_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE analysis_runs (
 analysis_id INTEGER PRIMARY KEY, analysis_key TEXT NOT NULL UNIQUE,
 replay_id INTEGER NOT NULL REFERENCES replays, spec_id INTEGER NOT NULL REFERENCES analysis_specs,
 status TEXT NOT NULL CHECK(status IN ('artifacts_ready','indexed','failed')),
 outcome TEXT NOT NULL CHECK(outcome IN ('complete','early_stop','truncated','legacy_partial')),
 queued_at_ms INTEGER NOT NULL, indexed_at_ms INTEGER, processed_end_frame INTEGER,
 termination_reason TEXT, validation_json TEXT, UNIQUE(analysis_id,replay_id)
) STRICT;
CREATE TABLE current_analyses (
 replay_id INTEGER PRIMARY KEY REFERENCES replays, analysis_id INTEGER NOT NULL UNIQUE,
 accepted_at_ms INTEGER NOT NULL,
 FOREIGN KEY(analysis_id,replay_id) REFERENCES analysis_runs(analysis_id,replay_id)
) STRICT;
CREATE TABLE analysis_participations (
 observation_id INTEGER PRIMARY KEY, analysis_id INTEGER NOT NULL,
 participation_id INTEGER NOT NULL, replay_id INTEGER NOT NULL,
 UNIQUE(analysis_id,participation_id),
 FOREIGN KEY(analysis_id,replay_id) REFERENCES analysis_runs(analysis_id,replay_id),
 FOREIGN KEY(participation_id,replay_id) REFERENCES participations(participation_id,replay_id)
) STRICT;
CREATE INDEX observations_by_participation ON analysis_participations(participation_id,analysis_id);
CREATE TABLE stream_coverage (
 observation_id INTEGER NOT NULL REFERENCES analysis_participations,
 stream TEXT NOT NULL CHECK(stream IN ('builds','economy','supply','composition','deaths')),
 start_frame INTEGER NOT NULL CHECK(start_frame>=0),
 end_frame INTEGER NOT NULL CHECK(end_frame>=start_frame),
 basis TEXT NOT NULL CHECK(basis IN ('verified','legacy_inferred','observations_only')),
 PRIMARY KEY(observation_id,stream,start_frame)
) STRICT, WITHOUT ROWID;
CREATE TABLE economy_changes (
 observation_id INTEGER NOT NULL REFERENCES analysis_participations,
 frame INTEGER NOT NULL CHECK(frame>=0), minerals INTEGER NOT NULL CHECK(minerals>=0),
 gas INTEGER NOT NULL CHECK(gas>=0), workers INTEGER CHECK(workers>=0),
 gathered_minerals INTEGER CHECK(gathered_minerals>=0), gathered_gas INTEGER CHECK(gathered_gas>=0),
 PRIMARY KEY(observation_id,frame)
) STRICT, WITHOUT ROWID;
CREATE TABLE unit_types (
 unit_type_id INTEGER PRIMARY KEY, unit_key TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL
) STRICT;
CREATE TABLE analysis_unit_domain (
 spec_id INTEGER NOT NULL REFERENCES analysis_specs,
 unit_type_id INTEGER NOT NULL REFERENCES unit_types,
 PRIMARY KEY(spec_id,unit_type_id)
) STRICT, WITHOUT ROWID;
CREATE TABLE unit_count_changes (
 observation_id INTEGER NOT NULL REFERENCES analysis_participations,
 unit_type_id INTEGER NOT NULL REFERENCES unit_types,
 frame INTEGER NOT NULL CHECK(frame>=0), count INTEGER NOT NULL CHECK(count>=0),
 PRIMARY KEY(observation_id,unit_type_id,frame)
) STRICT, WITHOUT ROWID;

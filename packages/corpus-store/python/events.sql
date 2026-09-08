CREATE TABLE analysis_artifacts (
 analysis_id INTEGER NOT NULL REFERENCES analysis_runs,
 artifact_key TEXT NOT NULL, sha256 TEXT NOT NULL CHECK(length(sha256)=64),
 byte_size INTEGER NOT NULL CHECK(byte_size>=0),
 PRIMARY KEY(analysis_id,artifact_key)
) STRICT, WITHOUT ROWID;
CREATE TABLE build_events (
 observation_id INTEGER NOT NULL REFERENCES analysis_participations,
 occurrence INTEGER NOT NULL CHECK(occurrence>=0),
 unit_type_id INTEGER NOT NULL REFERENCES unit_types,
 frame INTEGER CHECK(frame>=0),
 time_seconds INTEGER NOT NULL CHECK(time_seconds>=0),
 frame_min INTEGER NOT NULL CHECK(frame_min>=0),
 frame_max INTEGER NOT NULL CHECK(frame_max>=frame_min),
 timing_basis TEXT NOT NULL CHECK(timing_basis='legacy_second_floor'),
 raw_line TEXT NOT NULL,
 PRIMARY KEY(observation_id,occurrence)
) STRICT, WITHOUT ROWID;
CREATE TABLE supply_changes (
 observation_id INTEGER NOT NULL REFERENCES analysis_participations,
 frame INTEGER NOT NULL CHECK(frame>=0),
 current INTEGER NOT NULL CHECK(current>=0), max INTEGER NOT NULL CHECK(max>=0),
 PRIMARY KEY(observation_id,frame)
) STRICT, WITHOUT ROWID;
CREATE TABLE death_events (
 observation_id INTEGER NOT NULL REFERENCES analysis_participations,
 occurrence INTEGER NOT NULL CHECK(occurrence>=0),
 frame INTEGER NOT NULL CHECK(frame>=0),
 unit_type_id INTEGER NOT NULL REFERENCES unit_types,
 source_unit_id INTEGER NOT NULL, source_unit_type_id INTEGER NOT NULL,
 dead_owner INTEGER NOT NULL CHECK(dead_owner>=0), category TEXT NOT NULL,
 pos_x INTEGER NOT NULL, pos_y INTEGER NOT NULL,
 PRIMARY KEY(observation_id,occurrence)
) STRICT, WITHOUT ROWID;
CREATE INDEX deaths_by_frame ON death_events(observation_id,frame);
CREATE TRIGGER immutable_analysis_specs_update BEFORE UPDATE ON analysis_specs
 BEGIN SELECT RAISE(ABORT,'Analysis specifications are immutable'); END;
CREATE TRIGGER immutable_analysis_specs_delete BEFORE DELETE ON analysis_specs
 BEGIN SELECT RAISE(ABORT,'Analysis specifications are immutable'); END;
CREATE TRIGGER current_requires_indexed_insert BEFORE INSERT ON current_analyses
 WHEN (SELECT status FROM analysis_runs WHERE analysis_id=NEW.analysis_id) != 'indexed'
 BEGIN SELECT RAISE(ABORT,'Current analysis must be indexed'); END;
CREATE TRIGGER current_requires_indexed_update BEFORE UPDATE ON current_analyses
 WHEN (SELECT status FROM analysis_runs WHERE analysis_id=NEW.analysis_id) != 'indexed'
 BEGIN SELECT RAISE(ABORT,'Current analysis must be indexed'); END;

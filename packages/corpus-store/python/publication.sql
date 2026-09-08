-- Additive publication locations for v2 only, installed inside the ingestion transaction.
CREATE TABLE IF NOT EXISTS analysis_publications (
 analysis_id INTEGER PRIMARY KEY REFERENCES analysis_runs,
 replay_manifest_path TEXT NOT NULL,
 raw_replay_path TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS analysis_artifact_locations (
 analysis_id INTEGER NOT NULL,
 artifact_key TEXT NOT NULL,
 artifact_path TEXT NOT NULL,
 archive_member TEXT,
 PRIMARY KEY(analysis_id,artifact_key),
 FOREIGN KEY(analysis_id,artifact_key) REFERENCES analysis_artifacts(analysis_id,artifact_key)
) STRICT, WITHOUT ROWID;

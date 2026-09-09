CREATE TABLE replay_sources (
 source_id INTEGER PRIMARY KEY,
 replay_id INTEGER NOT NULL REFERENCES replays,
 source_kind TEXT NOT NULL CHECK(length(source_kind)>0),
 source_ref TEXT NOT NULL CHECK(length(source_ref)>0),
 first_seen_at_ms INTEGER NOT NULL,
 last_seen_at_ms INTEGER NOT NULL CHECK(last_seen_at_ms>=first_seen_at_ms),
 UNIQUE(replay_id,source_kind,source_ref)
) STRICT;
CREATE INDEX replay_sources_by_replay ON replay_sources(replay_id,first_seen_at_ms);

CREATE TABLE analysis_jobs (
 job_id INTEGER PRIMARY KEY,
 job_key TEXT NOT NULL UNIQUE,
 replay_id INTEGER NOT NULL REFERENCES replays,
 status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed')),
 priority INTEGER NOT NULL DEFAULT 0,
 created_at_ms INTEGER NOT NULL,
 available_at_ms INTEGER NOT NULL,
 started_at_ms INTEGER,
 finished_at_ms INTEGER,
 attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
 max_attempts INTEGER NOT NULL CHECK(max_attempts>0),
 worker_id TEXT,
 lease_expires_at_ms INTEGER,
 last_heartbeat_at_ms INTEGER,
 result_analysis_id INTEGER REFERENCES analysis_runs,
 last_error_json TEXT CHECK(last_error_json IS NULL OR json_valid(last_error_json)),
 CHECK((status='running')=(worker_id IS NOT NULL AND lease_expires_at_ms IS NOT NULL AND last_heartbeat_at_ms IS NOT NULL)),
 CHECK(status!='succeeded' OR (finished_at_ms IS NOT NULL AND result_analysis_id IS NOT NULL)),
 CHECK(status!='failed' OR finished_at_ms IS NOT NULL)
) STRICT;
CREATE UNIQUE INDEX one_active_analysis_job_per_replay
 ON analysis_jobs(replay_id) WHERE status IN ('queued','running');
CREATE INDEX analysis_jobs_claim
 ON analysis_jobs(status,priority DESC,available_at_ms,job_id);
CREATE INDEX analysis_jobs_by_replay ON analysis_jobs(replay_id,created_at_ms DESC);

CREATE TABLE analysis_job_attempts (
 attempt_id INTEGER PRIMARY KEY,
 job_id INTEGER NOT NULL REFERENCES analysis_jobs,
 attempt_number INTEGER NOT NULL CHECK(attempt_number>0),
 worker_id TEXT NOT NULL,
 claimed_at_ms INTEGER NOT NULL,
 recovered_expired_lease INTEGER NOT NULL CHECK(recovered_expired_lease IN (0,1)),
 completed_at_ms INTEGER,
 outcome TEXT NOT NULL CHECK(outcome IN ('running','succeeded','failed','abandoned')),
 error_json TEXT CHECK(error_json IS NULL OR json_valid(error_json)),
 UNIQUE(job_id,attempt_number)
) STRICT;
CREATE INDEX analysis_job_attempts_by_job ON analysis_job_attempts(job_id,attempt_number);

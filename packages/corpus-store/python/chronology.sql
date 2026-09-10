ALTER TABLE replays ADD COLUMN played_at_unix_s INTEGER
 CHECK(played_at_unix_s IS NULL OR played_at_unix_s BETWEEN 1 AND 4294967295);
CREATE INDEX IF NOT EXISTS replays_by_played_at ON replays(played_at_unix_s);

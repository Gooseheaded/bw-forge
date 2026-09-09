CREATE TABLE canonical_players (
 player_id INTEGER PRIMARY KEY, player_key TEXT NOT NULL UNIQUE,
 display_name TEXT NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE player_aliases (
 name_namespace TEXT NOT NULL, observed_name_key TEXT NOT NULL,
 alias_name TEXT NOT NULL, player_id INTEGER NOT NULL REFERENCES canonical_players,
 PRIMARY KEY(name_namespace,observed_name_key)
) STRICT, WITHOUT ROWID;
CREATE INDEX aliases_by_player ON player_aliases(player_id);
CREATE INDEX IF NOT EXISTS participation_names ON participations(observed_name_key,name_namespace);
CREATE TABLE participation_identity_overrides (
 participation_id INTEGER PRIMARY KEY REFERENCES participations,
 player_id INTEGER NOT NULL REFERENCES canonical_players
) STRICT;
CREATE INDEX overrides_by_player ON participation_identity_overrides(player_id);
CREATE TABLE player_groups (
 group_id INTEGER PRIMARY KEY, group_key TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL
) STRICT;
CREATE TABLE player_group_members (
 group_id INTEGER NOT NULL REFERENCES player_groups,
 player_id INTEGER NOT NULL REFERENCES canonical_players,
 PRIMARY KEY(group_id,player_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX groups_by_player ON player_group_members(player_id,group_id);
CREATE TABLE query_scopes (
 scope_id INTEGER PRIMARY KEY, scope_key TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
 filters_json TEXT NOT NULL CHECK(json_valid(filters_json))
) STRICT;
CREATE TABLE scope_players (
 scope_id INTEGER NOT NULL REFERENCES query_scopes, role TEXT NOT NULL CHECK(role IN ('self','opponent')),
 player_id INTEGER NOT NULL REFERENCES canonical_players, PRIMARY KEY(scope_id,role,player_id)
) STRICT, WITHOUT ROWID;
CREATE TABLE scope_groups (
 scope_id INTEGER NOT NULL REFERENCES query_scopes, role TEXT NOT NULL CHECK(role IN ('self','opponent')),
 group_id INTEGER NOT NULL REFERENCES player_groups, PRIMARY KEY(scope_id,role,group_id)
) STRICT, WITHOUT ROWID;
CREATE TABLE scope_replays (
 scope_id INTEGER NOT NULL REFERENCES query_scopes, replay_sha256 TEXT NOT NULL
 CHECK(length(replay_sha256)=64 AND replay_sha256 NOT GLOB '*[^0-9a-f]*'),
 PRIMARY KEY(scope_id,replay_sha256)
) STRICT, WITHOUT ROWID;

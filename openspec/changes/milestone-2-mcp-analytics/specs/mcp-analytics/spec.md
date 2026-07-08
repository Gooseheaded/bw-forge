## ADDED Requirements

### Requirement: Replay Analytics Discovery Tools

`bw-forge mcp` MUST expose read-only discovery tools that let clients inspect the loaded replay corpus without understanding the SQLite schema.

#### Scenario: List corpus contents

- **WHEN** a client calls `get_corpus_summary`
- **THEN** the server returns replay, player, matchup, race, map, and data-availability summary fields
- **AND** the response includes the applied filters

#### Scenario: List players and queryable item names

- **WHEN** a client calls `list_players`, `list_matchups`, `list_build_items`, `search_build_items`, or `list_unit_types`
- **THEN** the server returns compact, structured discovery results
- **AND** the response does not require arbitrary SQL or direct table inspection

### Requirement: Replay Analytics Aggregate Tools

`bw-forge mcp` MUST expose read-only aggregate analytics tools for build timings, compositions, economy, deaths, and replay/player digest cards.

#### Scenario: Timing and event-order analytics

- **WHEN** a client calls `get_event_timing_distribution` or `count_replays_with_event_before_event`
- **THEN** the server returns sample sizes, applied filters, and compact evidence rows

#### Scenario: Snapshot and replay-card analytics

- **WHEN** a client calls `get_composition_snapshot`, `get_economy_distribution`, `get_death_summary`, or `get_player_replay_card`
- **THEN** the server returns structured replay analytics summaries using Brood War domain concepts
- **AND** the existing stdio and HTTP MCP transports continue to expose those tools

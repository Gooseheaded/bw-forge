## MODIFIED Requirements

### Requirement: Replay Analytics Discovery Tools

Discovery tools exposed by `bw-forge mcp` MUST provide compact human-readable summaries in `content.text` in addition to their structured payloads.

#### Scenario: Weak client lists players and build items

- **WHEN** a client calls `list_players`, `list_build_items`, `search_build_items`, `list_matchups`, or `list_unit_types`
- **THEN** `structuredContent` remains available
- **AND** `content.text` includes actual names or values, not only a count
- **AND** long result sets are capped with a truncation notice

### Requirement: Replay Analytics Aggregate Tools

Aggregate analytics tools exposed by `bw-forge mcp` MUST provide enough information in `content.text` for a weak client to answer common replay-analysis questions without parsing raw JSON.

#### Scenario: Weak client reads timing and snapshot summaries

- **WHEN** a client calls `get_event_timing_distribution`, `count_replays_with_event_before_event`, `get_composition_snapshot`, `get_economy_distribution`, `get_death_summary`, or `get_player_replay_card`
- **THEN** `content.text` includes key values such as sample size, timings, medians, percentages, and example rows
- **AND** `structuredContent` remains the canonical machine-readable payload

### Requirement: Primitive Replay Query Tools

Older primitive replay query tools exposed by `bw-forge mcp` MUST avoid count-only text summaries when they already have useful replay, event, or sample details available.

#### Scenario: Weak client reads low-level query results

- **WHEN** a client calls `find_replays`, `find_first_event`, `list_build_events`, `find_nth_event`, `get_unit_count`, `get_economy`, or `get_deaths`
- **THEN** `content.text` includes concrete replay names, event names, timings, counts, or unit names
- **AND** the tool remains read-only

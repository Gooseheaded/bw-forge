1. Add shared analytics helpers under `packages/corpus-query/src/analytics` for filters, limits, time formatting, numeric summaries, and reusable replay-scope SQL helpers.
2. Add corpus discovery MCP tools:
   - `get_corpus_summary`
   - `list_players`
   - `list_matchups`
   - `list_build_items`
   - `search_build_items`
   - `list_unit_types`
3. Add build timing MCP analytics:
   - `get_event_timing_distribution`
   - `count_replays_with_event_before_event`
4. Add composition, economy, and death summary MCP analytics:
   - `get_composition_snapshot`
   - `get_economy_distribution`
   - `get_death_summary`
5. Add `get_player_replay_card` with default race-specific anchor lists and compact replay/player evidence.
6. Update `server_info` and MCP tool registration so the new tools are advertised consistently in both stdio and HTTP modes.
7. Add helper unit tests and fixture-backed MCP integration tests covering discovery, timing, composition, economy, death summary, and replay card behavior.
8. Re-run `tsc` and MCP/runtime smokes to confirm existing tools and both transports still work.

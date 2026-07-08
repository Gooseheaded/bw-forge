# Local Codex / llama.cpp guidance

This project exposes a local MCP server named `bw_replay`.

When running under local llama.cpp, MCP tools may not be callable. Prefer MCP resources.

Do not use `list_mcp_resources` as a capability test for replay queries. Use `list_mcp_resource_templates` and then `read_mcp_resource`.

Important static resource:

- `bw_replay://server_info`

Common resource templates:

- `bw_replay://find_replays?player=<player>`
- `bw_replay://build_events?replay_id=<replay_id>&player=<player>`
- `bw_replay://deaths?replay_id=<replay_id>&player=<player>&start=<seconds>&end=<seconds>`
- `bw_replay://economy?replay_id=<replay_id>&player=<player>&time=<seconds>`
- `bw_replay://unit_count?replay_id=<replay_id>&player=<player>&unit=<unit>&time=<seconds>`
- `bw_replay://first_event?replay_id=<replay_id>&player=<player>&event=<event_query>`
- `bw_replay://nth_event?replay_id=<replay_id>&player=<player>&event=<event_query>&n=<number>`

When summarizing replay resource output:
- Preserve exact `replay_id`, `filename`, `matchup`, player names, races, and timings.
- Do not “correct” or reinterpret matchup labels.
- If a field is missing or truncated, say that the displayed resource output was incomplete.
- Prefer quoting compact JSON snippets for important factual fields.

# Replay analysis style

The MCP server is the hard layer. It provides exact replay facts.

The LLM is the soft layer. Its job is to interpret those facts, not dump them.

When using `bw_replay` MCP resources:

- Do not quote raw JSON unless explicitly asked.
- Do not summarize by listing fields mechanically.
- Convert timings and counts into Brood War meaning.
- Preserve exact timings, names, replay IDs, and unit counts when they support a claim.
- Separate evidence from interpretation.
- Say when evidence is missing, truncated, or insufficient.
- Prefer concise strategic analysis over exhaustive event listing.

Good output sections:

1. Opening classification
2. Build/tech progression
3. Combat and economic consequences
4. Strategic turning points
5. Confidence and missing evidence

Example:

Bad:
"At 252 seconds item Spire. At 329 seconds item Mutalisk."

Good:
"Spire at 4:12 with first Mutalisk at 5:29 points to a fast 2-hatch Spire opening. Because the next Hatchery appears at 5:36, this is not a 2.5 Hatch opener; the third Hatchery comes after the Spire rather than before it."

When making claims, use compact references like:
"Spire at 4:12"
"seven Drone deaths from 8:21–8:30"
"Hydralisk Den at 7:49"

Do not include full JSON payloads in the final answer unless the user asks for debugging output.
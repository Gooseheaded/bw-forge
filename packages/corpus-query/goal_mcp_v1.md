Implement MCP v1 for the replay-corpus-query TypeScript project without stopping until the generic deterministic query tools are exposed, documented, and verified by local build/tests plus a real-data smoke test.

Context:
This project is `C:\Users\gctri\Documents\_\replay-corpus-query`.

It already has:
- TypeScript CLI
- SQLite ingest from replay-analysis manifest/player ZIP artifacts
- deterministic query helpers
- real-data smoke-tested corpus DB
- generic query commands for:
  - replays
  - first-event
  - unit-count
  - economy
  - deaths
- a temporary CLI-only composed query for muta/vessel candidates

Important architecture:
The MCP server must be a thin deterministic facade over the existing query layer.
Do not add LLM logic.
Do not add strategic interpretation.
Do not add derived predicates.
Do not expose the temporary muta/vessel demo query as MCP v1 unless explicitly asked later.
Do not create unit-specific MCP tools or arguments like `muta_before`.

MCP v1 tool surface:
Expose only generic tools:

1. `find_replays`
Inputs:
- `db_path`: string
- `matchup?`: string
- `player?`: string
- `race?`: string

Returns replay rows with players, replay_id, matchup, source_replay_filename, source_replay_path if available.

2. `find_first_event`
Inputs:
- `db_path`: string
- `player`: string
- `item`: string
- `matchup?`: string
- `race?`: string
- `as?`: `"self"` or `"enemy"`; default `"self"`

Returns first matching build-order event rows.

3. `get_unit_count`
Inputs:
- `db_path`: string
- `player`: string
- `unit`: string
- `at_seconds`: number
- `matchup?`: string
- `race?`: string
- `as?`: `"self"` or `"enemy"`; default `"self"`

Returns latest unit-count sample at or before timestamp. Preserve current semantics: `sample: null` means no evidence at/before that time; a real zero count should be a non-null sample with `count: 0`.

4. `get_economy`
Inputs:
- `db_path`: string
- `player`: string
- `at_seconds`: number
- `matchup?`: string
- `race?`: string
- `as?`: `"self"` or `"enemy"`; default `"self"`

Returns latest economy sample at or before timestamp.

5. `get_deaths`
Inputs:
- `db_path`: string
- `player`: string
- `from_seconds`: number
- `to_seconds`: number
- `matchup?`: string
- `race?`: string
- `as?`: `"self"` or `"enemy"`; default `"self"`

Returns death events in the requested window.

Output requirements:
Every result should preserve evidence fields wherever applicable:
- replay_id
- source_replay_filename
- source_replay_path
- matchup
- player_name
- target_name
- self_owner
- target_owner
- event/sample/deaths payload

Implementation constraints:
- Reuse the existing query helpers in `src/query/query.ts`.
- Do not parse report text.
- Do not scan replay folders from MCP.
- Do not call replay-analysis.
- MCP reads existing SQLite DBs only.
- Keep the CLI and existing tests working.
- Keep the composed muta/vessel query CLI-only.
- Keep item matching case-insensitive exact as currently implemented.
- Keep player matching case-insensitive exact.

Suggested implementation:
- Add MCP server entrypoint under something like `src/mcp/server.ts`.
- Use the official/model-context-protocol TypeScript SDK if already standard for this codebase; otherwise choose the smallest reasonable MCP dependency.
- Add package scripts for running the MCP server, e.g. `pnpm mcp`.
- Add README documentation showing how to configure/run the MCP server locally.
- Add either automated tests for tool handlers or a documented manual smoke test if MCP stdio testing is awkward.

Verification required before declaring success:
1. Run `pnpm check`.
2. Run `pnpm build`.
3. Run `pnpm test`.
4. Run at least one MCP/manual smoke test that calls, or closely exercises, each MCP tool against an existing `corpus.sqlite`.
5. Show example output for at least:
   - `find_replays` with `matchup: "ZvT"` and `player: "pbjt"`
   - `find_first_event` for self `Mutalisk`
   - `find_first_event` for enemy `Science Vessel`
   - `get_unit_count` for self `Mutalisk` at 420 seconds
   - `get_economy` at 300 seconds
   - `get_deaths` from 300 to 480 seconds

Stopping condition:
Stop only when MCP v1 is implemented, documented, and verified by the commands above.

Blocked condition:
If MCP SDK integration or local MCP invocation is blocked, stop and report:
- what was implemented
- which command failed
- exact error output
- what evidence still verifies the query handlers
- the smallest next action needed to unblock MCP runtime verification
# Replay metadata and termination contract

## Executive summary

The current ShieldBattery unit-timeline format is not a replay-metadata format. It emits a frame number plus per-owner unit/state snapshots and deaths. Of the metadata exposed by BW Forge, ShieldBattery directly supplies only numeric unit owners and player names. Python infers player race and matchup from observed unit types, takes the last telemetry frame as the end of analysis, and derives duration from that frame. The CLI hashes and preserves the original replay separately.

BW Forge currently has no winner, loser, result, victory/defeat, team/force, map-dimension, replay-seed, or explicit start/end-frame contract. Map is present in manifests and SQLite only as `null` and is displayed as `unknown`. Result is not inferred from replay termination.

## Field contract

| Field | Origin and derivation | Downstream storage and use |
|---|---|---|
| Replay ID / SHA-256 | The Python manifest hashes `replay_path` when an original replay was supplied, otherwise it hashes the timeline input (`replay_analysis.py:1128-1160`). The wrapper CLI independently hashes the original `.rep` bytes (`apps/cli/src/main.ts`). In the normal replay workflow these are the same SHA-256. A bare JSONL invocation without `--embedded-replay-input` instead identifies the JSONL, not its source replay. | Directory key; top-level replay manifest; legacy `manifest.json`; corpus manifest; SQLite `replays.replay_id`; replay lookup, replay cards, filters, query plans, and MCP tool results. A replacement producer does not need to calculate it if the existing CLI retains the original replay bytes/path. |
| Replay filename/path | Comes from CLI/Python input arguments, not telemetry. The top-level CLI manifest keeps the original filename and path and the copied `raw/<filename>` path. Python records the resolved replay path when supplied, otherwise the resolved timeline path. Standalone HTML can embed the original replay under its filename. | Top-level and legacy manifests, corpus manifest, SQLite `source_replay_filename` and `source_replay_path`, replay discovery/cards, desktop library, and MCP results. Paths are provenance, not simulation state, and can be machine-specific. |
| Numeric owner/player ID | ShieldBattery keys each owner record with `unit.player()` and serializes it as a decimal string. It is an observed-unit owner, not a separately exported replay slot roster (`third_party/shieldbattery/game/src/unit_timeline.rs`). | Python converts it to an integer and uses it as the player/bundle identity. Stored in each ZIP's `player.json`, both manifests, SQLite `players.owner`, query identity resolution, and per-player report selection. Owner values must remain stable and consistent with unit/death ownership. |
| Player name | ShieldBattery looks up the owner in the StarCraft player table and calls `bw::player_name`; fallback is `Player {owner + 1}`. Python keeps the first non-empty name observed for an owner. | `player.json`, manifests, SQLite `players.name`, report/UI labels, player discovery/filtering, replay matching by player, query-plan identity resolution, and MCP output. A player with no captured owner state is not independently added from a slot roster. |
| Player race | Not serialized as player metadata. Python counts the races of observed unit DAT IDs for each owner and chooses the most frequent; explicit owner selection uses the first recognized race (`replay_analysis.py:956-1090`). | `player.json`, manifests, SQLite `players.race`, report labels, race/enemy-race filters, matchup, replay cards, aggregate grouping, query-plan identity, and MCP tools. Exact current parity therefore requires sufficient unit telemetry for the same inference, or an adapter that supplies the same inferred value. |
| Matchup | Python sorts selected owner IDs, takes each inferred race's initial, and joins them with `v` (`replay_analysis.py:1120-1125`). It is not read from replay teams or forces. | Manifests, SQLite `replays.matchup`, replay cards/library, matchup filters and discovery, query plans, aggregate grouping, and MCP tools. This is owner-order/race shorthand, not a team-aware matchup model. |
| Teams / forces | Replay/game structures contain related information, but the unit timeline and Python output do not export or consume it. | No manifest field, SQLite column, report display, query filter, or MCP result. Current opponent resolution generally assumes one other selected player; it does not derive allies/enemies from teams. |
| Map name | The ShieldBattery replay header has a map name, but the timeline does not serialize it. Python unconditionally writes `"map": null`. | Legacy/top-level manifests and nullable SQLite `replays.map`; map discovery/filtering and replay cards can consume the column. With current output the UI/MCP surface shows or groups it as `unknown`; no actual map name is available. |
| Map dimensions | Available inside ShieldBattery's replay/game data, but not emitted or copied into BW Forge metadata. | Nowhere. No current report, SQLite column, query, aggregate, or MCP tool depends on it. Unit positions remain raw tile/pixel coordinates without an exported map-size field. |
| Replay start frame | No metadata field. Normal export sets timeline time units to frames and stride 1, with the emitter's default inclusive start bound of 0. Capture occurs after game logic advances, so the first observed frame can be 1. Python treats the first received snapshot as its baseline. | Not stored or exposed. |
| Replay end / final analysis frame | ShieldBattery determines an effective terminal frame as described below. Python independently records only the frame of the last snapshot it consumes; it does not retain that as a manifest field. | The numeric frame remains in per-player datasets/events. There is no explicit end-frame column or manifest property. It indirectly controls duration and the available time range of all analyses/visualizations. |
| Duration | Python computes `last_snapshot_frame * 0.042` seconds (`FRAME_DURATION_MS = 42`); it does not subtract the first frame and does not read replay-header duration (`replay_analysis.py:1144-1160`). Manifest-refresh fallback similarly scans datasets for their maximum frame. | Manifests, corpus manifest, SQLite `replays.duration_seconds`, replay cards/library and MCP replay results. Standalone chart extent is computed from dataset samples rather than reading manifest duration. |
| Winner / loser / result | Not obtained. ShieldBattery has broader game-result/victory-state machinery, but none is serialized into this unit timeline or passed to Python. Python does not infer a winner from survivors, deaths, leaving, connectivity, or the final frame. | No fields or columns; not shown, filterable, queryable, or exposed by MCP. Current BW Forge cannot reliably answer winner, loser, or result. |
| Victory/defeat and disconnect/leave state | Not serialized. Connectivity is used internally only to choose the replay-export cutoff. A disconnect and a leave are not separately represented in BW Forge output. | Nowhere except their possible indirect effect on the last frame, duration, and which late telemetry exists. |
| Replay seed | ShieldBattery can access an RNG seed, but the timeline and BW Forge pipeline do not export or use it. | Nowhere. |

The schemas confirming the stored subset are in `packages/schemas/src/index.ts`; SQLite storage is defined in `packages/corpus-query/src/db/schema.ts` and populated by `packages/corpus-query/src/ingest/manifest.ts`.

## Exact termination behavior

The current exporter uses this effective terminal frame:

```text
header_or_cap = replay_header.end_frame, if nonzero, otherwise 43,200
header_or_cap = min(header_or_cap, 43,200)
effective_end = min(header_or_cap, all_humans_disconnected_cutoff if one was set)
```

`43,200` is the hard safety cap (`30 * 60 * 24` frames). The disconnect cutoff is set only when all of the following hold:

1. replay export is active and the game is a replay;
2. among the first eight BW player entries there is at least one human slot;
3. at least one such human was previously observed connected; and
4. no human slot is currently connected according to its Storm ID/connection flag.

If human slots never appear connected, or there are no human slots, the exporter continues to the replay-header end/cap. One human leaving does not terminate export while another human remains connected. The code does not export whether the loss of connectivity was a leave, disconnect, or another cause.

After each game-logic step, ShieldBattery updates this cutoff and then emits the current frame when `frame <= cutoff`. Consequently the cutoff/end frame itself is included. Later snapshots are suppressed. Progress reports use the same effective end; when current frame reaches it, the app schedules replay cleanup/quit. Under a successful normal run, the final analysis frame is therefore the last emitted frame at the minimum above. Export range settings are also inclusive, but BW Forge sets no custom end and uses stride 1.

Python has no second replay-ending algorithm. It reads until producer EOF, overwrites `last_frame` on every snapshot, and calculates duration from that final observed frame. It does not compare EOF with the replay header, classify why export ended, or detect a semantically premature but otherwise successful trace. Thus an early all-human disconnect can truncate telemetry before the nominal header end, and downstream data simply ends there.

No result is inferred from this termination. The cutoff means only "stop exporting"; it does not identify a winner or loser.

## Downstream dependency summary

- User-visible and MCP behavior directly depends on replay SHA, source filename/path, player owner/name/race, matchup, and duration.
- Map plumbing exists in manifests, SQLite, filters, cards, and MCP, but the current producer path always supplies `null`, surfaced as `unknown`.
- Final-frame choice indirectly affects every time-series/event dataset by deciding what late state is present, and directly affects stored/displayed duration.
- Standalone HTML uses embedded player owner/name/race and reconstructs matchup; its chart range comes from dataset frames. It does not expose winner/result, teams, dimensions, seed, or explicit start/end frames.
- Replay matching and query plans use replay ID, player name/owner, race, and matchup. They do not use termination reason or result.

## Replacement-backend answers

1. **Fields the bwsim replacement must provide:** frame number on every snapshot; stable numeric owner IDs on player/unit/death state; and player names, unless an adapter obtains the same names from replay parsing. It must expose enough owner/unit information to preserve Python's current race and matchup inference. It must also terminate deterministically at the compatibility final frame so EOF and the last emitted frame match current behavior.
2. **Fields generated outside ShieldBattery:** replay SHA-256, source filename/path and copied replay provenance come from the original replay and CLI; player race and matchup are Python inference; duration is Python's conversion of the final snapshot frame. These need no simulator-native metadata field if the adapter preserves the same inputs. Map is currently forced to null.
3. **End behavior to preserve:** for exact legacy parity, include the terminal frame and stop at `min(nonzero replay-header end or 43,200 fallback, 43,200 cap, first all-human-disconnected frame after a connected human has been seen)`. The adapter does not need to expose disconnect state downstream, only reproduce the terminal-frame/EOF effect. Merely running to the nominal replay end could change duration and late datasets for affected replays.
4. **Duration:** `42 ms * last telemetry frame`, with no subtraction of start frame. It is not replay-header duration.
5. **Winner/result:** neither is currently determined. Termination/connectivity is not a result signal in BW Forge.
6. **Currently missing or intentionally null:** actual map name (`null`), map dimensions, teams/forces, explicit replay start/end frame, winner, loser, result, victory/defeat state, disconnect/leave reason, and replay seed. These are absent rather than partially reliable, except that termination can indirectly shorten the data.
7. **Replacement blocker assessment:** no metadata/result field appears to block replacement. The only simulator-sensitive compatibility obligation in this area is matching the last emitted frame/EOF behavior (plus owner IDs/names if they are not supplied by a replay parser). Result support would be a new feature, not a ShieldBattery-parity requirement. Exact map/team/seed support is likewise outside the current contract.

# AGENTS.md

## Project role

This project exposes a local MCP server named `bw_replay` for querying StarCraft: Brood War replay corpora.

The MCP server is the hard layer: it provides exact replay facts, deterministic query results, schemas, timings, counts, filenames, player names, races, and replay IDs.

The LLM is the soft layer: it interprets those facts into Brood War meaning. Its job is to classify openings, explain strategic consequences, identify timing windows, compare evidence, and state uncertainty. It should not dump raw JSON unless explicitly asked.

## Local Codex / llama.cpp guidance

When running Codex against a local llama.cpp model, MCP tools may not be callable by the model. Prefer MCP resources.

Do not use `list_mcp_resources` as a capability test for replay queries. Use `list_mcp_resource_templates` to discover query shapes, then use `read_mcp_resource(server, uri)`.

Use server name:

```text
bw_replay
```

Important static resource:

```text
bw_replay://server_info
```

Common resource templates:

```text
bw_replay://find_replays?player=<player>
bw_replay://build_events?replay_id=<replay_id>&player=<player>
bw_replay://deaths?replay_id=<replay_id>&player=<player>&start=<seconds>&end=<seconds>
bw_replay://economy?replay_id=<replay_id>&player=<player>&time=<seconds>
bw_replay://unit_count?replay_id=<replay_id>&player=<player>&unit=<unit>&time=<seconds>
bw_replay://first_event?replay_id=<replay_id>&player=<player>&event=<event_query>
bw_replay://nth_event?replay_id=<replay_id>&player=<player>&event=<event_query>&n=<number>
```

If a database path is needed, prefer setting `BW_REPLAY_DB_PATH` before launching Codex. Only include `db_path` in a URI when necessary, and URL-encode Windows paths.

## Resource-query behavior

Use narrow queries. Avoid asking for huge payloads and then summarizing truncated output.

When a resource response is too large, truncated, or incomplete:

1. Say that the displayed output was incomplete.
2. Ask a narrower resource query.
3. Prefer time windows, item filters, player filters, or specific replay IDs.
4. Do not infer from missing middle sections.

Good examples:

```text
bw_replay://build_events?replay_id=<id>&player=abfprl&start=240&end=600
bw_replay://deaths?replay_id=<id>&player=abfprl&start=300&end=540
bw_replay://unit_count?replay_id=<id>&player=abfprl&unit=Mutalisk&time=420
```

When using resource output:

- Preserve exact `replay_id`, `filename` / `source_replay_filename`, `matchup`, player names, races, unit names, counts, and timings.
- Do not “correct” or reinterpret exact labels from the data.
- If a field is missing, null, contradictory, or truncated, say so.
- Do not quote full JSON payloads unless the user asks for debugging output.
- Compact factual snippets are acceptable when they support an important claim.

## Replay analysis style

Default to interpretation-first analysis, not data dumping.

Preferred output sections:

1. Opening classification
2. Build / tech progression
3. Combat and economic consequences
4. Strategic turning points
5. Confidence and missing evidence

For every meaningful claim:

- Ground it in timings, counts, or exact facts from MCP resources.
- Explain what the evidence means strategically.
- Separate hard facts from interpretation.
- Avoid overclaiming beyond the data.

Bad:

```text
At 252 seconds item Spire. At 329 seconds item Mutalisk.
```

Good:

```text
Spire at 4:12 with first Mutalisk at 5:29 points to a fast 2-hatch Spire opening. Because the next Hatchery appears at 5:36, this is not a 2.5 Hatch opener; the third Hatchery comes after the Spire rather than before it.
```

Use compact evidence references like:

```text
Spire at 4:12
first Mutalisk at 5:29
three Overlords lost from 5:26–5:47
seven Drone deaths from 8:21–8:30
Hydralisk Den at 7:49
Lurkers at 9:34 and 9:38
```

Then interpret them:

```text
The Overlord losses likely caused supply disruption during the first Mutalisk production window.
```

```text
The Drone-loss cluster damages the economy just as the Hydra/Lurker transition needs worker support.
```

## Evidence vs interpretation

Use this mental split:

Hard-layer evidence:

```text
Spire 4:12, first Mutalisk 5:29, third Hatchery 5:36, three Overlords lost 5:26–5:47, seven Drones lost 8:21–8:30.
```

Soft-layer interpretation:

```text
This is a fast 2-hatch Spire line that suffered Wraith-driven supply disruption and later worker damage, but still reached Hydra/Lurker tech by 9:34.
```

Do not let the hard layer overreach into subjective conclusions. Do not let the soft layer become a JSON printer.

## Brood War interpretation heuristics

These are heuristics, not absolute rules. Use them carefully and cite the evidence.

### Zerg vs Terran

- Early Pool + early Gas + Lair around ~3:00 and Spire around ~4:00 usually indicates fast 2-hatch Spire.
- A third Hatchery before Spire often suggests a 2.5 Hatch / more economic variant.
- A third Hatchery after Spire usually supports a stricter 2-hatch Spire interpretation.
- Early Scourge/Mutalisk production suggests air control, harassment, or anti-Wraith/anti-Dropship preparation.
- Hydralisk Den followed by Hydralisks/Lurkers indicates a transition away from pure Mutalisk play into Hydra/Lurker midgame.
- Overlord losses near first Mutalisk timing can be strategically severe because they may supply-block Zerg.
- Drone-loss clusters are more important than isolated worker deaths, especially during tech transitions.
- Terran Wraith deaths should be interpreted in context: losing many Wraiths can mean the air harassment was cleaned up, but the opening may still have succeeded if it killed Overlords, Drones, or delayed Zerg production.

### General combat interpretation

- Count clusters, not just totals. A burst of deaths in a 10–30 second window often marks a fight, raid, or timing attack.
- Compare combat losses against the build plan. A build can be strategically successful even with uneven trades if it delays the opponent’s key timing.
- Separate tactical trades from strategic consequences.
- Avoid declaring a player “ahead” unless the evidence includes enough economy, army, tech, and death context.

## Handling uncertainty

Be explicit about confidence.

Good confidence language:

```text
High confidence: the opening is fast 2-hatch Spire because Spire starts at 4:12, first Mutalisk appears at 5:29, and the third Hatchery appears after Spire at 5:36.
```

```text
Medium confidence: the Drone losses around 8:21–8:30 look like a damaging raid, but the resource output does not show unit positions or the attacking units directly.
```

```text
Low confidence: I cannot determine whether Zerg was ahead after 9:00 without additional economy, army count, and death data after the Lurker transition.
```

Never hide uncertainty. If evidence is insufficient, ask a narrower follow-up query.

## Preferred user-facing answer shape

Unless the user asks for raw data, answer in prose.

Use short sections and concrete claims.

Example answer shape:

```text
Opening: fast 2-hatch Spire.

The evidence is Spire at 4:12, first Scourge/Mutalisk at 5:28–5:29, and the next Hatchery at 5:36. Since the third Hatchery comes after Spire, I would not classify this as 2.5 Hatch.

Transition: Mutalisk/Scourge into Hydra/Lurker.

Hydralisk Den appears at 7:49, first Hydralisk at 8:18, Carapace at 8:24, and Lurkers at 9:34/9:38. That is a clear midgame transition rather than continued pure Mutalisk play.

Combat consequence: Terran Wraith pressure did damage but got cleaned up.

Zerg lost three Overlords from 5:26–5:47, which likely disrupted supply during the first Mutalisk window. Terran then lost multiple Wraiths from 5:50–6:13 and again around 8:44–8:51, so the air pressure was expensive for Terran too.

Biggest warning sign: seven Drone deaths from 8:21–8:30.

That worker-loss cluster lands right as Zerg is transitioning into Hydra/Lurker, which likely slows the economy behind the tech switch.

Confidence: medium-high.

The build classification is high confidence. The interpretation of the fights is medium confidence because the death data shows what died and when, but not exact positions or tactical intent.
```

## Implementation-agent expectations

When modifying this project:

- Keep existing MCP tools backward-compatible.
- Keep resource compatibility additive.
- Add tests for both tool and resource paths.
- Prefer deterministic, schema-shaped outputs from the MCP server.
- Do not move subjective strategic interpretation into the MCP server unless explicitly implementing a derived-facts resource.
- Derived-facts resources may cluster and summarize facts, but should still return factual data rather than coaching conclusions.

Good derived-facts resource idea:

```text
bw_replay://analysis_snapshot?replay_id=<id>&player=<player>&start=<seconds>&end=<seconds>
```

Acceptable output:

```json
{
  "opening_facts": {
    "spawning_pool": "01:04",
    "extractor": "01:21",
    "lair": "03:06",
    "spire": "04:12",
    "first_mutalisk": "05:29",
    "third_hatchery": "05:36"
  },
  "death_clusters": [
    {
      "player": "abfprl",
      "window": "05:26-05:47",
      "losses": {"overlord": 3, "drone": 1, "scourge": 3}
    }
  ]
}
```

Avoid output like:

```json
{
  "conclusion": "Zerg played badly and lost because of poor scouting."
}
```

That kind of subjective conclusion belongs in the LLM layer, not the MCP hard layer.


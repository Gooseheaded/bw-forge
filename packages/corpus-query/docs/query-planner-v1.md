# Query Planner v1

## Summary

This document defines the v1 JSON contract for a future LLM query planner over `replay-corpus-query`.

The planner is intentionally narrow:

- It emits a declarative JSON plan.
- It does not encode execution order or control flow.
- It targets replay-centric selection and evidence gathering only.
- It executes through the existing generic MCP tools.
- It does not expose or depend on strategy-specific predicates.

MCP v1 remains generic and deterministic:

- `find_replays`
- `find_first_event`
- `list_build_events`
- `find_nth_event`
- `get_unit_count`
- `get_economy`
- `get_deaths`

Strategy-specific composition or classification belongs in later query-planning, enrichment, or classifier layers.

The temporary muta/vessel composed query remains CLI-only.

## Three-Stage Model

### 1. `replay_set`

Coarse corpus filtering.

- Maps directly to `find_replays`.
- v1 supported fields:
  - `matchup`
  - `player`
  - `race`
  - `replay_ids`
- `replay_set` may be `{}`, which means "start from all replays in the corpus."
- `replay_ids` enables follow-up exploratory querying over a previously matched replay subset.
- Empty `replay_ids` is invalid in v1.

Future planned fields, not valid v1 output:

- `opponent`
- `opponent_race`

If the user asks for opponent-specific replay filtering in v1, the planner must either:

- record it under `unsupported_or_approximate`, or
- gather post-filter evidence if possible.

### 2. `constraints`

Replay-specific boolean filters applied to each replay in the coarse set.

- `constraints` use flat `all_of` semantics.
- A replay survives only if every constraint passes.
- Constraint order is semantically irrelevant.
- The executor may evaluate constraints in any order.
- The executor may reorder constraints for efficiency.

`constraints` must contain only executable deterministic pass/fail predicates.

Examples:

- `first_event_before`
- `first_event_after`
- `unit_count_at_least_at`
- `unit_count_at_most_at`
- `economy_workers_at_least_at`
- `economy_workers_at_most_at`
- `deaths_count_at_least_between`
- `deaths_count_at_most_between`

Bare fact retrieval does not belong in `constraints`.

### 3. `evidence_requests`

Additional facts gathered for surviving replays.

- Evidence does not affect replay survival unless the same condition is also represented as a constraint.
- Evidence is used for explanation, citation, and later reasoning.
- Evidence requests may return raw facts and lightweight deterministic summaries.

Allowed v1 summaries are mechanically derived from a single MCP result and must not introduce strategic BW semantics.

## Execution Pipeline

1. Validate planner JSON strictly.
   - Reject unknown fields, invalid enum values, duplicate IDs, missing required fields, unsupported constraint types, contradictory constraints, unsupported v1 fields, and other invalid plan structure.
2. Resolve `replay_set` via `find_replays`.
   - Empty `replay_set` means all replays.
   - Store resulting replay IDs in `coarse_replay_ids`.
3. Evaluate `constraints` per replay with flat `all_of` semantics.
   - A replay is `matched: true` only if every constraint passes.
4. Gather `evidence_requests` for matched replays.
   - In normal mode, gather evidence only for matched replays.
   - Debug mode is runtime configuration, not part of planner JSON.
5. Emit the canonical executor result.
   - Include `result_schema`.
   - Echo `plan`.
   - Include `coarse_replay_ids`.
   - Include `replay_results`.
   - Copy `unsupported_or_approximate` from the plan.

## Planner Envelope

`planner_schema` is required and must be `"query-planner-v1"`.

```json
{
  "planner_schema": "query-planner-v1",
  "query": {
    "original_text": "string",
    "intent": "find_replays_matching_pattern"
  },
  "replay_set": {
    "matchup": "ZvT",
    "player": "pbjt",
    "race": "zerg"
  },
  "constraints": [],
  "evidence_requests": [],
  "assumptions": [],
  "unsupported_or_approximate": []
}
```

Rules:

- All top-level keys are required.
- `planner_schema` is required.
- The only valid v1 planner schema is `"query-planner-v1"`.
- Unknown top-level keys make the plan invalid.
- `replay_set` may be `{}`.
- `constraints`, `evidence_requests`, `assumptions`, and `unsupported_or_approximate` may be empty arrays.
- Unsupported or approximate user intent must appear only in `unsupported_or_approximate`.

## Field Reference

### `query`

```json
{
  "original_text": "string",
  "intent": "find_replays_matching_pattern | gather_evidence_for_replays"
}
```

Rules:

- `original_text` is required.
- `intent` is required.
- Allowed `intent` values:
  - `find_replays_matching_pattern`
  - `gather_evidence_for_replays`
- Unknown keys inside `query` make the plan invalid.

### `replay_set`

```json
{
  "matchup": "string?",
  "player": "string?",
  "race": "string?",
  "replay_ids": ["string"]?
}
```

Rules:

- Supported v1 fields are only `matchup`, `player`, `race`, and `replay_ids`.
- Unknown keys inside `replay_set` make the plan invalid.
- `replay_set` may be `{}`.
- `replay_ids`, when present, must be a non-empty array of replay IDs.
- `replay_ids` restricts the coarse replay set before replay-specific constraints are evaluated.
- Planned future fields such as `opponent` and `opponent_race` are not valid v1 output.

### `constraints`

Each constraint item requires:

```json
{
  "id": "snake_case_id",
  "type": "supported_constraint_type",
  "perspective": "self | enemy",
  "...": "type-specific fields"
}
```

Rules:

- `id` is required.
- `id` must be unique across both `constraints` and `evidence_requests`.
- `id` should be descriptive, stable, and snake_case.
- `perspective` is required on every constraint.
- Allowed `perspective` values:
  - `self`
  - `enemy`
- `constraints` must contain only executable boolean predicates.
- Fact-shaped constraints without explicit pass/fail comparison are invalid.
- Unsupported or approximate items must not appear inside `constraints`.

### `evidence_requests`

Each evidence request item requires:

```json
{
  "id": "snake_case_id",
  "type": "supported_evidence_type",
  "perspective": "self | enemy",
  "...": "type-specific fields"
}
```

Rules:

- `id` is required.
- `id` must be unique across both `constraints` and `evidence_requests`.
- `perspective` is required on every evidence request.
- `evidence_requests` may return raw facts and lightweight deterministic summaries.
- `include_raw` is allowed for evidence requests only, never for constraints.

### `assumptions`

```json
{
  "phrase": "string",
  "meaning": "string"
}
```

Rules:

- `assumptions` are for user-intent or interpretation assumptions only.
- Do not use `assumptions` for executor defaults or planner-spec rules.

### `unsupported_or_approximate`

```json
{
  "phrase": "string",
  "status": "unsupported | approximate",
  "reason": "string"
}
```

Rules:

- Allowed `status` values:
  - `unsupported`
  - `approximate`
- Unknown status values make the plan invalid.
- This section preserves user-requested semantics that cannot be executed exactly in v1.

## Matching Semantics

v1 matching semantics inherit the current deterministic query layer.

- `replay_set.player` uses case-insensitive exact matching.
- `replay_set.race` uses case-insensitive exact matching.
- `replay_set.matchup` uses exact matching as stored by the corpus DB.
- `first_event.item` uses case-insensitive exact matching.
- `unit_count_at.unit` uses the current unit-count query semantics: case-insensitive exact matching against normalized stored unit types.

v1 does not support:

- fuzzy matching
- substring matching
- aliases such as `muta` -> `Mutalisk`
- player-name disambiguation beyond exact normalized name
- race inference beyond explicitly represented planner fields

## Supported Item Types

### Constraints

Supported v1 constraint types:

- `first_event_before`
- `first_event_after`
- `unit_count_at_least_at`
- `unit_count_at_most_at`
- `economy_workers_at_least_at`
- `economy_workers_at_most_at`
- `deaths_count_at_least_between`
- `deaths_count_at_most_between`

### Evidence Requests

Supported v1 evidence request types:

- `first_event`
- `economy_at_event_time`
- `unit_count_at`
- `unit_count_at_event_time`
- `economy_at`
- `deaths_between`

Supported v1 event comparison constraint types:

- `event_before_event`

## Event Selectors

Some planner items refer to another build-order event instead of a fixed timestamp.

Supported v1 event selector types:

- `first_event`
- `nth_event`

Example:

```json
{
  "type": "nth_event",
  "perspective": "self",
  "item": "Hatchery",
  "n": 2
}
```

`n` is 1-based over matching build-order events in replay order.

### Evidence Summaries

Allowed v1 `summaries` values:

- `total_count`
- `count_by_unit_type`
- `count_by_category`
- `first_time_seconds`
- `last_time_seconds`

Rules:

- Unsupported summary names make the plan invalid.
- Summaries must be mechanically derived from a single MCP result.
- These summaries are primarily intended for `deaths_between`.
- Strategic summaries such as `won_fight` or `efficient_trade` are invalid in v1.

### `include_raw`

`include_raw` rules:

- For `deaths_between`, `include_raw` is required.
- If `include_raw: true`, return the raw death list plus any requested summaries.
- If `include_raw: false`, return only requested summaries.
- `summaries` may be `[]` only if `include_raw: true`.
- For `first_event`, `unit_count_at`, and `economy_at`, `include_raw` is optional and normally omitted.

## Planner-to-MCP Mapping

| Planner type | Valid section(s) | MCP tool | Executor behavior |
|---|---|---|---|
| `first_event` | `evidence_requests` | `find_first_event` | Return event or null. |
| `event_before_event` | `constraints` | `find_first_event` and/or `find_nth_event` | Pass if both referenced events exist and `left_event.time_seconds < right_event.time_seconds`. |
| `first_event_before` | `constraints` | `find_first_event` | Pass if `event != null && event.time_seconds < before_seconds`. |
| `first_event_after` | `constraints` | `find_first_event` | Pass if `event != null && event.time_seconds > after_seconds`. |
| `unit_count_at` | `evidence_requests` | `get_unit_count` | Return sample or null. |
| `unit_count_at_event_time` | `evidence_requests` | event selector plus `get_unit_count` semantics | Resolve the referenced event time per replay, then return the latest sample at or before that replay-specific timestamp, or null. |
| `unit_count_at_least_at` | `constraints` | `get_unit_count` | Pass if `sample != null && sample.count >= count_at_least`. |
| `unit_count_at_most_at` | `constraints` | `get_unit_count` | Pass if `sample != null && sample.count <= count_at_most`. |
| `economy_at` | `evidence_requests` | `get_economy` | Return sample or null. |
| `economy_at_event_time` | `evidence_requests` | event selector plus `get_economy` semantics | Resolve the referenced event time per replay, then return the latest sample at or before that replay-specific timestamp, or null. |
| `economy_workers_at_least_at` | `constraints` | `get_economy` | Pass if `sample != null && sample.workers >= workers_at_least`. |
| `economy_workers_at_most_at` | `constraints` | `get_economy` | Pass if `sample != null && sample.workers <= workers_at_most`. |
| `deaths_between` | `evidence_requests` | `get_deaths` | Return raw deaths and optional deterministic summaries. |
| `deaths_count_at_least_between` | `constraints` | `get_deaths` | Pass if `deaths.length >= count_at_least`. |
| `deaths_count_at_most_between` | `constraints` | `get_deaths` | Pass if `deaths.length <= count_at_most`. |

General rules:

- `event: null` fails event-based constraints.
- `sample: null` fails sample-based constraints.
- event-relative evidence returns `event: null` and `sample: null` when the referenced event does not exist.
- If the specific compared field inside a non-null event/sample is `null` or missing, the constraint fails.
- Empty `deaths: []` is valid evidence.
- Count-based death constraints pass or fail based on the requested threshold.

## Null and Missing Evidence Rules

Constraint evaluation rules:

- `event: null` fails event-based constraints.
- `sample: null` fails sample-based constraints.
- If a non-null event/sample exists but the compared field is `null` or missing, the constraint fails.
- Evidence requests may still return null fields unchanged.
- Null fields are evidence, not license to infer zero or absence.

Examples:

- `economy_workers_at_least_at` fails if:
  - `sample == null`
  - `sample.workers == null`
  - `sample.workers < workers_at_least`
- `economy_workers_at_most_at` fails if:
  - `sample == null`
  - `sample.workers == null`
  - `sample.workers > workers_at_most`
- `unit_count_at_least_at` treats a real `count: 0` as valid evidence and compares it normally.

## 1v1 Assumption

v1 assumes a unique enemy in a 1v1-style replay context.

- `self` refers to the player selected by `replay_set.player` and planner perspective.
- `enemy` refers to the unique opposing player when resolvable.
- Multi-enemy or non-1v1 ambiguity is outside v1 scope and should be treated as unsupported future work.

## Executor Deduplication

The planner JSON is purely declarative and may contain overlapping items.

The executor may deduplicate identical underlying MCP calls as an optimization, as long as:

- pass/fail behavior does not change
- requested evidence is still returned
- constraint semantics remain constraint semantics
- evidence semantics remain evidence semantics

Examples:

- reuse one `find_first_event` result for a timing constraint and an evidence request
- reuse one `get_deaths` result for raw deaths and deterministic summaries

## Executor Result Shape

`result_schema` is required and must be `"query-executor-result-v1"`.

```json
{
  "result_schema": "query-executor-result-v1",
  "plan": {},
  "coarse_replay_ids": [],
  "replay_results": [],
  "unsupported_or_approximate": []
}
```

Rules:

- `plan` echoes the planner JSON that was executed.
- `coarse_replay_ids` records the replay IDs selected by `replay_set`.
- In normal mode, `replay_results` should include matched replays only.
- In debug mode, `replay_results` may also include rejected replays.
- `unsupported_or_approximate` should be copied from the plan.

Each `replay_result` should have this shape:

```json
{
  "replay_id": "string",
  "source_replay_filename": "string | null",
  "source_replay_path": "string | null",
  "matchup": "string | null",
  "self_player_name": "string | null",
  "self_owner": 2,
  "enemy_player_name": "string | null",
  "enemy_owner": 3,
  "matched": true,
  "constraint_results": {},
  "evidence": {}
}
```

Rules:

- `matched` means all constraints passed.
- `constraint_results` is keyed by constraint `id`.
- `evidence` is keyed by evidence request `id`.
- Top-level self/enemy identity metadata exists so consumers do not need to inspect nested payloads for basic replay context.

Per-item result shape:

```json
{
  "passed": true,
  "value": {},
  "error": null
}
```

Rules:

- Constraints should include:
  - `passed`
  - `value`
  - `error`
- Evidence should include:
  - `value`
  - `error`
- `error` should be explicit when an MCP call fails or evidence is unusable.
- `passed: false` is different from `error != null`.

## Validation Failures

The executor must reject invalid plans before running MCP calls.

Rules:

- reject invalid plans before MCP execution
- report clear validation errors
- do not silently normalize invalid plans
- do not move invalid constraints into `unsupported_or_approximate`
- do not accept unknown fields for forward compatibility

Representative invalid examples:

### Unknown top-level field

```json
{
  "planner_schema": "query-planner-v1",
  "query": { "original_text": "x", "intent": "find_replays_matching_pattern" },
  "replay_set": {},
  "constraints": [],
  "evidence_requests": [],
  "assumptions": [],
  "unsupported_or_approximate": [],
  "extra": "invalid"
}
```

### Missing required `perspective`

```json
{
  "id": "self_first_mutalisk_before_6m",
  "type": "first_event_before",
  "item": "Mutalisk",
  "before_seconds": 360
}
```

### Unsupported item inside `constraints`

```json
{
  "id": "won_muta_phase",
  "type": "won_early_muta_phase",
  "perspective": "self"
}
```

### Fact-shaped non-boolean constraint

```json
{
  "id": "economy_at_5m",
  "type": "economy_at",
  "perspective": "self",
  "at_seconds": 300
}
```

### Duplicate item IDs

Two constraints or evidence requests both using:

```json
{ "id": "self_first_mutalisk" }
```

### Invalid enum value

```json
{
  "phrase": "map control",
  "status": "partially_supported",
  "reason": "..."
}
```

### Contradictory constraints on the same fact

- self first Mutalisk before 6:00
- self first Mutalisk after 7:00

in the same flat `all_of` constraint list

## Full Planner Example

Values in this example are illustrative. They demonstrate planner and executor shape and semantics, not exact results from a specific corpus snapshot.

```json
{
  "planner_schema": "query-planner-v1",
  "query": {
    "original_text": "Which pbjt ZvT games have early Mutalisks before enemy Science Vessels are out?",
    "intent": "find_replays_matching_pattern"
  },
  "replay_set": {
    "matchup": "ZvT",
    "player": "pbjt",
    "race": "zerg"
  },
  "constraints": [
    {
      "id": "self_first_mutalisk_before_6m",
      "type": "first_event_before",
      "perspective": "self",
      "item": "Mutalisk",
      "before_seconds": 360
    },
    {
      "id": "enemy_first_science_vessel_before_11m30s",
      "type": "first_event_before",
      "perspective": "enemy",
      "item": "Science Vessel",
      "before_seconds": 690
    }
  ],
  "evidence_requests": [
    {
      "id": "self_mutalisk_count_at_7m",
      "type": "unit_count_at",
      "perspective": "self",
      "unit": "Mutalisk",
      "at_seconds": 420
    },
    {
      "id": "self_economy_at_5m",
      "type": "economy_at",
      "perspective": "self",
      "at_seconds": 300
    },
    {
      "id": "self_deaths_5m_to_8m",
      "type": "deaths_between",
      "perspective": "self",
      "from_seconds": 300,
      "to_seconds": 480,
      "include_raw": true,
      "summaries": [
        "total_count",
        "count_by_unit_type",
        "count_by_category",
        "first_time_seconds",
        "last_time_seconds"
      ]
    }
  ],
  "assumptions": [
    {
      "phrase": "early Mutalisks",
      "meaning": "first self Mutalisk before 6:00"
    },
    {
      "phrase": "Science Vessels are out",
      "meaning": "first enemy Science Vessel exists before 11:30"
    },
    {
      "phrase": "pbjt ZvT games",
      "meaning": "pbjt is the self player of interest in replays filtered as matchup ZvT with race zerg"
    }
  ],
  "unsupported_or_approximate": []
}
```

## Full Executor Result Example

Values in this example are illustrative. They demonstrate shape and execution semantics, not exact output from a specific corpus snapshot.

```json
{
  "result_schema": "query-executor-result-v1",
  "plan": {
    "planner_schema": "query-planner-v1",
    "query": {
      "original_text": "Which pbjt ZvT games have early Mutalisks before enemy Science Vessels are out?",
      "intent": "find_replays_matching_pattern"
    },
    "replay_set": {
      "matchup": "ZvT",
      "player": "pbjt",
      "race": "zerg"
    },
    "constraints": [
      {
        "id": "self_first_mutalisk_before_6m",
        "type": "first_event_before",
        "perspective": "self",
        "item": "Mutalisk",
        "before_seconds": 360
      },
      {
        "id": "enemy_first_science_vessel_before_11m30s",
        "type": "first_event_before",
        "perspective": "enemy",
        "item": "Science Vessel",
        "before_seconds": 690
      }
    ],
    "evidence_requests": [
      {
        "id": "self_mutalisk_count_at_7m",
        "type": "unit_count_at",
        "perspective": "self",
        "unit": "Mutalisk",
        "at_seconds": 420
      },
      {
        "id": "self_economy_at_5m",
        "type": "economy_at",
        "perspective": "self",
        "at_seconds": 300
      },
      {
        "id": "self_deaths_5m_to_8m",
        "type": "deaths_between",
        "perspective": "self",
        "from_seconds": 300,
        "to_seconds": 480,
        "include_raw": true,
        "summaries": [
          "total_count",
          "count_by_unit_type",
          "count_by_category",
          "first_time_seconds",
          "last_time_seconds"
        ]
      }
    ],
    "assumptions": [
      {
        "phrase": "early Mutalisks",
        "meaning": "first self Mutalisk before 6:00"
      },
      {
        "phrase": "Science Vessels are out",
        "meaning": "first enemy Science Vessel exists before 11:30"
      }
    ],
    "unsupported_or_approximate": []
  },
  "coarse_replay_ids": [
    "example_replay_id_1",
    "example_replay_id_2"
  ],
  "replay_results": [
    {
      "replay_id": "example_replay_id_1",
      "source_replay_filename": "example.rep",
      "source_replay_path": "C:/replays/example.rep",
      "matchup": "ZvT",
      "self_player_name": "pbjt",
      "self_owner": 2,
      "enemy_player_name": "Aether-X",
      "enemy_owner": 3,
      "matched": true,
      "constraint_results": {
        "self_first_mutalisk_before_6m": {
          "passed": true,
          "value": {
            "event": {
              "time_seconds": 316,
              "item": "Mutalisk",
              "raw_line": "05:16 Mutalisk"
            }
          },
          "error": null
        },
        "enemy_first_science_vessel_before_11m30s": {
          "passed": true,
          "value": {
            "event": {
              "time_seconds": 594,
              "item": "Science Vessel",
              "raw_line": "09:54 Science Vessel"
            }
          },
          "error": null
        }
      },
      "evidence": {
        "self_mutalisk_count_at_7m": {
          "value": {
            "sample": {
              "time_seconds": 419.4,
              "unit_type": "mutalisk",
              "count": 10
            }
          },
          "error": null
        },
        "self_economy_at_5m": {
          "value": {
            "sample": {
              "time_seconds": 300.0,
              "minerals": 120,
              "gas": 480,
              "gathered_minerals": 3100,
              "gathered_gas": 820,
              "workers": 23
            }
          },
          "error": null
        },
        "self_deaths_5m_to_8m": {
          "value": {
            "deaths": [
              {
                "frame": 9600,
                "time_seconds": 403.2,
                "dead_owner": 2,
                "unit_type": "mutalisk",
                "category": "air"
              }
            ],
            "summaries": {
              "total_count": 1,
              "count_by_unit_type": {
                "mutalisk": 1
              },
              "count_by_category": {
                "air": 1
              },
              "first_time_seconds": 403.2,
              "last_time_seconds": 403.2
            }
          },
          "error": null
        }
      }
    }
  ],
  "unsupported_or_approximate": []
}
```

## Scope Boundary

This v1 design is replay-centric only.

Supported:

- selecting a coarse replay set
- applying per-replay deterministic boolean constraints
- gathering per-replay evidence
- returning replay-centric `replay_results`

Not supported in v1:

- top-k or ranking queries
- corpus-wide averages or medians
- percentile or distribution queries
- grouped cross-replay comparisons
- strategic BW predicates such as `won_early_muta_phase` or `contained_terran`

Those require a separate aggregate or enrichment design.

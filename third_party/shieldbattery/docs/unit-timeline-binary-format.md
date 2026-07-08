# Unit Timeline Binary Format

This document specifies the MessagePack-based binary format emitted by the ShieldBattery replay
timeline exporter when `SB_UNIT_TIMELINE_FORMAT=msgpack`.

The format is an append-only sequential stream intended for fast writing and single-pass reading.
It is not indexed and is not designed for random access.

## Overview

- File extension: `.sbtl`
- Encoding: MessagePack
- Stream structure:
  - Record 0 is always a header record
  - Records 1..N are snapshot records
- All hot-path records are encoded as MessagePack arrays, not maps

## Versioning

- Magic string: `"sbtl"`
- Current format version: `2`
- Readers should reject files whose magic or version does not match what they implement

## Record Types

Each top-level record starts with a `record_type` tag:

- `0` = header
- `1` = snapshot

## Record 0: Header

The first record in the stream is always:

```text
[
  0,                  // record_type: header
  "sbtl",             // magic
  2,                  // format version
  [category strings], // category dictionary by category_id
  [unit type names],  // unit type dictionary by unit_type_id
]
```

### Category Dictionary

The category array is ordered by `category_id`:

```text
0 = "building"
1 = "worker"
2 = "resource"
3 = "powerup"
4 = "subunit"
5 = "air"
6 = "unit"
```

### Unit Type Dictionary

The unit type array is ordered by `unit_type_id`.

- `unit_type_id` values found in snapshot and death records are indices into this array
- The array content is sourced from the writer’s `UNIT_TYPE_NAMES` table

## Snapshot Records

Each snapshot record is:

```text
[
  1,        // record_type: snapshot
  frame,    // u32
  owners,   // owner array
  deaths,   // unit array
]
```

- `frame` is the StarCraft simulation frame number
- `owners` contains one entry per serialized owner for that frame
- `deaths` contains units that disappeared since the previous emitted snapshot

## Owner Records

Each owner entry is:

```text
[
  owner_id,        // u8
  name,            // str
  minerals,        // u32
  gas,             // u32
  gathered_minerals, // u32
  gathered_gas,      // u32
  supply_current,  // u32
  supply_max,      // u32
  workers_alive,   // u32
  unit_counts,     // flat [unit_type_id, count, ...]
  units,           // unit array
]
```

- `gathered_minerals` and `gathered_gas` are cumulative worker-return totals for that owner
- They are monotonic within a replay and are independent of current stockpile/spending

### `unit_counts`

`unit_counts` is a flat alternating array:

```text
[unit_type_id_0, count_0, unit_type_id_1, count_1, ...]
```

- `unit_type_id` is `u16`
- `count` is `u32`
- Counts are recomputed from the serialized unit list for that owner

## Unit Records

Live units and death records use the same binary record layout.

Each unit record is:

```text
[
  id,                    // u32
  owner,                 // u8
  unit_type_id,          // u16
  killer_unit_type_id,   // u16 | nil
  morph_target_type_id,  // u16 | nil
  category_id,           // u8
  binary_flags,          // u16
  hp_raw,                // i32
  shields_raw,           // i32
  energy_raw,            // u16
  pos_x,                 // i16
  pos_y,                 // i16
  move_target_x,         // i16
  move_target_y,         // i16
  move_target_unit_id,   // u32
  order_target_x,        // i16
  order_target_y,        // i16
  order_target_unit_id,  // u32
  main_order_id,         // u8
  main_order_state,      // u8
  main_order_timer,      // u8
  secondary_order_id,    // u8
  secondary_order_state, // u8
  secondary_order_timer, // u8
  connected_unit_id,     // u32
  current_build_unit_id, // u32
  subunit_id,            // u32
  loaded_unit_ids,       // [u32, ...]
  build_queue_unit_ids,  // [u16, ...]
  build_time,            // u32 | nil
  remaining_build_time,  // u32 | nil
  tech_in_progress,      // u16 | nil
  upgrade_in_progress,   // u16 | nil
]
```

## `binary_flags`

`binary_flags` is a packed `u16` bitfield.

Bit layout:

```text
bit 0  = completed
bit 1  = reserved, currently always 0
bit 2  = morphing_building
bit 3  = constructing_building
bit 4  = disabled
bit 5  = burrowed
bit 6  = cloaked_or_burrowed
bit 7  = hallucination
bit 8  = in_transport
bit 9  = in_bunker
bit 10 = lifted
bits 11-15 = reserved, currently 0
```

Notes:

- `lifted` means a building that is not currently landed
- `cloaked_or_burrowed` matches the exporter’s invisibility check, not a separate BW field

## Optional Fields

The following unit fields may be `nil`:

- `killer_unit_type_id`
- `morph_target_type_id`
- `build_time`
- `remaining_build_time`
- `tech_in_progress`
- `upgrade_in_progress`

### `killer_unit_type_id`

This is best-effort metadata derived from BW’s `previous_attacker` pointer.

- It is not guaranteed to be the final blow source
- It may be `nil` even for a unit that appears in `deaths`

## Filtering and Omitted Data

The binary stream follows the same capture/filtering rules as the timeline exporter:

- pseudo-owners with `vespene_geyser` in their unit counts are excluded
- only units that satisfy the writer’s capture rules are serialized
- repeated frames are deduplicated by the writer before emission

## Access Pattern

Readers should process the file as a sequential stream:

1. decode the header record
2. build category and unit-type dictionaries
3. decode each subsequent snapshot record in order

There is no footer, index, or checksum in version 2.

## Reference Notes

The authoritative writer implementation is in:

- `game/src/unit_timeline.rs`

Downstream consumers should treat this document and the version number as the wire contract.

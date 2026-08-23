# SCR UnitId output parity

## Scope and conclusion

This report covers only `bwf-8uu`: the stable-unit-ID namespace difference in
SCR replay telemetry. The simulation and disappearance logic were already
correct. headless-bwsim v0.1.4 now exposes its retained namespace decision and
checked output conversion, allowing BW Forge to close the legacy output gap
without reproducing any replay-format logic.

The compatibility fix retains native bwsim UnitIds for all internal tracking
and calls upstream `toReplayUnitId()` only while serializing legacy telemetry.
It applies to every emitted live-unit `id`; deaths receive the same conversion
when the previous native live record is serialized. Conversion failure is a
hard error containing replay, frame, native ID, owner, unit type, and namespace
context.

## Current ID flow

ShieldBattery constructs every live `UnitRecord.id` with
`UnitArray::to_unique_id`. It keys its previous-live-unit map by that ID and
creates a death by cloning the disappeared live record. Consequently, an SCR
replay-local ID is present in both the owner `units` arrays and the `deaths`
array. SBTL uses the same `UnitRecord` representation for both.

The bwsim adapter calls `unitInstanceId(unit.index)`, places that native,
generation-bearing ID in the live `LegacyUnitRecord`, and keys both current and
previous unit maps with it. Death detection compares those native map keys and
serializes the previous live record. This is the correct internal identity
model and must remain unchanged.

The Python reducer reads every live `unit["id"]`. It uses the ID as an
in-memory correlation key for type/morph state, production queues, and
per-producer build-event deduplication. It copies a death ID unchanged into the
death dataset. The ID does not appear in build-order, supply, economy, unit
count, player, or manifest data.

The externally retained locations are:

- owner live IDs and death IDs in retained JSONL/SBTL debug telemetry;
- death IDs in each player ZIP's `deaths.json`;
- the same `deaths.json` embedded in the standalone HTML dataset.

Corpus ingestion deliberately drops the ID. SQLite `death_events` stores
replay/player/frame/time/dead owner/unit type/category only, so corpus queries,
replay cards, aggregate analytics, and MCP tools do not consume unit instance
IDs.

## Inverse transform and valid domain

For a replay that upstream has positively classified as `translated`, the
inverse of the v0.1.3 command-ID transform is:

```text
generation = bwsimId >>> 13
slotPart   = bwsimId & 0x1fff
component  = slotPart - 0x06a4

replayId = ((generation << 11) | component) >>> 0
```

The valid domain is:

- zero maps to zero; absent/null IDs remain absent/null;
- for a nonzero ID, `slotPart` must be in inclusive range
  `0x06a4..0x0ea3`;
- equivalently, the subtracted component must fit the replay-local 11-bit
  field, `0x0000..0x07ff`;
- `bwsimId` and the result must be treated as unsigned 32-bit values.

The generation field obtained from an unsigned bwsim ID is at most 19 bits and
therefore produces a replay-local ID no greater than `0x3fffffff`. An
exhaustive check of all 2,048 component values at generations 0, 1, 2, 3, 4,
5, and `0x7ffff` round-tripped all 14,336 cases.

This numeric domain is a representability check, not a namespace detector. A
native-namespace replay can contain IDs in the same numeric range. Applying the
inverse based on ID shape would double-convert valid native IDs.

No fixture in the replay-local `pvt_mid` trace produced an analysis-relevant
native ID outside the representable range. A later competitive fixture proved
that such IDs do occur for low legacy unit slots and that the legacy telemetry
namespace is intentionally hybrid; see "Low-slot legacy IDs" below.

## Golden validation

Fixture: `pvt_mid`, SHA-256
`779481fbd1d08e659c672b929d9173326f52c27d4a498f034eeea3cd0d19af30`.

- All 36 deaths match exactly after inverse conversion: frame, owner, DAT
  type, category, position, and ID are 36/36 exact.
- Across common frames 1..11,819, 598,022 bwsim live records matched a
  ShieldBattery record after inverse conversion on owner, ID, type, and
  position; zero records were missing/different and zero native IDs were
  outside the inverse domain.
- The trace covers native generations 1 through 5.
- Nineteen replay components were observed in multiple generations, directly
  exercising slot reuse.

Representative records are:

| Case | Frame | Owner | Unit | Shield replay ID | bwsim native ID |
|---|---:|---:|---|---:|---:|
| generation 1 | 1 | 0 | Probe | 3614 | 11458 |
| produced unit | 1015 | 1 | SCV | 3606 | 11450 |
| generation 2 | 2892 | 1 | Barracks | 5648 | 19636 |
| reused component 1499, generation 1 | 9281 | 1 | — | 3547 | 11391 |
| reused component 1499, generation 2 | 10366 | 0 | — | 5595 | 19583 |

Example deaths include `3600 -> 11444 -> 3600`,
`7684 -> 27816 -> 7684`, where the arrows are forward then inverse namespace
conversion.

After integrating v0.1.4, the fresh production bwsim JSONL matches the retained
ShieldBattery trace directly—no comparator normalization is applied:

- live records: 598,022/598,022 exact on owner, ID, type, and position;
- deaths: 36/36 IDs exact, split 11 for owner 0 and 25 for owner 1;
- build order: 103/103 exact (67 owner 0, 36 owner 1);
- supply: exact for both owners;
- minerals, gas, and workers: exact through common frame 11,819;
- unit counts: exact after the accepted Scanner Sweep removal;
- player metadata: exact;
- manifest: exact except the separately tracked duration/final-frame issue.

The ShieldBattery-only frame 11,820 remains explicitly outside this issue.

## Native-namespace controls

No conversion may be applied to native replays:

- `tvp_mid`: all 28 shared ShieldBattery/bwsim durable deaths have direct,
  unchanged ID equality (28/28, no mismatches).
- LastReplay: all 426 shared relevant durable deaths have direct, unchanged ID
  equality (426/426, no mismatches). The 17 Shield-only records are the already
  accepted Scanner Sweep omission and are outside this issue.

Fresh v0.1.4 production JSONL for both controls is byte-identical to the retained
v0.1.3 native output. Their player artifacts and legacy manifests are also
unchanged: `tvp_mid` retains all 28 direct death IDs and LastReplay retains all
426 relevant direct death IDs. This confirms there is no double conversion and
that disappearance correlation remains deterministic.

## Upstream API resolution

headless-bwsim v0.1.4 retains the replay-conversion classification and exposes
it as `replayUnitIdNamespace(): "native" | "replay-local" | undefined`. It
also exposes `toReplayUnitId(nativeId)`, which returns identity for native
replays, performs the checked inverse for replay-local replays, maps zero to
zero, and returns null before load or for a nonrepresentable ID.

BW Forge uses only that public conversion API. It neither reclassifies the
already-normalized DRPL nor duplicates the inverse formula or namespace
heuristic.

The adapter now:

1. keep native IDs in current/previous maps and all morph/disappearance logic;
2. serialize every live `LegacyUnitRecord.id` through `toReplayUnitId()`;
3. serialize disappeared previous records through the same function for death
   output without changing their native internal keys;
4. preserve the native ID when the public API returns null for a loaded
   replay-local replay;
5. fail loudly if two distinct native live IDs would serialize to the same
   legacy ID;
6. leave native replay output byte-for-byte unchanged.

## Low-slot legacy IDs

Fixture `bo99-primal-g1.rep`, SHA-256
`d254009025035b03e704d36647b718268e7876411d7b83559b07a47cd628448b`,
is a BW 1.21+ Melee ZvP on Polypoid 1.75. Native ID `0x2001` is a neutral
Vespene Geyser through frame 6,507 and morphs in place into owner 1's
Assimilator at frame 6,508. It remains live through terminal frame 13,027.

The low slot component `1` is outside the checked replay-local inverse domain,
so `toReplayUnitId(0x2001)` correctly returns null. Historical ShieldBattery
source establishes the required output semantics: the timeline exporter used
`UnitArray::to_unique_id()` directly. Low legacy slots therefore retain their
native generation-safe ID, while representable SCR action-addressable IDs use
the upstream inverse. A complete scan found no other nonrepresentable lifetime
in this replay, and `0x2001` did not collide with any converted live ID.

BW Forge applies this hybrid policy only at serialization. Current/previous
unit maps, disappearance detection, morph correlation, and slot-reuse safety
continue to use native bwsim IDs. A collision guard prevents two distinct
native live units from being exposed under one legacy ID.

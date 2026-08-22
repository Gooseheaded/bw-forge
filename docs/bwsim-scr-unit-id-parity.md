# SCR UnitId output parity

## Scope and conclusion

This report covers only `bwf-8uu`: the stable-unit-ID namespace difference in
SCR replay telemetry. The simulation and disappearance logic are already
correct. No adapter change was made because headless-bwsim v0.1.3 does not
expose the replay namespace decision needed to select the inverse transform
safely.

The eventual compatibility fix is small: retain native bwsim UnitIds for all
internal tracking, and convert IDs only while serializing legacy telemetry when
upstream reports that the loaded replay used the `translated` replay-local SCR
namespace. The conversion must apply to every emitted live-unit `id`; deaths
then receive the same converted ID because they serialize the previous live
record. Converting deaths alone would leave raw timeline parity incomplete.

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
native ID outside the representable range. If one does occur, BW Forge cannot
infer what ShieldBattery's active `UnitArray` would have emitted from the
native number alone. The compatibility layer must fail explicitly or use an
upstream-owned conversion result; it must not guess or mix namespaces.

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

## Native-namespace controls

No conversion may be applied to native replays:

- `tvp_mid`: all 28 shared ShieldBattery/bwsim durable deaths have direct,
  unchanged ID equality (28/28, no mismatches).
- LastReplay: all 426 shared relevant durable deaths have direct, unchanged ID
  equality (426/426, no mismatches). The 17 Shield-only records are the already
  accepted Scanner Sweep omission and are outside this issue.

Upstream v0.1.3 also established that the converted DRPL remains byte-identical
for native `tvp_mid` and LastReplay. These controls demonstrate why a numeric
range heuristic in BW Forge would be unsafe.

## Upstream API requirement

headless-bwsim already calculates the correct three-state decision during
`loadReplayBytes`: `not-applicable`, `native`, or `translated`. It then stores
the normalized DRPL but discards the decision. `ScrUnitIdMode` and the
normalization helper exist in `dist/replay-unit-id`, but the package root does
not export them and `Bwsim`/`LoadedReplayData` has no namespace accessor.

Reclassifying `replayData().drpl` after load is not valid: a translated replay's
stored DRPL has already been rewritten and would now look native. Deep-importing
the helper or independently reconverting and classifying the REP in BW Forge
would duplicate a fragile upstream replay-format decision, contrary to the
vendor policy.

The smallest required upstream capability is to retain and expose the original
load decision, for example as a read-only `replayUnitIdMode()` value or a field
on loaded replay metadata. Preferably upstream should also own a checked native
to replay-local serialization helper. After an upstream release/vendor refresh,
BW Forge can:

1. keep native IDs in current/previous maps and all morph/disappearance logic;
2. serialize every live `LegacyUnitRecord.id` through the checked inverse only
   when the exposed mode is `translated`;
3. derive death output from that compatibility serialization without changing
   its native internal key;
4. leave `native` and `not-applicable` replays byte-for-byte unchanged.

`bwf-8uu` therefore remains open pending an upstream API release. SCR death-ID
namespace parity is proven and bounded, but not yet closed in production BW
Forge.

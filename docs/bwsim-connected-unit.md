# `bw_unit_connected_unit_id` runtime semantics

These observations use the current `third_party/bwsim/bwsim_wasm.wasm` and
real replay data. They describe the primitive only.

## Input, output, and sentinel

The export has WASM signature `(i32) -> i32`. The argument is the live HUD
unit slot index exposed as `BwsimUnit.index`. Passing a generation-bearing
`unitInstanceId` as the argument does not resolve the unit reliably.

The return value is `0` when there is no connected unit. A nonzero return is a
generation-bearing unit ID in the ordinary bwsim `unitInstanceId` namespace;
it can be matched through ordinary unit snapshots and `unitInstanceId`.

Unrelated live units sampled at frame 0 returned `0`. Explicit invalid values
`0`, `1`, and `0xffffffff` also returned `0` in the sampled loaded replay.

## Larva and parent observations

The first fixture was `fixtures/replays/191104,(4)KnockOut1.4.rep`. At frame
0, Larva ID `11444` (index `3251`, owner 0, position `(288,314)`) returned
connected ID `11452`. ID `11452` resolved to owner 0, Hatchery type `131`,
position `(288,272)`. Larva IDs `11450` and `11451` (indices `3257` and
`3258`) returned the same parent. The parent was available on the first
observable frame.

The morph fixture is:

`tmp/corpus-conformance-v013-competitive/runs/zvz_long/bwsim/replays/86a77e447bcf870df252a6c7172617963e8c157243e59fa41db81b91722d5d9b/raw/231842,(4)KnockOut1.1.rep`

SHA-256: `86a77e447bcf870df252a6c7172617963e8c157243e59fa41db81b91722d5d9b`

At frame 5750, parent ID `11457` (index `3264`) was a Hatchery (type 131),
owner 2, at `(3808,272)`. Larva ID `11394` (index `3201`, owner 2,
`(3751,272)`) and Larva ID `11399` (index `3206`, owner 2, `(3748,320)`)
returned `11457`.

At frame 5760, the same parent index and ID (`3264` / `11457`) was a Lair
(type 132), still owner 2 and at `(3808,272)`. Existing Larvae continued to
return `11457`; for example, ID `11391` (index `3198`, owner 2, `(3749,272)`),
ID `11394`, and ID `11399` all returned that ID. The parent ID survives
Hatchery -> Lair morphing.

A second transition occurred at frame 5904: parent ID `11449` (index `3256`)
changed from Hatchery to Lair. Larva ID `11389` (index `3196`, owner 0,
position `(253,1178)`) returned `11449` after the transition. Parent and
larva owners matched in all sampled examples.

A full frame-by-frame scan of the fixture found newly observed larvae after
the morphs. The first new Larva after the `11449` transition was ID `11384`
(index `3191`) at frame 6427, owner 0, position `(347,272)`, returning
`11449`. The first new Larva after the `11457` transition was ID `11382`
(index `3189`) at frame 6679, owner 2, position `(3749,272)`, returning
`11457`. Later examples included ID `19585` at frame 7016 and ID `19604` at
frame 9244, both owner 2 and connected to `11457`. This confirms that larvae
first observed after the morph continue to resolve to the retained Lair ID.

The returned ID follows the parent identity rather than proximity. Multiple
Hatcheries/Lairs in the longer fixture produced parent IDs `11427`, `11436`,
`11449`, and `11457`.

## Lifecycle limits

The empirical pass establishes first-frame availability and retention across
sampled Hatchery -> Lair transitions. The available stable fixtures did not
provide a verified Hive transition, parent-death sequence, or complete
frame-by-frame Larva consumption/morph sequence. Those cases remain
unanswered and should not be inferred from proximity.

The repository fixture had no observed Lair/Hive transition. The longer
Zerg-vs-Zerg fixture above supplies the Lair evidence and is outside the
tracked fixture set.

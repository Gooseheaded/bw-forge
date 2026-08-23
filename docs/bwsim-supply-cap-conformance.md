# bwsim legacy supply-cap conformance

## Contract

ShieldBattery applies the legacy maximum in raw telemetry, before BW Forge's
Python reducer sees a snapshot. Its `owner_supply` function computes:

```text
used = floor((game.supply_used(owner, race) + 1) / 2)
max  = floor(min(game.supply_provided(owner, race),
                 game.supply_max(owner, race)) / 2)
```

The game's per-race `supply_max` is therefore the source of the ceiling; across
the affected traces it limits the emitted display maximum to 200. The same
function selects the owner's active race and runs while constructing every
emitted owner snapshot. It does not cap used supply.

The Python reducer reads `supply_current` and `supply_max` verbatim. It only
suppresses consecutive duplicate pairs before writing `supply.json`; it has no
clamp. The standalone HTML embeds that same generated `supply.json`.

The bwsim discrepancy was therefore a compatibility-serialization policy, not
an incorrect upstream engine value. BW Forge now uses:

```text
usedSupply = floor((rawUsedForActiveRace + 1) / 2)
maxSupply  = min(floor(rawMaxForActiveRace / 2), 200)
```

Only the outgoing normalized maximum is capped. Raw bwsim player state,
minerals, gas, workers, and used supply are unchanged.

## Seven affected bundles

The table uses `Shield/bwsim max, used` for each transition. Economy columns
are bwsim `minerals/gas/workers`; ShieldBattery is exact at the same samples.

| Fixture | Owner | Race | Previous -> first exceed -> next transition | First M/G/W | Peak frame: Shield/bwsim max, used; M/G/W |
|---|---:|---|---|---|---|
| `zvp_cap` | 2 | Protoss | 22861: 195/195, 192 -> 22862: 200/203, 192 -> 22887: 200/203, 190 | 969/877/50 | 26926: 200/244, 173; 263/486/50 |
| `tvp_long` | 2 | Terran | 26567: 200/200, 157 -> 26623: 200/210, 157 -> 26685: 200/210, 159 | 2303/1029/50 | 26623: 200/210, 157; 2303/1029/50 |
| `tvp_long` | 3 | Protoss | 18363: 195/195, 195 -> 18962: 200/203, 197 -> 19148: 200/203, 199 | 1208/1665/61 | 27225: 200/236, 156; 1763/954/62 |
| `tvt_long` | 3 | Terran | 29356: 198/198, 187 -> 29782: 200/206, 187 -> 30124: 200/206, 193 | 1988/3317/85 | 30671: 200/260, 191; 1588/2677/85 |
| `pvt_long` | 0 | Protoss | 16703: 196/196, 178 -> 16851: 200/204, 178 -> 17030: 200/212, 178 | 549/1133/69 | 30607: 200/245, 154; 7789/3326/64 |
| `pvt_long` | 1 | Terran | 29111: 198/198, 140 -> 29140: 200/208, 140 -> 29143: 200/208, 138 | 1092/1518/49 | 32715: 200/216, 148; 276/2207/49 |
| `pvp_long` | 0 | Protoss | 25957: 196/196, 163 -> 26011: 200/204, 163 -> 26555: 200/204, 165 | 1932/2863/64 | 26011: 200/204, 163; 1932/2863/64 |

Across every supply-transition interval within common emitted frames, all
seven bundles satisfy `Shield max == min(bwsim normalized max, 200)`. There are
zero used-supply differences in those common intervals. ShieldBattery's
observed maximum is 200 in every affected bundle.

## Production validation

All five affected replays were rerun through the production bwsim backend and
unchanged Python reducer, retaining JSONL:

- all seven first-boundary JSONL records emit `supply_max: 200` with exact used
  supply;
- no `supply_max` above 200 occurs anywhere in the five fresh JSONL files;
- all seven `supply.json` series match ShieldBattery exactly through the common
  final frame;
- six of seven are fully byte-identical to ShieldBattery;
- every standalone HTML embedded supply dataset exactly matches its fresh ZIP
  `supply.json`;
- build order, economy, unit counts, deaths, and player metadata are unchanged
  from the retained pre-cap bwsim baseline for every affected owner.

`tvp_long` owner 2 is the sole non-byte-identical full `supply.json`: bwsim
terminates at frame 34,296 and ShieldBattery later records a used-supply change
at frame 34,348. Their series is exact through the common final frame, including
all maximum-supply behavior. This is the pre-existing, out-of-scope termination
tail; it is not a remaining max-supply mismatch.

Unaffected controls cover every race:

- `early_zvz_6`: both Zerg owners;
- `early_pvz_197`: Protoss and Zerg;
- `pvt_mid`: Protoss and Terran.

All six control player bundles retain exact ShieldBattery `supply.json`, and
their standalone HTML embeds the same data. All three fresh control JSONL files
are byte-identical to their pre-cap production output.

Applying the proven rule to the retained 17-replay competitive baseline gives
exact common-frame supply parity for all 34 player bundles. No competitive
max-supply mismatch remains. `bwf-pee` is closed.

This removes the supply-cap shipping blocker. It does not by itself make bwsim
ready to become the default: the separately tracked competitive normalization
issues remain unchanged and were not investigated in this pass.

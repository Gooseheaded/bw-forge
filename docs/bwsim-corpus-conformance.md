# bwsim corpus conformance

Date: 2026-08-19  
Production implementation tested: `9bcc921eadc2fa014612babc36568c34477f2a10`

## Verdict

Do **not** make bwsim the default backend yet.

Nineteen replays (38 production `analyze` runs) covered every owner-ordered matchup. Both backends and both reducer invocations exited successfully for every replay. After removing only the accepted gathered-resource fields and Scanner Sweep effects, 9 replays had exact downstream parity. One more differed only because the accepted PlayerLeave+1 heuristic stopped bwsim 100 frames before ShieldBattery. The other 9 exposed reproducible, user-visible defects.

The most serious blocker is silent failure to execute replay actions in three replays. bwsim loads them, emits every frame, and reports success, but minerals, supply, live composition, and queues remain at their initial values. Two isolated reruns—one passing fixture and one affected fixture—were byte-identical at JSONL and extracted player-artifact level, so the behavior is deterministic rather than flaky.

## Method

Each fixture was run sequentially through the existing production CLI, without backend or reducer changes:

```text
bun apps/cli/src/main.ts analyze <replay> --out <isolated-output> \
  --backend shieldbattery --keep-snapshots

bun apps/cli/src/main.ts analyze <replay> --out <isolated-output> \
  --backend bwsim --keep-snapshots
```

The comparator read the generated player ZIP members and manifests. It applied only these predeclared transformations:

- removed `gathered_minerals` and `gathered_gas` from ShieldBattery economy samples;
- removed `scanner_sweep` counts/deaths and collapsed snapshots made redundant solely by that removal;
- when diagnosing PlayerLeave+1, compared ShieldBattery records through the bwsim terminal frame. This diagnostic truncation did not change the raw artifact classification.

No other unit, field, record, timestamp, or ordering was normalized. ZIP container bytes were not treated as significant; every member was compared directly. ShieldBattery extraction time is wall-clock total less the reducer's logged time because that backend does not log extraction separately. bwsim extraction and reducer times come from their production logs.

## Corpus and coverage

The corpus deliberately contains every requested matchup: ZvT, ZvP, ZvZ, TvZ, TvP, TvT, PvZ, PvT, and PvP. It includes the three early-leave goldens, a replay whose header exceeds the 43,200-frame cap, games from 66 to 45,017 nominal frames, and both medium and long samples for sparse non-Zerg matchups.

| Label | Matchup | SHA-256 | Source |
|---|---:|---|---|
| `early_zvz_6` | ZvZ | `af10cb48aa30f22416f1a56ad63ab48fb3f108d6f819ec402bbf7a88ee7940d1` | `packages/legacy-replay-analysis/26-04/20260412/173432,(4)Pole Star 1.1.rep` |
| `early_pvz_197` | PvZ | `6dc182c3ed881271b22d54d51fe34c3ca30a35da462e983d00b99631e81b178e` | `packages/legacy-replay-analysis/26-04/20260411/130754,(4)KnockOut1.4.rep` |
| `early_pvz_622` | PvZ | `82e32ff5f71a9bdb0a0e400503e6d551847a554a705c0c45f9ebb93e597ae9c6` | `packages/legacy-replay-analysis/26-04/20260427/015542,(4)Octagon1.0.rep` |
| `zvt_reference` | ZvT | `44b77091c689e59a4657215aff6bd281d6329dca73e4b6e1c7e9670117461ec6` | `howdidilosethis/replays/44b770…/raw/LastReplay.rep` |
| `zvt_mid` | ZvT | `736baf22bc380a5ec996a2e73f2710289ea3927242181bc24aa179ea17034070` | `packages/legacy-replay-analysis/zvt-pbjt/250719_032426_pbjt_AetherX….rep` |
| `zvp_mid` | ZvP | `4062ec495b0a446e23c07e130ecb92a98aed53b6659b841624c50fa3291fba7c` | `StarCraft/Maps/Replays/AutoSave/20250811/002819,(4)Polypoid 1.75.rep` |
| `zvp_cap` | ZvP | `037d708ab9356eff138b4281c724a764970a52bb203b2492ac2a28f0ec29ec7c` | `StarCraft/Maps/Replays/AutoSave/20260201/133227,Knockout 1.1.rep` |
| `zvz_long` | ZvZ | `86a77e447bcf870df252a6c7172617963e8c157243e59fa41db81b91722d5d9b` | `StarCraft/Maps/Replays/AutoSave/20260114/231842,(4)KnockOut1.1.rep` |
| `tvz_mid` | TvZ | `26fc5135c69878ff97a8fe02b1e48c529e051c0b3c1a03f4a98f606da815dd2f` | `StarCraft/Maps/Replays/pbjt/replays/003 - … Attitude … Sva3 vs pbjt.rep` |
| `tvz_long` | TvZ | `046a24fcb7d8f1e5467d898278d4c04ecd246cb144040c51dc9c6e6001c836d2` | `StarCraft/Maps/Replays/AutoSave/20260707/071545,Pole Star 1.1.rep` |
| `tvp_mid` | TvP | `1b58458bb761087de0e7194aeb7c187c4fb822a0f26451bf9500875ea1cb52c0` | `StarCraft/Maps/Replays/AutoSave/20250827/120930,(2)Litmus 1.1.rep` |
| `tvp_long` | TvP | `28bc8cd833051ba74fd8c335ed4b27101f8dae5a2ff0bdbdfb376ddcf422e841` | `StarCraft/Maps/Replays/semih-vs-lovesnow/241003_202022_….rep` |
| `tvt_mid` | TvT | `7c37903c73d51be5a0ef416b8619c3a31b8d537726d0a675b6e6f33953ceb009` | `StarCraft/Maps/Replays/CWALTerranReplays/RandomTopTerran/2025-07-19@191234_….rep` |
| `tvt_long` | TvT | `c2a1aba3eeba70bcc3eac249681ff15297ece25ff22e6a039e06eee5fb4aec41` | `StarCraft/Maps/Replays/AutoSave/20250826/222803,(4)Radeon 1.2.rep` |
| `pvz_mid` | PvZ | `2afed7db16517c10cdcc5908464981378fd42da954572a8595d5e007a00ede23` | `StarCraft/Maps/Replays/AutoSave/20260720/200345,(3)Neo_Sylphid_3.2.rep` |
| `pvt_mid` | PvT | `779481fbd1d08e659c672b929d9173326f52c27d4a498f034eeea3cd0d19af30` | `StarCraft/Maps/Replays/AutoSave/20250827/185843,(2)Litmus 1.1.rep` |
| `pvt_long` | PvT | `c380b6f260a857fb6d0878c26604a5156c03d0bb4c54fa8ccf44e121b0bf9644` | `StarCraft/Maps/Replays/AutoSave/20250914/154031,(4)Radeon 1.2.rep` |
| `pvp_mid` | PvP | `34116743f4cfb929bc0641a48e7226d93b6e5f44cd8f55fcb7673eba8c8d3899` | `StarCraft/Maps/Replays/AutoSave/20250910/001612,(4)Pole Star 1.1.rep` |
| `pvp_long` | PvP | `19b08d9ecbe948e857b48909b2c6b6020878200d7b258b7c081c7dd79cdab6d3` | `StarCraft/Maps/Replays/AutoSave/20250910/003647,(4)Radeon 1.2.rep` |

Feature coverage is observable in retained raw traces and legacy artifacts:

- LastReplay exercises the previously proven Zerg unit queues, unit and building morphs, Terran add-ons, simultaneous starts, depleted resources, upgrades, and large battles. Its ShieldBattery trace reaches 199 live units for one owner.
- That same raw trace contains 5,415 unit records with loaded IDs, 9,801 `in_transport`/`in_bunker` observations, 11,463 burrowed observations, 11,445 cloaked-or-burrowed observations, 40,376 lifted-building observations, and five incomplete building disappearances.
- Raw `tech_in_progress` observations contain three technology IDs; `upgrade_in_progress` contains ten upgrade IDs.
- Across the corpus, build orders include Dropships, Shuttles, Lurkers, Dark Templars, Observers, Science Vessels, Guardians, and Devourers.
- The three no-action failures themselves cover incomplete/cancelled construction and transport production on the ShieldBattery side, but cannot count as successful bwsim feature conformance.

The legacy artifacts do not preserve a distinct generic “cloaked” bit; they preserve a combined `cloaked_or_burrowed` state. Coverage should therefore not be read as a proof of every cloak mechanic independently.

## Per-replay results

Timing cells are extraction/reduction/total seconds. `EXACT MATCH` means all requested downstream artifacts match after only gathered-resource and Scanner Sweep removal.

| Replay | Matchup | Header | Final Shield / bwsim | bwsim stop | Shield E/R/T | bwsim E/R/T | Classification |
|---|---:|---:|---:|---|---:|---:|---|
| `early_zvz_6` | ZvZ | 66 | 6 / 6 | player-leave | 13.1/0.0/13.1 | 2.7/0.0/3.1 | EXACT MATCH |
| `early_pvz_197` | PvZ | 224 | 197 / 197 | player-leave | 11.5/0.1/11.6 | 3.0/0.1/3.5 | EXACT MATCH |
| `early_pvz_622` | PvZ | 677 | 622 / 622 | player-leave | 13.2/0.4/13.6 | 3.7/0.1/4.2 | EXACT MATCH |
| `zvt_reference` | ZvT | 32937 | 32937 / 32937 | header | 182.6/147.7/330.3 | 291.3/36.9/328.7 | EXACT MATCH |
| `zvt_mid` | ZvT | 22012 | 22012 / 21949 | player-leave | 138.3/88.5/226.8 | 114.8/3.5/118.8 | BUG / UNEXPLAINED |
| `zvp_mid` | ZvP | 11983 | 11983 / 11983 | header | 69.9/21.9/91.8 | 50.2/6.2/56.8 | EXACT MATCH |
| `zvp_cap` | ZvP | 45017 | 43200 / 43200 | safety-cap | 268.3/241.4/509.7 | 542.4/65.0/607.8 | BUG / UNEXPLAINED |
| `zvz_long` | ZvZ | 34924 | 34846 / 34846 | player-leave | 177.1/124.7/301.8 | 236.4/33.7/270.5 | EXACT MATCH |
| `tvz_mid` | TvZ | 11950 | 11950 / 11950 | header | 59.5/23.9/83.4 | 23.5/1.8/25.7 | BUG / UNEXPLAINED |
| `tvz_long` | TvZ | 35044 | 35044 / 35044 | header | 198.7/168.3/367.0 | 482.0/44.3/526.8 | BUG / UNEXPLAINED |
| `tvp_mid` | TvP | 12312 | 12312 / 12312 | header | 62.1/22.7/84.8 | 44.7/6.4/51.4 | EXACT MATCH |
| `tvp_long` | TvP | 34506 | 34506 / 34296 | player-leave | 169.2/229.6/398.8 | 455.9/59.9/516.3 | BUG / UNEXPLAINED |
| `tvt_mid` | TvT | 12172 | 12172 / 12072 | player-leave | 70.7/29.9/100.6 | 108.4/7.9/116.7 | KNOWN INTENTIONAL DIFFERENCE |
| `tvt_long` | TvT | 34649 | 34649 / 34579 | player-leave | 192.3/224.6/416.9 | 395.9/57.3/453.6 | BUG / UNEXPLAINED |
| `pvz_mid` | PvZ | 21969 | 21969 / 21969 | header | 100.1/57.1/157.2 | 103.0/15.9/119.3 | EXACT MATCH |
| `pvt_mid` | PvT | 11819 | 11820 / 11819 | header | 54.2/18.1/72.3 | 18.7/1.6/20.7 | BUG / UNEXPLAINED |
| `pvt_long` | PvT | 33156 | 33156 / 33016 | player-leave | 180.7/218.4/399.1 | 396.8/55.8/453.1 | BUG / UNEXPLAINED |
| `pvp_mid` | PvP | 17242 | 17242 / 17242 | header | 93.7/49.7/143.4 | 156.5/13.5/170.4 | EXACT MATCH |
| `pvp_long` | PvP | 26726 | 26726 / 26726 | header | 137.8/109.8/247.6 | 195.1/29.7/225.2 | BUG / UNEXPLAINED |

### Difference details

1. **Replay actions are not executed — BUG / UNEXPLAINED, 3 replays.** `zvt_mid`, `tvz_mid`, and `pvt_mid` retain only initial composition and supply under bwsim. Their bwsim build orders are empty. The missing ShieldBattery build-order counts are 421, 154, and 103 respectively (678 total). Current minerals/gas/workers, composition, deaths, and supply all consequently diverge. The backend nevertheless exits successfully, making this a hard defaulting blocker. The three files span game types 10 and 2, so no single header-mode restriction was established. Tracked as `bwf-uf2`; `zvt_mid` is already a repository-resident regression fixture.

2. **Supply maximum is not capped at legacy 200 — BUG / UNEXPLAINED, 5 replays / 7 player bundles.** `zvp_cap`, `tvp_long`, `tvt_long`, `pvt_long`, and `pvp_long` emit bwsim maxima from 204 through 260 while ShieldBattery remains at 200. There are 1,008 shared-frame supply records with different values. `current` agrees at the first mismatches; `max` is the divergent field. Tracked as `bwf-pee`.

3. **Observer/Devourer death category differs — BUG / UNEXPLAINED, 5 replays / 23 deaths.** The durable death records agree on frame, owner, stable ID, DAT ID, type, and position. ShieldBattery classifies Observer and Devourer as `air`; bwsim classifies them as `unit`. This affects `zvp_cap` (5 Observers), `tvz_long` (3 Devourers), `tvp_long` (7 Observers), `pvt_long` (6 Observers), and `pvp_long` (2 Observers). Tracked as `bwf-b7d`.

4. **Construction backdating crosses a rendered-second boundary — KNOWN NORMALIZATION ISSUE, 2 events.** `tvz_long` emits Control Tower at 12:14 under ShieldBattery and 12:13 under bwsim. `tvt_long` emits Comsat Station at 06:03 versus 06:02. This is the previously identified progress/backdating class, now proven to affect corpus artifacts. `tvz_long` also reverses two pairs of simultaneous same-second events; the event multisets and timestamps are otherwise the same. Tracked as `bwf-jra`.

5. **PlayerLeave+1 false positives relative to live Storm state — KNOWN INTENTIONAL DIFFERENCE.** Besides the three exact early-leave goldens and exact `zvz_long`, the heuristic stops five replays 63–210 frames before ShieldBattery: `zvt_mid`, `tvp_long`, `tvt_mid`, `tvt_long`, and `pvt_long`. In `tvt_mid`, all common-window state artifacts match; the only missing build event is a Siege Tank at 08:30, after bwsim's frame-12072 terminal point. That replay is therefore classified as known/acceptable only. The other four also contain independent bugs above and remain BUG / UNEXPLAINED.

6. **ShieldBattery emits header+1 on one fixture — BUG / UNEXPLAINED.** `pvt_mid` has header end 11819; its retained ShieldBattery SBTL was directly scanned and contains frames 1..11820, while bwsim correctly applies its stated header stop at 11819. This is separate from that replay's no-action failure. Tracked as `bwf-7ln`.

## Artifact aggregates

There are 38 player bundles.

- **Build order:** 13/19 replay build-order sets (28/38 player files) are byte-identical. No replay is merely formatting-different. The raw difference is 681 missing-line and 2 extra-line multiset entries: 678 are the three no-action failures; one missing tank is after a heuristic early stop; the remaining two missing/extra pairs are the one-second construction shifts. Two simultaneous-event pairs also change order within `tvz_long`.
- **Supply:** 10/19 replay sets (24/38 player files) are identical as generated. After restricting termination-only cases to the common frame window, remaining failures are the three no-action replays and five supply-cap replays.
- **Economy:** raw bytes differ for all 38 player files because bwsim intentionally omits gathered counters. After removing only those counters, 12/19 replay sets (28/38 players) match as generated. Every non-no-action mismatch disappears when ShieldBattery is restricted to the bwsim terminal frame. Minerals, gas, and workers have the same classification.
- **Unit counts:** raw bytes match only 4/38 player files because Scanner Sweep can create legacy-only samples. After removing Scanner Sweep and its redundant samples, 14/19 replay sets (30/38 players) match as generated. Common-window differences remain only in the three no-action replays.
- **Deaths:** after removing Scanner Sweep, 11/19 replay sets (27/38 players) match. Remaining failures are the three no-action replays and the five Observer/Devourer category cases.
- **Player metadata:** `player.json` is byte-identical for all 38 players. Names, numeric owners, and races therefore conform across the whole corpus.
- **Legacy manifest:** 13/19 are byte- and semantically identical. All six differences are duration changes caused by final-frame differences; player metadata and matchup agree.
- **Reducer robustness:** ShieldBattery 19/19 success; bwsim 19/19 process/reducer success; zero crashes, malformed JSONL files, conversion failures, or timeouts. The silent no-action successes show that exit status alone is not adequate validation.

No Scanner Sweep or missing gathered-resource field was counted as an unexplained difference.

## Termination

All three required early-PlayerLeave fixtures match exactly:

| Header | Shield final | bwsim final | Result |
|---:|---:|---:|---|
| 66 | 6 | 6 | exact; terminal frame included |
| 224 | 197 | 197 | exact; terminal frame included |
| 677 | 622 | 622 | exact; terminal frame included |

The long cap fixture has header 45017 and both backends end at 43200; bwsim reports `safety-cap`. Header-stop fixtures include their header frame. `zvz_long` is an additional exact PlayerLeave case (header 34924, final 34846).

The five heuristic false positives and one ShieldBattery header+1 case are listed above. Result/player metadata does not otherwise diverge.

## Performance

Seconds, across 19 replays:

| Backend | Phase | Min | Median | Max |
|---|---|---:|---:|---:|
| ShieldBattery | extraction (derived) | 11.55 | 100.06 | 268.31 |
| ShieldBattery | Python reduction | 0.00 | 57.10 | 241.40 |
| ShieldBattery | total | 11.65 | 157.16 | 509.71 |
| bwsim | extraction | 2.68 | 114.83 | 542.41 |
| bwsim | Python reduction | 0.00 | 13.50 | 65.00 |
| bwsim | total | 3.12 | 119.34 | 607.84 |

bwsim has the lower median total but a worse long tail. The 43,200-frame cap replay is the maximum for both (607.84s bwsim vs 509.71s ShieldBattery). Long TvZ/TvP cases also make bwsim slower overall, while several medium cases are substantially faster. The reducer is consistently faster on bwsim JSONL than ShieldBattery SBTL in this run; no optimization was attempted.

## Decision answers

1. **How many replays were compared?** 19, producing 38 backend runs and 38 player bundles per backend.
2. **How many had exact downstream parity after intentional differences?** 9.
3. **How many had known/acceptable differences only?** 1 (`tvt_mid`, PlayerLeave+1 truncation only).
4. **How many had unexplained differences?** 9.
5. **Did all three PlayerLeave fixtures terminate exactly?** Yes: 6, 197, and 622, with terminal frames included.
6. **Were there race/matchup-specific failures?** There is no single failing matchup. The no-action blocker spans ZvT, TvZ, and PvT. Supply-cap failures occur in late Protoss/Terran states; death-category failures are type-specific to Observer and Devourer; the observed backdating failures are Terran add-ons. Both ZvZ fixtures conform.
7. **Were there replay classes bwsim could not process?** Yes. Three replays are silently simulated without executing actions. They span at least two game types, so the exact format/class remains unresolved.
8. **What are the major performance characteristics?** bwsim median total is lower (119.34s vs 157.16s), but maximum and several long-game totals are worse. bwsim extraction dominates; its downstream JSONL reduction is much faster in this corpus.
9. **Is there enough evidence to make bwsim the default backend?** No.
10. **Concrete remaining blockers:** fix or explicitly reject the three no-action replays (`bwf-uf2`); cap legacy displayed supply at 200 (`bwf-pee`); restore Observer/Devourer `air` classification (`bwf-b7d`); resolve the two construction-backdate boundary differences and deterministic simultaneous ordering (`bwf-jra`); and explain the ShieldBattery header+1 fixture (`bwf-7ln`). Then rerun this same pinned corpus. The already accepted PlayerLeave+1 heuristic should remain documented rather than represented as exact Storm connection-state emulation.

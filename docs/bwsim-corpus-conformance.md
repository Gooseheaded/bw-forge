# bwsim corpus conformance

## v0.1.3 competitive-baseline follow-up — 2026-08-23

Upstream runtime tested: `headless-bwsim` `v0.1.3`, commit
`68ebdfd70d8d7a58d55c2ad206cc08da5697e7fa`. BW Forge's vendored runtime was
refreshed from that exact clean checkout. All 29 vendored release files match
upstream by SHA-256. The original Wasm, patched Wasm, and `sim.pack.gz` hashes
remain unchanged.

### Verdict

The competitive SCR action-execution defect is fixed. `pvt_mid` now reproduces
all 103 ShieldBattery build events, and its state agrees through the inclusive
header frame 11,819. No competitive fixture retains an unexplained missing-action
or simulation-state defect.

Do **not** make bwsim the default backend yet under the current artifact-parity
gate. The four pre-existing smaller blocker classes all remain, and `pvt_mid`
also exposes a representational difference in stable death IDs: ShieldBattery
retains SCR replay-local IDs while bwsim emits the corresponding native engine
IDs. All durable death fields match after the documented namespace transform,
but `deaths.json` is not byte- or object-identical.

The 17-fixture competitive classification is:

- 9 exact after the accepted gathered-resource and Scanner Sweep transforms;
- 1 accepted-intentional-only (`tvt_mid`, PlayerLeave+1 truncation);
- 7 with known normalization issues;
- 0 with an unexplained competitive action/state defect.

This improves the prior competitive result from 9 exact, 1 accepted-only, and
7 unexplained. `pvt_mid` leaves the unexplained action-execution group; it
remains non-exact only for the separately tracked header+1 behavior and its
stable-ID namespace representation.

### Vendor refresh

- Upstream tag: `v0.1.3`
- Upstream commit: `68ebdfd70d8d7a58d55c2ad206cc08da5697e7fa`
- Package/provenance version: `0.1.3`
- Original Wasm SHA-256: `b321eb4f274d2602be1ccdf3cefa72b0ba934e2025d76d7c25379a18af4d1226`
- Patched Wasm SHA-256: `aec4109937e4d1efefa921cf4fef8bfd2febc772809a026510ff1a6e88ca9a7d`
- `sim.pack.gz` SHA-256: `32f8cc3561e11d2756a579dc54675e0758e94c15b9f767a66a1ba533a9856a44`

No local vendor patch or BW Forge DRPL normalization was added. The conversion
change is solely upstream v0.1.3 built output. ShieldBattery remains the default
backend.

### `pvt_mid` end-to-end result

Both production backends and the unchanged Python reducer succeeded.

| Target | Result |
|---|---|
| `build_order.txt` | Exact: owner 0 is 67/67, owner 1 is 36/36, total 103/103; 0 missing, 0 extra, 0 timing differences |
| `supply.json` | Exact for both players |
| `economy.json` | Minerals, gas, and workers match at every common frame 1..11,819; ShieldBattery has one extra frame 11,820; gathered counters remain intentionally absent from bwsim |
| `unit_counts.json` | Exact after the accepted Scanner Sweep transform |
| `deaths.json` | 11/11 and 25/25 events; frame, owner, DAT type, category, and position all exact; all 36 stable IDs use the corresponding native bwsim namespace instead of ShieldBattery's replay-local namespace |
| Player metadata | Exact for both players |
| Legacy manifest | All fields exact except duration: ShieldBattery 496.440s versus bwsim 496.398s |
| Final frame | ShieldBattery 11,820; bwsim/header 11,819 |

For every death, applying the upstream v0.1.3 conversion to ShieldBattery's
replay-local ID makes the record exact:

```text
generation = replayId >>> 11
component  = replayId & 0x07ff
bwsimId    = ((generation << 13) | (component + 0x06a4)) >>> 0
```

This ID difference does not indicate a remaining replay-action failure, but it
is retained as an explicit downstream artifact-parity issue rather than hidden
by the corpus comparator.

### Competitive per-replay results

The table contains only the audited competitive/Melee-style set: 3 literal
Melee and 14 Top vs Bottom fixtures. Timing cells are
extraction/reduction/total seconds.

| Replay | Matchup | Header | Final Shield / bwsim | bwsim stop | Shield E/R/T | bwsim E/R/T | Classification |
|---|---:|---:|---:|---|---:|---:|---|
| `early_zvz_6` | ZvZ | 66 | 6 / 6 | player-leave | 17.2/0.0/17.2 | 3.6/0.1/4.3 | EXACT MATCH |
| `early_pvz_197` | PvZ | 224 | 197 / 197 | player-leave | 17.1/0.2/17.3 | 4.8/0.2/5.8 | EXACT MATCH |
| `early_pvz_622` | PvZ | 677 | 622 / 622 | player-leave | 20.3/0.6/20.9 | 6.3/0.2/7.5 | EXACT MATCH |
| `zvt_reference` | ZvT | 32,937 | 32,937 / 32,937 | header | 278.8/272.3/551.1 | 516.8/72.3/590.0 | EXACT MATCH |
| `zvp_mid` | ZvP | 11,983 | 11,983 / 11,983 | header | 96.4/35.3/131.7 | 86.1/10.4/97.4 | EXACT MATCH |
| `zvp_cap` | ZvP | 45,017 | 43,200 / 43,200 | safety-cap | 368.4/381.6/750.0 | 534.0/70.9/605.4 | KNOWN NORMALIZATION ISSUE |
| `zvz_long` | ZvZ | 34,924 | 34,846 / 34,846 | player-leave | 150.6/138.7/289.3 | 255.4/38.2/294.1 | EXACT MATCH |
| `tvz_long` | TvZ | 35,044 | 35,044 / 35,044 | header | 169.8/183.2/353.0 | 527.8/78.6/607.1 | KNOWN NORMALIZATION ISSUE |
| `tvp_mid` | TvP | 12,312 | 12,312 / 12,312 | header | 132.4/36.2/168.6 | 58.8/8.6/68.1 | EXACT MATCH |
| `tvp_long` | TvP | 34,506 | 34,506 / 34,296 | player-leave | 289.6/394.4/684.0 | 691.4/103.3/795.6 | KNOWN NORMALIZATION ISSUE |
| `tvt_mid` | TvT | 12,172 | 12,172 / 12,072 | player-leave | 114.7/47.5/162.2 | 162.3/11.5/174.6 | ACCEPTED INTENTIONAL DIFFERENCE |
| `tvt_long` | TvT | 34,649 | 34,649 / 34,579 | player-leave | 195.6/305.5/501.1 | 506.9/82.6/590.0 | KNOWN NORMALIZATION ISSUE |
| `pvz_mid` | PvZ | 21,969 | 21,969 / 21,969 | header | 110.6/69.3/179.9 | 133.1/21.6/155.3 | EXACT MATCH |
| `pvt_mid` | PvT | 11,819 | 11,820 / 11,819 | header | 69.5/21.2/90.7 | 76.1/8.4/85.4 | KNOWN NORMALIZATION ISSUE |
| `pvt_long` | PvT | 33,156 | 33,156 / 33,016 | player-leave | 189.0/283.1/472.1 | 528.1/76.9/605.6 | KNOWN NORMALIZATION ISSUE |
| `pvp_mid` | PvP | 17,242 | 17,242 / 17,242 | header | 95.8/58.9/154.7 | 182.9/15.5/198.9 | EXACT MATCH |
| `pvp_long` | PvP | 26,726 | 26,726 / 26,726 | header | 136.8/131.6/268.4 | 229.7/36.9/267.2 | KNOWN NORMALIZATION ISSUE |

All 34 production backend/reducer executions succeeded with no backend/reducer
timeout, crash, malformed output, or unsupported replay. Artifact-level replay
counts before classifying known causes are:

- build orders semantically exact: 14/17;
- supply exact: 11/17;
- economy exact after gathered-field removal: 12/17;
- unit counts exact after Scanner Sweep removal: 15/17;
- deaths exact after Scanner Sweep removal, including raw IDs/categories: 11/17;
- player metadata exact: 17/17, all 34 players;
- legacy manifests exact: 12/17;
- final emitted frames exact: 12/17.

The first all-corpus command exceeded its two-hour outer harness guard after 25
records. Its child process briefly overlapped a resume, making the post-timeout
tail timings untrustworthy. Those tail records were discarded. `tvt_long`,
`pvz_mid`, `pvt_long`, `pvp_mid`, and `pvp_long` were rerun through both
backends in a fresh single-writer root; their recorded timings were checked
against their own logs. The table and aggregate use only the clean records.

### Smaller known blockers

All four still reproduce; none was fixed in this pass.

1. **Supply maximum cap:** 7 player bundles still exceed legacy 200:
   `zvp_cap` owner 2 (244), `tvp_long` owners 2/3 (210/236), `tvt_long`
   owner 3 (260), `pvt_long` owners 0/1 (245/216), and `pvp_long` owner 0
   (204). `tvt_mid` also has a supply-series tail difference, but its maximum
   is 108/108 and the cause is accepted PlayerLeave+1 truncation, not the cap.
2. **Observer/Devourer death category:** all 23 durable deaths still match
   except `air` versus `unit`: `zvp_cap` (5 Observers), `tvz_long`
   (3 Devourers), `tvp_long` (7 Observers), `pvt_long` (6 Observers), and
   `pvp_long` (2 Observers).
3. **Construction backdating:** `tvz_long` still renders Control Tower at
   12:13 instead of 12:14; `tvt_long` still renders Comsat Station at 06:02
   instead of 06:03. The `tvz_long` same-second ordering difference remains.
4. **ShieldBattery header+1:** `pvt_mid` still emits frame 11,820 for header
   end 11,819; bwsim includes and stops at 11,819.

### UMS compatibility — not rerun

`zvt_mid` and `tvz_mid` are Use Map Settings fixtures. They were deliberately
excluded from every v0.1.3 production run, aggregate, performance statistic,
and default-backend verdict in this section. Their last retained evidence is
the separate v0.1.2 result: replay actions execute only partially and downstream
artifacts are materially incomplete. No conclusion about v0.1.3 UMS behavior
is made here.

### Competitive performance

Seconds across the 17 authoritative competitive runs:

| Backend | Phase | Min | Median | Max | Max fixture |
|---|---|---:|---:|---:|---|
| ShieldBattery | extraction (derived) | 17.13 | 132.40 | 368.37 | `zvp_cap` |
| ShieldBattery | Python reduction | 0.00 | 69.30 | 394.40 | `tvp_long` |
| ShieldBattery | total | 17.17 | 179.87 | 749.97 | `zvp_cap` |
| bwsim | extraction | 3.56 | 182.91 | 691.38 | `tvp_long` |
| bwsim | Python reduction | 0.10 | 21.60 | 103.30 | `tvp_long` |
| bwsim | total | 4.32 | 198.91 | 795.57 | `tvp_long` |

bwsim's five longest totals were `tvp_long` 795.57s, `tvz_long` 607.12s,
`pvt_long` 605.59s, `zvp_cap` 605.42s, and `tvt_long` 590.01s. Extraction
continues to dominate bwsim, while its reducer phase is substantially faster.
No optimization was attempted.

### Validation

- Upstream v0.1.3 suite: 23/23 passed from the exact tagged checkout.
- Vendored release verification: 29/29 files match upstream by SHA-256.
- BW Forge CLI suite: 12/12 passed.
- BW Forge desktop suite: 52/52 passed.
- BW Forge corpus-query suite: 49/49 passed.
- Repository typecheck: passed for root, desktop, and corpus-query packages.
- Production competitive corpus: 34/34 backend/reducer executions succeeded.

## v0.1.2 follow-up — 2026-08-22

Upstream runtime tested: `headless-bwsim` `v0.1.2`, commit
`31d7613f9dfec86897c69ea2e69e6f55ac19724e`. BW Forge's vendored runtime was
refreshed from that exact checkout. All 29 vendored release files match upstream
by SHA-256. The original Wasm, patched Wasm, and `sim.pack.gz` remain unchanged
at their previously pinned hashes.

### Verdict

Do **not** make bwsim the default backend yet.

Version 0.1.2 fixes the total silent no-action symptom: all three affected
replays now mine, produce units, reach the expected terminal frame, and rerun
byte-deterministically through the production BW Forge backend and unchanged
Python reducer. It does **not** restore correct replay execution for those
fixtures. Their downstream state diverges almost immediately and their build
orders remain severely incomplete. The existing `bwf-uf2` issue therefore
remains open.

The broader aggregate is unchanged from v0.1.1: 9 of 19 replays have exact
downstream parity after only the accepted gathered-resource and Scanner Sweep
transformations; one more has only the accepted PlayerLeave+1 difference; 9
retain unexplained defects. All 38 final production runs exited successfully.

### Vendor refresh

- Upstream tag: `v0.1.2`
- Upstream commit: `31d7613f9dfec86897c69ea2e69e6f55ac19724e`
- Package/provenance version: `0.1.2`
- Original Wasm SHA-256: `b321eb4f274d2602be1ccdf3cefa72b0ba934e2025d76d7c25379a18af4d1226`
- Patched Wasm SHA-256: `aec4109937e4d1efefa921cf4fef8bfd2febc772809a026510ff1a6e88ca9a7d`
- `sim.pack.gz` SHA-256: `32f8cc3561e11d2756a579dc54675e0758e94c15b9f767a66a1ba533a9856a44`

No BW Forge adapter-side DRPL normalization exists. The only new normalization
code in `third_party/bwsim` is the unchanged built output from upstream v0.1.2.
The default backend remains ShieldBattery.

### Game-type audit

Audited 2026-08-22 with `screp.exe -overview` and screp's structured JSON
header output. The SHA-256 of every file matched the pinned corpus selection.
All 19 fixtures use engine `BW 1.21+`.

For corpus policy, literal `Melee` and standard `Top vs Bottom` 1v1 fixtures are
the **baseline competitive / Melee-style** set. `Use map settings` is kept as a
separate **nonstandard / UMS compatibility** set. This preserves the UMS
coverage without allowing a UMS-only failure to determine ordinary competitive
backend readiness.

| Fixture | SHA-256 | screp type | Engine | Matchup | Map | Corpus class |
|---|---|---|---|---|---|---|
| `early_zvz_6` | `af10cb48aa30f22416f1a56ad63ab48fb3f108d6f819ec402bbf7a88ee7940d1` | Top vs Bottom | BW 1.21+ | ZvZ | Pole Star 1.1 | baseline competitive |
| `early_pvz_197` | `6dc182c3ed881271b22d54d51fe34c3ca30a35da462e983d00b99631e81b178e` | Melee | BW 1.21+ | PvZ | KnockOut 1.4 | baseline competitive |
| `early_pvz_622` | `82e32ff5f71a9bdb0a0e400503e6d551847a554a705c0c45f9ebb93e597ae9c6` | Top vs Bottom | BW 1.21+ | PvZ | Octagon 1.0 | baseline competitive |
| `zvt_reference` | `44b77091c689e59a4657215aff6bd281d6329dca73e4b6e1c7e9670117461ec6` | Top vs Bottom | BW 1.21+ | ZvT | KnockOut 1.4 | baseline competitive |
| `zvt_mid` | `736baf22bc380a5ec996a2e73f2710289ea3927242181bc24aa179ea17034070` | Use map settings | BW 1.21+ | ZvT | Pole Star 1.0 | nonstandard / UMS |
| `zvp_mid` | `4062ec495b0a446e23c07e130ecb92a98aed53b6659b841624c50fa3291fba7c` | Top vs Bottom | BW 1.21+ | PvZ | Polypoid 1.75 | baseline competitive |
| `zvp_cap` | `037d708ab9356eff138b4281c724a764970a52bb203b2492ac2a28f0ec29ec7c` | Melee | BW 1.21+ | ZvP | KnockOut 1.1 | baseline competitive |
| `zvz_long` | `86a77e447bcf870df252a6c7172617963e8c157243e59fa41db81b91722d5d9b` | Top vs Bottom | BW 1.21+ | ZvZ | KnockOut 1.1 | baseline competitive |
| `tvz_mid` | `26fc5135c69878ff97a8fe02b1e48c529e051c0b3c1a03f4a98f606da815dd2f` | Use map settings | BW 1.21+ | TvZ | Attitude 1.0 | nonstandard / UMS |
| `tvz_long` | `046a24fcb7d8f1e5467d898278d4c04ecd246cb144040c51dc9c6e6001c836d2` | Melee | BW 1.21+ | TvZ | Pole Star 1.1 | baseline competitive |
| `tvp_mid` | `1b58458bb761087de0e7194aeb7c187c4fb822a0f26451bf9500875ea1cb52c0` | Top vs Bottom | BW 1.21+ | PvT | Litmus 1.1 | baseline competitive |
| `tvp_long` | `28bc8cd833051ba74fd8c335ed4b27101f8dae5a2ff0bdbdfb376ddcf422e841` | Top vs Bottom | BW 1.21+ | PvT | Polypoid 1.75 | baseline competitive |
| `tvt_mid` | `7c37903c73d51be5a0ef416b8619c3a31b8d537726d0a675b6e6f33953ceb009` | Top vs Bottom | BW 1.21+ | TvT | Pole Star 1.0 | baseline competitive |
| `tvt_long` | `c2a1aba3eeba70bcc3eac249681ff15297ece25ff22e6a039e06eee5fb4aec41` | Top vs Bottom | BW 1.21+ | TvT | Radeon 1.2 | baseline competitive |
| `pvz_mid` | `2afed7db16517c10cdcc5908464981378fd42da954572a8595d5e007a00ede23` | Top vs Bottom | BW 1.21+ | PvZ | Neo Sylphid 3.2 | baseline competitive |
| `pvt_mid` | `779481fbd1d08e659c672b929d9173326f52c27d4a498f034eeea3cd0d19af30` | Melee | BW 1.21+ | PvT | Litmus 1.1 | baseline competitive |
| `pvt_long` | `c380b6f260a857fb6d0878c26604a5156c03d0bb4c54fa8ccf44e121b0bf9644` | Top vs Bottom | BW 1.21+ | TvP | Radeon 1.2 | baseline competitive |
| `pvp_mid` | `34116743f4cfb929bc0641a48e7226d93b6e5f44cd8f55fcb7673eba8c8d3899` | Top vs Bottom | BW 1.21+ | PvP | Pole Star 1.1 | baseline competitive |
| `pvp_long` | `19b08d9ecbe948e857b48909b2c6b6020878200d7b258b7c081c7dd79cdab6d3` | Top vs Bottom | BW 1.21+ | PvP | Radeon 1.2 | baseline competitive |

Raw type totals are 3 Melee, 14 Top vs Bottom, and 2 Use Map Settings.
Therefore the policy split is 17 baseline competitive/Melee-style and 2 UMS,
with no other nonstandard game type.

Two of the three incomplete SCR action fixtures are UMS: `zvt_mid` and
`tvz_mid`. The third, `pvt_mid`, is literal Melee. The defect is therefore
overrepresented in this tiny UMS sample but is not UMS-specific. Excluding UMS,
the v0.1.2 unexplained-defect count changes from 9/19 (47.4%) to 7/17 (41.2%):
9 exact, 1 accepted-only, and 7 unexplained among baseline fixtures. The
existing `bwf-uf2` issue must remain a general SCR replay-execution issue because
its Melee fixture still fails; its two UMS cases should be interpreted only as
UMS compatibility evidence.

### Three formerly silent fixtures

All three production JSONL files contain non-initial economy and production.
At frame 1,000 their `(minerals, completed workers)` values are exactly the
upstream v0.1.2 regression expectations:

| Replay | Owners | Frame-1,000 values | Final frame / stop | Build orders Shield / bwsim | Result |
|---|---|---|---|---:|---|
| `zvt_mid` | 0 / 3 | `(84, 5)` / `(60, 5)` | 21,949 / PlayerLeave+1 | 421 / 22 | actions execute partially; not conformant |
| `tvz_mid` | 0 / 1 | `(60, 5)` / `(76, 5)` | 11,950 / header | 154 / 27 | actions execute partially; not conformant |
| `pvt_mid` | 0 / 1 | `(26, 7)` / `(42, 6)` | 11,819 / header | 103 / 71 | actions execute partially; not conformant |

Each replay was then rerun through the production backend into a separate output
root. For all three, JSONL bytes, semantic manifest, and every player ZIP member
were identical across runs.

The downstream classification is:

| Replay | Build order | Supply | Economy without gathered counters | Unit counts without Scanner Sweep | Deaths without Scanner Sweep | Player metadata | Legacy manifest |
|---|---|---|---|---|---|---|---|
| `zvt_mid` | 404 missing events; 5 extras | differs | minerals, gas, and workers differ | differs | differs | exact | duration differs due accepted PlayerLeave+1 stop |
| `tvz_mid` | 132 missing events; 5 extras | differs | minerals, gas, and workers differ | differs | differs | exact | exact |
| `pvt_mid` | 39 missing events; 7 extras | differs | minerals, gas, and workers differ | differs | differs | exact | duration differs because ShieldBattery emits header+1 |

These differences are not reducer filtering or formatting differences. The
simulated economy/composition already differs, so v0.1.2 has corrected only the
initial UnitId failure mode, not full replay action execution.

### v0.1.2 per-replay results

The same selection, production commands, reducer, comparator, and intentional
transformations from the original run were used. Timing cells are
extraction/reduction/total seconds.

| Replay | Matchup | Header | Final Shield / bwsim | bwsim stop | Shield E/R/T | bwsim E/R/T | Classification |
|---|---:|---:|---:|---|---:|---:|---|
| `early_zvz_6` | ZvZ | 66 | 6 / 6 | player-leave | 12.6/0.0/12.6 | 2.3/0.0/2.8 | EXACT MATCH |
| `early_pvz_197` | PvZ | 224 | 197 / 197 | player-leave | 10.8/0.1/10.9 | 2.5/0.1/3.0 | EXACT MATCH |
| `early_pvz_622` | PvZ | 677 | 622 / 622 | player-leave | 12.6/0.3/12.9 | 3.4/0.1/3.9 | EXACT MATCH |
| `zvt_reference` | ZvT | 32937 | 32937 / 32937 | header | 149.8/137.1/286.9 | 267.1/35.3/302.9 | EXACT MATCH |
| `zvt_mid` | ZvT | 22012 | 22012 / 21949 | player-leave | 109.9/79.0/188.9 | 128.9/5.3/135.6 | BUG / UNEXPLAINED |
| `zvp_mid` | ZvP | 11983 | 11983 / 11983 | header | 55.6/21.1/76.7 | 51.1/6.3/58.0 | EXACT MATCH |
| `zvp_cap` | ZvP | 45017 | 43200 / 43200 | safety-cap | 209.9/229.0/438.9 | 521.5/56.1/578.1 | BUG / UNEXPLAINED |
| `zvz_long` | ZvZ | 34924 | 34846 / 34846 | player-leave | 143.9/109.5/253.4 | 265.0/34.8/300.3 | EXACT MATCH |
| `tvz_mid` | TvZ | 11950 | 11950 / 11950 | header | 52.0/23.6/75.6 | 32.1/2.8/35.3 | BUG / UNEXPLAINED |
| `tvz_long` | TvZ | 35044 | 35044 / 35044 | header | 172.6/158.8/331.4 | 468.4/43.9/512.7 | BUG / UNEXPLAINED |
| `tvp_mid` | TvP | 12312 | 12312 / 12312 | header | 52.2/18.7/70.9 | 49.4/5.9/55.7 | EXACT MATCH |
| `tvp_long` | TvP | 34506 | 34506 / 34296 | player-leave | 145.5/195.5/341.0 | 463.7/55.0/519.1 | BUG / UNEXPLAINED |
| `tvt_mid` | TvT | 12172 | 12172 / 12072 | player-leave | 60.2/27.3/87.5 | 103.2/7.3/111.0 | KNOWN INTENTIONAL DIFFERENCE |
| `tvt_long` | TvT | 34649 | 34649 / 34579 | player-leave | 166.6/192.6/359.2 | 422.3/53.6/476.4 | BUG / UNEXPLAINED |
| `pvz_mid` | PvZ | 21969 | 21969 / 21969 | header | 89.0/52.9/141.9 | 98.2/14.7/113.3 | EXACT MATCH |
| `pvt_mid` | PvT | 11819 | 11820 / 11819 | header | 51.4/16.8/68.2 | 34.3/4.1/38.9 | BUG / UNEXPLAINED |
| `pvt_long` | PvT | 33156 | 33156 / 33016 | player-leave | 159.8/185.0/344.8 | 399.5/53.2/453.2 | BUG / UNEXPLAINED |
| `pvp_mid` | PvP | 17242 | 17242 / 17242 | header | 80.3/42.2/122.5 | 141.3/11.8/153.6 | EXACT MATCH |
| `pvp_long` | PvP | 26726 | 26726 / 26726 | header | 112.3/93.7/206.0 | 173.9/25.9/200.2 | BUG / UNEXPLAINED |

Final artifact aggregate counts are also unchanged:

- build-order sets byte-identical: 13/19;
- supply sets identical: 10/19;
- economy sets identical after gathered-field removal: 12/19;
- unit-count sets identical after Scanner Sweep removal: 14/19;
- death sets identical after Scanner Sweep removal: 11/19;
- player metadata identical: 19/19 replays, all 38 players;
- legacy manifests identical: 13/19;
- production runs/reducers successful: 38/38, with no final crash, timeout,
  malformed output, or unsupported replay.

An interrupted outer test harness initially left several generated snapshot
files incomplete or associated with a subsequent ShieldBattery execution. Those
discarded test-run directories were not used for comparison or timing. Every
affected backend was rerun in isolation, its player roster was verified against
the pinned corpus, and the final 38 records above all completed successfully.

### Previously known smaller blockers

All four still reproduce unchanged:

1. **Supply cap:** the legacy maximum still exceeds 200 in `zvp_cap`,
   `tvp_long`, `tvt_long`, `pvt_long`, and `pvp_long` (7 player bundles). The
   three partially repaired replays also have supply differences caused by
   incorrect simulation, but those are distinct from the cap defect.
2. **Death categories:** 23 otherwise matching deaths still classify Observer
   or Devourer as `unit` instead of ShieldBattery's `air`: `zvp_cap` (5
   Observers), `tvz_long` (3 Devourers), `tvp_long` (7 Observers), `pvt_long`
   (6 Observers), and `pvp_long` (2 Observers).
3. **Construction backdating:** `tvz_long` still renders Control Tower at 12:13
   instead of 12:14; `tvt_long` still renders Comsat Station at 06:02 instead
   of 06:03. The `tvz_long` simultaneous same-second ordering difference also
   remains.
4. **ShieldBattery header+1:** `pvt_mid` still emits through frame 11,820 for a
   header end of 11,819; bwsim includes and stops at frame 11,819.

### v0.1.2 performance

Seconds across the 19 isolated final runs:

| Backend | Phase | Min | Median | Max |
|---|---|---:|---:|---:|
| ShieldBattery | extraction (derived) | 10.79 | 89.04 | 209.88 |
| ShieldBattery | Python reduction | 0.00 | 52.90 | 229.00 |
| ShieldBattery | total | 10.89 | 141.94 | 438.88 |
| bwsim | extraction | 2.33 | 128.88 | 521.49 |
| bwsim | Python reduction | 0.00 | 11.80 | 56.10 |
| bwsim | total | 2.76 | 135.64 | 578.08 |

bwsim again has a slightly lower median total and a materially worse long-game
tail. Extraction dominates bwsim; its JSONL reducer phase remains substantially
faster. No optimization was attempted.

### Validation

- Upstream v0.1.2 suite: 21/21 passed, including the three SCR regression
  fixtures, native SCR byte-identity control, and LastReplay byte-identity
  control.
- BW Forge CLI suite: 12/12 passed.
- BW Forge full test script: CLI 12/12, desktop 52/52, corpus-query 49/49.
- Repository typecheck: passed for root, desktop, and corpus-query packages.
- Three repaired production reruns: JSONL byte-identical, ZIP members exact,
  and manifests semantically exact across reruns.

### Updated decision answers

1. **Replays compared:** 19, with 38 successful final production runs.
2. **Exact parity after intentional field removal:** 9.
3. **Known/acceptable-only differences:** 1 (`tvt_mid`, PlayerLeave+1).
4. **Unexplained-defect replays:** 9.
5. **Silent no-action symptom:** removed, but all three affected replays remain
   materially incorrect under v0.1.2.
6. **Other four blockers:** all still reproduce on the same fixtures.
7. **Default-backend decision:** no. The partial replay-execution failure in
   `zvt_mid`, `tvz_mid`, and `pvt_mid` remains the highest-priority blocker;
   the four smaller defects also remain open.

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

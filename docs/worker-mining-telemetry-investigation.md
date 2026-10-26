# Worker telemetry for mining opportunity-cost analysis

Investigation only, 2026-10-26. Inspected BW Forge `ec07cc1` and the checked-in runtime. No feature or production-code changes.

## Finding

BW Forge can support this analysis with an additional worker observation stream, but **current report artifacts cannot reconstruct mining interruptions reliably**. Per-frame identities and positions already exist. Orders, worker cargo, mineral/depot targets, and builder associations are missing from the established wrapper. Preserving more existing HUD fields alone does not solve that gap. A documented engine observation interface, or a separately validated decoder for the pinned binary, is the prerequisite for reliable activity classification.

The simulation binary is hash-pinned, not source-revision-pinned: [VENDORED.md](../third_party/bwsim/VENDORED.md) records wrapper baseline `d8a1015464afbab9fc1d3d7426fc7e8952ce5e85` and an engine revision that is not established. The upstream repository contains the host wrapper, not the engine implementation. Consequently, internal worker fields cannot be asserted from game mechanics or from unrelated engine source. The [upstream host contract](https://github.com/Gooseheaded/headless-bwsim/blob/d8a1015464afbab9fc1d3d7426fc7e8952ce5e85/bwsim_host_contract.md) explicitly leaves raw snapshot layouts unestablished.

## 1. Capability matrix

Local evidence abbreviations: **W** = [wrapper](../third_party/bwsim/dist/bwsim.js), especially `units()` (256), `unitInstanceId()` (207), `connectedUnitId()` (213), `unitBuildQueue()` (219); **T** = [unit/player types](../third_party/bwsim/dist/types.d.ts); **E** = [exporter](../apps/cli/src/bwsim-backend.ts), `captureBwsimSnapshot()` (216), `toLegacyUnitRecord()` (336). Numbers are starting lines in the inspected revision.

| Required observation | Established runtime/wrapper support | Current export and gap |
|---|---|---|
| Stable SCV identity | W returns generation-bearing native IDs; HUD slot `index` alone is reusable. | E retains identity, translates to replay-local IDs where necessary; keeps native IDs for live-set comparison. New cross-references must use one explicit namespace. |
| Owner/player | T exposes owner; `replayHeader()` maps slots to player metadata. | Retained in owner groups and unit records. |
| Position/movement | T/W expose x/y, hidden status, facing and target coordinates. Movement follows from position changes; intent does not. | E retains x/y, drops hidden/facing/target coordinates. |
| Orders, targets, transitions | No established current-order ID, order-state, or target-unit field in T/W. Target coordinates are not target identity or intent. | Absent. Order transitions cannot be recovered from positions. |
| Approach/gather/return/deposit | No documented gathering phase, mineral target, depot target, or per-worker deposit event. | Absent. Bank changes mix income, spending and refunds. |
| Carried minerals/gas | No established worker cargo accessor. T's `resources` is not proven worker cargo. | Absent; do not interpret the binary export named `bw_unit_cargo` as mineral cargo. |
| Construction building | Building identity, position, completion and remaining/total build time are available. | Retained. First appearance/progress/completion are observations; build-order start times are derived. |
| Constructing SCV, interruption/resumption | No established builder link/current construction order. `connectedUnitId()` exists, but [validated semantics](bwsim-connected-unit.md) concern Larva parents, not SCV builders. | Connected ID is not called by E. Paused building progress alone cannot identify which SCV left or returned. |
| Build command before building exists | `replayData()` retains raw REP/converted DRPL bytes. No structured worker-command stream. Five-slot production queue is not an SCV order queue. | E inspects DRPL only for its leave heuristic (`findStandalonePlayerLeaveFrame`, 173). Issuance, queued activation, rejection and execution are distinct. |
| Creation/death | First/last live observations can be compared using generation IDs. No explicit lifecycle callback in W. | E emits disappearance as death (287); first appearance is implicit. Starts at frame 1, with no initial frame-0 baseline. Hidden/transport/removal behavior needs validation before every disappearance is called death. |
| Mineral patch identity/position/resources | Directly available through W plus `unitInstanceId()`; verified by the probe below. | E drops `resources`; moreover it skips an entire owner group if any unit is a geyser (254–257), normally excluding neutral mineral patches too. |
| Base association and active miners/base | Depot positions/types exist; patches are readable. No worker-to-patch/depot relationship or semantic base ID is established. | No base assignment or active-miner counts. `completedWorkers` counts all completed workers. |

**Binary versus wrapper evidence.** Node 24.5.0 compiled the checked-in patched Wasm and verified SHA-256 `f2bad72acbcd5d3c1d97506f05cbd370fde94a70a853cd3f59340a648db626ac`. Its export inventory includes `bw_units`, `bw_unit_snapshot_size`, `bw_unit_count`, `bw_unit_cargo`, `bw_player_selection` and `bw_recent_clicks`, beyond W's bound interface. Investigation probes found 456-byte raw records and 150 records at frame 0. Their field layout is not a supported contract. `bw_unit_cargo` disassembly emits linked 8-byte entries containing an identifier and small value; that suggests contained-unit cargo, but its semantics remain unverified. None of this establishes accessible worker orders or carried minerals. The upstream [wrapper source](https://github.com/Gooseheaded/headless-bwsim/blob/d8a1015464afbab9fc1d3d7426fc7e8952ce5e85/src/bwsim.ts) and local W are the verified integration boundary.

**Resource probe.** Loading `fixtures/replays/191104,(4)KnockOut1.4.rep` through local `Bwsim.create()`/`loadReplay()` returned 150 units, 4 SCVs and 12 geysers at frame 0. `units()` returned mineral type 176, owner 11, slot 3265, generation ID 11458, position `(64,240)`, `resources=1500`. This proves patch data is accessible before E filters it; it does not validate worker activity or cargo semantics.

## 2. Pipeline trace

1. [CLI `analyzeReplay`](../apps/cli/src/main.ts), lines 240–299, runs the [Node exporter entry point](../apps/cli/src/bwsim-exporter.ts), then Python. Raw JSONL is removed by default; `--keep-snapshots` preserves it.
2. E's `exportBwsimTimeline()` (86) calls `step(1)` and writes `sb-unit-timeline-v2` for frames 1 through its terminal frame. Its unit projection preserves ID/type/owner/position/completion/build queue/build timers/research only. `resolveBwsimTermination()` (151) can stop at header end, the 43,200-frame cap, or the player-leave heuristic. Coverage must report the actual stop, not assume the entire match was simulated.
3. [Python `analyze_timeline()`](../packages/legacy-replay-analysis/replay_analysis.py) (967) reduces JSONL into economy, supply, unit counts, deaths and build/technology events. `Analyzer._unit_events()` (269) uses IDs for type/queue/event tracking but does not retain worker histories. `backdated_frame()` (486) estimates build starts from timers; these are not observations of a worker's departure. JSON parsing accepts additive keys, but analysis does not preserve unused keys.
4. `economy_payload()` (1198) produces `replay-analysis-economy-v1`: owner/race and samples with frame/time, minerals/gas, optional gathered counters and total `workers`. The bwsim producer omits gathered counters. This contract has neither mining-worker counts nor base IDs. `player_bundle_files()` (1300) writes six ZIP members: `player.json`, `build_order.txt`, `economy.json`, `supply.json`, `unit_counts.json`, `deaths.json`. Live IDs/positions disappear; death records retain the last unit identity/position. `embedded_dataset_files()` (1270) gives standalone HTML the same datasets.
5. Current [Corpus v2 importer](../packages/corpus-store/python/store.py) (101–176, 302–353) hashes every ZIP member but parses only the known streams. [Sparse economy import](../packages/corpus-store/python/sparse.py), `FIELDS` (12) and `import_economy()` (83), stores changed full economy tuples with coverage; it does not retain workers individually. [Schema](../packages/corpus-store/python/schema.sql) (53–81) restricts coverage to builds/economy/supply/composition/deaths. No worker, patch or base stream exists. Older [TypeScript ingestion](../packages/corpus-query/src/ingest/manifest.ts) likewise maps aggregate economy samples to `economy_samples`; adding a ZIP member alone does not make it queryable.
6. [Standalone UI](../apps/sc-forge/build-order.override.js) reads the six known files (1249), normalizes only aggregate economy fields in `parseEconomyPayload()` (1406), and renders economy/hover data (1830, 2141). Missing gathered counters currently become zero; a new loss stream must explicitly represent unavailable data. The future heat bar needs a new reducer-produced dataset and cannot be computed from current HTML alone.

## 3. Smallest sufficient telemetry extension

Keep legacy `sb-unit-timeline-v2` semantics intact. Add a separately versioned, optional worker-observation sidecar. Merely adding positions/resources to the old record is useful groundwork, but insufficient for the requested feature.

| Proposed observation | Purpose / availability |
|---|---|
| Header: schema, replay hash, Wasm/asset hashes, ID namespace, frame clock, sampling phase, coverage and termination | Reproducibility and explicit missing data. Include frame 0 and terminal state. |
| Worker baseline/deltas: native generation ID, owner/type/completion/hidden, x/y | Already accessible. Include all live SCVs, including newly created, reassigned and initially present workers. |
| Raw current order ID/state, target unit ID and target position; intended build type/site before the building exists | Requires a documented accessor or validated raw decoder. Distinguishes mineral-cycle activity, construction travel, repair/combat and ordinary movement. Preserve raw values alongside downstream classifications. |
| Carried resource kind/amount; mining resource target and return depot ID; construction building ID when resolved | Requires validation/addition. Retain distinct fields if ordinary order target does not preserve the mining assignment during return or construction phases. Unknown and no target must differ. |
| Resource/depot baseline and changes: ID, type, owner, x/y, remaining resource amount; depot completion and usable/lifted state | Patches and most depot fields already accessible. Depot usability/lifted semantics need verification. Export resources outside the filtered owner groups. |
| Lifecycle records with first-seen/removal reason where available; explicit terminal coverage | Do not fabricate birth before observation, death from loss of visibility, or return-to-mining after coverage ends. |

Observe resolved worker state every simulation frame; emit complete baselines and lossless state changes with positions at changes. Position changes may still occur almost every frame. Compress serialization rather than reduce the temporal resolution of order/cargo transitions. Add raw issued/accepted command events only where pre-activation queued intent must be retained; record frame, sequence, affected worker IDs, queue flag, type/site/target and outcome when known. A build order active during travel is enough to detect departure; a queued command's issuance time is not departure. Frame snapshots cannot preserve multiple within-frame commands, so that stronger requirement needs engine command events.

Prefer a documented compact bulk worker accessor over reverse engineering the complete 456-byte structure. If maintaining a local decoder is chosen, pin it to the exact Wasm hash and validate each used offset/enum against controlled fixtures. An unvalidated decoder is not a supported shortcut. No source-level engine patch can presently be specified against an established engine revision.

Cost: sampling is already per frame; additional extraction/diffing is O(live workers + changed resources), with memory proportional to live state. Full raw snapshots cost O(all units × frames); 100 workers over the existing cap produce 4.32 million worker-frame observations before compression. Bulk reads and reused buffers avoid per-field Wasm calls. Measure bytes, CPU and memory on long/high-worker replays before selecting checkpoints or optional position downsampling. Read accessors must not advance frames, alter RNG, issue commands or change simulation state. Compare enabled/disabled replay outcomes and repeat hashes as a future conformance gate.

## 4. Reliability and loss model

“Exact” should mean an observed state transition at the declared frame boundary in the pinned simulation, not proof of original-game parity or exact within-frame timing. Current identity, position and building completion observations meet that narrower definition. Current artifacts cannot establish mining departure, construction travel, return-to-mining, previous mining base, or concurrent miners there.

Validated order/cargo/target telemetry could support reconstruction of mineral-cycle participation including approaching a patch, gathering, waiting in its queue, carrying minerals, and returning/depositing. Those phases are productive participation even when no mineral is deposited that frame. Separate that from measured deposits. A stopped or stationary unit is not automatically idle; use order semantics and preserve `unknown` for ambiguity. Repair, combat, gas mining and ordinary movement need distinct classifications, even if grouped for display.

Associate a worker with its observed patch and deposit depot, then map patches/depots into bases. Actual target/deposit relationships are stronger evidence than nearest-base geometry; semantic base grouping and a departed worker's hypothetical future assignment remain inferred. Count completed workers participating in the mineral cycle, not all completed workers or only workers currently harvesting. Retain assignment changes so births, deaths, transfers and depletion change the base count during an interruption.

For a worker absent from base b, integrate the marginal rate over intervals where counts and resource configuration are constant:

`loss = sum(delta_seconds * [R_b(n + 1, patches) - R_b(n, patches)])`

Here `n` is the number of other active mineral workers, and `R_b` is an explicitly versioned estimated total income curve. Split at every relevant count, patch/depot, category and assignment change. Use the repository's 42 ms/frame convention (`replay_analysis.py:22`, `sparse.check_samples()`), and normalize benchmark units consistently. For k simultaneous absences, total opportunity cost is `R_b(n+k)-R_b(n)`; summing k identical single-worker marginals can overcount near saturation. Declare an allocation policy (for example equal shares per interval) when assigning that total to workers/categories.

The requested [Liquipedia saturation source](https://liquipedia.net/starcraft/Mining#Saturation) returned HTTP 403 during this investigation. No numeric rates were verified or adopted. Benchmark patch geometry, worker counts and time units must be recorded before calibration. Even with verified benchmarks, forgone income remains a counterfactual estimate; actual bank deltas cannot validate individual loss directly.

| Edge case | Required interpretation |
|---|---|
| Queued/rejected/cancelled build | Keep issuance separate from execution. Start interruption when mineral participation actually ends; an unexecuted queued build costs no observed travel time. |
| Construction paused/resumed or another builder takes over | Use worker-to-building links and activity transitions. Split intervals by worker and category; building elapsed time is not one SCV's construction time. |
| Worker transfer/new mining base | End the observed interruption when productive mineral participation resumes anywhere; retain prior and new base. Do not label all transfer travel as building return. |
| Death or never returning | End at confirmed death or coverage end; label terminal censoring. Do not charge indefinitely or invent a return trip. |
| Gas reassignment, depletion, lifted depot, transport/hidden state | Use explicit targets/lifecycle/usability observations; split assignments or mark unknown. Cargo disappearance alone is not proof of a deposit. |
| Overlapping activities/uncertain cause | Keep mutually exclusive observed activity intervals and separate causal attribution/confidence. A later repair/combat detour is not automatically construction loss. |

## 5. Implementation boundaries

- **bwsim and TypeScript exporter:** expose versioned raw facts, stable cross-references, sampling/coverage and provenance. No saturation rates, base heuristics or opportunity-cost calculation.
- **Python reducer:** preserve lossless worker observations in a durable artifact; derive activity/base assignments and interruption intervals with evidence/confidence; integrate a versioned marginal-rate model over changing counts. Emit compact time-series/category summaries for display.
- **Player bundles/corpus:** add an optional versioned worker artifact and report summary; absent means unavailable. Preserve raw observations for reclassification without re-simulation. Add coverage-aware worker/interval storage only with an explicit corpus schema evolution, since today's coverage constraint rejects new stream names. Retain model/input provenance and avoid changing `economy-v1` field meanings.
- **Standalone UI:** render supplied interval/heat-bar summaries; hover shows observed duration, estimated minerals, category, base and confidence/coverage. Keep unknown coverage distinct from zero loss. Avoid recomputing simulation or economic assumptions in the browser.

## 6. Material open decisions

1. Can the engine owner provide a documented worker-state ABI and source/build provenance, or must BW Forge own a hash-specific raw-snapshot decoder? This determines implementation feasibility and maintenance cost.
2. Is frame-boundary resolved activity sufficient, or is queued command issuance/within-frame ordering a required artifact? The latter needs a command event interface.
3. What defines a base, and what counterfactual assignment ends construction attribution after transfers, combat detours or failure to return? Choose an explicit censoring/attribution policy.
4. Which verified saturation curve, patch geometry normalization and concurrent-loss allocation policy should be versioned? These determine the estimate, not the observations.

Investigation completion does not establish the missing ABI. A future implementation should first validate mining cycles/deposits, building travel/start/pause/resume/completion, queued/cancelled orders, transfers/deaths/hidden workers, resource depletion and deterministic repeatability against fixtures. Existing build-event parity tests do not cover these semantics.

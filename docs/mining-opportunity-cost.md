# Mining opportunity-cost calculator (M2)

M2 is a pure Python calculator for estimating mineral income forgone while
explicitly supplied workers are absent from productive mining. It operates on
synthetic timelines; it does not parse replays, infer activity, identify bases,
or access bwsim, SQLite, or report rendering.

The implementation is in `packages/legacy-replay-analysis/mining_opportunity_cost.py`.
Its public input types are `FrameInterval`, `BaseEconomicInterval`, and
`WorkerAbsence`. All intervals use half-open frame boundaries, `[start, end)`,
and frames use BW Forge's 42 ms convention (`0.042` fastest-replay-seconds per
frame). A base economic interval supplies its active mineral-worker count and
available patch count. An absence supplies an ID, base assignment, category,
and interval. The caller, rather than M2, decides which absences have a valid
mining counterfactual.

```python
from mining_opportunity_cost import (
    BaseEconomicInterval, FrameInterval, WorkerAbsence,
    calculate_opportunity_cost,
)

coverage = FrameInterval(0, 1_000)
result = calculate_opportunity_cost(
    [BaseEconomicInterval("main", 0, 1_000, 24, 9)],
    [WorkerAbsence("scv-1", "main", "construction", 100, 600)],
    coverage,
)
print(result.total_loss, result.loss_by_worker["scv-1"])
```

For a single SCV absent for 500 frames at a 24-worker, nine-patch base, the
printed result is approximately `13.6111111111` minerals. The interval lasts
21 seconds, and M1's rate difference is `R(25, 9) - R(24, 9)`.

The calculator sweeps the sorted union of coverage, economic-state, and
absence boundaries. For each resulting segment it evaluates M1's aggregate
counterfactual loss,

`R(active_workers + eligible_absences, patches) - R(active_workers, patches)`,

and multiplies that rate by segment duration. It therefore handles changing
worker counts, patch counts, overlapping absences, category changes, partial
coverage, and multiple independent bases without iterating once per replay
frame. Input intervals are validated globally, including intervals outside the
requested coverage. Same-base economic states and same-worker absences may not
overlap; every base named by an input must have complete economic coverage over
the non-empty evaluation window.

The sweep is performed per base. It sorts the event boundaries and updates the
active economic state and absence set at each boundary, so work scales with the
number of input events (`O(E log E)` for sorting, plus sorting and emitting
worker/category allocations within each segment), rather than with the
replay's frame span. A base must have
economic state for the whole requested coverage even when it has no absences;
this makes an omitted state distinguishable from a valid zero-loss base.

The nonlinear aggregate loss is allocated equally among the eligible absent
workers in each segment. Category totals are sums of those worker shares. This
is an accounting policy for conservation, not a claim that every SCV would
have produced the same minerals. The result preserves segment-level worker and
category detail, aggregate totals by base, worker, and category, and model
metadata (`model_version`, `clock`, and `seconds_per_frame`). A zero rate or
zero total is valid; missing economic state, malformed intervals, invalid
counts, conflicting assignments, non-finite values, and incompatible clocks
raise input errors. `MissingEconomicStateError` specifically distinguishes
unavailable economic data from a valid zero-loss result.

The result exposes `model_version`, `clock`, `seconds_per_frame`, `coverage`,
`total_loss`, immutable `loss_by_base`, `loss_by_worker`, and
`loss_by_category` mappings, and ordered `segments`. Each segment contains
`start_frame`, `end_frame`, `base_id`, `active_workers`, `absent_workers`,
`patch_count`, `loss_rate`, `loss`, and per-worker and per-category allocation
detail. Cumulative loss through any frame boundary can be reconstructed by
summing complete segments and, for a boundary inside one segment, adding
`(boundary - segment.start_frame) * seconds_per_frame * segment.loss_rate`;
the same proportional calculation applies to that segment's worker/category
detail. Zero-loss segments retain their zero worker/category allocations.

For example, at nine patches with M1's 24 active workers and three eligible
builders, the aggregate rate is `R(27, 9) - R(24, 9)`, approximately
116.67 minerals/minute. At 27 active workers, adding three absences remains at
the saturation cap and produces zero. A 1,000-frame interval lasts 42 seconds;
all results use minerals per fastest-replay-second and deterministic floating
arithmetic. Consumers should compare conservation totals with a small
floating-point tolerance of `abs_tol=1e-9` and `rel_tol=1e-9`. The 116.67 figure is a
rate in minerals per minute; it is not the loss over a 42-second interval.

The following values are independently calculated from M1's published curve
for a 1,000-frame (42-second) interval:

| Active miners, absent workers | Patches | Expected forgone minerals |
|---:|---:|---:|
| 8 + 1 | 9 | 45.5 |
| 24 + 1 | 9 | 27.2222222 |
| 24 + 3 | 9 | 81.6666667 |
| 26 + 3 | 9 | 27.2222222 |
| 27 + 3 | 9 | 0 |
| 24 + 1 | 0 | 0 |

The model argument must be an instance of `MineralSaturationModel`; its
callable `rate(worker_count, patch_count)`, non-empty `version`, and matching
`clock` (`fastest-replay-second`) are validated. Counts and frame boundaries are integers in
`[0, 10**12]`; the calculator also rejects a counterfactual `n + k` that would
exceed M1's supported bound, and rejects non-finite or overflowing model rates.
The evaluation interval may be empty, in which case validated inputs produce
an empty, zero result. Economic and absence records themselves must remain
non-empty intervals; an empty non-empty-coverage call with no economic scope
is rejected as missing data. Categories are arbitrary non-empty strings, and
zero-valued categories remain present in segment detail where applicable.

M2 intentionally leaves worker telemetry, base geometry, eligibility inference,
activity reconstruction, and report visualization to later milestones. M3 can
adapt worker observations into these synthetic contracts, while M6 can supply
the explicit interruption and counterfactual decisions without changing the
economic integration or allocation logic. M3 must preserve stable worker/base
identities, explicit coverage, and the 42 ms clock. M6 must exclude eligible
absentees from observed active-miner counts and supply mutually exclusive
categories and base assignments; unknown activity or missing coverage must not
be converted into zero loss. Clip censored interruptions to known coverage
without inventing a return to mining.

These are model estimates, not observed resource deposits. M2 inherits M1's
density scaling, saturation cap, and calibration uncertainty; it does not
model patch geometry, pathing, or each worker's individual productivity. See
[the calibration notes](mineral-saturation-calibration.md). Alternative
allocation policies can replace the isolated `_equal_allocation` helper;
only equal allocation is implemented in M2.

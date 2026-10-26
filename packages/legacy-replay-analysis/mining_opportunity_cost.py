"""Pure, synthetic mining opportunity-cost integration (M2).

The module intentionally knows nothing about replay telemetry.  Callers supply
frame-based economic states and explicitly eligible worker interruptions.  A
half-open sweep integrates M1's total-rate counterfactual over changes in either
input and allocates each segment's nonlinear loss equally among its workers.
"""

from __future__ import annotations

from dataclasses import dataclass
import math
from types import MappingProxyType
from typing import Mapping, Sequence

from mineral_saturation import DEFAULT_MODEL, MineralSaturationModel

SECONDS_PER_FRAME = 0.042
_MAX_COUNT = 10**12


class OpportunityCostInputError(ValueError):
    """Raised when a supplied timeline is malformed or ambiguous."""


class MissingEconomicStateError(OpportunityCostInputError):
    """Raised when a base has no economic state for part of the coverage."""


def _frame(value: object, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0 or value > _MAX_COUNT:
        raise OpportunityCostInputError(f"{name} must be a nonnegative integer")
    return value


def _count(value: object, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0 or value > _MAX_COUNT:
        raise OpportunityCostInputError(f"{name} must be a nonnegative integer")
    return value


def _text(value: object, name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise OpportunityCostInputError(f"{name} must be a non-empty string")
    return value


def _range(start: int, end: int, name: str, *, allow_empty: bool = False) -> None:
    _frame(start, f"{name}.start_frame")
    _frame(end, f"{name}.end_frame")
    if end < start or (end == start and not allow_empty):
        raise OpportunityCostInputError(f"{name} must be a non-empty half-open interval")


@dataclass(frozen=True, slots=True)
class FrameInterval:
    """Half-open replay-frame coverage interval ``[start_frame, end_frame)``."""
    start_frame: int
    end_frame: int

    def __post_init__(self) -> None:
        _range(self.start_frame, self.end_frame, "coverage", allow_empty=True)


@dataclass(frozen=True, slots=True)
class BaseEconomicInterval:
    """Economic state for one base, constant over a half-open frame interval."""
    base_id: str
    start_frame: int
    end_frame: int
    active_workers: int
    patch_count: int

    def __post_init__(self) -> None:
        _text(self.base_id, "base_id")
        _range(self.start_frame, self.end_frame, "economic interval")
        _count(self.active_workers, "active_workers")
        _count(self.patch_count, "patch_count")


@dataclass(frozen=True, slots=True)
class WorkerAbsence:
    """Caller-declared eligible worker absence and its accounting category."""
    worker_id: str
    base_id: str
    category: str
    start_frame: int
    end_frame: int

    def __post_init__(self) -> None:
        _text(self.worker_id, "worker_id")
        _text(self.base_id, "base_id")
        _text(self.category, "category")
        _range(self.start_frame, self.end_frame, "worker absence")


@dataclass(frozen=True, slots=True)
class OpportunityCostSegment:
    """One constant-state integration segment and equal-share attribution."""
    start_frame: int
    end_frame: int
    base_id: str
    active_workers: int
    absent_workers: int
    patch_count: int
    loss_rate: float
    loss: float
    worker_losses: tuple[tuple[str, float], ...] = ()
    category_losses: tuple[tuple[str, float], ...] = ()


@dataclass(frozen=True, slots=True)
class OpportunityCostResult:
    """Immutable calculator output with model provenance and reporting totals."""
    model_version: str
    clock: str
    seconds_per_frame: float
    coverage: FrameInterval
    total_loss: float
    loss_by_base: Mapping[str, float]
    loss_by_worker: Mapping[str, float]
    loss_by_category: Mapping[str, float]
    segments: tuple[OpportunityCostSegment, ...]


def _freeze(mapping: Mapping[str, float]) -> Mapping[str, float]:
    return MappingProxyType(dict(sorted(mapping.items())))


def _validate_model(model: MineralSaturationModel, clock: str) -> tuple[str, str]:
    if not isinstance(model, MineralSaturationModel):
        raise OpportunityCostInputError("model must be a MineralSaturationModel")
    version = getattr(model, "version", None)
    model_clock = getattr(model, "clock", None)
    rate = getattr(model, "rate", None)
    _text(version, "model.version")
    _text(model_clock, "model.clock")
    _text(clock, "clock")
    if model_clock != clock or clock != "fastest-replay-second" or not callable(rate):
        raise OpportunityCostInputError("incompatible clock convention or invalid model")
    return version, clock


def _validate_nonoverlap(intervals: Sequence[tuple[int, int]], name: str) -> None:
    ordered = sorted(intervals)
    if any(start < previous_end for (_, previous_end), (start, _) in zip(ordered, ordered[1:])):
        raise OpportunityCostInputError(f"overlapping {name} intervals")


def _coverage_complete(intervals: Sequence[BaseEconomicInterval], coverage: FrameInterval, base: str) -> bool:
    current = coverage.start_frame
    for item in sorted((x for x in intervals if x.base_id == base), key=lambda x: x.start_frame):
        if item.end_frame <= current:
            continue
        if item.start_frame > current:
            return False
        current = item.end_frame
        if current >= coverage.end_frame:
            return True
    return current >= coverage.end_frame


def _equal_allocation(total: float, absences: Sequence[WorkerAbsence]) -> tuple[tuple[tuple[str, float], ...], tuple[tuple[str, float], ...]]:
    """Allocate one segment's aggregate loss equally, without economic logic."""
    workers = tuple(sorted(absences, key=lambda x: x.worker_id))
    if not workers:
        return (), ()
    if total == 0.0:
        worker_detail = tuple((x.worker_id, 0.0) for x in workers)
        return worker_detail, tuple((category, 0.0) for category in sorted({x.category for x in workers}))
    share = total / len(workers)
    worker_detail = tuple((x.worker_id, share) for x in workers)
    categories: dict[str, list[float]] = {}
    for item in workers:
        categories.setdefault(item.category, []).append(share)
    return worker_detail, tuple((category, math.fsum(amounts)) for category, amounts in sorted(categories.items()))


def calculate_opportunity_cost(
    economic_intervals: Sequence[BaseEconomicInterval],
    absences: Sequence[WorkerAbsence],
    coverage: FrameInterval,
    *,
    model: MineralSaturationModel = DEFAULT_MODEL,
    clock: str = "fastest-replay-second",
) -> OpportunityCostResult:
    """Integrate supplied counterfactual absences over a frame-based timeline.

    Economic states and absences are half-open replay-frame intervals. Rates are
    minerals per fastest-replay-second and are integrated using 0.042 seconds
    per frame. The caller supplies eligibility; this function does not infer
    mining intent. Malformed timelines raise :class:`OpportunityCostInputError`
    and incomplete economic coverage raises :class:`MissingEconomicStateError`.
    """
    if not isinstance(coverage, FrameInterval):
        raise OpportunityCostInputError("coverage must be a FrameInterval")
    try:
        economics = tuple(economic_intervals)
        interruptions = tuple(absences)
    except TypeError as error:
        raise OpportunityCostInputError("interval inputs must be iterable") from error
    if any(not isinstance(x, BaseEconomicInterval) for x in economics):
        raise OpportunityCostInputError("economic_intervals must contain BaseEconomicInterval values")
    if any(not isinstance(x, WorkerAbsence) for x in interruptions):
        raise OpportunityCostInputError("absences must contain WorkerAbsence values")
    version, normalized_clock = _validate_model(model, clock)
    # Economic states for different bases may overlap; only same-base overlap is
    # contradictory. Worker identities, in contrast, must never overlap.
    economics_by_base: dict[str, list[BaseEconomicInterval]] = {}
    for item in economics:
        economics_by_base.setdefault(item.base_id, []).append(item)
    absences_by_base: dict[str, list[WorkerAbsence]] = {}
    absences_by_worker: dict[str, list[WorkerAbsence]] = {}
    for item in interruptions:
        absences_by_base.setdefault(item.base_id, []).append(item)
        absences_by_worker.setdefault(item.worker_id, []).append(item)
    for base, items in economics_by_base.items():
        _validate_nonoverlap([(x.start_frame, x.end_frame) for x in items], f"economic state for {base}")
    for worker, items in absences_by_worker.items():
        _validate_nonoverlap([(x.start_frame, x.end_frame) for x in items], f"worker {worker}")

    bases = set(economics_by_base) | set(absences_by_base)
    if coverage.end_frame > coverage.start_frame:
        if not bases:
            raise MissingEconomicStateError("no economic state supplied for coverage")
        for base in sorted(bases):
            if not _coverage_complete(economics_by_base.get(base, ()), coverage, base):
                raise MissingEconomicStateError(f"missing economic state for base {base}")
    if coverage.start_frame == coverage.end_frame:
        return OpportunityCostResult(version, normalized_clock, SECONDS_PER_FRAME, coverage, 0.0, _freeze({}), _freeze({}), _freeze({}), ())

    by_base = {base: sorted(economics_by_base.get(base, ()), key=lambda x: x.start_frame) for base in bases}
    absences_by_base = {base: sorted(absences_by_base.get(base, ()), key=lambda x: (x.start_frame, x.end_frame, x.worker_id)) for base in bases}
    base_amounts: dict[str, list[float]] = {}
    worker_amounts: dict[str, list[float]] = {}
    category_amounts: dict[str, list[float]] = {}
    segments: list[OpportunityCostSegment] = []
    for base in sorted(bases):
        base_economics = by_base[base]
        base_absences = absences_by_base[base]
        events = {coverage.start_frame, coverage.end_frame}
        for item in base_economics + base_absences:
            if item.end_frame > coverage.start_frame and item.start_frame < coverage.end_frame:
                events.add(max(item.start_frame, coverage.start_frame))
                events.add(min(item.end_frame, coverage.end_frame))
        ordered_events = sorted(events)
        econ_index = 0
        active_by_worker: dict[str, WorkerAbsence] = {}
        absence_starts: dict[int, list[WorkerAbsence]] = {}
        absence_ends: dict[int, list[WorkerAbsence]] = {}
        for item in base_absences:
            if item.start_frame >= coverage.end_frame or item.end_frame <= coverage.start_frame:
                continue
            absence_starts.setdefault(max(item.start_frame, coverage.start_frame), []).append(item)
            absence_ends.setdefault(min(item.end_frame, coverage.end_frame), []).append(item)
        for start, end in zip(ordered_events, ordered_events[1:]):
            if end <= start:
                continue
            for item in absence_ends.get(start, ()):
                active_by_worker.pop(item.worker_id, None)
            for item in absence_starts.get(start, ()):
                active_by_worker[item.worker_id] = item
            while econ_index < len(base_economics) and base_economics[econ_index].end_frame <= start:
                econ_index += 1
            econ = base_economics[econ_index] if econ_index < len(base_economics) and base_economics[econ_index].start_frame <= start else None
            if econ is None:
                raise MissingEconomicStateError(f"missing economic state for base {base} at frame {start}")
            active = tuple(active_by_worker.values())
            k = len(active)
            if econ.active_workers + k > _MAX_COUNT:
                raise OpportunityCostInputError("counterfactual worker count exceeds supported range")
            if k:
                observed_rate = model.rate(econ.active_workers, econ.patch_count)
                counterfactual_rate = model.rate(econ.active_workers + k, econ.patch_count)
                if not isinstance(observed_rate, (int, float)) or not isinstance(counterfactual_rate, (int, float)):
                    raise OpportunityCostInputError("model rates must be finite numbers")
                loss_rate = float(counterfactual_rate - observed_rate)
                if not math.isfinite(loss_rate) or loss_rate < 0:
                    raise OpportunityCostInputError("model rates must produce finite nonnegative loss")
            else:
                loss_rate = 0.0
            duration = (end - start) * SECONDS_PER_FRAME
            loss = duration * loss_rate
            if not math.isfinite(loss):
                raise OpportunityCostInputError("segment loss is not finite")
            worker_detail, category_detail = _equal_allocation(loss, active)
            segment = OpportunityCostSegment(start, end, base, econ.active_workers, k, econ.patch_count, loss_rate, loss, worker_detail, category_detail)
            segments.append(segment)
            base_amounts.setdefault(base, []).append(loss)
            for worker, amount in worker_detail:
                worker_amounts.setdefault(worker, []).append(amount)
            for category, amount in category_detail:
                category_amounts.setdefault(category, []).append(amount)
    segments.sort(key=lambda x: (x.start_frame, x.end_frame, x.base_id))
    def aggregate(groups: Mapping[str, Sequence[float]]) -> dict[str, float]:
        result: dict[str, float] = {}
        for key, amounts in groups.items():
            try:
                value = math.fsum(amounts)
            except OverflowError as error:
                raise OpportunityCostInputError("loss aggregation overflowed") from error
            if not math.isfinite(value):
                raise OpportunityCostInputError("loss aggregation is not finite")
            result[key] = value
        return result

    try:
        total = math.fsum(segment.loss for segment in segments)
    except OverflowError as error:
        raise OpportunityCostInputError("total loss aggregation overflowed") from error
    if not math.isfinite(total):
        raise OpportunityCostInputError("total loss is not finite")
    return OpportunityCostResult(version, normalized_clock, SECONDS_PER_FRAME, coverage, total, _freeze(aggregate(base_amounts)), _freeze(aggregate(worker_amounts)), _freeze(aggregate(category_amounts)), tuple(segments))


__all__ = [
    "FrameInterval", "BaseEconomicInterval", "WorkerAbsence", "OpportunityCostSegment",
    "OpportunityCostResult", "OpportunityCostInputError", "MissingEconomicStateError",
    "calculate_opportunity_cost", "SECONDS_PER_FRAME",
]

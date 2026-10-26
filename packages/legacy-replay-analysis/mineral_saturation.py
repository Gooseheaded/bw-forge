"""Deterministic mineral-line capacity model.

This module deliberately contains no replay, simulator, or corpus dependencies.
``MineralSaturationModel.rate`` estimates a base's *total* mineral income rate;
it does not calculate opportunity cost. Rates are minerals per
``fastest-replay-second``: the repository's 42 ms/frame elapsed,
fastest-speed wall-clock-equivalent excluding pauses, lag, and offline
processing time, unless a calibration explicitly declares another clock.

The model is a piecewise-linear empirical curve measured for a reference number
of patches.  A base with ``p`` patches evaluates the curve at
``workers * reference_patches / p`` and scales the resulting total by
``p / reference_patches``.  This transparent normalization is useful for M2,
but does not model patch geometry or worker pathing.

The published calibration data lives in ``mineral_saturation_calibration``;
this module constructs the default model and exposes ``mineral_income_rate``.
"""

from __future__ import annotations

from dataclasses import dataclass
import math

from mineral_saturation_calibration import (
    FITTED_POINTS_PER_MINUTE,
    REFERENCE_PATCH_COUNT,
    SOURCE_VERSION,
)

MAX_COUNT = 10**12


class CalibrationError(ValueError):
    """Raised when calibration data cannot define a valid saturation curve."""


@dataclass(frozen=True, slots=True)
class CalibrationPoint:
    """One observed total rate for a reference mineral field.

    ``workers`` is the number of mineral workers and ``rate`` is minerals per
    second on the calibration's declared clock.
    """

    workers: int
    rate: float


@dataclass(frozen=True, slots=True)
class MineralSaturationModel:
    """Versioned, pure mineral-income capacity curve.

    Points must start at ``(0, 0)`` and have nonnegative, non-increasing
    slopes.  The final point is a saturation cap: worker counts beyond it do
    not increase the rate.  ``version`` and ``clock`` are provenance labels,
    not evaluation inputs, so equal models are deterministic.
    """

    version: str
    reference_patch_count: int
    points: tuple[CalibrationPoint, ...]
    clock: str = "fastest-game-second"

    def __post_init__(self) -> None:
        # A frozen dataclass does not freeze a list supplied by a caller. Take
        # a defensive immutable snapshot so later list mutation cannot change
        # a model's behavior or hash/equality semantics.
        try:
            points = tuple(self.points)
        except TypeError as error:
            raise CalibrationError("points must be an iterable of CalibrationPoint") from error
        object.__setattr__(self, "points", points)
        if not isinstance(self.version, str) or not self.version.strip():
            raise CalibrationError("version must be a non-empty string")
        if not isinstance(self.clock, str) or not self.clock.strip():
            raise CalibrationError("clock must be a non-empty string")
        if isinstance(self.reference_patch_count, bool) or not isinstance(
            self.reference_patch_count, int
        ) or not 0 < self.reference_patch_count <= MAX_COUNT:
            raise CalibrationError("reference_patch_count must be a positive integer")
        if not self.points:
            raise CalibrationError("at least one calibration point is required")
        previous: CalibrationPoint | None = None
        previous_slope: float | None = None
        for point in self.points:
            if not isinstance(point, CalibrationPoint):
                raise CalibrationError("points must contain CalibrationPoint values")
            if isinstance(point.workers, bool) or not isinstance(point.workers, int):
                raise CalibrationError("point workers must be integers")
            if isinstance(point.rate, bool) or not isinstance(point.rate, (int, float)):
                raise CalibrationError("point rates must be finite numbers")
            if point.workers < 0 or point.workers > MAX_COUNT:
                raise CalibrationError("point workers must be within the supported count range")
            try:
                point_rate = float(point.rate)
            except (OverflowError, ValueError) as error:
                raise CalibrationError("points must have finite nonnegative values") from error
            if not math.isfinite(point_rate) or point_rate < 0 or point_rate > float.fromhex("0x1.fffffffffffffp+1023") / MAX_COUNT:
                raise CalibrationError("points must have finite nonnegative values")
            if previous is not None:
                if point.workers <= previous.workers:
                    raise CalibrationError("point workers must be strictly increasing")
                slope = (point.rate - previous.rate) / (point.workers - previous.workers)
                if slope < 0:
                    raise CalibrationError("rates must be monotonic")
                if previous_slope is not None and slope > previous_slope:
                    raise CalibrationError("marginal rates must not increase")
                previous_slope = slope
            previous = point
        first = self.points[0]
        if first.workers != 0 or first.rate != 0:
            raise CalibrationError("the curve must start at (0 workers, 0 rate)")

    def rate(self, worker_count: int, patch_count: int) -> float:
        """Return estimated total minerals per declared second.

        Worker and patch counts are nonnegative integers.  Invalid values are
        rejected rather than silently coerced; zero workers or patches returns
        exactly zero.  Results are finite and nonnegative by construction.
        """

        _validate_count("worker_count", worker_count)
        _validate_count("patch_count", patch_count)
        if worker_count == 0 or patch_count == 0:
            return 0.0
        # Keep arithmetic integral until the ratio is known to be within the
        # measured range. This avoids converting enormous valid integers to an
        # overflowing float merely to discover that the curve is saturated.
        last_workers = self.points[-1].workers
        if worker_count * self.reference_patch_count >= last_workers * patch_count:
            return self.points[-1].rate * patch_count / self.reference_patch_count
        equivalent_workers = worker_count * self.reference_patch_count / patch_count
        reference_rate = self._interpolate(equivalent_workers)
        result = reference_rate * patch_count / self.reference_patch_count
        # Guard against tiny floating-point negatives at a zero endpoint.
        return max(0.0, result)

    def _interpolate(self, workers: float) -> float:
        if workers >= self.points[-1].workers:
            return self.points[-1].rate
        for left, right in zip(self.points, self.points[1:]):
            if workers <= right.workers:
                fraction = (workers - left.workers) / (right.workers - left.workers)
                return left.rate + fraction * (right.rate - left.rate)
        return self.points[-1].rate


def _validate_count(name: str, value: int) -> None:
    # This bound keeps returned IEEE-754 rates finite while covering replay
    # sized inputs by many orders of magnitude. It is part of the input policy,
    # rather than an implicit float conversion failure.
    if isinstance(value, bool) or not isinstance(value, int) or value < 0 or value > MAX_COUNT:
        raise ValueError(f"{name} must be a nonnegative integer")


DEFAULT_MODEL = MineralSaturationModel(
    version=SOURCE_VERSION,
    reference_patch_count=REFERENCE_PATCH_COUNT,
    points=tuple(CalibrationPoint(workers, rate / 60) for workers, rate in FITTED_POINTS_PER_MINUTE),
    clock="fastest-replay-second",
)


def mineral_income_rate(worker_count: int, patch_count: int) -> float:
    """Return estimated total minerals per fastest-replay-second."""

    return DEFAULT_MODEL.rate(worker_count, patch_count)


__all__ = [
    "CalibrationError", "CalibrationPoint", "MineralSaturationModel",
    "DEFAULT_MODEL", "mineral_income_rate",
]

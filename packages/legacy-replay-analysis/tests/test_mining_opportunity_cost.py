"""Synthetic tests for the M2 opportunity-cost calculator.

The expected values below are calculated from the published M1 anchors rather
than by comparing the calculator with itself.  A frame is 0.042 fastest-speed
seconds, and all intervals use half-open frame boundaries.
"""

from __future__ import annotations

import math
import unittest
from fractions import Fraction

from mineral_saturation import CalibrationPoint, DEFAULT_MODEL, MineralSaturationModel
from mining_opportunity_cost import (
    BaseEconomicInterval,
    FrameInterval,
    MissingEconomicStateError,
    OpportunityCostInputError,
    WorkerAbsence,
    calculate_opportunity_cost,
)


SECONDS_PER_FRAME = 0.042


def expected_rate(workers: int, patches: int) -> float:
    """Independent implementation of M1's published piecewise curve."""
    if workers == 0 or patches == 0:
        return 0.0
    x = Fraction(9 * workers, patches)
    if x <= 9:
        fitted_per_minute = Fraction(65) * x
    elif x <= 27:
        fitted_per_minute = Fraction(585) + Fraction(700, 18) * (x - 9)
    else:
        fitted_per_minute = Fraction(1285)
    return float(Fraction(patches, 9) * fitted_per_minute / 60)


def expected_loss(workers: int, patches: int, absent: int, frames: int) -> float:
    return (expected_rate(workers + absent, patches) - expected_rate(workers, patches)) * frames * SECONDS_PER_FRAME


def economy(base="main", start=0, end=100, workers=24, patches=9):
    return BaseEconomicInterval(base, start, end, workers, patches)


def absence(worker="scv-1", base="main", category="construction", start=0, end=100):
    return WorkerAbsence(worker, base, category, start, end)


def calculate(economics, absences=(), start=0, end=100):
    return calculate_opportunity_cost(
        economics,
        absences,
        FrameInterval(start, end),
    )


class OpportunityCostTest(unittest.TestCase):
    def test_zero_absent_workers_is_zero_and_keeps_metadata(self):
        result = calculate([economy()], ())
        self.assertEqual(result.total_loss, 0.0)
        self.assertEqual(result.loss_by_worker, {})
        self.assertEqual(result.loss_by_category, {})
        self.assertEqual(result.loss_by_base, {"main": 0.0})
        self.assertEqual(result.model_version, DEFAULT_MODEL.version)
        self.assertEqual(result.clock, DEFAULT_MODEL.clock)
        self.assertEqual(result.seconds_per_frame, SECONDS_PER_FRAME)
        self.assertEqual(result.coverage, FrameInterval(0, 100))
        self.assertEqual(len(result.segments), 1)
        self.assertEqual(result.segments[0].absent_workers, 0)

    def test_zero_patches_has_zero_loss(self):
        result = calculate([economy(patches=0)], [absence()])
        self.assertEqual(result.total_loss, 0.0)
        self.assertEqual(result.loss_by_worker["scv-1"], 0.0)
        self.assertEqual(result.segments[0].loss_rate, 0.0)

    def test_single_unsaturated_worker_uses_aggregate_counterfactual(self):
        result = calculate([economy(workers=8)], [absence()])
        rate = expected_rate(9, 9) - expected_rate(8, 9)
        self.assertAlmostEqual(result.segments[0].loss_rate, rate)
        self.assertAlmostEqual(result.total_loss, expected_loss(8, 9, 1, 100))

    def test_partial_saturation_and_saturation(self):
        partial = calculate([economy(workers=24)], [absence()])
        expected = expected_loss(24, 9, 1, 100)
        self.assertAlmostEqual(partial.total_loss, expected)

        saturated = calculate([economy(workers=27)], [absence()])
        self.assertEqual(saturated.total_loss, 0.0)

    def test_aggregate_cap_with_three_absences_at_26_workers(self):
        result = calculate([economy(workers=26)], [absence("a"), absence("b"), absence("c")])
        self.assertAlmostEqual(result.total_loss, expected_loss(26, 9, 3, 100))
        self.assertGreater(result.total_loss, 0.0)
        saturated = calculate([economy(workers=27)], [absence("a"), absence("b"), absence("c")])
        self.assertEqual(saturated.total_loss, 0.0)

    def test_entering_and_leaving_miner_changes_active_count(self):
        for economics, expected_workers in (
            ([economy(start=0, end=50, workers=8), economy(start=50, end=100, workers=9)], (8, 9)),
            ([economy(start=0, end=50, workers=9), economy(start=50, end=100, workers=8)], (9, 8)),
        ):
            result = calculate(economics, [absence(start=0, end=100)])
            expected = expected_loss(expected_workers[0], 9, 1, 50) + expected_loss(expected_workers[1], 9, 1, 50)
            self.assertAlmostEqual(result.total_loss, expected)
            self.assertEqual([s.active_workers for s in result.segments], list(expected_workers))
            self.assertEqual([s.loss_rate for s in result.segments], [expected_rate(n + 1, 9) - expected_rate(n, 9) for n in expected_workers])

    def test_patch_unavailability_changes_loss(self):
        economics = [economy(start=0, end=50, workers=8, patches=9), economy(start=50, end=100, workers=8, patches=8)]
        result = calculate(economics, [absence()])
        self.assertAlmostEqual(result.total_loss, expected_loss(8, 9, 1, 50) + expected_loss(8, 8, 1, 50))

    def test_worker_changes_category_without_identity_overlap(self):
        result = calculate([economy()], [absence(category="construction", start=0, end=40), absence(category="idle", start=40, end=100)])
        self.assertAlmostEqual(result.loss_by_category["construction"], expected_loss(24, 9, 1, 40))
        self.assertAlmostEqual(result.loss_by_category["idle"], expected_loss(24, 9, 1, 60))

    def test_worker_changes_counterfactual_base_assignment(self):
        economics = [economy("alpha", workers=8), economy("beta", workers=24)]
        absences = [absence("traveler", "alpha", start=0, end=50), absence("traveler", "beta", start=50, end=100)]
        result = calculate(economics, absences)
        self.assertAlmostEqual(result.total_loss, expected_loss(8, 9, 1, 50) + expected_loss(24, 9, 1, 50))
        self.assertAlmostEqual(result.loss_by_worker["traveler"], result.total_loss)

    def test_complex_overlap_conserves_workers_and_categories(self):
        economics = [economy("a", workers=8), economy("b", workers=24)]
        absences = [
            absence("a1", "a", "construction", 0, 70),
            absence("a2", "a", "idle", 30, 100),
            absence("b1", "b", "construction", 20, 90),
        ]
        result = calculate(economics, absences)
        expected = (expected_loss(8, 9, 1, 30) + expected_loss(8, 9, 2, 40) + expected_loss(8, 9, 1, 30)
                    + expected_loss(24, 9, 1, 70))
        self.assertAlmostEqual(result.total_loss, expected)
        self.assertAlmostEqual(sum(result.loss_by_worker.values()), result.total_loss)
        self.assertAlmostEqual(sum(result.loss_by_category.values()), result.total_loss)
        self.assertAlmostEqual(result.loss_by_worker["a1"], expected_loss(8, 9, 1, 30) / 1 + expected_loss(8, 9, 2, 40) / 2)
        self.assertAlmostEqual(result.loss_by_worker["a2"], expected_loss(8, 9, 2, 40) / 2 + expected_loss(8, 9, 1, 30) / 1)
        self.assertAlmostEqual(result.loss_by_worker["b1"], expected_loss(24, 9, 1, 70))
        self.assertAlmostEqual(result.loss_by_category["construction"], result.loss_by_worker["a1"] + result.loss_by_worker["b1"])
        self.assertAlmostEqual(result.loss_by_category["idle"], result.loss_by_worker["a2"])
        for segment in result.segments:
            self.assertAlmostEqual(sum(value for _, value in segment.worker_losses), segment.loss)
            self.assertAlmostEqual(sum(value for _, value in segment.category_losses), segment.loss)

    def test_overlapping_builders_share_same_category(self):
        result = calculate([economy(workers=24)], [absence("a", start=0, end=60), absence("b", start=40, end=100)])
        expected = expected_loss(24, 9, 1, 40) + expected_loss(24, 9, 2, 20) + expected_loss(24, 9, 1, 40)
        self.assertAlmostEqual(result.total_loss, expected)
        self.assertAlmostEqual(result.loss_by_category["construction"], expected)

    def test_missing_state_for_economic_scope_without_absence(self):
        with self.assertRaises(MissingEconomicStateError):
            calculate([economy("main", 0, 20)], (), 0, 100)

    def test_missing_state_gap_is_rejected_even_without_absences(self):
        with self.assertRaises(MissingEconomicStateError):
            calculate([economy("main", 0, 40), economy("main", 60, 100)], (), 0, 100)

    def test_adjacent_worker_intervals_are_valid(self):
        result = calculate([economy()], [absence("x", start=0, end=40), absence("x", start=40, end=100)])
        self.assertAlmostEqual(result.total_loss, expected_loss(24, 9, 1, 100))

    def test_multiple_absences_use_one_aggregate_difference(self):
        absences = [absence("builder-a"), absence("builder-b"), absence("builder-c")]
        result = calculate([economy(workers=24)], absences)
        expected = expected_loss(24, 9, 3, 100)
        self.assertAlmostEqual(result.total_loss, expected)
        for worker in ("builder-a", "builder-b", "builder-c"):
            self.assertAlmostEqual(result.loss_by_worker[worker], expected / 3)
        self.assertAlmostEqual(result.loss_by_category["construction"], expected)

    def test_two_bases_are_independent(self):
        economics = [economy("alpha", workers=8), economy("beta", workers=24)]
        absences = [absence("a", "alpha"), absence("b", "beta", "idle")]
        result = calculate(economics, absences)
        self.assertAlmostEqual(result.loss_by_base["alpha"], expected_loss(8, 9, 1, 100))
        self.assertAlmostEqual(result.loss_by_base["beta"], expected_loss(24, 9, 1, 100))
        self.assertAlmostEqual(result.total_loss, sum(result.loss_by_base.values()))

    def test_time_varying_workers_patches_and_overlapping_categories(self):
        economics = [
            economy(start=0, end=50, workers=8, patches=9),
            economy(start=50, end=100, workers=9, patches=8),
        ]
        absences = [
            absence("builder", category="construction", start=0, end=75),
            absence("idle", category="idle", start=50, end=100),
        ]
        result = calculate(economics, absences)
        r0 = expected_rate(9, 9) - expected_rate(8, 9)
        r1 = expected_rate(10, 8) - expected_rate(9, 8)
        r2 = expected_rate(11, 8) - expected_rate(9, 8)
        expected = (50 * r0 + 25 * r1 + 25 * r2) * SECONDS_PER_FRAME
        self.assertAlmostEqual(result.total_loss, expected)
        self.assertAlmostEqual(sum(result.loss_by_worker.values()), result.total_loss)
        self.assertAlmostEqual(sum(result.loss_by_category.values()), result.total_loss)
        self.assertEqual([(s.start_frame, s.end_frame) for s in result.segments], [(0, 50), (50, 75), (75, 100)])

    def test_coverage_clips_interruption_and_economy(self):
        result = calculate([economy(start=0, end=200)], [absence(start=25, end=175)], 50, 100)
        self.assertAlmostEqual(result.total_loss, expected_loss(24, 9, 1, 50))
        self.assertEqual(result.segments[0].start_frame, 50)
        self.assertEqual(result.segments[0].end_frame, 100)

    def test_empty_coverage_validates_then_returns_empty_result(self):
        result = calculate([economy()], [absence()], 100, 100)
        self.assertEqual(result.total_loss, 0.0)
        self.assertEqual(result.segments, ())
        self.assertEqual(result.loss_by_base, {})

    def test_empty_inputs_require_economic_scope_for_nonempty_coverage(self):
        with self.assertRaises(MissingEconomicStateError):
            calculate([], [], 0, 1)
        result = calculate([], [], 0, 0)
        self.assertEqual(result.total_loss, 0.0)
        self.assertEqual(result.segments, ())

    def test_absences_outside_coverage_are_not_charged(self):
        economics = [economy(start=20, end=100)]
        before = calculate(economics, [absence(start=0, end=10)], 20, 100)
        after = calculate(economics, [absence(start=100, end=120)], 20, 100)
        self.assertEqual(before.total_loss, 0.0)
        self.assertEqual(after.total_loss, 0.0)
        self.assertEqual(before.loss_by_worker, {})
        self.assertEqual(before.loss_by_category, {})

    def test_adjacent_past_absence_does_not_overwrite_current_category(self):
        result = calculate(
            [economy()],
            [absence("x", category="construction", start=0, end=20), absence("x", category="idle", start=20, end=40)],
            20,
            100,
        )
        self.assertAlmostEqual(result.loss_by_category["idle"], expected_loss(24, 9, 1, 20))
        self.assertNotIn("construction", result.loss_by_category)

    def test_deterministic_input_order_and_equivalent_split_economy(self):
        absences = [absence("z", category="idle", start=20, end=80), absence("a", start=0, end=40)]
        one = calculate([economy()], absences)
        split = calculate([economy(end=50), economy(start=50, end=100)], list(reversed(absences)))
        self.assertEqual(one.total_loss, split.total_loss)
        self.assertEqual(one.loss_by_worker, split.loss_by_worker)
        self.assertEqual(one.loss_by_category, split.loss_by_category)
        self.assertEqual([(s.start_frame, s.end_frame) for s in one.segments], [(0, 20), (20, 40), (40, 80), (80, 100)])

    def test_result_preserves_segment_reconstruction(self):
        result = calculate([economy()], [absence("a", start=0, end=40), absence("b", start=60, end=100)])
        self.assertAlmostEqual(sum(s.loss for s in result.segments), result.total_loss)
        self.assertEqual(sum(s.end_frame - s.start_frame for s in result.segments), 100)
        self.assertTrue(all(math.isfinite(s.loss_rate) and s.loss_rate >= 0 for s in result.segments))

    def test_result_and_input_dataclasses_are_immutable_and_iterables_snapshot(self):
        economics = [economy()]
        absences = [absence()]
        result = calculate(economics, absences)
        economics.clear()
        absences.clear()
        self.assertGreater(result.total_loss, 0.0)
        with self.assertRaises((AttributeError, TypeError)):
            result.total_loss = 1.0
        with self.assertRaises((AttributeError, TypeError)):
            result.loss_by_base["main"] = 1.0
        with self.assertRaises((AttributeError, TypeError)):
            result.segments[0].loss = 1.0

    def test_zero_category_loss_is_retained_for_saturated_worker(self):
        result = calculate([economy(workers=27)], [absence(category="construction")])
        self.assertIn("construction", result.loss_by_category)
        self.assertEqual(result.loss_by_category["construction"], 0.0)

    def test_split_absence_same_category_is_equivalent(self):
        whole = calculate([economy()], [absence("x", "main", "construction", 0, 100)])
        split = calculate([economy()], [absence("x", "main", "construction", 0, 40), absence("x", "main", "construction", 40, 100)])
        self.assertAlmostEqual(whole.total_loss, split.total_loss)
        self.assertAlmostEqual(whole.loss_by_worker["x"], split.loss_by_worker["x"])
        self.assertAlmostEqual(whole.loss_by_category["construction"], split.loss_by_category["construction"])

    def test_missing_economic_state_is_distinct_from_zero_loss(self):
        with self.assertRaises(MissingEconomicStateError):
            calculate([], [absence()])
        with self.assertRaises(MissingEconomicStateError):
            calculate([economy(start=0, end=20)], [absence()], 0, 100)

    def test_rejects_conflicting_or_malformed_intervals(self):
        cases = [
            ([economy(start=0, end=60), economy(start=50, end=100)], []),
            ([economy()], [absence("x", start=0, end=60), absence("x", start=50, end=70)]),
        ]
        for economics, absences in cases:
            with self.subTest(economics=economics, absences=absences):
                with self.assertRaises(ValueError):
                    calculate(economics, absences)
        with self.assertRaises(ValueError):
            economy(workers=-1)
        with self.assertRaises(ValueError):
            economy(start=10, end=10)

    def test_rejects_nonfinite_or_incompatible_clock(self):
        with self.assertRaises(ValueError):
            calculate_opportunity_cost([economy()], [absence()], FrameInterval(0, 100), clock="other-clock")
        for value in (float("nan"), float("inf"), float("-inf")):
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    FrameInterval(value, 10)
                with self.assertRaises(ValueError):
                    BaseEconomicInterval("main", 0, 10, value, 9)
                with self.assertRaises(ValueError):
                    BaseEconomicInterval("main", 0, 10, 1, value)

    def test_rejects_bad_types_counts_frames_and_empty_text(self):
        bad_values = [
            lambda: FrameInterval(True, 10), lambda: FrameInterval(0, 1.5),
            lambda: BaseEconomicInterval("main", 0, 10, True, 9),
            lambda: BaseEconomicInterval("main", 0, 10, 1, -1),
            lambda: WorkerAbsence("", "main", "idle", 0, 10),
            lambda: WorkerAbsence("x", "main", "", 0, 10),
            lambda: FrameInterval(10, 9), lambda: WorkerAbsence("x", "main", "idle", 2, 2),
            lambda: BaseEconomicInterval("main", 0, 10, 10**12 + 1, 9),
            lambda: BaseEconomicInterval("main", 0, 10, 1, 10**12 + 1),
        ]
        for make in bad_values:
            with self.assertRaises(ValueError):
                make()
        with self.assertRaises(ValueError):
            calculate_opportunity_cost([], [], (0, 1))
        with self.assertRaises(ValueError):
            calculate_opportunity_cost([economy()], [object()], FrameInterval(0, 100))
        with self.assertRaises(ValueError):
            calculate_opportunity_cost([object()], [], FrameInterval(0, 100))

    def test_counterfactual_count_overflow_is_rejected(self):
        with self.assertRaises(ValueError):
            calculate([economy(workers=10**12)], [absence("x")])

    def test_nonfinite_custom_model_loss_is_normalized_to_value_error(self):
        huge_rate = float.fromhex("0x1.fffffffffffffp+1023") / 10**12
        model = MineralSaturationModel("huge", 1, (CalibrationPoint(0, 0), CalibrationPoint(1, huge_rate)), clock="fastest-replay-second")
        end = 10**12
        absences = [absence(f"x{i}", end=end) for i in range(30)]
        with self.assertRaisesRegex(OpportunityCostInputError, "segment loss is not finite"):
            calculate_opportunity_cost([economy(end=end, workers=0, patches=10**12)], absences, FrameInterval(0, end), model=model)

    def test_finite_segments_with_overflowing_total_are_rejected(self):
        huge_rate = float.fromhex("0x1.fffffffffffffp+1023") / 10**12
        model = MineralSaturationModel("huge", 1, (CalibrationPoint(0, 0), CalibrationPoint(1, huge_rate)), clock="fastest-replay-second")
        end = 10**12
        economics = [economy(base, end=end, workers=0, patches=10**12) for base in ("a", "b")]
        absences = [absence(f"{base}-{i}", base, end=end) for base in ("a", "b") for i in range(15)]
        for base in ("a", "b"):
            result = calculate_opportunity_cost([x for x in economics if x.base_id == base], [x for x in absences if x.base_id == base], FrameInterval(0, end), model=model)
            self.assertTrue(math.isfinite(result.total_loss))
        with self.assertRaisesRegex(OpportunityCostInputError, "total loss aggregation overflowed"):
            calculate_opportunity_cost(economics, absences, FrameInterval(0, end), model=model)

    def test_valid_custom_curve_is_used(self):
        model = MineralSaturationModel("synthetic", 8, (CalibrationPoint(0, 0), CalibrationPoint(8, 16), CalibrationPoint(16, 24)), clock="fastest-replay-second")
        result = calculate_opportunity_cost([economy(workers=8, patches=8)], [absence()], FrameInterval(0, 100), model=model)
        self.assertAlmostEqual(result.total_loss, 4.2)

    def test_rejects_overlaps_across_categories_and_outside_coverage(self):
        with self.assertRaises(ValueError):
            calculate([economy()], [absence("x", category="construction", start=0, end=10), absence("x", category="idle", start=10, end=20), absence("x", category="gas", start=19, end=30)])
        with self.assertRaises(ValueError):
            calculate([economy()], [absence("x", start=0, end=10), absence("x", base="other", start=5, end=8)])
        with self.assertRaises(ValueError):
            calculate([economy(start=0, end=400)], [absence("x", start=300, end=350), absence("x", start=340, end=360)], 0, 100)

    def test_reordering_inputs_produces_identical_result(self):
        economics = [economy("a", 0, 50, 8), economy("a", 50, 100, 9), economy("b", 0, 100, 24)]
        absences = [absence("a1", "a", "construction", 10, 60), absence("a2", "a", "idle", 40, 90), absence("b1", "b", "construction", 0, 100)]
        left = calculate(economics, absences)
        right = calculate(list(reversed(economics)), list(reversed(absences)))
        self.assertEqual(left, right)

    def test_custom_model_metadata_and_incompatible_model(self):
        model = MineralSaturationModel("synthetic-v2", 9, (CalibrationPoint(0, 0), CalibrationPoint(9, 585 / 60), CalibrationPoint(27, 1285 / 60)), clock="fastest-replay-second")
        result = calculate_opportunity_cost([economy()], [absence()], FrameInterval(0, 100), model=model)
        self.assertEqual(result.model_version, "synthetic-v2")
        self.assertEqual(result.clock, "fastest-replay-second")
        with self.assertRaises(ValueError):
            calculate_opportunity_cost([economy()], [absence()], FrameInterval(0, 100), model=model, clock="game-second")
        incompatible = MineralSaturationModel("other-clock", 1, (CalibrationPoint(0, 0),))
        with self.assertRaisesRegex(OpportunityCostInputError, "incompatible clock"):
            calculate_opportunity_cost([economy()], [absence()], FrameInterval(0, 100), model=incompatible)

    def test_huge_frame_span_uses_few_segments(self):
        end = 10**9
        result = calculate([economy(end=end)], [absence(start=100, end=end - 100)], 0, end)
        self.assertEqual(len(result.segments), 3)
        self.assertAlmostEqual(result.total_loss, expected_loss(24, 9, 1, end - 200))

    def test_frame_boundary_is_half_open(self):
        result = calculate([economy()], [absence(start=100, end=200)], 0, 100)
        self.assertEqual(result.total_loss, 0.0)
        result = calculate([economy()], [absence(start=99, end=101)], 0, 100)
        self.assertAlmostEqual(result.total_loss, expected_loss(24, 9, 1, 1))


if __name__ == "__main__":
    unittest.main()

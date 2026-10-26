import math
import unittest

from mineral_saturation import (
    CalibrationError,
    CalibrationPoint,
    DEFAULT_MODEL,
    MineralSaturationModel,
    mineral_income_rate,
)
from mineral_saturation_calibration import (
    FITTED_POINTS_PER_MINUTE,
)

PUBLISHED_NINE_PATCH_TOTALS_PER_MINUTE = (
    (5, 325), (7, 455), (9, 585), (11, 663), (13, 741), (15, 818),
    (17, 896), (19, 974), (21, 1052), (23, 1129), (25, 1207),
    (27, 1285), (29, 1285),
)


def synthetic_model() -> MineralSaturationModel:
    # Synthetic fixture: tests mathematical behavior, not empirical calibration.
    return MineralSaturationModel(
        version="test-synthetic-v1",
        reference_patch_count=8,
        points=(
            CalibrationPoint(0, 0.0),
            CalibrationPoint(8, 16.0),
            CalibrationPoint(16, 24.0),
            CalibrationPoint(24, 24.0),
        ),
    )


class MineralSaturationTest(unittest.TestCase):
    def test_zero_cases_and_one_worker(self):
        model = synthetic_model()
        self.assertEqual(model.rate(0, 8), 0.0)
        self.assertEqual(model.rate(1, 0), 0.0)
        self.assertAlmostEqual(model.rate(1, 8), 2.0)

    def test_piecewise_linear_interpolation(self):
        model = synthetic_model()
        self.assertAlmostEqual(model.rate(12, 8), 20.0)
        self.assertAlmostEqual(model.rate(20, 8), 24.0)

    def test_patch_scaling_and_equivalent_workers(self):
        model = synthetic_model()
        self.assertAlmostEqual(model.rate(4, 4), 8.0)
        self.assertAlmostEqual(model.rate(16, 16), 32.0)
        self.assertAlmostEqual(model.rate(1, 1), 2.0)

    def test_saturation_caps_beyond_last_point(self):
        model = synthetic_model()
        self.assertEqual(model.rate(24, 8), 24.0)
        self.assertEqual(model.rate(240, 8), 24.0)

    def test_monotonic_nonnegative_finite_and_diminishing(self):
        model = synthetic_model()
        values = [model.rate(worker, 8) for worker in range(80)]
        self.assertTrue(all(math.isfinite(v) and v >= 0 for v in values))
        self.assertTrue(all(a <= b for a, b in zip(values, values[1:])))
        marginal = [b - a for a, b in zip(values, values[1:])]
        self.assertTrue(all(a + 1e-12 >= b for a, b in zip(marginal, marginal[1:])))

    def test_determinism(self):
        model = synthetic_model()
        self.assertEqual(model.rate(13, 5), model.rate(13, 5))
        self.assertEqual(model, synthetic_model())

    def test_counts_reject_invalid_values(self):
        model = synthetic_model()
        for workers, patches in [
            (-1, 8), (1, -1), (1.0, 8), (True, 8), (1, False),
            (float("nan"), 8), (float("inf"), 8), (1, 1.5),
            (1, float("nan")), (1, float("inf")), (10**12 + 1, 8),
            (1, 10**12 + 1),
        ]:
            with self.subTest(workers=workers, patches=patches):
                with self.assertRaises(ValueError):
                    model.rate(workers, patches)

    def test_calibration_rejects_bad_curves(self):
        with self.assertRaises(CalibrationError):
            MineralSaturationModel("v", 8, (CalibrationPoint(1, 1),))
        with self.assertRaises(CalibrationError):
            MineralSaturationModel("v", 8, (CalibrationPoint(0, 0), CalibrationPoint(2, 3), CalibrationPoint(3, 5)))
        with self.assertRaises(CalibrationError):
            MineralSaturationModel("v", 8, (CalibrationPoint(0, 0), CalibrationPoint(2, -1)))
        with self.assertRaises(CalibrationError):
            MineralSaturationModel("v", 8, (CalibrationPoint(0, 0), CalibrationPoint(1, 1), CalibrationPoint(2, 2.1)))
        with self.assertRaises(CalibrationError):
            MineralSaturationModel("v", 8, (CalibrationPoint(0, 0), CalibrationPoint(0, 1)))
        with self.assertRaises(CalibrationError):
            MineralSaturationModel("v", 8, ((0, 0),))
        for version, clock in (("", "x"), ("v", "")):
            with self.assertRaises(CalibrationError):
                MineralSaturationModel(version, 8, (CalibrationPoint(0, 0),), clock=clock)
        for point in (
            CalibrationPoint(True, 0), CalibrationPoint(10**12 + 1, 1),
            CalibrationPoint(0, float("nan")), CalibrationPoint(0, float("inf")),
            CalibrationPoint(0, 10**400),
        ):
            with self.assertRaises(CalibrationError):
                MineralSaturationModel("v", 8, (point,))

    def test_calibration_is_defensively_immutable(self):
        points = [CalibrationPoint(0, 0), CalibrationPoint(8, 16)]
        model = MineralSaturationModel("v", 8, points)
        points.append(CalibrationPoint(16, 24))
        self.assertEqual(len(model.points), 2)
        with self.assertRaises(AttributeError):
            model.version = "changed"

    def test_systematic_patch_and_worker_sweep(self):
        for name, model in (("synthetic", synthetic_model()), ("published", DEFAULT_MODEL)):
            with self.subTest(model=name):
                for patches in range(0, 65):
                    values = [model.rate(workers, patches) for workers in range(201)]
                    self.assertTrue(all(a <= b + 1e-10 for a, b in zip(values, values[1:])))
                    self.assertTrue(all(value >= 0 and math.isfinite(value) for value in values))
                    marginal = [b - a for a, b in zip(values, values[1:])]
                    self.assertTrue(all(a + 1e-10 >= b for a, b in zip(marginal, marginal[1:])))
                for workers in range(1, 201):
                    values = [model.rate(workers, patches) for patches in range(65)]
                    self.assertTrue(all(a <= b + 1e-10 for a, b in zip(values, values[1:])))

    def test_large_range_is_stable(self):
        model = synthetic_model()
        for patches in (1, 2, 8, 32, 1000):
            for workers in (0, 1, 10, 100, 10_000):
                value = model.rate(workers, patches)
                self.assertTrue(math.isfinite(value) and value >= 0)

    def test_published_calibration_conversion_and_fit(self):
        self.assertAlmostEqual(DEFAULT_MODEL.rate(9, 9), 585 / 60)
        self.assertAlmostEqual(DEFAULT_MODEL.rate(27, 9), 1285 / 60)
        for workers, source_per_minute in PUBLISHED_NINE_PATCH_TOTALS_PER_MINUTE:
            estimate_per_minute = DEFAULT_MODEL.rate(workers, 9) * 60
            self.assertLessEqual(abs(estimate_per_minute - source_per_minute), 0.5)
        self.assertEqual(FITTED_POINTS_PER_MINUTE, ((0, 0.0), (9, 585.0), (27, 1285.0)))

    def test_default_wrapper_uses_calibrated_model(self):
        self.assertEqual(mineral_income_rate(0, 9), 0.0)
        self.assertEqual(mineral_income_rate(27, 9), DEFAULT_MODEL.rate(27, 9))
        self.assertEqual(DEFAULT_MODEL.clock, "fastest-replay-second")

    def test_default_representative_scaling_and_saturation(self):
        self.assertAlmostEqual(DEFAULT_MODEL.rate(18, 9), 935 / 60)
        self.assertAlmostEqual(DEFAULT_MODEL.rate(1, 1), 65 / 60)
        self.assertAlmostEqual(DEFAULT_MODEL.rate(6, 3), 935 / 180)
        self.assertAlmostEqual(DEFAULT_MODEL.rate(36, 18), 935 / 30)
        self.assertEqual(DEFAULT_MODEL.rate(100, 9), DEFAULT_MODEL.rate(27, 9))
        self.assertEqual(DEFAULT_MODEL.rate(3, 1), DEFAULT_MODEL.rate(27, 9) / 9)
        self.assertEqual(DEFAULT_MODEL.rate(4, 1), DEFAULT_MODEL.rate(27, 9) / 9)
        self.assertTrue(math.isfinite(DEFAULT_MODEL.rate(10**12, 10**12)))


if __name__ == "__main__":
    unittest.main()

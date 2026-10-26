"""Published calibration data for :mod:`mineral_saturation`.

The source presents a nine-patch SCV example as approximate minerals per
minute at the fastest game speed.  The raw table is retained for provenance;
the evaluator uses a monotone, concave fit through the 9- and 27-worker
anchors so rounded intermediate observations cannot create artificial slope
increases.
"""

from __future__ import annotations

SOURCE_URL = "https://liquipedia.net/starcraft/Mining#Saturation"
SOURCE_VERSION = "liquipedia-scv-nine-patch-v1"
REFERENCE_PATCH_COUNT = 9

# Source table: workers and approximate total minerals per minute, for nine
# mineral patches at fastest speed. Keep this as an immutable source record.
RAW_NINE_PATCH_TOTALS_PER_MINUTE: tuple[tuple[int, int], ...] = (
    (5, 325), (7, 455), (9, 585), (11, 663), (13, 741), (15, 818),
    (17, 896), (19, 974), (21, 1052), (23, 1129), (25, 1207),
    (27, 1285), (29, 1285),
)

# The published values are rounded. Fit the endpoints that define unsaturated
# and saturated capacity, then hold the final rate flat beyond saturation.
FITTED_POINTS_PER_MINUTE: tuple[tuple[int, float], ...] = (
    (0, 0.0),
    (9, 585.0),
    (27, 1285.0),
)


__all__ = [
    "FITTED_POINTS_PER_MINUTE",
    "RAW_NINE_PATCH_TOTALS_PER_MINUTE",
    "REFERENCE_PATCH_COUNT",
    "SOURCE_URL",
    "SOURCE_VERSION",
]

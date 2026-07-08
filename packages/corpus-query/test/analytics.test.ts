import test from "node:test";
import assert from "node:assert/strict";
import { clampExampleLimit, clampListLimit, normalizeCorpusFilters } from "../src/analytics/filters.js";
import { mean, percentile, summarizeNumbers } from "../src/analytics/stats.js";
import { formatSecondsClock } from "../src/analytics/time.js";

test("analytics helpers format time consistently", () => {
  assert.equal(formatSecondsClock(0), "0:00");
  assert.equal(formatSecondsClock(255), "4:15");
  assert.equal(formatSecondsClock(255.4), "4:15");
});

test("analytics helpers normalize filters and replay ids", () => {
  assert.deepEqual(
    normalizeCorpusFilters({
      player: "  Soulkey  ",
      matchup: " ZvT ",
      replayIds: [" replay-1 ", "replay-1", "replay-2"]
    }),
    {
      player: "Soulkey",
      matchup: "ZvT",
      replayIds: ["replay-1", "replay-2"]
    }
  );
});

test("analytics helpers clamp list and example limits", () => {
  assert.equal(clampListLimit(undefined), 100);
  assert.equal(clampListLimit(999), 500);
  assert.equal(clampListLimit(-1), 100);
  assert.equal(clampExampleLimit(undefined), 5);
  assert.equal(clampExampleLimit(30), 25);
});

test("analytics stats helpers compute mean percentiles and summary", () => {
  const values = [10, 20, 30, 40];
  assert.equal(mean(values), 25);
  assert.equal(percentile(values, 0), 10);
  assert.equal(percentile(values, 0.5), 25);
  assert.equal(percentile(values, 1), 40);
  assert.deepEqual(summarizeNumbers(values), {
    min: 10,
    p25: 17.5,
    median: 25,
    p75: 32.5,
    max: 40,
    mean: 25
  });
});

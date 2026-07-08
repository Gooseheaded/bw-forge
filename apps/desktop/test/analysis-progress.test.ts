import { describe, expect, test } from "vitest";
import {
  estimateReplayExportPercent,
  finalizingReplayProgressPercent,
  parseAnalysisOutputProgress,
  replayProgressFromAnalysisPercent,
  replayProgressFromExactExportPercent
} from "../src/main/analysis-progress";

describe("analysis progress parsing", () => {
  test("parses exact replay export progress", () => {
    expect(
      parseAnalysisOutputProgress(
        "[replay-export] progress gameId=abc frame=123/456 time=00:12 27.0% timeline=8 MB"
      )
    ).toEqual({
      kind: "replay_export_exact",
      percent: 27,
      detail: "Replay playback 00:12"
    });
  });

  test("parses replay export heartbeat", () => {
    expect(parseAnalysisOutputProgress("[replay-export] running... elapsed 12.4s")).toEqual({
      kind: "replay_export_heartbeat",
      elapsedSeconds: 12.4,
      detail: "Replay playback 0:12"
    });
  });

  test("parses replay export completion marker", () => {
    expect(parseAnalysisOutputProgress("[pipeline] 50.0% replay export complete")).toEqual({
      kind: "replay_export_stage_complete"
    });
  });

  test("parses timeline analysis progress", () => {
    expect(parseAnalysisOutputProgress("[analysis]  37.5% elapsed 4.0s")).toEqual({
      kind: "timeline_analysis",
      percent: 37.5,
      elapsedSeconds: 4,
      detail: "Reading replay data • 0:04"
    });
  });

  test("parses ingest progress", () => {
    expect(parseAnalysisOutputProgress("Ingest batch 2: 15/40 replays processed")).toEqual({
      kind: "ingest_progress",
      processed: 15,
      total: 40,
      detail: "15 of 40 replays added"
    });
  });

  test("ignores unrelated lines", () => {
    expect(parseAnalysisOutputProgress("Completed KnockOut.rep")).toBeNull();
  });
});

describe("analysis progress helpers", () => {
  test("maps exact replay export to the first half of replay progress", () => {
    expect(replayProgressFromExactExportPercent(50)).toBe(25);
  });

  test("maps timeline analysis to the second weighted portion", () => {
    expect(replayProgressFromAnalysisPercent(100)).toBe(95);
  });

  test("caps the heartbeat heuristic below completion", () => {
    expect(estimateReplayExportPercent(0)).toBe(0);
    expect(estimateReplayExportPercent(10)).toBeGreaterThan(12);
    expect(estimateReplayExportPercent(300)).toBeLessThanOrEqual(92);
  });

  test("uses a stable finalizing percentage", () => {
    expect(finalizingReplayProgressPercent()).toBe(97);
  });
});

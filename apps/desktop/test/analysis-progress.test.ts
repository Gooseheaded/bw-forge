import { describe, expect, test } from "vitest";
import {
  finalizingReplayProgressPercent,
  parseAnalysisOutputProgress,
  replayProgressFromAnalysisPercent
} from "../src/main/analysis-progress";

describe("analysis progress parsing", () => {
  test("parses bwsim completion marker", () => {
    expect(parseAnalysisOutputProgress("[bwsim] extraction completed in 12.4s")).toEqual({
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
  test("maps timeline analysis to the second weighted portion", () => {
    expect(replayProgressFromAnalysisPercent(100)).toBe(95);
  });

  test("uses a stable finalizing percentage", () => {
    expect(finalizingReplayProgressPercent()).toBe(97);
  });
});

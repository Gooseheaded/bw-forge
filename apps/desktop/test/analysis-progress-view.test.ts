import { describe, expect, test } from "vitest";
import type { AnalysisRunState } from "../src/shared/contracts";
import { getAnalysisPrimaryProgressView } from "../src/renderer/src/analysis-progress-view";

describe("analysis progress view", () => {
  test("prefers structured primary progress and current replay name", () => {
    const view = getAnalysisPrimaryProgressView(
      state({
        status: "running",
        currentJobId: "job-1",
        jobs: [
          {
            id: "job-1",
            filename: "game.rep",
            replayPath: "C:\\replays\\game.rep",
            status: "running"
          }
        ],
        primaryProgress: {
          phase: "replay_export",
          label: "Playing the replay",
          detail: "Replay playback 0:12 • Estimated",
          percent: 22,
          mode: "estimated",
          updatedAt: new Date().toISOString()
        }
      })
    );

    expect(view).toEqual({
      label: "Playing the replay",
      detail: "Replay playback 0:12 • Estimated",
      percent: 22,
      mode: "estimated",
      currentReplayName: "game.rep"
    });
  });

  test("falls back to a friendly completion message", () => {
    expect(
      getAnalysisPrimaryProgressView(
        state({
          status: "succeeded"
        })
      )
    ).toMatchObject({
      label: "Finished",
      percent: 100
    });
  });

  test("surfaces failure details when progress is unavailable", () => {
    expect(
      getAnalysisPrimaryProgressView(
        state({
          status: "failed",
          error: "No replay analysis completed successfully; ingestion was not started."
        })
      )
    ).toMatchObject({
      label: "Analysis failed",
      detail: "No replay analysis completed successfully; ingestion was not started.",
      percent: null
    });
  });
});

function state(partial: Partial<AnalysisRunState>): AnalysisRunState {
  return {
    runId: null,
    status: "idle",
    jobs: [],
    logs: [],
    queueProgress: {
      completed: 0,
      total: 0,
      percent: 0
    },
    currentJobId: null,
    ...partial
  };
}

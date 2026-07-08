import { describe, expect, test } from "vitest";
import type { AnalysisRunState } from "../src/shared/contracts";
import { getAnalysisCompletionEffects } from "../src/renderer/src/analysis-completion";

describe("analysis completion effects", () => {
  test("refreshes library and clears queue on full success", () => {
    expect(
      getAnalysisCompletionEffects(
        state({ runId: "run-1", status: "ingesting" }),
        state({ runId: "run-1", status: "succeeded" })
      )
    ).toEqual({
      refreshLibrary: true,
      clearQueue: true
    });
  });

  test("refreshes library but keeps the queue on partial completion", () => {
    expect(
      getAnalysisCompletionEffects(
        state({ runId: "run-1", status: "ingesting" }),
        state({ runId: "run-1", status: "partial" })
      )
    ).toEqual({
      refreshLibrary: true,
      clearQueue: false
    });
  });

  test("does nothing for initial state or in-flight updates", () => {
    expect(getAnalysisCompletionEffects(null, state({ runId: null, status: "idle" }))).toEqual({
      refreshLibrary: false,
      clearQueue: false
    });
    expect(
      getAnalysisCompletionEffects(
        state({ runId: "run-1", status: "running" }),
        state({ runId: "run-1", status: "ingesting" })
      )
    ).toEqual({
      refreshLibrary: false,
      clearQueue: false
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

import { describe, expect, test } from "vitest";
import type { AnalysisRunState } from "../src/shared/contracts";
import {
  getAnalyzeCompletionHeadline,
  getAnalyzeCompletionSummary,
  getAnalyzeNavStatus,
  getAnalyzeWorkflowState
} from "../src/renderer/src/analyze-workflow";

describe("analyze workflow state", () => {
  test("uses empty when nothing is selected and no run is active", () => {
    expect(
      getAnalyzeWorkflowState({
        analysis: state({ status: "idle" }),
        pendingReplays: [],
        dismissedCompletedRunId: null
      })
    ).toBe("empty");
  });

  test("uses queue-review when files are selected and no completion is showing", () => {
    expect(
      getAnalyzeWorkflowState({
        analysis: state({ status: "idle" }),
        pendingReplays: ["C:\\replays\\a.rep"],
        dismissedCompletedRunId: null
      })
    ).toBe("queue-review");
  });

  test("uses running for active analysis statuses", () => {
    expect(
      getAnalyzeWorkflowState({
        analysis: state({ status: "running", runId: "run-1" }),
        pendingReplays: ["C:\\replays\\a.rep"],
        dismissedCompletedRunId: null
      })
    ).toBe("running");
  });

  test("uses complete for terminal runs until dismissed", () => {
    expect(
      getAnalyzeWorkflowState({
        analysis: state({ status: "partial", runId: "run-1" }),
        pendingReplays: ["C:\\replays\\a.rep"],
        dismissedCompletedRunId: null
      })
    ).toBe("complete");

    expect(
      getAnalyzeWorkflowState({
        analysis: state({ status: "partial", runId: "run-1" }),
        pendingReplays: ["C:\\replays\\a.rep"],
        dismissedCompletedRunId: "run-1"
      })
    ).toBe("queue-review");
  });
});

describe("analyze nav status", () => {
  test("summarizes workflow state for the sidebar", () => {
    expect(
      getAnalyzeNavStatus({
        analysis: state({ status: "idle" }),
        pendingReplays: [],
        dismissedCompletedRunId: null
      })
    ).toBe("Ready");

    expect(
      getAnalyzeNavStatus({
        analysis: state({ status: "idle" }),
        pendingReplays: ["a", "b"],
        dismissedCompletedRunId: null
      })
    ).toBe("2 selected");

    expect(
      getAnalyzeNavStatus({
        analysis: state({ status: "cancelled", runId: "run-1" }),
        pendingReplays: [],
        dismissedCompletedRunId: null
      })
    ).toBe("Cancelled");
  });
});

describe("analyze completion summaries", () => {
  test("summarizes partial completion", () => {
    expect(
      getAnalyzeCompletionHeadline(state({ status: "partial" }))
    ).toBe("Analysis complete with errors");
  });

  test("summarizes cancelled completion", () => {
    expect(
      getAnalyzeCompletionSummary(
        state({
          status: "cancelled",
          jobs: [
            job("ok.rep", "C:\\replays\\ok.rep", "succeeded"),
            job("later.rep", "C:\\replays\\later.rep", "cancelled")
          ]
        })
      )
    ).toEqual([
      { label: "Completed before cancellation", value: "1 of 2" },
      { label: "Not analyzed", value: "1" }
    ]);
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

function job(
  filename: string,
  replayPath: string,
  status: AnalysisRunState["jobs"][number]["status"]
) {
  return {
    id: `${filename}-${status}`,
    filename,
    replayPath,
    status
  };
}

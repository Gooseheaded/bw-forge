import type { AnalysisRunState, ProgressSnapshot, ReplayJob } from "../../shared/contracts";

export interface AnalysisPrimaryProgressView {
  label: string;
  detail: string;
  percent: number | null;
  mode: ProgressSnapshot["mode"];
  currentReplayName: string | null;
}

export function getAnalysisPrimaryProgressView(
  analysis: AnalysisRunState
): AnalysisPrimaryProgressView {
  const currentReplay = getCurrentReplayJob(analysis);
  if (analysis.primaryProgress) {
    return {
      label: analysis.primaryProgress.label,
      detail: analysis.primaryProgress.detail,
      percent: analysis.primaryProgress.percent,
      mode: analysis.primaryProgress.mode,
      currentReplayName: currentReplay?.filename ?? null
    };
  }

  switch (analysis.status) {
    case "succeeded":
      return {
        label: "Finished",
        detail: "All selected replays were added to your library",
        percent: 100,
        mode: "exact",
        currentReplayName: null
      };
    case "partial":
      return {
        label: "Finished with some problems",
        detail: "At least one replay failed, but successful results were kept",
        percent: 100,
        mode: "exact",
        currentReplayName: null
      };
    case "failed":
      return {
        label: "Analysis failed",
        detail: analysis.error ?? "The run stopped before any replay could be added",
        percent: null,
        mode: "indeterminate",
        currentReplayName: null
      };
    case "cancelled":
      return {
        label: "Run cancelled",
        detail: "The current run was stopped before it finished",
        percent: null,
        mode: "indeterminate",
        currentReplayName: null
      };
    default:
      return {
        label: "Ready to start",
        detail: "Choose one or more replays to begin",
        percent: 0,
        mode: "exact",
        currentReplayName: null
      };
  }
}

export function getCurrentReplayJob(
  analysis: AnalysisRunState
): ReplayJob | undefined {
  if (analysis.currentJobId) {
    return analysis.jobs.find((job) => job.id === analysis.currentJobId);
  }
  return analysis.jobs.find((job) => job.status === "running");
}

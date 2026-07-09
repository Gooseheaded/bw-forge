import type { AnalysisRunState, ReplayJob } from "../../shared/contracts";

export type AnalyzeWorkflowState =
  | "empty"
  | "queue-review"
  | "running"
  | "complete";

interface AnalyzeWorkflowModel {
  analysis: AnalysisRunState;
  pendingReplays: string[];
  dismissedCompletedRunId: string | null;
}

const ACTIVE_STATUSES = new Set<AnalysisRunState["status"]>([
  "running",
  "ingesting",
  "cancelling"
]);

const TERMINAL_STATUSES = new Set<AnalysisRunState["status"]>([
  "succeeded",
  "partial",
  "failed",
  "cancelled"
]);

export function getAnalyzeWorkflowState(model: AnalyzeWorkflowModel): AnalyzeWorkflowState {
  if (ACTIVE_STATUSES.has(model.analysis.status)) {
    return "running";
  }

  if (
    model.analysis.runId &&
    TERMINAL_STATUSES.has(model.analysis.status) &&
    model.dismissedCompletedRunId !== model.analysis.runId
  ) {
    return "complete";
  }

  if (model.pendingReplays.length > 0) {
    return "queue-review";
  }

  return "empty";
}

export function getAnalyzeNavStatus(model: AnalyzeWorkflowModel): string {
  const state = getAnalyzeWorkflowState(model);
  switch (state) {
    case "empty":
      return "Ready";
    case "queue-review":
      return `${model.pendingReplays.length} selected`;
    case "running":
      return model.analysis.status === "cancelling" ? "Cancelling" : "Running";
    case "complete":
      if (model.analysis.status === "cancelled") {
        return "Cancelled";
      }
      if (model.analysis.status === "failed" || model.analysis.jobs.some((job) => job.status === "failed")) {
        return "Errors";
      }
      return "Complete";
  }
}

export function getFailedReplayPaths(analysis: AnalysisRunState): string[] {
  return analysis.jobs.filter((job) => job.status === "failed").map((job) => job.replayPath);
}

export function getCancelledReplayPaths(analysis: AnalysisRunState): string[] {
  return analysis.jobs.filter((job) => job.status === "cancelled").map((job) => job.replayPath);
}

export function getAnalyzeCompletionHeadline(analysis: AnalysisRunState): string {
  switch (analysis.status) {
    case "succeeded":
      return "Analysis complete";
    case "partial":
      return "Analysis complete with errors";
    case "failed":
      return "Analysis failed";
    case "cancelled":
      return "Analysis cancelled";
    default:
      return "Analysis complete";
  }
}

export function getAnalyzeCompletionSummary(analysis: AnalysisRunState): Array<{
  label: string;
  value: string;
}> {
  const processed = analysis.jobs.length;
  const added = analysis.jobs.filter((job) => job.status === "succeeded").length;
  const failed = analysis.jobs.filter((job) => job.status === "failed").length;
  const cancelled = analysis.jobs.filter((job) => job.status === "cancelled").length;

  if (analysis.status === "cancelled") {
    return [
      {
        label: "Completed before cancellation",
        value: `${added} of ${processed}`
      },
      {
        label: "Not analyzed",
        value: String(cancelled)
      }
    ];
  }

  return [
    {
      label: "Replays processed",
      value: String(processed)
    },
    {
      label: "Added to library",
      value: String(added)
    },
    {
      label: "Failed",
      value: String(failed)
    }
  ];
}

export function getReplayResultLabel(job: ReplayJob): string {
  switch (job.status) {
    case "succeeded":
      return "Added to library";
    case "failed":
      return job.error ? `Failed: ${job.error}` : "Failed";
    case "cancelled":
      return "Not analyzed";
    case "running":
      return job.progress?.detail ?? job.progress?.label ?? "In progress";
    case "queued":
      return "Queued";
  }
}

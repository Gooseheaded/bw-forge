import type { AnalysisRunState } from "../../shared/contracts";

const ACTIVE_ANALYSIS_STATUSES = new Set<AnalysisRunState["status"]>([
  "running",
  "ingesting",
  "cancelling"
]);

const REFRESH_LIBRARY_STATUSES = new Set<AnalysisRunState["status"]>(["succeeded", "partial"]);

export interface AnalysisCompletionEffects {
  refreshLibrary: boolean;
  clearQueue: boolean;
}

export function getAnalysisCompletionEffects(
  previous: AnalysisRunState | null,
  next: AnalysisRunState
): AnalysisCompletionEffects {
  if (!previous?.runId || previous.runId !== next.runId) {
    return noEffects();
  }
  if (!ACTIVE_ANALYSIS_STATUSES.has(previous.status) || ACTIVE_ANALYSIS_STATUSES.has(next.status)) {
    return noEffects();
  }

  return {
    refreshLibrary: REFRESH_LIBRARY_STATUSES.has(next.status),
    clearQueue: next.status === "succeeded"
  };
}

function noEffects(): AnalysisCompletionEffects {
  return {
    refreshLibrary: false,
    clearQueue: false
  };
}

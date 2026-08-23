import type { ProgressMode } from "../shared/contracts";

export type AnalysisOutputProgressEvent =
  | {
      kind: "replay_export_stage_complete";
    }
  | {
      kind: "timeline_analysis";
      percent: number;
      elapsedSeconds: number | null;
      detail: string;
    }
  | {
      kind: "ingest_progress";
      processed: number;
      total: number;
      detail: string;
    };

const BWSIM_EXPORT_COMPLETE_PATTERN = /\[bwsim\]\s+extraction completed in\s+\d+(?:\.\d+)?s/iu;
const TIMELINE_ANALYSIS_PATTERN =
  /\[analysis\]\s+(\d+(?:\.\d+)?)%\s+elapsed\s+(\d+(?:\.\d+)?)s/iu;
const INGEST_PROGRESS_PATTERN =
  /Ingest batch\s+\d+:\s+(\d+)\/(\d+)\s+replays processed/iu;

export function parseAnalysisOutputProgress(
  message: string
): AnalysisOutputProgressEvent | null {
  if (BWSIM_EXPORT_COMPLETE_PATTERN.test(message)) {
    return { kind: "replay_export_stage_complete" };
  }

  const timelineAnalysis = TIMELINE_ANALYSIS_PATTERN.exec(message);
  if (timelineAnalysis) {
    return {
      kind: "timeline_analysis",
      percent: clampPercent(Number(timelineAnalysis[1])),
      elapsedSeconds: Number(timelineAnalysis[2]),
      detail: `Reading replay data • ${formatElapsed(Number(timelineAnalysis[2]))}`
    };
  }

  const ingestProgress = INGEST_PROGRESS_PATTERN.exec(message);
  if (ingestProgress) {
    return {
      kind: "ingest_progress",
      processed: Number(ingestProgress[1]),
      total: Number(ingestProgress[2]),
      detail: `${ingestProgress[1]} of ${ingestProgress[2]} replays added`
    };
  }

  return null;
}

export function replayProgressFromAnalysisPercent(percent: number): number {
  return clampPercent(50 + percent * 0.45);
}

export function finalizingReplayProgressPercent(): number {
  return 97;
}

export function progressModeLabel(mode: ProgressMode): string | null {
  return mode === "estimated" ? "Estimated" : null;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, value));
}

function formatElapsed(elapsedSeconds: number): string {
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = Math.floor(elapsedSeconds % 60);
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

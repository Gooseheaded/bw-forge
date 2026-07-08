import type { ProgressMode } from "../shared/contracts";

export type AnalysisOutputProgressEvent =
  | {
      kind: "replay_export_exact";
      percent: number;
      detail: string;
    }
  | {
      kind: "replay_export_heartbeat";
      elapsedSeconds: number;
      detail: string;
    }
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

const REPLAY_EXPORT_EXACT_PATTERN =
  /\[replay-export\]\s+progress\b.*?\btime=([0-9:]+)\b.*?\b(\d+(?:\.\d+)?)%/iu;
const REPLAY_EXPORT_HEARTBEAT_PATTERN =
  /\[replay-export\]\s+running\.\.\.\s+elapsed\s+(\d+(?:\.\d+)?)s/iu;
const PIPELINE_EXPORT_COMPLETE_PATTERN =
  /\[pipeline\]\s+50(?:\.0+)?%\s+replay export complete/iu;
const TIMELINE_ANALYSIS_PATTERN =
  /\[analysis\]\s+(\d+(?:\.\d+)?)%\s+elapsed\s+(\d+(?:\.\d+)?)s/iu;
const INGEST_PROGRESS_PATTERN =
  /Ingest batch\s+\d+:\s+(\d+)\/(\d+)\s+replays processed/iu;

export function parseAnalysisOutputProgress(
  message: string
): AnalysisOutputProgressEvent | null {
  const replayExportExact = REPLAY_EXPORT_EXACT_PATTERN.exec(message);
  if (replayExportExact) {
    return {
      kind: "replay_export_exact",
      percent: clampPercent(Number(replayExportExact[2])),
      detail: `Replay playback ${replayExportExact[1]}`
    };
  }

  const replayExportHeartbeat = REPLAY_EXPORT_HEARTBEAT_PATTERN.exec(message);
  if (replayExportHeartbeat) {
    return {
      kind: "replay_export_heartbeat",
      elapsedSeconds: Number(replayExportHeartbeat[1]),
      detail: `Replay playback ${formatElapsed(Number(replayExportHeartbeat[1]))}`
    };
  }

  if (PIPELINE_EXPORT_COMPLETE_PATTERN.test(message)) {
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

export function estimateReplayExportPercent(elapsedSeconds: number): number {
  const elapsed = Math.max(0, elapsedSeconds);
  if (elapsed <= 5) {
    return interpolate(elapsed, 0, 5, 0, 12);
  }
  if (elapsed <= 30) {
    return interpolate(elapsed, 5, 30, 12, 45);
  }
  if (elapsed <= 90) {
    return interpolate(elapsed, 30, 90, 45, 80);
  }
  const overage = elapsed - 90;
  return Math.min(92, 80 + 12 * (1 - Math.exp(-overage / 45)));
}

export function replayProgressFromExactExportPercent(percent: number): number {
  return clampPercent(percent * 0.5);
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

function interpolate(value: number, inputMin: number, inputMax: number, outputMin: number, outputMax: number): number {
  const fraction = (value - inputMin) / (inputMax - inputMin);
  return outputMin + (outputMax - outputMin) * fraction;
}

function formatElapsed(elapsedSeconds: number): string {
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = Math.floor(elapsedSeconds % 60);
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

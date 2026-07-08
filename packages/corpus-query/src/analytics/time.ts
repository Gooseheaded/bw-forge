export function formatSecondsClock(seconds: number): string {
  if (!Number.isFinite(seconds)) {
    return "unknown";
  }
  const rounded = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(rounded / 60);
  const remainingSeconds = rounded % 60;
  return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

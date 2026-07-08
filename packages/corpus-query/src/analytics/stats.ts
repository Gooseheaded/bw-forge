export interface NumericSummary {
  min: number;
  p25: number;
  median: number;
  p75: number;
  max: number;
  mean: number;
}

export function mean(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function percentile(values: number[], percentileValue: number): number | null {
  if (values.length === 0) {
    return null;
  }
  if (percentileValue <= 0) {
    return values[0] ?? null;
  }
  if (percentileValue >= 1) {
    return values[values.length - 1] ?? null;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = (sorted.length - 1) * percentileValue;
  const lowerIndex = Math.floor(index);
  const upperIndex = Math.ceil(index);
  const lowerValue = sorted[lowerIndex] ?? sorted[sorted.length - 1]!;
  const upperValue = sorted[upperIndex] ?? sorted[sorted.length - 1]!;
  if (lowerIndex === upperIndex) {
    return lowerValue;
  }
  const weight = index - lowerIndex;
  return lowerValue + (upperValue - lowerValue) * weight;
}

export function summarizeNumbers(values: number[]): NumericSummary | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  return {
    min: sorted[0]!,
    p25: percentile(sorted, 0.25)!,
    median: percentile(sorted, 0.5)!,
    p75: percentile(sorted, 0.75)!,
    max: sorted[sorted.length - 1]!,
    mean: mean(sorted)!
  };
}

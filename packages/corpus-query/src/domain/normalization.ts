const BUILD_ORDER_LINE_PATTERN =
  /^(?<minutes>\d+):(?<seconds>[0-5]\d)(?:\s+\[(?<supplyUsed>\d+)\/(?<supplyMax>\d+)\])?\s+(?<item>.+)$/;

export interface ParsedBuildOrderLine {
  timeSeconds: number;
  supplyUsed: number | null;
  supplyMax: number | null;
  item: string;
  rawLine: string;
}

export function parseBuildOrderLine(rawLine: string): ParsedBuildOrderLine {
  const line = rawLine.trim();
  const match = BUILD_ORDER_LINE_PATTERN.exec(line);
  if (!match?.groups) {
    throw new Error(`Invalid build_order.txt line: ${rawLine}`);
  }

  const { minutes, seconds, item, supplyUsed, supplyMax } = match.groups;
  if (!minutes || !seconds || !item) {
    throw new Error(`Invalid build_order.txt line: ${rawLine}`);
  }

  return {
    timeSeconds: Number.parseInt(minutes, 10) * 60 + Number.parseInt(seconds, 10),
    supplyUsed: supplyUsed ? Number.parseInt(supplyUsed, 10) : null,
    supplyMax: supplyMax ? Number.parseInt(supplyMax, 10) : null,
    item: item.trim(),
    rawLine
  };
}

export function normalizeName(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

export function normalizeAsArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

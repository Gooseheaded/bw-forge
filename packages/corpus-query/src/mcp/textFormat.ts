import type { NumericSummary } from "../analytics/stats.js";
import { formatSecondsClock } from "../analytics/time.js";

const DEFAULT_TEXT_ROW_LIMIT = 25;
const MAX_TEXT_ROW_LIMIT = 50;

type FiltersRecord = Record<string, unknown>;

type CorpusSummaryResult = {
  filters: FiltersRecord;
  replayCount: number;
  playerCount: number;
  matchups: Array<{ matchup: string; replayCount: number }>;
  races: Array<{ race: string; playerRows: number }>;
  maps: Array<{ map: string; replayCount: number }>;
  dataAvailability: {
    buildOrderEvents: boolean;
    economySamples: boolean;
    supplySamples: boolean;
    unitCountSamples: boolean;
    deathEvents: boolean;
  };
};

type PlayerListResult = {
  filters: FiltersRecord;
  players: Array<{
    name: string;
    races: string[];
    replayCount: number;
    matchups: Array<{ matchup: string; replayCount: number }>;
  }>;
};

type MatchupListResult = {
  filters: FiltersRecord;
  matchups: Array<{ matchup: string; replayCount: number; playerRows: number }>;
};

type BuildItemListResult = {
  filters: FiltersRecord;
  items: Array<{ name: string; count: number; replayCount: number }>;
};

type BuildItemSearchResult = {
  query: string;
  filters: FiltersRecord;
  matches: Array<{ name: string; count: number; replayCount: number }>;
};

type UnitTypeListResult = {
  source: "unit_counts" | "deaths" | "both";
  filters: FiltersRecord;
  units: Array<{ name: string; unitCountSampleCount: number; deathEventCount: number }>;
};

type EventTimingDistributionResult = {
  filters: FiltersRecord & { item?: unknown; n?: unknown };
  sampleSize: number;
  seconds: NumericSummary | null;
  times: { min: string; p25: string; median: string; p75: string; max: string } | null;
  examples: Array<{
    replayId: string;
    filename: string | null;
    player: string;
    opponent: string | null;
    race: string;
    matchup: string | null;
    timeSeconds: number;
    time: string;
  }>;
  hints?: string[];
};

type EventBeforeEventResult = {
  filters: FiltersRecord;
  condition: {
    first: { item: string; n: number };
    second: { item: string; n: number };
  };
  sampleSize: number;
  matchCount: number;
  percentage: number;
  missingFirstCount: number;
  missingSecondCount: number;
  examples: Array<{
    replayId: string;
    filename: string | null;
    player: string;
    opponent: string | null;
    firstTimeSeconds: number;
    firstTime: string;
    secondTimeSeconds: number;
    secondTime: string;
    deltaSeconds: number;
  }>;
  nonMatches: Array<{
    replayId: string;
    filename: string | null;
    player: string;
    opponent: string | null;
    firstTimeSeconds: number;
    firstTime: string;
    secondTimeSeconds: number;
    secondTime: string;
    deltaSeconds: number;
  }>;
};

type CompositionSnapshotResult = {
  filters: FiltersRecord & { timeSeconds?: unknown; time?: unknown };
  sampleSize: number;
  units: Record<string, NumericSummary>;
  examples: Array<{
    replayId: string;
    filename: string | null;
    player: string;
    opponent: string | null;
    time: string;
    units: Record<string, number>;
  }>;
};

type EconomyDistributionResult = {
  filters: FiltersRecord & { timeSeconds?: unknown; time?: unknown };
  sampleSize: number;
  workers: NumericSummary | null;
  minerals: NumericSummary | null;
  gas: NumericSummary | null;
  examples: Array<{
    replayId: string;
    filename: string | null;
    player: string;
    opponent: string | null;
    workers: number | null;
    minerals: number;
    gas: number;
  }>;
};

type DeathSummaryResult = {
  filters: FiltersRecord & { start?: unknown; end?: unknown };
  sampleSize: number;
  lost: Array<{ unit: string; count: number; perReplayMean: number }>;
  killed: Array<{ unit: string; count: number; perReplayMean: number }>;
  examples: Array<{
    replayId: string;
    filename: string | null;
    player: string;
    opponent: string | null;
    lost: Record<string, number>;
    killed: Record<string, number>;
  }>;
};

type ReplayCardResult = {
  replayId: string;
  filename: string | null;
  map: string | null;
  duration: string;
  player: { name: string; race: string };
  opponent: { name: string | null; race: string | null };
  matchup: string | null;
  buildAnchors?: Array<{ item: string; n: number; time: string }>;
  economyBenchmarks?: Array<{ time: string; workers: number | null }>;
  combatSummary?: Array<{ window: string; lost: Record<string, number>; killed: Record<string, number> }>;
};

type DescribeSchemaResult = {
  tables: Array<{
    name: string;
    type: string;
    purpose: string | null;
    columns: Array<{
      name: string;
      type: string;
      nullable: boolean;
      primaryKey: boolean;
      defaultValue: string | null;
    }>;
    indexes?: Array<{
      name: string;
      unique: boolean;
      columns: string[];
    }>;
  }>;
  joinHints: Array<{
    left: string;
    right: string;
    on: string[];
  }>;
};

type SchemaNotesResult = {
  topic: string;
  notes: Array<{
    topic: string;
    title: string;
    bullets: string[];
  }>;
};

type QueryExamplesResult = {
  topic: string;
  examples: Array<{
    title: string;
    topic: string;
    sql: string;
    notes: string[];
  }>;
};

type ReadonlySqlValidationResult = {
  allowed: boolean;
  statementKind: string;
  effectiveMaxRows: number;
  warnings: string[];
  blockedReasons: string[];
};

type ExecuteReadonlySqlResult = {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
  maxRows: number;
  executionMs: number;
  warnings?: string[];
};

type PrimitiveToolResult = { count: number; results: unknown[] };

export function formatServerInfoText(serverInfo: {
  package_name: string;
  package_version: string;
  supported_tools: string[];
}): string {
  const preview = serverInfo.supported_tools.slice(0, 8).join(", ");
  return [
    `Running ${serverInfo.package_name}@${serverInfo.package_version}.`,
    `Tools available: ${serverInfo.supported_tools.length}.`,
    `Examples: ${preview}${serverInfo.supported_tools.length > 8 ? ", ..." : "."}`
  ].join("\n");
}

export function formatCorpusSummaryText(result: CorpusSummaryResult): string {
  return [
    `Corpus summary${formatFilterSuffix(result.filters)}:`,
    `- Replays: ${result.replayCount}`,
    `- Distinct players: ${result.playerCount}`,
    formatCountSection("Matchups", result.matchups, (row) => `${row.matchup} — ${row.replayCount} replay${plural(row.replayCount)}`),
    formatCountSection("Races", result.races, (row) => `${row.race} — ${row.playerRows} player row${plural(row.playerRows)}`),
    formatCountSection("Maps", result.maps, (row) => `${row.map} — ${row.replayCount} replay${plural(row.replayCount)}`),
    [
      "Data availability:",
      `- Build orders: ${yesNo(result.dataAvailability.buildOrderEvents)}`,
      `- Economy: ${yesNo(result.dataAvailability.economySamples)}`,
      `- Supply: ${yesNo(result.dataAvailability.supplySamples)}`,
      `- Unit counts: ${yesNo(result.dataAvailability.unitCountSamples)}`,
      `- Deaths: ${yesNo(result.dataAvailability.deathEvents)}`
    ].join("\n")
  ].join("\n\n");
}

export function formatListPlayersText(result: PlayerListResult): string {
  if (result.players.length === 0) {
    return `Found 0 players${formatFilterSuffix(result.filters)}.`;
  }
  return [
    `Found ${result.players.length} player${plural(result.players.length)}${formatFilterSuffix(result.filters)}.`,
    formatRankedSection(
      "Players",
      result.players,
      (player) =>
        `${player.name} — ${player.replayCount} replay${plural(player.replayCount)} — races: ${player.races.join(", ")} — matchups: ${player.matchups.map((matchup) => `${matchup.matchup} (${matchup.replayCount})`).join(", ")}`
    )
  ].join("\n\n");
}

export function formatListMatchupsText(result: MatchupListResult): string {
  if (result.matchups.length === 0) {
    return `Found 0 matchups${formatFilterSuffix(result.filters)}.`;
  }
  return [
    `Found ${result.matchups.length} matchup${plural(result.matchups.length)}${formatFilterSuffix(result.filters)}.`,
    formatRankedSection(
      "Matchups",
      result.matchups,
      (matchup) => `${matchup.matchup} — ${matchup.replayCount} replay${plural(matchup.replayCount)}, ${matchup.playerRows} player row${plural(matchup.playerRows)}`
    )
  ].join("\n\n");
}

export function formatListBuildItemsText(result: BuildItemListResult): string {
  if (result.items.length === 0) {
    return `Found 0 build items${formatFilterSuffix(result.filters)}.`;
  }
  return [
    `Found ${result.items.length} build item${plural(result.items.length)}${formatFilterSuffix(result.filters)}.`,
    formatRankedSection(
      "Top build items",
      result.items,
      (item) => `${item.name} — ${item.replayCount} replay${plural(item.replayCount)}, ${item.count} event${plural(item.count)}`
    )
  ].join("\n\n");
}

export function formatSearchBuildItemsText(result: BuildItemSearchResult): string {
  if (result.matches.length === 0) {
    return [
      `Found 0 build item matches for "${result.query}"${formatFilterSuffix(result.filters)}.`,
      `Try a broader substring or call list_build_items${formatFilterSuffix(result.filters)}.`
    ].join("\n\n");
  }
  return [
    `Found ${result.matches.length} build item match${plural(result.matches.length)} for "${result.query}"${formatFilterSuffix(result.filters)}.`,
    formatRankedSection(
      "Matches",
      result.matches,
      (item) => `${item.name} — ${item.replayCount} replay${plural(item.replayCount)}, ${item.count} event${plural(item.count)}`
    )
  ].join("\n\n");
}

export function formatListUnitTypesText(result: UnitTypeListResult): string {
  if (result.units.length === 0) {
    return `Found 0 unit types from ${result.source}${formatFilterSuffix(result.filters)}.`;
  }
  return [
    `Found ${result.units.length} unit type${plural(result.units.length)} from ${result.source}${formatFilterSuffix(result.filters)}.`,
    formatRankedSection(
      "Units",
      result.units,
      (unit) => `${unit.name} — unit-count samples: ${unit.unitCountSampleCount}, death events: ${unit.deathEventCount}`
    )
  ].join("\n\n");
}

export function formatEventTimingDistributionText(result: EventTimingDistributionResult): string {
  const item = String(result.filters.item ?? "event");
  const n = Number(result.filters.n ?? 1);
  const header = `${item} #${n} timing${formatFilterSuffix(result.filters)}:`;
  if (result.sampleSize === 0 || !result.seconds || !result.times) {
    return [header, "- Sample size: 0", ...(result.hints ?? [])].join("\n");
  }
  return [
    header,
    `- Sample size: ${result.sampleSize} replay${plural(result.sampleSize)}`,
    `- Median: ${result.times.median}`,
    `- IQR: ${result.times.p25}-${result.times.p75}`,
    `- Range: ${result.times.min}-${result.times.max}`,
    `- Mean: ${formatSecondsClock(result.seconds.mean)}`,
    formatExampleSection(
      "Examples",
      result.examples,
      (example) => `${example.filename ?? example.replayId} — ${example.player}${example.opponent ? ` vs ${example.opponent}` : ""} — ${example.time}`
    )
  ].join("\n\n");
}

export function formatEventBeforeEventText(result: EventBeforeEventResult): string {
  const header = `${result.condition.first.item} #${result.condition.first.n} before ${result.condition.second.item} #${result.condition.second.n}${formatFilterSuffix(result.filters)}:`;
  const parts = [
    header,
    `- Matches: ${result.matchCount} / ${result.sampleSize} replay${plural(result.sampleSize)}`,
    `- Percentage: ${result.percentage}%`,
    `- Missing ${result.condition.first.item} #${result.condition.first.n}: ${result.missingFirstCount}`,
    `- Missing ${result.condition.second.item} #${result.condition.second.n}: ${result.missingSecondCount}`
  ];
  if (result.examples.length > 0) {
    parts.push(
      formatExampleSection(
        "Examples",
        result.examples,
        (example) =>
          `${example.filename ?? example.replayId} — ${example.firstTime} then ${example.secondTime} — delta ${formatSignedDuration(example.deltaSeconds)}`
      )
    );
  }
  if (result.nonMatches.length > 0) {
    parts.push(
      formatExampleSection(
        "Non-matches",
        result.nonMatches,
        (example) =>
          `${example.filename ?? example.replayId} — ${example.firstTime} then ${example.secondTime} — delta ${formatSignedDuration(example.deltaSeconds)}`
      )
    );
  }
  return parts.join("\n\n");
}

export function formatCompositionSnapshotText(result: CompositionSnapshotResult): string {
  const timeLabel = String(result.filters.time ?? formatSecondsClock(Number(result.filters.timeSeconds ?? 0)));
  const unitEntries = Object.entries(result.units);
  if (unitEntries.length === 0) {
    return `Composition snapshot at ${timeLabel}${formatFilterSuffix(result.filters)} has 0 samples.`;
  }
  return [
    `Composition snapshot at ${timeLabel}${formatFilterSuffix(result.filters)}:`,
    `- Sample size: ${result.sampleSize} replay${plural(result.sampleSize)}`,
    formatRankedSection(
      "Units",
      unitEntries,
      ([unit, stats]) =>
        `${unit}: median ${formatNumber(stats.median)}, IQR ${formatNumber(stats.p25)}-${formatNumber(stats.p75)}, range ${formatNumber(stats.min)}-${formatNumber(stats.max)}`
    ),
    formatExampleSection(
      "Examples",
      result.examples,
      (example) => `${example.filename ?? example.replayId} — ${formatUnitCounts(example.units)}`
    )
  ].join("\n\n");
}

export function formatEconomyDistributionText(result: EconomyDistributionResult): string {
  const timeLabel = String(result.filters.time ?? formatSecondsClock(Number(result.filters.timeSeconds ?? 0)));
  const lines = [
    `Economy snapshot at ${timeLabel}${formatFilterSuffix(result.filters)}:`,
    `- Sample size: ${result.sampleSize} replay${plural(result.sampleSize)}`
  ];
  if (result.workers) {
    lines.push(`- Workers: median ${formatNumber(result.workers.median)}, IQR ${formatNumber(result.workers.p25)}-${formatNumber(result.workers.p75)}, range ${formatNumber(result.workers.min)}-${formatNumber(result.workers.max)}`);
  }
  if (result.minerals) {
    lines.push(`- Minerals: median ${formatNumber(result.minerals.median)}, IQR ${formatNumber(result.minerals.p25)}-${formatNumber(result.minerals.p75)}`);
  }
  if (result.gas) {
    lines.push(`- Gas: median ${formatNumber(result.gas.median)}, IQR ${formatNumber(result.gas.p25)}-${formatNumber(result.gas.p75)}`);
  }
  if (result.examples.length > 0) {
    lines.push("");
    lines.push(formatExampleSection("Examples", result.examples, (example) => `${example.filename ?? example.replayId} — workers ${example.workers ?? "unknown"}, minerals ${example.minerals}, gas ${example.gas}`));
  }
  return lines.join("\n");
}

export function formatDeathSummaryText(result: DeathSummaryResult): string {
  const start = String(result.filters.start ?? formatSecondsClock(Number(result.filters.startSeconds ?? 0)));
  const end = String(result.filters.end ?? formatSecondsClock(Number(result.filters.endSeconds ?? 0)));
  const sections = [
    `Death summary${formatFilterSuffix(result.filters)}, ${start}-${end}:`,
    `- Sample size: ${result.sampleSize} replay/player row${plural(result.sampleSize)}`
  ];
  sections.push("");
  sections.push(formatRankedSection("Lost", result.lost, (row) => `${row.unit}: ${row.count} total, ${row.perReplayMean} per replay`));
  sections.push("");
  sections.push(formatRankedSection("Killed", result.killed, (row) => `${row.unit}: ${row.count} total, ${row.perReplayMean} per replay`));
  if (result.examples.length > 0) {
    sections.push("");
    sections.push(
      formatExampleSection(
        "Examples",
        result.examples,
        (example) => `${example.filename ?? example.replayId} — lost ${formatUnitCounts(example.lost)} — killed ${formatUnitCounts(example.killed)}`
      )
    );
  }
  return sections.join("\n");
}

export function formatReplayCardText(result: ReplayCardResult): string {
  const lines = [
    `Replay card: ${result.filename ?? result.replayId}`,
    `- Replay ID: ${result.replayId}`,
    `- Matchup: ${result.matchup ?? "unknown"}`,
    `- Map: ${result.map ?? "unknown"}`,
    `- Duration: ${result.duration}`,
    `- Player: ${result.player.name} (${result.player.race})`,
    `- Opponent: ${result.opponent.name ?? "unknown"} (${result.opponent.race ?? "unknown"})`
  ];
  if (result.buildAnchors && result.buildAnchors.length > 0) {
    lines.push("");
    lines.push("Build anchors:");
    for (const anchor of capRows(result.buildAnchors, 12).rows) {
      lines.push(`- ${anchor.item} #${anchor.n} — ${anchor.time}`);
    }
  }
  if (result.economyBenchmarks && result.economyBenchmarks.length > 0) {
    lines.push("");
    lines.push("Economy benchmarks:");
    for (const benchmark of result.economyBenchmarks) {
      lines.push(`- ${benchmark.time} — workers ${benchmark.workers ?? "unknown"}`);
    }
  }
  if (result.combatSummary && result.combatSummary.length > 0) {
    lines.push("");
    lines.push("Combat summary:");
    for (const window of result.combatSummary) {
      lines.push(`- ${window.window} — lost ${formatUnitCounts(window.lost)} — killed ${formatUnitCounts(window.killed)}`);
    }
  }
  return lines.join("\n");
}

export function formatDescribeSchemaText(result: DescribeSchemaResult): string {
  const sections = ["Corpus SQLite schema:", "", "Tables:"];
  const { rows: displayedTables, limit } = capRows(result.tables, 12);
  for (const [index, table] of displayedTables.entries()) {
    sections.push(`${index + 1}. ${table.name}`);
    for (const column of table.columns) {
      const columnParts = [
        `${column.name} ${column.type || "TEXT"}`,
        column.primaryKey ? "PRIMARY KEY" : null,
        column.nullable ? null : "NOT NULL"
      ].filter(Boolean);
      sections.push(`   - ${columnParts.join(" ")}`);
    }
    if (table.purpose) {
      sections.push(`   Purpose: ${table.purpose}`);
    }
    if (table.indexes && table.indexes.length > 0) {
      sections.push(`   Indexes: ${table.indexes.map((indexDescription) => `${indexDescription.name} (${indexDescription.columns.join(", ")})`).join("; ")}`);
    }
    sections.push("");
  }
  if (result.tables.length > displayedTables.length) {
    sections.push(formatTruncationNotice(displayedTables.length, result.tables.length, limit));
    sections.push("");
  }
  if (result.joinHints.length > 0) {
    sections.push("Common joins:");
    for (const hint of result.joinHints) {
      sections.push(`- ${hint.left} joins ${hint.right} on ${hint.on.join(" + ")}`);
    }
  }
  return sections.join("\n").trim();
}

export function formatSchemaNotesText(result: SchemaNotesResult): string {
  const sections = ["Schema notes:"];
  for (const note of result.notes) {
    sections.push("");
    sections.push(`${note.title}:`);
    for (const bullet of note.bullets) {
      sections.push(`- ${bullet}`);
    }
  }
  return sections.join("\n");
}

export function formatListQueryExamplesText(result: QueryExamplesResult): string {
  if (result.examples.length === 0) {
    return `Query examples for topic ${result.topic}: none available.`;
  }
  const lines = [`Query examples for topic: ${result.topic}`];
  const { rows: displayedExamples, limit } = capRows(result.examples, 10);
  for (const [index, example] of displayedExamples.entries()) {
    lines.push("");
    lines.push(`Example ${index + 1}: ${example.title}`);
    lines.push("");
    lines.push(example.sql);
    if (example.notes.length > 0) {
      lines.push("");
      for (const note of example.notes) {
        lines.push(`- ${note}`);
      }
    }
  }
  if (result.examples.length > displayedExamples.length) {
    lines.push("");
    lines.push(formatTruncationNotice(displayedExamples.length, result.examples.length, limit));
  }
  return lines.join("\n");
}

export function formatValidateReadonlySqlText(result: ReadonlySqlValidationResult): string {
  const lines = [
    result.allowed ? "Read-only SQL validation passed." : "Read-only SQL validation failed.",
    `- Statement kind: ${result.statementKind}`,
    `- Effective max rows: ${result.effectiveMaxRows}`
  ];
  if (result.warnings.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    for (const warning of result.warnings) {
      lines.push(`- ${warning}`);
    }
  }
  if (result.blockedReasons.length > 0) {
    lines.push("");
    lines.push("Blocked reasons:");
    for (const reason of result.blockedReasons) {
      lines.push(`- ${reason}`);
    }
  }
  return lines.join("\n");
}

export function formatExecuteReadonlySqlText(result: ExecuteReadonlySqlResult): string {
  const lines = [
    `Read-only SQL query returned ${result.rowCount} row${plural(result.rowCount)} in ${result.executionMs} ms.`,
    "",
    "Columns:"
  ];
  for (const column of result.columns) {
    lines.push(`- ${column}`);
  }
  lines.push("");
  if (result.rows.length === 0) {
    lines.push("Rows: none");
  } else {
    lines.push("Rows:");
    const { rows: displayedRows, limit } = capRows(result.rows);
    for (const [index, row] of displayedRows.entries()) {
      lines.push(`${index + 1}. ${row.map(formatCellValue).join(" | ")}`);
    }
    lines.push(formatTruncationNotice(displayedRows.length, result.rowCount + (result.truncated ? 1 : 0), limit));
  }
  if (result.truncated) {
    lines.push(`Result rows were capped at ${result.maxRows}.`);
  }
  if (result.warnings && result.warnings.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    for (const warning of result.warnings) {
      lines.push(`- ${warning}`);
    }
  }
  return lines.join("\n");
}

export function formatPrimitiveToolText(toolName: string, payload: PrimitiveToolResult): string {
  switch (toolName) {
    case "find_replays":
      return formatPrimitiveReplayList(payload);
    case "find_first_event":
    case "find_nth_event":
      return formatPrimitiveEventLookup(toolName, payload);
    case "list_build_events":
      return formatPrimitiveBuildEventList(payload);
    case "get_unit_count":
      return formatPrimitiveUnitCounts(payload);
    case "get_economy":
      return formatPrimitiveEconomy(payload);
    case "get_deaths":
      return formatPrimitiveDeaths(payload);
    default:
      return `Returned ${payload.count} result${plural(payload.count)}.`;
  }
}

function formatPrimitiveReplayList(payload: PrimitiveToolResult): string {
  if (payload.count === 0) {
    return "Found 0 replays.";
  }
  const rows = payload.results as Array<{
    replay_id: string;
    source_replay_filename: string | null;
    matchup: string | null;
    duration_seconds: number | null;
    players: Array<{ name: string; race: string }>;
  }>;
  return [
    `Found ${payload.count} replay${plural(payload.count)}.`,
    formatRankedSection(
      "Replays",
      rows,
      (row) =>
        `${row.source_replay_filename ?? row.replay_id} — ${row.matchup ?? "unknown"} — ${row.duration_seconds === null ? "unknown" : formatSecondsClock(row.duration_seconds)} — players: ${row.players.map((player) => `${player.name} (${player.race})`).join(", ")}`,
      payload.count
    )
  ].join("\n\n");
}

function formatPrimitiveEventLookup(toolName: string, payload: PrimitiveToolResult): string {
  if (payload.count === 0) {
    return `Found 0 ${toolName === "find_first_event" ? "first" : "nth"} event results.`;
  }
  const rows = payload.results as Array<{
    replay_id: string;
    source_replay_filename: string | null;
    player_name: string;
    target_name: string;
    event: { time_seconds: number; item: string } | null;
    n?: number;
  }>;
  const label = toolName === "find_first_event" ? "Event timings" : "Nth event timings";
  return [
    `Found ${payload.count} ${toolName === "find_first_event" ? "first-event" : "nth-event"} result${plural(payload.count)}.`,
    formatRankedSection(
      label,
      rows,
      (row) =>
        `${row.source_replay_filename ?? row.replay_id} — ${row.player_name} vs ${row.target_name} — ${row.event ? `${row.event.item} at ${formatSecondsClock(row.event.time_seconds)}` : "no matching event"}`
    )
  ].join("\n\n");
}

function formatPrimitiveBuildEventList(payload: PrimitiveToolResult): string {
  if (payload.count === 0) {
    return "Found 0 build events.";
  }
  const rows = payload.results as Array<{
    replay_id: string;
    source_replay_filename: string | null;
    player_name: string;
    target_name: string;
    event: { time_seconds: number; item: string; raw_line: string };
  }>;
  return [
    `Found ${payload.count} build event${plural(payload.count)}.`,
    formatRankedSection(
      "Build events",
      rows,
      (row) => `${row.source_replay_filename ?? row.replay_id} — ${row.player_name} vs ${row.target_name} — ${formatSecondsClock(row.event.time_seconds)} ${row.event.item}`,
      payload.count
    )
  ].join("\n\n");
}

function formatPrimitiveUnitCounts(payload: PrimitiveToolResult): string {
  if (payload.count === 0) {
    return "Found 0 unit-count samples.";
  }
  const rows = payload.results as Array<{
    replay_id: string;
    source_replay_filename: string | null;
    player_name: string;
    target_name: string;
    sample: { time_seconds: number; unit_type: string; count: number } | null;
  }>;
  return [
    `Found ${payload.count} unit-count result${plural(payload.count)}.`,
    formatRankedSection(
      "Unit counts",
      rows,
      (row) =>
        `${row.source_replay_filename ?? row.replay_id} — ${row.player_name} vs ${row.target_name} — ${row.sample ? `${row.sample.unit_type} ${row.sample.count} at ${formatSecondsClock(row.sample.time_seconds)}` : "no sample"}`
    )
  ].join("\n\n");
}

function formatPrimitiveEconomy(payload: PrimitiveToolResult): string {
  if (payload.count === 0) {
    return "Found 0 economy samples.";
  }
  const rows = payload.results as Array<{
    replay_id: string;
    source_replay_filename: string | null;
    player_name: string;
    target_name: string;
    sample: { time_seconds: number; workers: number | null; minerals: number; gas: number } | null;
  }>;
  return [
    `Found ${payload.count} economy result${plural(payload.count)}.`,
    formatRankedSection(
      "Economy samples",
      rows,
      (row) =>
        `${row.source_replay_filename ?? row.replay_id} — ${row.player_name} vs ${row.target_name} — ${row.sample ? `${formatSecondsClock(row.sample.time_seconds)} workers ${row.sample.workers ?? "unknown"}, minerals ${row.sample.minerals}, gas ${row.sample.gas}` : "no sample"}`
    )
  ].join("\n\n");
}

function formatPrimitiveDeaths(payload: PrimitiveToolResult): string {
  if (payload.count === 0) {
    return "Found 0 death windows.";
  }
  const rows = payload.results as Array<{
    replay_id: string;
    source_replay_filename: string | null;
    player_name: string;
    target_name: string;
    deaths: Array<{ unit_type: string }>;
  }>;
  return [
    `Found ${payload.count} death-window result${plural(payload.count)}.`,
    formatRankedSection(
      "Death windows",
      rows,
      (row) => `${row.source_replay_filename ?? row.replay_id} — ${row.player_name} vs ${row.target_name} — ${row.deaths.length} death${plural(row.deaths.length)}${row.deaths.length > 0 ? ` (${formatTopUnitNames(row.deaths.map((death) => death.unit_type))})` : ""}`
    )
  ].join("\n\n");
}

function formatCountSection<T>(label: string, rows: T[], renderRow: (row: T) => string): string {
  if (rows.length === 0) {
    return `${label}: none`;
  }
  return formatRankedSection(label, rows, renderRow, rows.length);
}

function formatRankedSection<T>(label: string, rows: T[], renderRow: (row: T) => string, totalCount = rows.length): string {
  const { rows: displayedRows, limit } = capRows(rows);
  const lines = [label + ":"];
  for (const row of displayedRows) {
    lines.push(`- ${renderRow(row)}`);
  }
  lines.push(formatTruncationNotice(displayedRows.length, totalCount, limit));
  return lines.join("\n");
}

function formatExampleSection<T>(label: string, rows: T[], renderRow: (row: T) => string): string {
  if (rows.length === 0) {
    return `${label}: none`;
  }
  const { rows: displayedRows, limit } = capRows(rows, 5);
  const lines = [label + ":"];
  for (const row of displayedRows) {
    lines.push(`- ${renderRow(row)}`);
  }
  if (rows.length > displayedRows.length) {
    lines.push(formatTruncationNotice(displayedRows.length, rows.length, limit));
  }
  return lines.join("\n");
}

function formatFilterSuffix(filters: FiltersRecord): string {
  const parts: string[] = [];
  if (typeof filters.player === "string") {
    parts.push(`player ${filters.player}`);
  }
  if (typeof filters.opponent === "string") {
    parts.push(`opponent ${filters.opponent}`);
  }
  if (typeof filters.race === "string") {
    parts.push(`race ${filters.race}`);
  }
  if (typeof filters.opponentRace === "string") {
    parts.push(`opponent race ${filters.opponentRace}`);
  }
  if (typeof filters.matchup === "string") {
    parts.push(`matchup ${filters.matchup}`);
  }
  if (typeof filters.map === "string") {
    parts.push(`map ${filters.map}`);
  }
  return parts.length > 0 ? ` for ${parts.join(", ")}` : "";
}

function capRows<T>(rows: T[], preferredLimit = DEFAULT_TEXT_ROW_LIMIT): { rows: T[]; limit: number } {
  const limit = Math.max(1, Math.min(preferredLimit, MAX_TEXT_ROW_LIMIT));
  return {
    rows: rows.slice(0, limit),
    limit
  };
}

function formatTruncationNotice(displayedCount: number, totalCount: number, limit: number): string {
  if (totalCount <= displayedCount) {
    return `Showing ${displayedCount} of ${totalCount}. Full data is in structuredContent.`;
  }
  return `Showing ${displayedCount} of ${totalCount}. Use limit/filters for narrower results. Full data is in structuredContent. Text display cap: ${limit}.`;
}

function plural(count: number): string {
  return count === 1 ? "" : "s";
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatSignedDuration(seconds: number): string {
  const sign = seconds >= 0 ? "+" : "-";
  return `${sign}${formatSecondsClock(Math.abs(seconds))}`;
}

function formatUnitCounts(units: Record<string, number>): string {
  const entries = Object.entries(units);
  if (entries.length === 0) {
    return "none";
  }
  return entries
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 6)
    .map(([unit, count]) => `${unit} ${count}`)
    .join(", ");
}

function formatTopUnitNames(unitNames: string[]): string {
  const counts = new Map<string, number>();
  for (const unitName of unitNames) {
    counts.set(unitName, (counts.get(unitName) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 4)
    .map(([unitName, count]) => `${unitName} ${count}`)
    .join(", ");
}

function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return JSON.stringify(value);
}

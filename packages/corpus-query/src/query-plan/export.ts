import { createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { ZipFile } from "yazl";
import { discoverManifestPaths } from "../ingest/discovery.js";
import {
  executeQueryPlan,
  type QueryExecutorMode,
  type QueryExecutorResultV1,
  type QueryPlanV1
} from "./executor.js";

export interface QueryPlanExportWarning {
  kind: "invalid_manifest" | "missing_html" | "ambiguous_html" | "duplicate_replay_id";
  replay_id?: string;
  manifest_path?: string;
  message: string;
}

export interface QueryPlanExportSummary {
  out_path: string;
  coarse_count: number;
  matched_count: number;
  html_files_added: number;
  warning_count: number;
  warnings: QueryPlanExportWarning[];
}

interface HtmlArtifact {
  source_path: string;
  zip_path: string;
}

interface ExportReplayRow {
  replay_id: string;
  source_replay_filename: string | null;
  source_replay_path: string | null;
  matchup: string | null;
  self_player_name: string | null;
  self_owner: number | null;
  enemy_player_name: string | null;
  enemy_owner: number | null;
  first_mutalisk: EventLike | null;
  first_enemy_science_vessel: EventLike | null;
  mutalisk_count_at_420: UnitCountLike | null;
  economy_at_300: EconomyLike | null;
  deaths_300_480: DeathEvidenceLike;
  relative_html_path: string | null;
}

type EventLike = {
  time_seconds: number;
  supply_used: number | null;
  supply_max: number | null;
  item: string;
  raw_line: string;
};

type UnitCountLike = {
  time_seconds: number;
  unit_type: string;
  count: number;
};

type EconomyLike = {
  time_seconds: number;
  minerals: number;
  gas: number;
  gathered_minerals: number | null;
  gathered_gas: number | null;
  workers: number | null;
};

type DeathLike = {
  frame: number;
  time_seconds: number;
  dead_owner: number;
  unit_type: string;
  category: string;
};

type DeathEvidenceLike = {
  deaths: DeathLike[];
  summaries: {
    total_count: number;
    count_by_unit_type: Record<string, number>;
    count_by_category: Record<string, number>;
    first_time_seconds: number | null;
    last_time_seconds: number | null;
  };
};

export async function exportQueryPlanZip(input: {
  dbPath: string;
  plan: QueryPlanV1;
  htmlRoot: string;
  outPath: string;
  mode?: QueryExecutorMode;
}): Promise<QueryPlanExportSummary> {
  const result = await executeQueryPlan({
    dbPath: input.dbPath,
    plan: input.plan,
    mode: input.mode ?? "normal"
  });
  const matchedReplays = result.replay_results.filter((replay) => replay.matched);
  const htmlLookup = await discoverHtmlArtifacts(input.htmlRoot);
  const zip = new ZipFile();
  const usedZipPaths = new Set<string>();
  const rows: ExportReplayRow[] = [];
  const warnings = [...htmlLookup.warnings];
  let htmlFilesAdded = 0;

  for (const replay of matchedReplays) {
    const htmlSourcePath = htmlLookup.byReplayId.get(replay.replay_id) ?? null;
    let relativeHtmlPath: string | null = null;
    if (htmlSourcePath) {
      relativeHtmlPath = buildZipHtmlPath(replay.replay_id, htmlSourcePath, usedZipPaths);
      zip.addFile(htmlSourcePath, relativeHtmlPath);
      htmlFilesAdded += 1;
    } else {
      warnings.push({
        kind: "missing_html",
        replay_id: replay.replay_id,
        message: `No HTML artifact found under ${resolve(input.htmlRoot)} for replay ${replay.replay_id}`
      });
    }

    rows.push({
      replay_id: replay.replay_id,
      source_replay_filename: replay.source_replay_filename,
      source_replay_path: replay.source_replay_path,
      matchup: replay.matchup,
      self_player_name: replay.self_player_name,
      self_owner: replay.self_owner,
      enemy_player_name: replay.enemy_player_name,
      enemy_owner: replay.enemy_owner,
      first_mutalisk: findEventValue(result.plan, replay, { perspective: "self", item: "Mutalisk" }),
      first_enemy_science_vessel: findEventValue(result.plan, replay, { perspective: "enemy", item: "Science Vessel" }),
      mutalisk_count_at_420: findUnitCountValue(result.plan, replay, { perspective: "self", unit: "Mutalisk", at_seconds: 420 }),
      economy_at_300: findEconomyValue(result.plan, replay, { perspective: "self", at_seconds: 300 }),
      deaths_300_480: findDeathsValue(result.plan, replay, { perspective: "self", from_seconds: 300, to_seconds: 480 }),
      relative_html_path: relativeHtmlPath
    });
  }

  const readme = renderReadme(result, rows, warnings);
  const csv = renderMatchedReplaysCsv(rows);

  zip.addBuffer(Buffer.from(readme, "utf8"), "README.md");
  zip.addBuffer(Buffer.from(JSON.stringify(result.plan, null, 2) + "\n", "utf8"), "query-plan.json");
  zip.addBuffer(Buffer.from(JSON.stringify(result, null, 2) + "\n", "utf8"), "query-result.json");
  zip.addBuffer(Buffer.from(csv, "utf8"), "matched-replays.csv");

  await mkdir(dirname(resolve(input.outPath)), { recursive: true });
  await writeZipFile(zip, resolve(input.outPath));

  return {
    out_path: resolve(input.outPath),
    coarse_count: result.coarse_replay_ids.length,
    matched_count: matchedReplays.length,
    html_files_added: htmlFilesAdded,
    warning_count: warnings.length,
    warnings
  };
}

async function discoverHtmlArtifacts(htmlRoot: string): Promise<{
  byReplayId: Map<string, string>;
  warnings: QueryPlanExportWarning[];
}> {
  const byReplayId = new Map<string, string>();
  const warnings: QueryPlanExportWarning[] = [];
  const manifestPaths = await discoverManifestPaths(htmlRoot);

  for (const manifestPath of manifestPaths) {
    let manifest: unknown;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch (error) {
      warnings.push({
        kind: "invalid_manifest",
        manifest_path: manifestPath,
        message: `Failed to parse manifest: ${error instanceof Error ? error.message : String(error)}`
      });
      continue;
    }

    const replayId = readReplayId(manifest);
    if (!replayId) {
      warnings.push({
        kind: "invalid_manifest",
        manifest_path: manifestPath,
        message: "Manifest is missing replay_id"
      });
      continue;
    }

    if (byReplayId.has(replayId)) {
      warnings.push({
        kind: "duplicate_replay_id",
        replay_id: replayId,
        manifest_path: manifestPath,
        message: `Duplicate replay_id ${replayId} discovered while locating HTML artifacts`
      });
      continue;
    }

    const replayDir = dirname(manifestPath);
    const exactHtmlPath = join(replayDir, `${basename(replayDir)}.html`);
    if (await isExistingFile(exactHtmlPath)) {
      byReplayId.set(replayId, exactHtmlPath);
      continue;
    }

    const htmlFiles = (await readdir(replayDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === ".html")
      .map((entry) => join(replayDir, entry.name))
      .sort((left, right) => left.localeCompare(right));

    if (htmlFiles.length === 1 && htmlFiles[0]) {
      byReplayId.set(replayId, htmlFiles[0]);
      continue;
    }

    if (htmlFiles.length > 1) {
      warnings.push({
        kind: "ambiguous_html",
        replay_id: replayId,
        manifest_path: manifestPath,
        message: `Multiple HTML files found for replay ${replayId} in ${replayDir}`
      });
    }
  }

  return { byReplayId, warnings };
}

function readReplayId(manifest: unknown): string | null {
  if (!manifest || typeof manifest !== "object") {
    return null;
  }
  const replayId = (manifest as { replay_id?: unknown }).replay_id;
  return typeof replayId === "string" && replayId.length > 0 ? replayId : null;
}

async function isExistingFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

function buildZipHtmlPath(replayId: string, htmlPath: string, usedZipPaths: Set<string>): string {
  const baseName = basename(htmlPath).replace(/\\/g, "/");
  let candidate = `replays/${baseName}`;
  let suffix = 2;
  while (usedZipPaths.has(candidate)) {
    candidate = `replays/${replayId}-${suffix}-${baseName}`;
    suffix += 1;
  }
  usedZipPaths.add(candidate);
  return candidate;
}

function renderReadme(
  result: QueryExecutorResultV1,
  rows: ExportReplayRow[],
  warnings: QueryPlanExportWarning[]
): string {
  const constraintLines =
    result.plan.constraints.length > 0
      ? result.plan.constraints.map((constraint) => `- \`${constraint.id}\`: \`${JSON.stringify(constraint)}\``).join("\n")
      : "- none";
  const evidenceLines =
    result.plan.evidence_requests.length > 0
      ? result.plan.evidence_requests.map((request) => `- \`${request.id}\`: \`${JSON.stringify(request)}\``).join("\n")
      : "- none";
  const caveatLines =
    result.unsupported_or_approximate.length > 0
      ? result.unsupported_or_approximate
          .map((item) => `- \`${item.status}\` ${item.phrase}: ${item.reason}`)
          .join("\n")
      : "- none";
  const warningLines =
    warnings.length > 0
      ? warnings.map((warning) => `- ${warning.message}`).join("\n")
      : "- none";

  const tableHeader = [
    "| Replay | Matchup | Self | Enemy | First Muta | First Enemy Vessel | Muta@7 | Eco@5 (M/G/W) | Deaths 5:00-8:00 | HTML |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"
  ];
  const tableRows =
    rows.length > 0
      ? rows.map((row) =>
          [
            row.source_replay_filename ?? row.replay_id,
            row.matchup ?? "",
            row.self_player_name ?? "",
            row.enemy_player_name ?? "",
            formatClock(row.first_mutalisk?.time_seconds ?? null),
            formatClock(row.first_enemy_science_vessel?.time_seconds ?? null),
            row.mutalisk_count_at_420?.count ?? "",
            formatEconomyCompact(row.economy_at_300),
            formatDeathsCompact(row.deaths_300_480),
            row.relative_html_path ?? ""
          ]
            .map((cell) => String(cell).replace(/\|/g, "\\|"))
            .join(" | ")
            .replace(/^/, "| ")
            .concat(" |")
        )
      : ["| none |  |  |  |  |  |  |  |  |  |"];

  return [
    "# Query Plan Export",
    "",
    "## Summary",
    `- original query text: ${result.plan.query.original_text}`,
    `- matched replays: ${rows.length}`,
    `- coarse replay set: ${result.coarse_replay_ids.length}`,
    "",
    "## Replay Set",
    "```json",
    JSON.stringify(result.plan.replay_set, null, 2),
    "```",
    "",
    "## Constraints",
    constraintLines,
    "",
    "## Evidence Requests",
    evidenceLines,
    "",
    "## Caveats",
    caveatLines,
    "",
    "## Export Warnings",
    warningLines,
    "",
    "## Matched Replays",
    ...tableHeader,
    ...tableRows,
    ""
  ].join("\n");
}

function renderMatchedReplaysCsv(rows: ExportReplayRow[]): string {
  const headers = [
    "replay_id",
    "source_replay_filename",
    "matchup",
    "self_player_name",
    "enemy_player_name",
    "first_mutalisk_time_seconds",
    "first_mutalisk_time_clock",
    "first_enemy_science_vessel_time_seconds",
    "first_enemy_science_vessel_time_clock",
    "mutalisk_count_at_7m",
    "economy_minerals_at_5m",
    "economy_gas_at_5m",
    "economy_workers_at_5m",
    "death_total_5m_8m",
    "death_count_by_unit_type_5m_8m",
    "relative_html_path"
  ];
  const lines = [headers.map(toCsvCell).join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.replay_id,
        row.source_replay_filename ?? "",
        row.matchup ?? "",
        row.self_player_name ?? "",
        row.enemy_player_name ?? "",
        toNullableString(row.first_mutalisk?.time_seconds),
        formatClock(row.first_mutalisk?.time_seconds ?? null),
        toNullableString(row.first_enemy_science_vessel?.time_seconds),
        formatClock(row.first_enemy_science_vessel?.time_seconds ?? null),
        toNullableString(row.mutalisk_count_at_420?.count),
        toNullableString(row.economy_at_300?.minerals),
        toNullableString(row.economy_at_300?.gas),
        toNullableString(row.economy_at_300?.workers),
        String(row.deaths_300_480.summaries.total_count),
        JSON.stringify(row.deaths_300_480.summaries.count_by_unit_type),
        row.relative_html_path ?? ""
      ]
        .map(toCsvCell)
        .join(",")
    );
  }
  return lines.join("\n") + "\n";
}

function toCsvCell(value: string): string {
  return `"${value.replace(/"/g, "\"\"")}"`;
}

function findEventValue(
  plan: QueryPlanV1,
  replay: QueryExecutorResultV1["replay_results"][number],
  filters: { perspective: "self" | "enemy"; item: string }
): EventLike | null {
  for (const request of plan.evidence_requests) {
    if (request.type === "first_event" && request.perspective === filters.perspective && request.item.localeCompare(filters.item, undefined, { sensitivity: "accent" }) === 0) {
      return readEventValue(replay.evidence[request.id]?.value) ?? null;
    }
  }
  for (const constraint of plan.constraints) {
    if (
      (constraint.type === "first_event_before" || constraint.type === "first_event_after") &&
      constraint.perspective === filters.perspective &&
      constraint.item.localeCompare(filters.item, undefined, { sensitivity: "accent" }) === 0
    ) {
      return readEventValue(replay.constraint_results[constraint.id]?.value) ?? null;
    }
  }
  return null;
}

function findUnitCountValue(
  plan: QueryPlanV1,
  replay: QueryExecutorResultV1["replay_results"][number],
  filters: { perspective: "self" | "enemy"; unit: string; at_seconds: number }
): UnitCountLike | null {
  for (const request of plan.evidence_requests) {
    if (
      request.type === "unit_count_at" &&
      request.perspective === filters.perspective &&
      request.at_seconds === filters.at_seconds &&
      request.unit.localeCompare(filters.unit, undefined, { sensitivity: "accent" }) === 0
    ) {
      return readSampleValue<UnitCountLike>(replay.evidence[request.id]?.value) ?? null;
    }
  }
  for (const constraint of plan.constraints) {
    if (
      (constraint.type === "unit_count_at_least_at" || constraint.type === "unit_count_at_most_at") &&
      constraint.perspective === filters.perspective &&
      constraint.at_seconds === filters.at_seconds &&
      constraint.unit.localeCompare(filters.unit, undefined, { sensitivity: "accent" }) === 0
    ) {
      return readSampleValue<UnitCountLike>(replay.constraint_results[constraint.id]?.value) ?? null;
    }
  }
  return null;
}

function findEconomyValue(
  plan: QueryPlanV1,
  replay: QueryExecutorResultV1["replay_results"][number],
  filters: { perspective: "self" | "enemy"; at_seconds: number }
): EconomyLike | null {
  for (const request of plan.evidence_requests) {
    if (request.type === "economy_at" && request.perspective === filters.perspective && request.at_seconds === filters.at_seconds) {
      return readSampleValue<EconomyLike>(replay.evidence[request.id]?.value) ?? null;
    }
  }
  for (const constraint of plan.constraints) {
    if (
      (constraint.type === "economy_workers_at_least_at" || constraint.type === "economy_workers_at_most_at") &&
      constraint.perspective === filters.perspective &&
      constraint.at_seconds === filters.at_seconds
    ) {
      return readSampleValue<EconomyLike>(replay.constraint_results[constraint.id]?.value) ?? null;
    }
  }
  return null;
}

function findDeathsValue(
  plan: QueryPlanV1,
  replay: QueryExecutorResultV1["replay_results"][number],
  filters: { perspective: "self" | "enemy"; from_seconds: number; to_seconds: number }
): DeathEvidenceLike {
  for (const request of plan.evidence_requests) {
    if (
      request.type === "deaths_between" &&
      request.perspective === filters.perspective &&
      request.from_seconds === filters.from_seconds &&
      request.to_seconds === filters.to_seconds
    ) {
      const deathsValue = readDeathsValue(replay.evidence[request.id]?.value);
      const deaths = deathsValue?.deaths ?? [];
      const summaries = deathsValue?.summaries;
      return {
        deaths,
        summaries: normalizeDeathSummaries(deaths, summaries)
      };
    }
  }
  for (const constraint of plan.constraints) {
    if (
      (constraint.type === "deaths_count_at_least_between" || constraint.type === "deaths_count_at_most_between") &&
      constraint.perspective === filters.perspective &&
      constraint.from_seconds === filters.from_seconds &&
      constraint.to_seconds === filters.to_seconds
    ) {
      const deaths = readDeathsList(replay.constraint_results[constraint.id]?.value) ?? [];
      return {
        deaths,
        summaries: normalizeDeathSummaries(deaths, undefined)
      };
    }
  }
  return {
    deaths: [],
    summaries: normalizeDeathSummaries([], undefined)
  };
}

function readEventValue(value: unknown): EventLike | null {
  if (!value || typeof value !== "object" || !("event" in value)) {
    return null;
  }
  const event = (value as { event?: EventLike | null }).event;
  return event ?? null;
}

function readSampleValue<T>(value: unknown): T | null {
  if (!value || typeof value !== "object" || !("sample" in value)) {
    return null;
  }
  const sample = (value as { sample?: T | null }).sample;
  return sample ?? null;
}

function readDeathsList(value: unknown): DeathLike[] | null {
  if (!value || typeof value !== "object" || !("deaths" in value)) {
    return null;
  }
  const deaths = (value as { deaths?: DeathLike[] | null }).deaths;
  return deaths ?? null;
}

function readDeathsValue(value: unknown): { deaths?: DeathLike[]; summaries?: Record<string, unknown> } | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as { deaths?: DeathLike[]; summaries?: Record<string, unknown> };
  return "deaths" in candidate || "summaries" in candidate ? candidate : null;
}

function normalizeDeathSummaries(
  deaths: DeathLike[],
  summaries: Record<string, unknown> | undefined
): DeathEvidenceLike["summaries"] {
  const countByUnitType = isRecordOfNumbers(summaries?.count_by_unit_type)
    ? summaries.count_by_unit_type
    : countDeathsByUnitType(deaths);
  const countByCategory = isRecordOfNumbers(summaries?.count_by_category)
    ? summaries.count_by_category
    : countDeathsByCategory(deaths);
  const totalCount = typeof summaries?.total_count === "number" ? summaries.total_count : deaths.length;
  const firstTimeSeconds = typeof summaries?.first_time_seconds === "number" ? summaries.first_time_seconds : deaths[0]?.time_seconds ?? null;
  const lastTimeSeconds =
    typeof summaries?.last_time_seconds === "number" ? summaries.last_time_seconds : deaths[deaths.length - 1]?.time_seconds ?? null;
  return {
    total_count: totalCount,
    count_by_unit_type: countByUnitType,
    count_by_category: countByCategory,
    first_time_seconds: firstTimeSeconds,
    last_time_seconds: lastTimeSeconds
  };
}

function isRecordOfNumbers(value: unknown): value is Record<string, number> {
  return !!value && typeof value === "object" && Object.values(value).every((entry) => typeof entry === "number");
}

function countDeathsByUnitType(deaths: DeathLike[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const death of deaths) {
    result[death.unit_type] = (result[death.unit_type] ?? 0) + 1;
  }
  return result;
}

function countDeathsByCategory(deaths: DeathLike[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const death of deaths) {
    result[death.category] = (result[death.category] ?? 0) + 1;
  }
  return result;
}

function formatClock(seconds: number | null): string {
  if (seconds === null) {
    return "";
  }
  const totalSeconds = Math.floor(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const remainder = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function formatEconomyCompact(sample: EconomyLike | null): string {
  if (!sample) {
    return "";
  }
  return `${sample.minerals}/${sample.gas}/${sample.workers ?? ""}`;
}

function formatDeathsCompact(deaths: DeathEvidenceLike): string {
  const parts = Object.entries(deaths.summaries.count_by_unit_type)
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([unitType, count]) => `${unitType}:${count}`);
  return `${deaths.summaries.total_count}${parts.length > 0 ? ` (${parts.join(", ")})` : ""}`;
}

function toNullableString(value: number | string | null | undefined): string {
  return value === null || value === undefined ? "" : String(value);
}

function writeZipFile(zip: ZipFile, outPath: string): Promise<void> {
  return new Promise<void>((resolvePromise, reject) => {
    const output = createWriteStream(outPath);
    zip.outputStream.on("error", reject);
    output.on("error", reject);
    output.on("close", () => resolvePromise());
    zip.outputStream.pipe(output);
    zip.end();
  });
}

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
  BuildOrderEventRow,
  DeathEventRow,
  EconomySampleRow,
  IngestedReplayData,
  PlayerBundle,
  PlayerRow,
  ReplayManifest,
  ReplayRow,
  SupplySampleRow,
  UnitCountSampleRow
} from "../domain/contracts.js";
import { parseBuildOrderLine } from "../domain/normalization.js";
import { readZipTextFiles } from "./zip.js";

const REQUIRED_ZIP_FILES = ["player.json", "build_order.txt", "economy.json", "supply.json"] as const;

export async function loadReplayFromManifest(manifestPath: string): Promise<IngestedReplayData> {
  const manifest = parseManifest(await readFile(manifestPath, "utf8"), manifestPath);
  const replay: ReplayRow = {
    replay_id: manifest.replay_id,
    source_replay_filename: manifest.source.filename,
    source_replay_path: manifest.source.path,
    matchup: manifest.matchup,
    map: manifest.map,
    duration_seconds: manifest.duration_seconds,
    manifest_path: manifestPath
  };

  const players: PlayerRow[] = [];
  const buildOrderEvents: BuildOrderEventRow[] = [];
  const economySamples: EconomySampleRow[] = [];
  const supplySamples: SupplySampleRow[] = [];
  const unitCountSamples: UnitCountSampleRow[] = [];
  const deathEvents: DeathEventRow[] = [];

  for (const player of manifest.players) {
    const zipPath = resolve(dirname(manifestPath), player.zip_filename);
    const files = await readZipTextFiles(zipPath);
    for (const requiredFile of REQUIRED_ZIP_FILES) {
      if (!files.has(requiredFile)) {
        throw new Error(`${zipPath}: missing required bundle file ${requiredFile}`);
      }
    }

    const bundle = parseBundle(files, zipPath);
    if (bundle.player.owner !== player.owner) {
      throw new Error(`${zipPath}: player.json owner ${bundle.player.owner} does not match manifest owner ${player.owner}`);
    }

    players.push({
      replay_id: manifest.replay_id,
      owner: player.owner,
      name: player.name,
      race: player.race,
      zip_path: zipPath
    });

    for (const rawLine of bundle.buildOrderText.split(/\r?\n/)) {
      if (!rawLine.trim()) {
        continue;
      }
      const parsed = parseBuildOrderLine(rawLine);
      buildOrderEvents.push({
        replay_id: manifest.replay_id,
        owner: player.owner,
        time_seconds: parsed.timeSeconds,
        supply_used: parsed.supplyUsed,
        supply_max: parsed.supplyMax,
        item: parsed.item,
        raw_line: parsed.rawLine
      });
    }

    for (const sample of bundle.economy.samples) {
      economySamples.push({
        replay_id: manifest.replay_id,
        owner: player.owner,
        time_seconds: sample.time_seconds,
        minerals: sample.minerals,
        gas: sample.gas,
        gathered_minerals: sample.gathered_minerals ?? null,
        gathered_gas: sample.gathered_gas ?? null,
        workers: sample.workers ?? null
      });
    }

    for (const sample of bundle.supply.samples) {
      supplySamples.push({
        replay_id: manifest.replay_id,
        owner: player.owner,
        time_seconds: sample.time_seconds,
        current: sample.current,
        max: sample.max
      });
    }

    for (const sample of bundle.unitCounts?.samples ?? []) {
      for (const [unitType, count] of Object.entries(sample.counts)) {
        unitCountSamples.push({
          replay_id: manifest.replay_id,
          owner: player.owner,
          time_seconds: sample.time_seconds,
          unit_type: unitType,
          count
        });
      }
    }

    for (const sample of bundle.deaths?.samples ?? []) {
      deathEvents.push({
        replay_id: manifest.replay_id,
        owner: player.owner,
        frame: sample.frame,
        time_seconds: sample.time_seconds,
        dead_owner: sample.death.owner,
        unit_type: sample.death.unit_type,
        category: sample.death.category
      });
    }
  }

  return {
    replay,
    players,
    buildOrderEvents,
    economySamples,
    supplySamples,
    unitCountSamples,
    deathEvents
  };
}

function parseManifest(contents: string, manifestPath: string): ReplayManifest {
  const manifest = JSON.parse(contents) as ReplayManifest;
  if (manifest.schema_version !== "replay-analysis-manifest-v1") {
    throw new Error(`${manifestPath}: unsupported manifest schema ${manifest.schema_version}`);
  }
  if (!Array.isArray(manifest.players)) {
    throw new Error(`${manifestPath}: manifest players must be an array`);
  }
  for (const player of manifest.players) {
    if (typeof player.zip_filename !== "string" || !player.zip_filename) {
      throw new Error(`${manifestPath}: manifest player is missing zip_filename`);
    }
  }
  return manifest;
}

function parseBundle(files: Map<string, string>, zipPath: string): PlayerBundle {
  const player = parseJsonFile(files, "player.json", zipPath) as PlayerBundle["player"];
  const economy = parseJsonFile(files, "economy.json", zipPath) as PlayerBundle["economy"];
  const supply = parseJsonFile(files, "supply.json", zipPath) as PlayerBundle["supply"];
  const unitCounts = files.has("unit_counts.json")
    ? (parseJsonFile(files, "unit_counts.json", zipPath) as PlayerBundle["unitCounts"])
    : undefined;
  const deaths = files.has("deaths.json")
    ? (parseJsonFile(files, "deaths.json", zipPath) as PlayerBundle["deaths"])
    : undefined;

  const bundle: PlayerBundle = {
    player,
    buildOrderText: files.get("build_order.txt") ?? "",
    economy,
    supply
  };
  if (unitCounts) {
    bundle.unitCounts = unitCounts;
  }
  if (deaths) {
    bundle.deaths = deaths;
  }
  return bundle;
}

function parseJsonFile(files: Map<string, string>, fileName: string, zipPath: string): unknown {
  const text = files.get(fileName);
  if (text === undefined) {
    throw new Error(`${zipPath}: missing ${fileName}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${zipPath}: invalid JSON in ${fileName}: ${String(error)}`);
  }
}

import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { once } from "node:events";
import { dirname } from "node:path";

import { Bwsim } from "../../../third_party/bwsim/dist/index.js";
import type {
  BwsimPlayer,
  BwsimReplayHeader,
  BwsimUnit
} from "../../../third_party/bwsim/dist/index.js";

export const BWSIM_TIMELINE_SCHEMA = "sb-unit-timeline-v2";
export const BWSIM_SAFETY_FRAME_CAP = 43_200;
export const LEGACY_MAX_SUPPLY = 200;
const DRPL_COMMANDS_OFFSET = 641;
const PLAYER_LEAVE_COMMAND = 0x57;
const EMPTY_QUEUE_SLOT = 0xffff;
const SCANNER_SWEEP = 33;
const VESPENE_GEYSER = 188;

export interface BwsimRuntimePaths {
  wasmPath: string;
  assetPackPath: string;
}

export interface BwsimExportResult {
  firstFrame: number;
  terminalFrame: number;
  framesEmitted: number;
  elapsedMilliseconds: number;
  termination: "header" | "safety-cap" | "player-leave";
}

interface Simulation {
  loadReplay(path: string): Promise<void>;
  replayHeader(): BwsimReplayHeader | undefined;
  replayData(): { readonly drpl: Uint8Array } | undefined;
  currentFrame(): number;
  step(frames: number): number;
  players(): readonly BwsimPlayer[];
  units(): readonly BwsimUnit[];
  unitInstanceId(index: number): number | null;
  unitBuildQueue(index: number): readonly number[];
  replayUnitIdNamespace(): "native" | "replay-local" | undefined;
  toReplayUnitId(nativeId: number): number | null;
}

export interface LegacyUnitRecord {
  id: number;
  owner: number;
  unit_type: string;
  unit_type_id: number;
  category: string;
  completed: boolean;
  pos_x: number;
  pos_y: number;
  build_queue_unit_ids: number[];
  morphing_building: boolean;
  morph_target_unit_type_id?: number;
  morph_target_unit_type?: string;
  build_time?: number;
  remaining_build_time?: number;
  tech_in_progress?: number;
  upgrade_in_progress?: number;
}

export interface LegacyOwnerSnapshot {
  name: string;
  minerals: number;
  gas: number;
  supply_current: number;
  supply_max: number;
  workers_alive: number;
  unit_counts: Record<string, number>;
  units: LegacyUnitRecord[];
}

export interface LegacyTimelineSnapshot {
  schema_version: typeof BWSIM_TIMELINE_SCHEMA;
  frame: number;
  owners: Record<string, LegacyOwnerSnapshot>;
  deaths: LegacyUnitRecord[];
}

export async function exportBwsimTimeline(params: {
  replayPath: string;
  snapshotPath: string;
  runtime: BwsimRuntimePaths;
  createSimulation?: () => Promise<Simulation>;
}): Promise<BwsimExportResult> {
  const startedAt = performance.now();
  const simulation = params.createSimulation
    ? await params.createSimulation()
    : await Bwsim.create({
        wasmPath: params.runtime.wasmPath,
        assetPackPath: params.runtime.assetPackPath
      });
  await simulation.loadReplay(params.replayPath);
  const header = simulation.replayHeader();
  if (!header) {
    throw new Error(`bwsim did not expose a replay header for ${params.replayPath}`);
  }
  if (simulation.currentFrame() !== 0) {
    throw new Error(`bwsim loaded replay at unexpected frame ${simulation.currentFrame()}`);
  }

  const termination = resolveBwsimTermination(header.frameCount, simulation.replayData()?.drpl);
  await mkdir(dirname(params.snapshotPath), { recursive: true });
  const output = createWriteStream(params.snapshotPath, { encoding: "utf8" });
  let previousUnits = new Map<number, LegacyUnitRecord>();
  let framesEmitted = 0;
  try {
    for (let frame = 1; frame <= termination.frame; frame += 1) {
      const currentFrame = simulation.step(1);
      if (currentFrame !== frame) {
        throw new Error(`bwsim frame sequence diverged: expected ${frame}, got ${currentFrame}`);
      }
      const captured = captureBwsimSnapshot(simulation, header, previousUnits, {
        replayPath: params.replayPath,
        frame
      });
      previousUnits = captured.currentUnits;
      const snapshot: LegacyTimelineSnapshot = {
        schema_version: BWSIM_TIMELINE_SCHEMA,
        frame,
        owners: captured.owners,
        deaths: captured.deaths
      };
      if (!output.write(`${JSON.stringify(snapshot)}\n`)) {
        await once(output, "drain");
      }
      framesEmitted += 1;
    }
    output.end();
    await once(output, "finish");
  } catch (error) {
    output.destroy();
    throw error;
  }

  return {
    firstFrame: framesEmitted > 0 ? 1 : 0,
    terminalFrame: termination.frame,
    framesEmitted,
    elapsedMilliseconds: performance.now() - startedAt,
    termination: termination.reason
  };
}

export function resolveBwsimTermination(
  replayHeaderEndFrame: number,
  drpl?: Uint8Array
): { frame: number; reason: BwsimExportResult["termination"] } {
  const headerFrame = Math.max(0, Math.trunc(replayHeaderEndFrame));
  let frame = Math.min(headerFrame || BWSIM_SAFETY_FRAME_CAP, BWSIM_SAFETY_FRAME_CAP);
  let reason: BwsimExportResult["termination"] =
    headerFrame > 0 && headerFrame <= BWSIM_SAFETY_FRAME_CAP ? "header" : "safety-cap";
  const leaveFrame = drpl ? findStandalonePlayerLeaveFrame(drpl, headerFrame) : undefined;
  if (leaveFrame !== undefined && leaveFrame + 1 < frame) {
    frame = leaveFrame + 1;
    reason = "player-leave";
  }
  return { frame, reason };
}

/**
 * DRPL stores replay command frames at a fixed header offset. PlayerLeave is a
 * three-byte Storm-player/opcode/reason command in the known golden fixtures.
 * This intentionally implements only the accepted legacy heuristic; it does
 * not claim to reconstruct Storm connection state.
 */
export function findStandalonePlayerLeaveFrame(
  drpl: Uint8Array,
  replayHeaderEndFrame: number
): number | undefined {
  let offset = DRPL_COMMANDS_OFFSET;
  let previousFrame = -1;
  while (offset + 5 <= drpl.byteLength) {
    const view = new DataView(drpl.buffer, drpl.byteOffset + offset, 5);
    const frame = view.getUint32(0, true);
    const commandBytes = view.getUint8(4);
    const end = offset + 5 + commandBytes;
    if (
      commandBytes === 0 ||
      end > drpl.byteLength ||
      frame < previousFrame ||
      frame > replayHeaderEndFrame
    ) {
      break;
    }
    const commands = drpl.subarray(offset + 5, end);
    if (
      commands.length >= 3 &&
      commands.length % 3 === 0 &&
      everyCommandIsPlayerLeave(commands)
    ) {
      return frame;
    }
    previousFrame = frame;
    offset = end;
  }
  return undefined;
}

function everyCommandIsPlayerLeave(commands: Uint8Array): boolean {
  for (let offset = 0; offset < commands.length; offset += 3) {
    const stormPlayer = commands[offset];
    if (stormPlayer === undefined || stormPlayer > 11 || commands[offset + 1] !== PLAYER_LEAVE_COMMAND) {
      return false;
    }
  }
  return true;
}

export function captureBwsimSnapshot(
  simulation: Pick<
    Simulation,
    | "players"
    | "units"
    | "unitInstanceId"
    | "unitBuildQueue"
    | "replayUnitIdNamespace"
    | "toReplayUnitId"
  >,
  header: BwsimReplayHeader,
  previousUnits: ReadonlyMap<number, LegacyUnitRecord>,
  context: { replayPath: string; frame: number }
): {
  owners: Record<string, LegacyOwnerSnapshot>;
  deaths: LegacyUnitRecord[];
  currentUnits: Map<number, LegacyUnitRecord>;
} {
  const playerState = new Map(simulation.players().map((player) => [player.owner, player]));
  const unitsByOwner = new Map<number, LegacyUnitRecord[]>();
  for (const unit of simulation.units()) {
    if (unit.type === SCANNER_SWEEP || unit.type < 0 || unit.type >= UNIT_NAMES.length) {
      continue;
    }
    const id = simulation.unitInstanceId(unit.index);
    if (id === null) {
      throw new Error(`bwsim returned no generation-safe ID for live unit index ${unit.index}`);
    }
    const queue = simulation.unitBuildQueue(unit.index).filter((type) => type !== EMPTY_QUEUE_SLOT);
    const record = toLegacyUnitRecord(unit, id, queue);
    const ownerUnits = unitsByOwner.get(unit.owner) ?? [];
    ownerUnits.push(record);
    unitsByOwner.set(unit.owner, ownerUnits);
  }

  const owners: Record<string, LegacyOwnerSnapshot> = {};
  const currentUnits = new Map<number, LegacyUnitRecord>();
  for (const [owner, units] of [...unitsByOwner].sort(([left], [right]) => left - right)) {
    if (units.some((unit) => unit.unit_type_id === VESPENE_GEYSER)) {
      continue;
    }
    units.sort((left, right) => left.id - right.id);
    const state = playerState.get(owner);
    if (!state) {
      throw new Error(`bwsim did not expose player state for live owner ${owner}`);
    }
    const race = header.players[owner]?.race ?? 0;
    const raceIndex = race >= 0 && race <= 2 ? race : 0;
    const supply = normalizeLegacySupply(state.usedSupplyRaw, state.maxSupplyRaw, raceIndex);
    const unitCounts: Record<string, number> = {};
    for (const unit of units) {
      unitCounts[unit.unit_type] = (unitCounts[unit.unit_type] ?? 0) + 1;
      currentUnits.set(unit.id, unit);
    }
    const serializedUnits = units
      .map((unit) => serializeLegacyUnitRecord(simulation, unit, context))
      .sort((left, right) => left.id - right.id);
    owners[String(owner)] = {
      name: header.players[owner]?.name || `Player ${owner + 1}`,
      minerals: state.minerals,
      gas: state.gas,
      supply_current: supply.current,
      supply_max: supply.max,
      workers_alive: state.completedWorkers,
      unit_counts: unitCounts,
      units: serializedUnits
    };
  }

  const deaths = [...previousUnits]
    .filter(([id]) => !currentUnits.has(id))
    .map(([, unit]) => serializeLegacyUnitRecord(simulation, unit, context))
    .sort((left, right) => left.id - right.id);
  return { owners, deaths, currentUnits };
}

export function normalizeLegacySupply(
  usedSupplyRaw: readonly [number, number, number],
  maxSupplyRaw: readonly [number, number, number],
  raceIndex: number
): { current: number; max: number } {
  return {
    current: Math.floor((usedSupplyRaw[raceIndex] + 1) / 2),
    max: Math.min(Math.floor(maxSupplyRaw[raceIndex] / 2), LEGACY_MAX_SUPPLY)
  };
}

function serializeLegacyUnitRecord(
  simulation: Pick<Simulation, "replayUnitIdNamespace" | "toReplayUnitId">,
  unit: LegacyUnitRecord,
  context: { replayPath: string; frame: number }
): LegacyUnitRecord {
  const serializedId = simulation.toReplayUnitId(unit.id);
  if (serializedId === null) {
    const namespace = simulation.replayUnitIdNamespace() ?? "unavailable";
    throw new Error(
      `bwsim could not serialize native UnitId ${unit.id} for ${unit.unit_type} ` +
        `(owner ${unit.owner}) at frame ${context.frame} in ${context.replayPath}; ` +
        `replay UnitId namespace is ${namespace}`
    );
  }
  return { ...unit, id: serializedId };
}

function toLegacyUnitRecord(
  unit: BwsimUnit,
  id: number,
  buildQueue: readonly number[]
): LegacyUnitRecord {
  const firstTarget = buildQueue[0];
  const morphTarget =
    isBuilding(unit.type) && firstTarget !== undefined && isBuilding(firstTarget) && firstTarget !== unit.type
      ? firstTarget
      : undefined;
  const record: LegacyUnitRecord = {
    id,
    owner: unit.owner,
    unit_type: UNIT_NAMES[unit.type]!,
    unit_type_id: unit.type,
    category: unitCategory(unit.type),
    completed: unit.completed,
    pos_x: unit.x,
    pos_y: unit.y,
    build_queue_unit_ids: [...buildQueue],
    morphing_building: morphTarget !== undefined
  };
  if (morphTarget !== undefined) {
    record.morph_target_unit_type_id = morphTarget;
    record.morph_target_unit_type = UNIT_NAMES[morphTarget];
  }
  if (unit.totalBuildTime > 0 && unit.remainingBuildTime > 0) {
    // The HUD total is for the current unit type. During an explicit building
    // morph (for example Hatchery -> Lair), legacy telemetry instead reports the
    // queued target's total. At stride 1 the positive queue transition is the
    // morph start, so its target total equals the initial remaining value.
    record.build_time = morphTarget === undefined ? unit.totalBuildTime : unit.remainingBuildTime;
    record.remaining_build_time = unit.remainingBuildTime;
  }
  if (unit.researchKind === 1) {
    record.tech_in_progress = unit.researchId;
  } else if (unit.researchKind === 2) {
    record.upgrade_in_progress = unit.researchId;
  }
  return record;
}

export function unitCategory(unitType: number): string {
  if (isBuilding(unitType)) return "building";
  if (unitType === 7 || unitType === 41 || unitType === 64) return "worker";
  if ([176, 177, 178, 188, 218, 219].includes(unitType)) return "resource";
  if ([4, 6, 18, 24, 26, 31].includes(unitType)) return "subunit";
  if (AIR_UNIT_IDS.has(unitType)) return "air";
  if (unitType >= 128 && unitType <= 129 || unitType >= 217 && unitType <= 227) return "powerup";
  return "unit";
}

function isBuilding(unitType: number): boolean {
  return unitType >= 0x6a && unitType <= 0xac;
}

const AIR_UNIT_IDS = new Set([
  8, 9, 11, 12, 14, 21, 22, 28, 29, 42, 43, 44, 45, 47, 49, 55, 56, 57, 58,
  59, 60, 69, 70, 71, 72, 73, 79, 80, 81, 83, 86
]);

export const UNIT_NAMES = [
  "marine", "ghost", "vulture", "goliath", "goliath_turret", "siege_tank_tank",
  "siege_tank_turret", "scv", "wraith", "science_vessel", "gui_montag", "dropship",
  "battlecruiser", "spider_mine", "nuclear_missile", "civilian", "sarah_kerrigan",
  "alan_schezar", "schezar_turret", "jim_raynor_vulture", "jim_raynor_marine",
  "tom_kazansky", "magellan", "edmund_duke_tank", "edmund_duke_tank_turret",
  "edmund_duke_siege", "edmund_duke_siege_turret", "arcturus_mengsk", "hyperion",
  "norad_ii", "siege_tank_siege", "siege_tank_siege_turret", "firebat", "scanner_sweep",
  "medic", "larva", "egg", "zergling", "hydralisk", "ultralisk", "broodling", "drone",
  "overlord", "mutalisk", "guardian", "queen", "defiler", "scourge", "torrasque",
  "matriarch", "infested_terran", "infested_kerrigan", "unclean_one", "hunter_killer",
  "devouring_one", "kukulza_mutalisk", "kukulza_guardian", "yggdrasill", "valkyrie",
  "cocoon", "corsair", "dark_templar", "devourer", "dark_archon", "probe", "zealot",
  "dragoon", "high_templar", "archon", "shuttle", "scout", "arbiter", "carrier",
  "interceptor", "dark_templar_hero", "zeratul", "tassadar_zeratul", "fenix_zealot",
  "fenix_dragoon", "tassadar", "mojo", "warbringer", "gantrithor", "reaver", "observer",
  "scarab", "danimoth", "aldaris", "artanis", "rhynadon", "bengalaas", "cargo_ship",
  "mercenary_gunship", "scantid", "kakaru", "ragnasaur", "ursadon", "lurker_egg",
  "raszagal", "samir_duran", "alexei_stukov", "map_revealer", "gerard_dugalle", "lurker",
  "infested_duran", "disruption_web", "command_center", "comsat_station", "nuclear_silo",
  "supply_depot", "refinery", "barracks", "academy", "factory", "starport",
  "control_tower", "science_facility", "covert_ops", "physics_lab", "starbase",
  "machine_shop", "repair_bay", "engineering_bay", "armory", "missile_turret", "bunker",
  "norad_ii_crashed", "ion_cannon", "uraj_crystal", "khalis_crystal",
  "infested_command_center", "hatchery", "lair", "hive", "nydus_canal", "hydralisk_den",
  "defiler_mound", "greater_spire", "queens_nest", "evolution_chamber",
  "ultralisk_cavern", "spire", "spawning_pool", "creep_colony", "spore_colony",
  "unused_zerg_building_1", "sunken_colony", "overmind_with_shell", "overmind",
  "extractor", "mature_chrysalis", "cerebrate", "cerebrate_daggoth",
  "unused_zerg_building_2", "nexus", "robotics_facility", "pylon", "assimilator",
  "unused_protoss_building_1", "observatory", "gateway", "unused_protoss_building_2",
  "photon_cannon", "citadel_of_adun", "cybernetics_core", "templar_archives", "forge",
  "stargate", "stasis_cell", "fleet_beacon", "arbiter_tribunal", "robotics_support_bay",
  "shield_battery", "khaydarin_crystal_formation", "temple", "xelnaga_temple",
  "mineral_field_1", "mineral_field_2", "mineral_field_3", "cave", "cave_in", "cantina",
  "mining_platform", "independent_command_center", "independent_starport",
  "jump_gate_unused", "ruins", "kyadarin_crystal_formation_unused", "vespene_geyser",
  "warp_gate", "psi_disrupter", "zerg_marker", "terran_marker", "protoss_marker",
  "zerg_beacon", "terran_beacon", "protoss_beacon", "zerg_flag_beacon",
  "terran_flag_beacon", "protoss_flag_beacon", "power_generator", "overmind_cocoon",
  "dark_swarm", "floor_missile_trap", "floor_hatch", "left_upper_level_door",
  "right_upper_level_door", "left_pit_door", "right_pit_door", "floor_gun_trap",
  "left_wall_missile_trap", "left_wall_flame_trap", "right_wall_missile_trap",
  "right_wall_flame_trap", "start_location", "flag", "young_chrysalis", "psi_emitter",
  "data_disc", "khaydarin_crystal", "mineral_chunk_1", "mineral_chunk_2", "vespene_orb_1",
  "vespene_orb_2", "vespene_sac_1", "vespene_sac_2", "vespene_tank_1", "vespene_tank_2"
] as const;

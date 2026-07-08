#!/usr/bin/env python3
"""Convert ShieldBattery unit timeline JSONL into per-owner replay summary files."""

from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import time
import unicodedata
import zipfile
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable

FRAME_DURATION_MS = 42
DEFAULT_SHIELDBATTERY_DIR = Path(__file__).resolve().parents[2] / "third_party" / "shieldbattery"
DEFAULT_REPLAY_EXPORT_SPEED = 128
DEFAULT_TIMELINE_FORMAT = "msgpack"
DEFAULT_BUILD_ORDER_TEMPLATE = Path(__file__).with_name("build-order.html")
DEFAULT_EMBEDDED_BUILD_ORDER_NAME = "build-order.embedded.html"

TRANSIENT_UNIT_TYPES = {"egg", "cocoon", "lurker_egg"}
IGNORED_CATEGORIES = {"resource", "subunit", "powerup"}
RACE_NAMES = {"terran", "zerg", "protoss"}
UNIT_TYPE_NORMALIZATIONS = {
    "siege_tank_tank": "siege_tank",
}
IGNORED_OUTPUT_UNIT_TYPES = {
    "goliath_turret",
    "schezar_turret",
    "siege_tank_turret",
    "edmund_duke_tank_turret",
    "edmund_duke_siege_turret",
    "siege_tank_siege_turret",
}

UNIT_NAMES = [
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
    "vespene_orb_2", "vespene_sac_1", "vespene_sac_2", "vespene_tank_1", "vespene_tank_2",
]

UPGRADE_NAMES = {
    0x00: "infantry_armor", 0x01: "vehicle_plating", 0x02: "ship_plating",
    0x03: "carapace", 0x04: "flyer_carapace", 0x05: "protoss_armor",
    0x06: "protoss_plating", 0x07: "infantry_weapons", 0x08: "vehicle_weapons",
    0x09: "ship_weapons", 0x0A: "zerg_melee_attacks", 0x0B: "zerg_missile_attacks",
    0x0C: "zerg_flyer_attacks", 0x0D: "protoss_ground_weapons",
    0x0E: "protoss_air_weapons", 0x0F: "plasma_shields", 0x10: "u_238_shells",
    0x11: "ion_thrusters", 0x12: "burst_lasers", 0x13: "titan_reactor",
    0x14: "ocular_implants", 0x15: "moebius_reactor", 0x16: "apollo_reactor",
    0x17: "colossus_reactor", 0x18: "ventral_sacs", 0x19: "antennae",
    0x1A: "pneumatized_carapace", 0x1B: "metabolic_boost", 0x1C: "adrenal_glands",
    0x1D: "muscular_augments", 0x1E: "grooved_spines", 0x1F: "gamete_meiosis",
    0x20: "metasynaptic_node", 0x21: "singularity_charge", 0x22: "leg_enhancements",
    0x23: "scarab_damage", 0x24: "reaver_capacity", 0x25: "gravitic_drive",
    0x26: "sensor_array", 0x27: "gravitic_boosters", 0x28: "khaydarin_amulet",
    0x29: "apial_sensors", 0x2A: "gravitic_thrusters", 0x2B: "carrier_capacity",
    0x2C: "khaydarin_core", 0x2D: "upgrade_45", 0x2E: "upgrade_46",
    0x2F: "argus_jewel", 0x30: "upgrade_48", 0x31: "argus_talisman",
    0x32: "upgrade_50", 0x33: "caduceus_reactor", 0x34: "chitinous_plating",
    0x35: "anabolic_synthesis", 0x36: "charon_boosters",
}

TECH_NAMES = {
    0x00: "stim_packs", 0x01: "lockdown", 0x02: "emp_shockwave", 0x03: "spider_mines",
    0x04: "scanner_sweep", 0x05: "siege_mode", 0x06: "defensive_matrix",
    0x07: "irradiate", 0x08: "yamato_gun", 0x09: "cloaking_field",
    0x0A: "personnel_cloaking", 0x0B: "burrowing", 0x0C: "infestation",
    0x0D: "spawn_broodlings", 0x0E: "dark_swarm", 0x0F: "plague", 0x10: "consume",
    0x11: "ensnare", 0x12: "parasite", 0x13: "psionic_storm",
    0x14: "hallucination", 0x15: "recall", 0x16: "stasis_field", 0x17: "archon_warp",
    0x18: "restoration", 0x19: "disruption_web", 0x1A: "tech_26",
    0x1B: "mind_control", 0x1C: "dark_archon_meld", 0x1D: "feedback",
    0x1E: "optical_flare", 0x1F: "maelstrom", 0x20: "lurker_aspect",
    0x21: "tech_33", 0x22: "healing",
}


@dataclass(frozen=True)
class Event:
    frame: int
    owner: int
    name: str


@dataclass(frozen=True)
class SamplingInfo:
    max_frame_delta: int = 0


@dataclass(frozen=True)
class AnalysisResult:
    sampling: SamplingInfo
    events: list[Event]
    economy: dict[int, list[dict[str, int | float]]]
    supply: dict[int, list[dict[str, int | float]]]
    unit_counts: dict[int, list[dict[str, Any]]]
    deaths: dict[int, list[dict[str, Any]]]
    race_by_owner: dict[int, str]
    name_by_owner: dict[int, str]
    output_owners: set[int]
    last_frame: int | None


@dataclass(frozen=True)
class EmbeddedDatasetBlock:
    name: str
    data_format: str
    payload: str


@dataclass(frozen=True)
class EmbeddedReplayBlock:
    filename: str
    data_format: str
    payload: str


@dataclass(frozen=True)
class EmbeddedReportArtifacts:
    datasets: list[EmbeddedDatasetBlock]
    replay: EmbeddedReplayBlock | None
    page_title: str | None


@dataclass(frozen=True)
class ExistingPlayerBundleInfo:
    owner: int
    name: str
    race: str
    zip_filename: str
    is_canonical: bool
    max_frame: int | None


class AnalysisProgressReporter:
    def __init__(self, total_bytes: int, interval_seconds: float = 2.0) -> None:
        self.total_bytes = max(total_bytes, 1)
        self.interval_seconds = interval_seconds
        self.start_time = time.perf_counter()
        self.last_print_time = 0.0

    def start(self) -> None:
        self._print_progress(0, force=True)

    def update(self, bytes_read: int) -> None:
        self._print_progress(bytes_read)

    def finish(self) -> None:
        self._print_progress(self.total_bytes, force=True)

    def _print_progress(self, bytes_read: int, force: bool = False) -> None:
        now = time.perf_counter()
        if not force and now - self.last_print_time < self.interval_seconds:
            return

        overall_fraction = min(max(bytes_read / self.total_bytes, 0.0), 1.0)
        elapsed = now - self.start_time
        print(f"[analysis] {overall_fraction * 100:5.1f}% elapsed {elapsed:.1f}s", flush=True)
        self.last_print_time = now


class Analyzer:
    def __init__(
        self,
        owners: set[int] | None,
        include_initial: bool,
        include_tech: bool,
        include_unit_appearances: bool,
    ) -> None:
        self.owners = owners
        self.include_initial = include_initial
        self.include_tech = include_tech
        self.include_unit_appearances = include_unit_appearances
        self.first_snapshot = True
        self.unit_types_by_owner: dict[int, dict[int, int]] = defaultdict(dict)
        self.queues_by_owner: dict[int, dict[int, Counter[int]]] = defaultdict(dict)
        self.emitted_build_events: dict[int, dict[int, int]] = defaultdict(dict)
        self.upgrades_by_owner: dict[int, set[int]] = defaultdict(set)
        self.tech_by_owner: dict[int, set[int]] = defaultdict(set)

    def process_snapshot(self, snapshot: dict[str, Any]) -> list[Event]:
        frame = int(snapshot["frame"])
        events: list[Event] = []
        emit_initial = self.include_initial or not self.first_snapshot

        current_upgrades: dict[int, set[int]] = defaultdict(set)
        current_tech: dict[int, set[int]] = defaultdict(set)

        for owner, units in iter_owner_units(snapshot):
            if self.owners is not None and owner not in self.owners:
                continue

            for unit in units:
                unit_id = int(unit["id"])
                unit_type_id = get_unit_type_id(unit)
                unit_type = get_unit_type_name(unit)
                category = unit.get("category", "")

                if emit_initial:
                    events.extend(self._unit_events(frame, owner, unit_id, unit_type_id, unit_type, category, unit))

                upgrade = unit.get("upgrade_in_progress")
                if upgrade is not None:
                    current_upgrades[owner].add(int(upgrade))

                tech = unit.get("tech_in_progress")
                if tech is not None:
                    current_tech[owner].add(int(tech))

                self.unit_types_by_owner[owner][unit_id] = unit_type_id

            if emit_initial:
                events.extend(self._research_events(frame, owner, current_upgrades[owner], current_tech[owner]))

        self.upgrades_by_owner = current_upgrades
        self.tech_by_owner = current_tech
        self.first_snapshot = False
        return events

    def _unit_events(
        self,
        frame: int,
        owner: int,
        unit_id: int,
        unit_type_id: int,
        unit_type: str,
        category: str,
        unit: dict[str, Any],
    ) -> list[Event]:
        events: list[Event] = []
        previous_type = self.unit_types_by_owner[owner].get(unit_id)
        is_new_or_changed = previous_type is None or previous_type != unit_type_id

        build_event = self._building_event(frame, owner, unit_id, unit_type_id, unit_type, category, unit, previous_type)
        if build_event is not None:
            events.append(build_event)
        elif (
            category != "building"
            and is_new_or_changed
            and should_emit_appearance(unit_type, category, self.include_unit_appearances)
        ):
            events.append(Event(frame, owner, display_name(unit_type)))

        current_queue = Counter(int(x) for x in unit.get("build_queue_unit_ids", []) if x is not None)
        previous_queue = self.queues_by_owner[owner].get(unit_id, Counter())
        for target_id, count in (current_queue - previous_queue).items():
            target_name = unit_name_from_id(target_id)
            if target_name is None or target_name in TRANSIENT_UNIT_TYPES:
                continue
            if is_building_id(target_id):
                if unit.get("morphing_building", False):
                    event = self._emit_building_event(frame, owner, unit_id, target_id, target_name, unit)
                    if event is not None:
                        events.append(event)
                continue
            events.extend(Event(frame, owner, display_name(target_name)) for _ in range(count))
        self.queues_by_owner[owner][unit_id] = current_queue
        return events

    def _building_event(
        self,
        frame: int,
        owner: int,
        unit_id: int,
        unit_type_id: int,
        unit_type: str,
        category: str,
        unit: dict[str, Any],
        previous_type: int | None,
    ) -> Event | None:
        morph_target_id = get_morph_target_unit_type_id(unit)
        if morph_target_id is not None:
            target_name = unit_name_from_id(morph_target_id)
            if target_name is not None:
                return self._emit_building_event(frame, owner, unit_id, morph_target_id, target_name, unit)

        if category != "building":
            return None

        if previous_type is None:
            return self._emit_building_event(frame, owner, unit_id, unit_type_id, unit_type, unit)

        if previous_type != unit_type_id:
            return self._emit_building_event(frame, owner, unit_id, unit_type_id, unit_type, unit)

        return None

    def _emit_building_event(
        self,
        frame: int,
        owner: int,
        unit_id: int,
        target_type_id: int,
        target_name: str,
        unit: dict[str, Any],
    ) -> Event | None:
        if self.emitted_build_events[owner].get(unit_id) == target_type_id:
            return None
        if target_name in TRANSIENT_UNIT_TYPES:
            return None
        self.emitted_build_events[owner][unit_id] = target_type_id
        return Event(backdated_frame(frame, unit), owner, display_name(target_name))

    def _research_events(
        self,
        frame: int,
        owner: int,
        current_upgrades: set[int],
        current_tech: set[int],
    ) -> list[Event]:
        events = [
            Event(frame, owner, display_name(upgrade_name(upgrade_id)))
            for upgrade_id in sorted(current_upgrades - self.upgrades_by_owner[owner])
        ]
        if self.include_tech:
            events.extend(
                Event(frame, owner, display_name(tech_name(tech_id)))
                for tech_id in sorted(current_tech - self.tech_by_owner[owner])
            )
        return events


def iter_owner_units(snapshot: dict[str, Any]) -> Iterable[tuple[int, list[dict[str, Any]]]]:
    for owner_key, owner_value in snapshot.get("owners", {}).items():
        yield int(owner_key), list(owner_value.get("units", []))


def get_unit_type_id(unit: dict[str, Any]) -> int:
    if "unit_type_id" in unit:
        return int(unit["unit_type_id"])
    if isinstance(unit.get("unit_type"), int):
        return int(unit["unit_type"])
    return -1


def get_unit_type_name(unit: dict[str, Any]) -> str:
    unit_type = unit.get("unit_type")
    if isinstance(unit_type, str):
        return normalize_unit_type_name(unit_type)
    name = unit_name_from_id(get_unit_type_id(unit))
    return normalize_unit_type_name(name or f"unit_{get_unit_type_id(unit)}")


def should_emit_appearance(unit_type: str, category: str, include_unit_appearances: bool) -> bool:
    if category in IGNORED_CATEGORIES or unit_type in TRANSIENT_UNIT_TYPES:
        return False
    return category == "building" or include_unit_appearances


def get_morph_target_unit_type_id(unit: dict[str, Any]) -> int | None:
    morph_target = unit.get("morph_target_unit_type_id")
    if morph_target is None:
        return None
    return int(morph_target)


def unit_name_from_id(unit_id: int) -> str | None:
    if 0 <= unit_id < len(UNIT_NAMES):
        return normalize_unit_type_name(UNIT_NAMES[unit_id])
    return None


def normalize_unit_type_name(unit_type: str | None) -> str | None:
    if unit_type is None:
        return None
    return UNIT_TYPE_NORMALIZATIONS.get(unit_type, unit_type)


def should_omit_output_unit_type(unit_type: str | None) -> bool:
    return unit_type in IGNORED_OUTPUT_UNIT_TYPES


def is_building_id(unit_id: int) -> bool:
    return 0x6A <= unit_id <= 0xAC


def upgrade_name(upgrade_id: int) -> str:
    return UPGRADE_NAMES.get(upgrade_id, f"upgrade_{upgrade_id}")


def tech_name(tech_id: int) -> str:
    return TECH_NAMES.get(tech_id, f"tech_{tech_id}")


def display_name(value: str) -> str:
    special = {
        "scv": "SCV",
        "emp_shockwave": "EMP Shockwave",
        "u_238_shells": "U-238 Shells",
    }
    if value in special:
        return special[value]
    return " ".join(part.upper() if len(part) <= 2 and part in {"ii"} else part.capitalize() for part in value.split("_"))


def race_for_unit(unit: dict[str, Any]) -> str | None:
    unit_type = get_unit_type_name(unit)
    if unit_type.startswith(("terran_", "zerg_", "protoss_")):
        return unit_type.split("_", 1)[0]

    unit_id = get_unit_type_id(unit)
    if 0 <= unit_id <= 34 or 106 <= unit_id <= 130:
        return "terran"
    if 35 <= unit_id <= 58 or 97 <= unit_id <= 103 or 131 <= unit_id <= 152:
        return "zerg"
    if 59 <= unit_id <= 83 or 154 <= unit_id <= 172:
        return "protoss"
    return None


def format_timestamp(frame: int) -> str:
    seconds = int(frame_to_seconds(frame))
    return f"{seconds // 60:02d}:{seconds % 60:02d}"


def frame_to_seconds(frame: int) -> float:
    return frame * FRAME_DURATION_MS / 1000


def backdated_frame(observed_frame: int, unit: dict[str, Any]) -> int:
    build_time = unit.get("build_time")
    remaining = unit.get("remaining_build_time")
    if build_time is None or remaining is None:
        return observed_frame
    build_time = int(build_time)
    remaining = int(remaining)
    if build_time <= 0 or remaining < 0:
        return observed_frame
    elapsed = max(0, min(build_time, build_time - remaining))
    return max(0, observed_frame - elapsed)


def load_events(
    path: Path,
    analyzer: Analyzer,
    progress: Callable[[int], None] | None = None,
) -> list[Event]:
    events: list[Event] = []
    for snapshot in iter_snapshots(path, progress=progress):
        events.extend(analyzer.process_snapshot(snapshot))
    return sorted(events, key=lambda event: (event.frame, event.owner, event.name))


def load_owner_races(
    path: Path,
    owners: set[int] | None,
    progress: Callable[[int], None] | None = None,
) -> dict[int, str]:
    if owners is not None:
        unresolved = set(owners)
        races: dict[int, str] = {}
        for snapshot in iter_snapshots(path, progress=progress):
            for owner, units in iter_owner_units(snapshot):
                if owner not in unresolved:
                    continue
                for unit in units:
                    race = race_for_unit(unit)
                    if race in RACE_NAMES:
                        races[owner] = race
                        unresolved.remove(owner)
                        break
            if not unresolved:
                break
        return races

    race_counts: dict[int, Counter[str]] = defaultdict(Counter)
    for snapshot in iter_snapshots(path, progress=progress):
        for owner, units in iter_owner_units(snapshot):
            if owners is not None and owner not in owners:
                continue
            for unit in units:
                race = race_for_unit(unit)
                if race in RACE_NAMES:
                    race_counts[owner][race] += 1

    races: dict[int, str] = {}
    for owner, counts in race_counts.items():
        if counts:
            races[owner] = sorted(counts.items(), key=lambda item: (-item[1], item[0]))[0][0]
    return races


def load_owner_names(
    path: Path,
    owners: set[int] | None,
    progress: Callable[[int], None] | None = None,
) -> dict[int, str]:
    names: dict[int, str] = {}
    unresolved = set(owners) if owners is not None else None
    for snapshot in iter_snapshots(path, progress=progress):
        for owner_key, owner_value in snapshot.get("owners", {}).items():
            owner = int(owner_key)
            if owners is not None and owner not in owners:
                continue
            name = owner_value.get("name")
            if isinstance(name, str) and name:
                names.setdefault(owner, name)
                if unresolved is not None:
                    unresolved.discard(owner)
        if unresolved is not None and not unresolved:
            break
    return names


class MessagePackStreamReader:
    def __init__(self, input_file: Any) -> None:
        self.input_file = input_file

    def tell(self) -> int:
        return self.input_file.tell()

    def unpack(self) -> Any:
        code_raw = self.input_file.read(1)
        if not code_raw:
            raise EOFError
        code = code_raw[0]

        if code <= 0x7F:
            return code
        if code >= 0xE0:
            return code - 0x100
        if 0x90 <= code <= 0x9F:
            return [self.unpack() for _ in range(code & 0x0F)]
        if 0xA0 <= code <= 0xBF:
            return self._read_exact(code & 0x1F).decode("utf-8")
        if code == 0xC0:
            return None
        if code == 0xCC:
            return struct.unpack(">B", self._read_exact(1))[0]
        if code == 0xCD:
            return struct.unpack(">H", self._read_exact(2))[0]
        if code == 0xCE:
            return struct.unpack(">I", self._read_exact(4))[0]
        if code == 0xD0:
            return struct.unpack(">b", self._read_exact(1))[0]
        if code == 0xD1:
            return struct.unpack(">h", self._read_exact(2))[0]
        if code == 0xD2:
            return struct.unpack(">i", self._read_exact(4))[0]
        if code == 0xD9:
            return self._read_exact(struct.unpack(">B", self._read_exact(1))[0]).decode("utf-8")
        if code == 0xDA:
            return self._read_exact(struct.unpack(">H", self._read_exact(2))[0]).decode("utf-8")
        if code == 0xDB:
            return self._read_exact(struct.unpack(">I", self._read_exact(4))[0]).decode("utf-8")
        if code == 0xDC:
            return [self.unpack() for _ in range(struct.unpack(">H", self._read_exact(2))[0])]
        if code == 0xDD:
            return [self.unpack() for _ in range(struct.unpack(">I", self._read_exact(4))[0])]

        raise ValueError(f"unsupported MessagePack type 0x{code:02x}")

    def _read_exact(self, size: int) -> bytes:
        data = self.input_file.read(size)
        if len(data) != size:
            raise ValueError("unexpected end of MessagePack stream")
        return data


def detect_timeline_format(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix == ".sbtl":
        return "msgpack"
    if suffix == ".jsonl":
        return "jsonl"

    with path.open("rb") as input_file:
        prefix = input_file.read(16)
    prefix = prefix.removeprefix(b"\xef\xbb\xbf").lstrip()
    if prefix.startswith((b"{", b"[")):
        return "jsonl"
    return "msgpack"


def decode_binary_flags(value: int) -> dict[str, bool]:
    return {
        "completed": bool(value & (1 << 0)),
        "morphing_building": bool(value & (1 << 2)),
        "constructing_building": bool(value & (1 << 3)),
        "disabled": bool(value & (1 << 4)),
        "burrowed": bool(value & (1 << 5)),
        "cloaked_or_burrowed": bool(value & (1 << 6)),
        "hallucination": bool(value & (1 << 7)),
        "in_transport": bool(value & (1 << 8)),
        "in_bunker": bool(value & (1 << 9)),
        "lifted": bool(value & (1 << 10)),
    }


def unit_name_from_dictionary(unit_type_names: list[str], unit_type_id: int | None) -> str | None:
    if unit_type_id is None:
        return None
    if unit_type_id < 0 or unit_type_id >= len(unit_type_names):
        raise ValueError(f"unit_type_id out of range: {unit_type_id}")
    return normalize_unit_type_name(unit_type_names[unit_type_id])


def decode_binary_unit_record(
    record: list[Any],
    category_names: list[str],
    unit_type_names: list[str],
) -> dict[str, Any]:
    if len(record) != 33:
        raise ValueError(f"invalid unit record length: {len(record)}")

    flags = decode_binary_flags(int(record[6]))
    unit_type_id = int(record[2])
    killer_unit_type_id = int(record[3]) if record[3] is not None else None
    morph_target_type_id = int(record[4]) if record[4] is not None else None
    category_id = int(record[5])
    if category_id < 0 or category_id >= len(category_names):
        raise ValueError(f"category_id out of range: {category_id}")

    return {
        "id": int(record[0]),
        "owner": int(record[1]),
        "unit_type": unit_name_from_dictionary(unit_type_names, unit_type_id),
        "unit_type_id": unit_type_id,
        "killer_unit_type": unit_name_from_dictionary(unit_type_names, killer_unit_type_id),
        "killer_unit_type_id": killer_unit_type_id,
        "morph_target_unit_type": unit_name_from_dictionary(unit_type_names, morph_target_type_id),
        "morph_target_unit_type_id": morph_target_type_id,
        "category": category_names[category_id],
        **flags,
        "hp_raw": int(record[7]),
        "shields_raw": int(record[8]),
        "energy_raw": int(record[9]),
        "pos_x": int(record[10]),
        "pos_y": int(record[11]),
        "move_target_x": int(record[12]),
        "move_target_y": int(record[13]),
        "move_target_unit_id": int(record[14]),
        "order_target_x": int(record[15]),
        "order_target_y": int(record[16]),
        "order_target_unit_id": int(record[17]),
        "main_order_id": int(record[18]),
        "main_order_state": int(record[19]),
        "main_order_timer": int(record[20]),
        "secondary_order_id": int(record[21]),
        "secondary_order_state": int(record[22]),
        "secondary_order_timer": int(record[23]),
        "connected_unit_id": int(record[24]),
        "current_build_unit_id": int(record[25]),
        "subunit_id": int(record[26]),
        "loaded_unit_ids": [int(x) for x in record[27]],
        "build_queue_unit_ids": [int(x) for x in record[28]],
        "build_time": int(record[29]) if record[29] is not None else None,
        "remaining_build_time": int(record[30]) if record[30] is not None else None,
        "tech_in_progress": int(record[31]) if record[31] is not None else None,
        "upgrade_in_progress": int(record[32]) if record[32] is not None else None,
    }


def iter_snapshots_jsonl(path: Path, progress: Callable[[int], None] | None = None) -> Iterable[dict[str, Any]]:
    with path.open("r", encoding="utf-8-sig") as input_file:
        line_number = 0
        while True:
            line = input_file.readline()
            if not line:
                break
            line_number += 1
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
                if progress is not None:
                    progress(input_file.tell())
            except json.JSONDecodeError as e:
                raise ValueError(f"{path}:{line_number}: invalid JSON: {e}") from e


def iter_snapshots_msgpack(path: Path, progress: Callable[[int], None] | None = None) -> Iterable[dict[str, Any]]:
    with path.open("rb") as input_file:
        reader = MessagePackStreamReader(input_file)
        try:
            header = reader.unpack()
        except EOFError as e:
            raise ValueError(f"{path}: empty MessagePack stream") from e

        if (
            not isinstance(header, list)
            or len(header) != 5
            or header[0] != 0
            or header[1] != "sbtl"
            or header[2] not in {1, 2}
        ):
            raise ValueError(f"{path}: invalid sbtl header")
        format_version = int(header[2])
        category_names = [str(x) for x in header[3]]
        unit_type_names = [str(x) for x in header[4]]

        while True:
            try:
                record = reader.unpack()
            except EOFError:
                break

            if not isinstance(record, list) or len(record) != 4 or record[0] != 1:
                raise ValueError(f"{path}: invalid snapshot record")

            owners_payload: dict[str, Any] = {}
            for owner_record in record[2]:
                expected_length = 11 if format_version >= 2 else 9
                if not isinstance(owner_record, list) or len(owner_record) != expected_length:
                    raise ValueError(f"{path}: invalid owner record")
                owner_id = int(owner_record[0])
                if format_version >= 2:
                    gathered_minerals = int(owner_record[4])
                    gathered_gas = int(owner_record[5])
                    supply_current = int(owner_record[6])
                    supply_max = int(owner_record[7])
                    workers_alive = int(owner_record[8])
                    flat_counts = owner_record[9]
                    units = owner_record[10]
                else:
                    gathered_minerals = None
                    gathered_gas = None
                    supply_current = int(owner_record[4])
                    supply_max = int(owner_record[5])
                    workers_alive = int(owner_record[6])
                    flat_counts = owner_record[7]
                    units = owner_record[8]
                if len(flat_counts) % 2 != 0:
                    raise ValueError(f"{path}: invalid unit_counts record for owner {owner_id}")
                counts: dict[str, int] = {}
                for i in range(0, len(flat_counts), 2):
                    unit_type_id = int(flat_counts[i])
                    counts[unit_name_from_dictionary(unit_type_names, unit_type_id)] = int(flat_counts[i + 1])
                owners_payload[str(owner_id)] = {
                    "name": str(owner_record[1]),
                    "minerals": int(owner_record[2]),
                    "gas": int(owner_record[3]),
                    "supply_current": supply_current,
                    "supply_max": supply_max,
                    "workers_alive": workers_alive,
                    "unit_counts": counts,
                    "units": [decode_binary_unit_record(unit, category_names, unit_type_names) for unit in units],
                }
                if gathered_minerals is not None:
                    owners_payload[str(owner_id)]["gathered_minerals"] = gathered_minerals
                    owners_payload[str(owner_id)]["gathered_gas"] = gathered_gas

            snapshot = {
                "frame": int(record[1]),
                "owners": owners_payload,
                "deaths": [decode_binary_unit_record(unit, category_names, unit_type_names) for unit in record[3]],
            }
            yield snapshot
            if progress is not None:
                progress(reader.tell())


def iter_snapshots(path: Path, progress: Callable[[int], None] | None = None) -> Iterable[dict[str, Any]]:
    if detect_timeline_format(path) == "msgpack":
        yield from iter_snapshots_msgpack(path, progress=progress)
    else:
        yield from iter_snapshots_jsonl(path, progress=progress)


def inspect_sampling(path: Path, progress: Callable[[int], None] | None = None) -> SamplingInfo:
    last_frame: int | None = None
    max_frame_delta = 0
    for snapshot in iter_snapshots(path, progress=progress):
        frame = int(snapshot["frame"])
        if last_frame is not None:
            max_frame_delta = max(max_frame_delta, frame - last_frame)
        last_frame = frame
    return SamplingInfo(max_frame_delta=max_frame_delta)


def load_economy(
    path: Path,
    owners: set[int] | None,
    progress: Callable[[int], None] | None = None,
) -> dict[int, list[dict[str, int | float]]]:
    economy: dict[int, list[dict[str, int | float]]] = defaultdict(list)
    for snapshot in iter_snapshots(path, progress=progress):
        frame = int(snapshot["frame"])
        for owner_key, owner_value in snapshot.get("owners", {}).items():
            owner = int(owner_key)
            if owners is not None and owner not in owners:
                continue
            if "minerals" not in owner_value or "gas" not in owner_value:
                continue
            sample = {
                "frame": frame,
                "time_seconds": frame_to_seconds(frame),
                "minerals": int(owner_value["minerals"]),
                "gas": int(owner_value["gas"]),
            }
            if "gathered_minerals" in owner_value:
                sample["gathered_minerals"] = int(owner_value["gathered_minerals"])
            if "gathered_gas" in owner_value:
                sample["gathered_gas"] = int(owner_value["gathered_gas"])
            if "workers_alive" in owner_value:
                sample["workers"] = int(owner_value["workers_alive"])
            economy[owner].append(sample)
    return dict(economy)


def load_unit_counts(
    path: Path,
    owners: set[int] | None,
    progress: Callable[[int], None] | None = None,
) -> dict[int, list[dict[str, Any]]]:
    unit_counts: dict[int, list[dict[str, Any]]] = defaultdict(list)
    previous_counts_by_owner: dict[int, dict[str, int]] = {}
    for snapshot in iter_snapshots(path, progress=progress):
        frame = int(snapshot["frame"])
        for owner_key, owner_value in snapshot.get("owners", {}).items():
            owner = int(owner_key)
            if owners is not None and owner not in owners:
                continue
            if "unit_counts" not in owner_value:
                continue
            counts = {
                normalized_name: int(count)
                for name, count in owner_value["unit_counts"].items()
                for normalized_name in [normalize_unit_type_name(str(name))]
                if not should_omit_output_unit_type(normalized_name)
            }
            if previous_counts_by_owner.get(owner) == counts:
                continue
            previous_counts_by_owner[owner] = counts.copy()
            unit_counts[owner].append(
                {
                    "frame": frame,
                    "time_seconds": frame_to_seconds(frame),
                    "counts": counts,
                }
            )
    return dict(unit_counts)


def load_supply(
    path: Path,
    owners: set[int] | None,
    progress: Callable[[int], None] | None = None,
) -> dict[int, list[dict[str, int | float]]]:
    supply: dict[int, list[dict[str, int | float]]] = defaultdict(list)
    previous_supply_by_owner: dict[int, tuple[int, int]] = {}
    for snapshot in iter_snapshots(path, progress=progress):
        frame = int(snapshot["frame"])
        for owner_key, owner_value in snapshot.get("owners", {}).items():
            owner = int(owner_key)
            if owners is not None and owner not in owners:
                continue
            if "supply_current" not in owner_value or "supply_max" not in owner_value:
                continue
            current = int(owner_value["supply_current"])
            max_supply = int(owner_value["supply_max"])
            sample_supply = (current, max_supply)
            if previous_supply_by_owner.get(owner) == sample_supply:
                continue
            previous_supply_by_owner[owner] = sample_supply
            supply[owner].append(
                {
                    "frame": frame,
                    "time_seconds": frame_to_seconds(frame),
                    "current": current,
                    "max": max_supply,
                }
            )
    return dict(supply)


def load_deaths(
    path: Path,
    owners: set[int] | None,
    progress: Callable[[int], None] | None = None,
) -> dict[int, list[dict[str, Any]]]:
    deaths: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for snapshot in iter_snapshots(path, progress=progress):
        frame = int(snapshot["frame"])
        for death in snapshot.get("deaths", []):
            owner = int(death["owner"])
            if owners is not None and owner not in owners:
                continue
            unit_type = normalize_unit_type_name(str(death["unit_type"]))
            if should_omit_output_unit_type(unit_type):
                continue
            deaths[owner].append(
                {
                    "frame": frame,
                    "time_seconds": frame_to_seconds(frame),
                    "death": {
                        "id": int(death["id"]),
                        "owner": owner,
                        "unit_type": unit_type,
                        "unit_type_id": int(death["unit_type_id"]),
                        "category": str(death["category"]),
                        "pos_x": int(death["pos_x"]),
                        "pos_y": int(death["pos_y"]),
                    },
                }
            )
    return dict(deaths)


def analyze_timeline(
    path: Path,
    analyzer: Analyzer,
    owners: set[int] | None,
    progress: Callable[[int], None] | None = None,
) -> AnalysisResult:
    events: list[Event] = []
    economy: dict[int, list[dict[str, int | float]]] = defaultdict(list)
    supply: dict[int, list[dict[str, int | float]]] = defaultdict(list)
    unit_counts: dict[int, list[dict[str, Any]]] = defaultdict(list)
    deaths: dict[int, list[dict[str, Any]]] = defaultdict(list)
    race_counts: dict[int, Counter[str]] = defaultdict(Counter)
    name_by_owner: dict[int, str] = {}
    output_owners: set[int] = set(owners or ())
    previous_counts_by_owner: dict[int, dict[str, int]] = {}
    previous_supply_by_owner: dict[int, tuple[int, int]] = {}
    last_frame: int | None = None
    max_frame_delta = 0

    for snapshot in iter_snapshots(path, progress=progress):
        frame = int(snapshot["frame"])
        if last_frame is not None:
            max_frame_delta = max(max_frame_delta, frame - last_frame)
        last_frame = frame

        events.extend(analyzer.process_snapshot(snapshot))

        for owner_key, owner_value in snapshot.get("owners", {}).items():
            owner = int(owner_key)
            if owners is not None and owner not in owners:
                continue

            output_owners.add(owner)

            name = owner_value.get("name")
            if isinstance(name, str) and name:
                name_by_owner.setdefault(owner, name)

            if "minerals" in owner_value and "gas" in owner_value:
                sample = {
                    "frame": frame,
                    "time_seconds": frame_to_seconds(frame),
                    "minerals": int(owner_value["minerals"]),
                    "gas": int(owner_value["gas"]),
                }
                if "gathered_minerals" in owner_value:
                    sample["gathered_minerals"] = int(owner_value["gathered_minerals"])
                if "gathered_gas" in owner_value:
                    sample["gathered_gas"] = int(owner_value["gathered_gas"])
                if "workers_alive" in owner_value:
                    sample["workers"] = int(owner_value["workers_alive"])
                economy[owner].append(sample)

            if "supply_current" in owner_value and "supply_max" in owner_value:
                current = int(owner_value["supply_current"])
                max_supply = int(owner_value["supply_max"])
                sample_supply = (current, max_supply)
                if previous_supply_by_owner.get(owner) != sample_supply:
                    previous_supply_by_owner[owner] = sample_supply
                    supply[owner].append(
                        {
                            "frame": frame,
                            "time_seconds": frame_to_seconds(frame),
                            "current": current,
                            "max": max_supply,
                        }
                    )

            if "unit_counts" in owner_value:
                counts = {
                    normalized_name: int(count)
                    for name, count in owner_value["unit_counts"].items()
                    for normalized_name in [normalize_unit_type_name(str(name))]
                    if not should_omit_output_unit_type(normalized_name)
                }
                if previous_counts_by_owner.get(owner) != counts:
                    previous_counts_by_owner[owner] = counts.copy()
                    unit_counts[owner].append(
                        {
                            "frame": frame,
                            "time_seconds": frame_to_seconds(frame),
                            "counts": counts,
                        }
                    )

        for owner, units in iter_owner_units(snapshot):
            if owners is not None and owner not in owners:
                continue
            for unit in units:
                race = race_for_unit(unit)
                if race in RACE_NAMES:
                    race_counts[owner][race] += 1

        for death in snapshot.get("deaths", []):
            owner = int(death["owner"])
            if owners is not None and owner not in owners:
                continue
            unit_type = normalize_unit_type_name(str(death["unit_type"]))
            if should_omit_output_unit_type(unit_type):
                continue
            output_owners.add(owner)
            deaths[owner].append(
                {
                    "frame": frame,
                    "time_seconds": frame_to_seconds(frame),
                    "death": {
                        "id": int(death["id"]),
                        "owner": owner,
                        "unit_type": unit_type,
                        "unit_type_id": int(death["unit_type_id"]),
                        "category": str(death["category"]),
                        "pos_x": int(death["pos_x"]),
                        "pos_y": int(death["pos_y"]),
                    },
                }
            )

    events = sorted(events, key=lambda event: (event.frame, event.owner, event.name))
    output_owners |= {event.owner for event in events}
    race_by_owner: dict[int, str] = {}
    for owner, counts in race_counts.items():
        if counts:
            race_by_owner[owner] = sorted(counts.items(), key=lambda item: (-item[1], item[0]))[0][0]

    return AnalysisResult(
        sampling=SamplingInfo(max_frame_delta=max_frame_delta),
        events=events,
        economy=dict(economy),
        supply=dict(supply),
        unit_counts=dict(unit_counts),
        deaths=dict(deaths),
        race_by_owner=race_by_owner,
        name_by_owner=name_by_owner,
        output_owners=output_owners,
        last_frame=last_frame,
    )


def normalize_filename(name: str) -> str:
    # Normalize unicode characters (NFKD decomposes characters like 'á' to 'a' + '´')
    name = unicodedata.normalize("NFKD", name)
    # Remove non-ascii characters or replace with underscores
    name = "".join(c if ord(c) < 128 else "_" for c in name)
    # Replace non-alphanumeric (excluding _ and -) with underscores
    name = re.sub(r"[^a-zA-Z0-9_\-]", "_", name)
    # Collapse multiple underscores
    name = re.sub(r"_+", "_", name)
    # Strip leading/trailing underscores
    return name.strip("_")


def output_stem(owner: int, race_by_owner: dict[int, str], name_by_owner: dict[int, str]) -> str:
    name = name_by_owner.get(owner)
    if name:
        normalized = normalize_filename(name)
        if normalized:
            return normalized
    return f"{race_by_owner.get(owner, 'unknown')}_{owner}"


def canonical_player_zip_name(owner: int) -> str:
    return f"player_{owner}.zip"


def manifest_matchup(owners: Iterable[int], race_by_owner: dict[int, str]) -> str:
    matchup_parts = []
    for owner in sorted(set(owners)):
        race = race_by_owner.get(owner, "unknown")
        matchup_parts.append(race[:1].upper() if race else "?")
    return "v".join(matchup_parts)


def file_sha256(path: Path, chunk_size: int = 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(chunk_size)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def manifest_payload(
    analysis: AnalysisResult,
    input_path: Path | None,
    replay_path: Path | None,
) -> dict[str, Any]:
    source_path = replay_path.resolve() if replay_path is not None else (input_path.resolve() if input_path is not None else None)
    replay_id_source = replay_path if replay_path is not None else input_path
    if replay_id_source is None:
        raise ValueError("manifest generation requires an input or replay path")
    replay_id = file_sha256(replay_id_source.resolve())
    duration_seconds = frame_to_seconds(analysis.last_frame) if analysis.last_frame is not None else None
    return {
        "schema_version": "replay-analysis-manifest-v1",
        "replay_id": replay_id,
        "source": {
            "filename": source_path.name if source_path is not None else None,
            "path": str(source_path) if source_path is not None else None,
        },
        "matchup": manifest_matchup(analysis.output_owners, analysis.race_by_owner),
        "map": None,
        "duration_seconds": duration_seconds,
        "players": [
            {
                "owner": owner,
                "name": analysis.name_by_owner.get(owner, f"Player {owner + 1}"),
                "race": analysis.race_by_owner.get(owner, "unknown"),
                "zip_filename": canonical_player_zip_name(owner),
            }
            for owner in sorted(analysis.output_owners)
        ],
    }


def default_embedded_html_name(input_path: Path) -> str:
    normalized = normalize_filename(input_path.stem)
    if normalized:
        return f"{normalized}.html"
    return DEFAULT_EMBEDDED_BUILD_ORDER_NAME


def default_batch_output_name(input_path: Path) -> str:
    normalized = normalize_filename(input_path.stem)
    return normalized or "replay"


def collect_replay_files(input_dir: Path) -> list[Path]:
    return sorted(path for path in input_dir.rglob("*.rep") if path.is_file())


def collect_refreshable_html_files(input_dir: Path) -> list[Path]:
    refreshable_paths: list[Path] = []
    for path in sorted(input_dir.rglob("*.html")):
        if path.is_file() and is_embedded_report_html(path):
            refreshable_paths.append(path)
    return refreshable_paths


def unique_batch_output_dirs(replay_paths: list[Path]) -> dict[Path, str]:
    used_names: dict[str, int] = {}
    output_names: dict[Path, str] = {}
    for replay_path in replay_paths:
        base_name = default_batch_output_name(replay_path)
        count = used_names.get(base_name, 0) + 1
        used_names[base_name] = count
        output_names[replay_path] = base_name if count == 1 else f"{base_name}_{count}"
    return output_names


def economy_payload(
    owner: int,
    samples: list[dict[str, int | float]],
    race_by_owner: dict[int, str],
) -> dict[str, Any]:
    return {
        "schema_version": "replay-analysis-economy-v1",
        "owner": owner,
        "race": race_by_owner.get(owner, "unknown"),
        "samples": samples,
    }


def supply_payload(
    owner: int,
    samples: list[dict[str, int | float]],
    race_by_owner: dict[int, str],
) -> dict[str, Any]:
    return {
        "schema_version": "replay-analysis-supply-v1",
        "owner": owner,
        "race": race_by_owner.get(owner, "unknown"),
        "samples": samples,
    }


def unit_counts_payload(
    owner: int,
    samples: list[dict[str, Any]],
    race_by_owner: dict[int, str],
) -> dict[str, Any]:
    return {
        "schema_version": "replay-analysis-unit-counts-v1",
        "owner": owner,
        "race": race_by_owner.get(owner, "unknown"),
        "samples": samples,
    }


def deaths_payload(
    owner: int,
    samples: list[dict[str, Any]],
    race_by_owner: dict[int, str],
) -> dict[str, Any]:
    return {
        "schema_version": "replay-analysis-deaths-v1",
        "owner": owner,
        "race": race_by_owner.get(owner, "unknown"),
        "samples": samples,
    }


def player_payload(
    owner: int,
    race_by_owner: dict[int, str],
    name_by_owner: dict[int, str],
) -> dict[str, Any]:
    return {
        "schema_version": "replay-analysis-player-bundle-v1",
        "owner": owner,
        "name": name_by_owner.get(owner, f"Player {owner + 1}"),
        "race": race_by_owner.get(owner, "unknown"),
        "files": {
            "build_order": "build_order.txt",
            "economy": "economy.json",
            "supply": "supply.json",
            "unit_counts": "unit_counts.json",
            "deaths": "deaths.json",
        },
    }


def embedded_dataset_files(
    owner: int,
    race_by_owner: dict[int, str],
    name_by_owner: dict[int, str],
    economy: dict[int, list[dict[str, int | float]]],
    supply: dict[int, list[dict[str, int | float]]],
    unit_counts: dict[int, list[dict[str, Any]]],
    deaths: dict[int, list[dict[str, Any]]],
    events_by_owner: dict[int, list[Event]],
) -> tuple[str, dict[str, str]]:
    player = player_payload(owner, race_by_owner, name_by_owner)
    files = {
        "player.json": json.dumps(player, indent=2) + "\n",
        "build_order.txt": render_events(events_by_owner.get(owner, []), include_owner=False),
        "economy.json": json.dumps(economy_payload(owner, economy.get(owner, []), race_by_owner), indent=2) + "\n",
        "supply.json": json.dumps(supply_payload(owner, supply.get(owner, []), race_by_owner), indent=2) + "\n",
    }
    if owner in unit_counts:
        files["unit_counts.json"] = json.dumps(
            unit_counts_payload(owner, unit_counts.get(owner, []), race_by_owner),
            indent=2,
        ) + "\n"
    if owner in deaths:
        files["deaths.json"] = json.dumps(
            deaths_payload(owner, deaths.get(owner, []), race_by_owner),
            indent=2,
        ) + "\n"
    return str(player["name"]), files


def player_bundle_files(
    owner: int,
    race_by_owner: dict[int, str],
    name_by_owner: dict[int, str],
    economy: dict[int, list[dict[str, int | float]]],
    supply: dict[int, list[dict[str, int | float]]],
    unit_counts: dict[int, list[dict[str, Any]]],
    deaths: dict[int, list[dict[str, Any]]],
    events_by_owner: dict[int, list[Event]],
) -> dict[str, str]:
    return {
        "player.json": json.dumps(player_payload(owner, race_by_owner, name_by_owner), indent=2) + "\n",
        "build_order.txt": render_events(events_by_owner.get(owner, []), include_owner=False),
        "economy.json": json.dumps(economy_payload(owner, economy.get(owner, []), race_by_owner), indent=2) + "\n",
        "supply.json": json.dumps(supply_payload(owner, supply.get(owner, []), race_by_owner), indent=2) + "\n",
        "unit_counts.json": json.dumps(
            unit_counts_payload(owner, unit_counts.get(owner, []), race_by_owner),
            indent=2,
        ) + "\n",
        "deaths.json": json.dumps(
            deaths_payload(owner, deaths.get(owner, []), race_by_owner),
            indent=2,
        ) + "\n",
    }


def zip_base64_dataset(files: dict[str, str]) -> str:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
        for filename, contents in files.items():
            bundle.writestr(filename, contents)
    return base64.b64encode(buffer.getvalue()).decode("ascii")


def zip_base64_single_file(filename: str, contents: bytes) -> str:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
        bundle.writestr(filename, contents)
    return base64.b64encode(buffer.getvalue()).decode("ascii")


def write_zip_file(output_path: Path, files: dict[str, str]) -> None:
    with zipfile.ZipFile(output_path, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
        for filename, contents in files.items():
            bundle.writestr(filename, contents)


def render_embedded_dataset_scripts(datasets: Iterable[tuple[str, dict[str, str]]]) -> str:
    blocks = []
    for name, files in datasets:
        payload = zip_base64_dataset(files)
        escaped_name = json.dumps(name, ensure_ascii=False)[1:-1]
        blocks.append(
            '<script class="embedded-build-order-dataset" type="text/plain" '
            f'data-format="zip-base64" data-name="{escaped_name}">\n'
            f"{payload}\n"
            "</script>"
        )
    return "\n".join(blocks) + ("\n" if blocks else "")


def render_embedded_replay_script(replay_filename: str, replay_bytes: bytes) -> str:
    escaped_filename = json.dumps(replay_filename, ensure_ascii=False)[1:-1]
    payload = zip_base64_single_file(replay_filename, replay_bytes)
    return (
        '<script class="embedded-build-order-replay" type="text/plain" '
        f'data-format="zip-base64" data-filename="{escaped_filename}">\n'
        f"{payload}\n"
        "</script>\n"
    )


def render_embedded_page_meta_script(page_title: str) -> str:
    payload = json.dumps({"title": page_title}, ensure_ascii=False, separators=(",", ":"))
    return (
        '<script class="embedded-build-order-page-meta" type="application/json">\n'
        f"{payload}\n"
        "</script>\n"
    )


def render_existing_embedded_dataset_scripts(datasets: Iterable[EmbeddedDatasetBlock]) -> str:
    blocks = []
    for dataset in datasets:
        escaped_name = json.dumps(dataset.name, ensure_ascii=False)[1:-1]
        blocks.append(
            '<script class="embedded-build-order-dataset" type="text/plain" '
            f'data-format="{dataset.data_format}" data-name="{escaped_name}">\n'
            f"{dataset.payload}\n"
            "</script>"
        )
    return "\n".join(blocks) + ("\n" if blocks else "")


def render_existing_embedded_replay_script(replay: EmbeddedReplayBlock) -> str:
    escaped_filename = json.dumps(replay.filename, ensure_ascii=False)[1:-1]
    return (
        '<script class="embedded-build-order-replay" type="text/plain" '
        f'data-format="{replay.data_format}" data-filename="{escaped_filename}">\n'
        f"{replay.payload}\n"
        "</script>\n"
    )


def _parse_script_attributes(attribute_text: str) -> dict[str, str]:
    return {
        match.group(1).lower(): match.group(2)
        for match in re.finditer(r'([-\w:]+)\s*=\s*"([^"]*)"', attribute_text, flags=re.IGNORECASE)
    }


def _extract_script_blocks(html: str, class_name: str) -> list[tuple[dict[str, str], str]]:
    pattern = re.compile(r"<script\b(?P<attrs>[^>]*)>(?P<body>.*?)</script>", re.IGNORECASE | re.DOTALL)
    blocks: list[tuple[dict[str, str], str]] = []
    for match in pattern.finditer(html):
        attributes = _parse_script_attributes(match.group("attrs"))
        classes = attributes.get("class", "").split()
        if class_name not in classes:
            continue
        blocks.append((attributes, match.group("body").strip()))
    return blocks


def extract_embedded_report_artifacts(html: str) -> EmbeddedReportArtifacts:
    dataset_blocks: list[EmbeddedDatasetBlock] = []
    for attributes, body in _extract_script_blocks(html, "embedded-build-order-dataset"):
        dataset_blocks.append(
            EmbeddedDatasetBlock(
                name=attributes.get("data-name", ""),
                data_format=attributes.get("data-format", "zip-base64"),
                payload=body,
            )
        )
    if not dataset_blocks:
        raise ValueError("embedded report does not contain any embedded-build-order-dataset scripts")

    replay: EmbeddedReplayBlock | None = None
    replay_blocks = _extract_script_blocks(html, "embedded-build-order-replay")
    if replay_blocks:
        attributes, body = replay_blocks[0]
        replay = EmbeddedReplayBlock(
            filename=attributes.get("data-filename", "game.rep"),
            data_format=attributes.get("data-format", "zip-base64"),
            payload=body,
        )

    page_title: str | None = None
    page_meta_blocks = _extract_script_blocks(html, "embedded-build-order-page-meta")
    if page_meta_blocks:
        try:
            payload = json.loads(page_meta_blocks[0][1])
        except json.JSONDecodeError as e:
            raise ValueError(f"embedded page meta is not valid JSON: {e.msg}") from e
        if not isinstance(payload, dict):
            raise ValueError("embedded page meta must be a JSON object")
        title = payload.get("title")
        if title is not None and not isinstance(title, str):
            raise ValueError("embedded page meta title must be a string")
        page_title = title

    return EmbeddedReportArtifacts(datasets=dataset_blocks, replay=replay, page_title=page_title)


def is_embedded_report_html(path: Path) -> bool:
    try:
        html = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return False
    return bool(_extract_script_blocks(html, "embedded-build-order-dataset"))


def embed_datasets_into_build_order_html(
    template_html: str,
    datasets: Iterable[tuple[str, dict[str, str]]],
    replay_artifact: tuple[str, bytes] | None = None,
    page_title: str | None = None,
) -> str:
    body_close_index = template_html.lower().rfind("</body>")
    if body_close_index == -1:
        raise ValueError("build-order template is missing </body>")

    body_open_index = template_html.lower().find("<body")
    if body_open_index == -1:
        raise ValueError("build-order template is missing <body>")

    body_start = template_html.find(">", body_open_index)
    if body_start == -1:
        raise ValueError("build-order template has malformed <body> tag")
    body_start += 1

    script_insert_index = template_html.lower().find("<script", body_start, body_close_index)
    insert_index = script_insert_index if script_insert_index != -1 else body_close_index
    embedded_blocks = ""
    if page_title:
        embedded_blocks += render_embedded_page_meta_script(page_title)
    embedded_blocks += render_embedded_dataset_scripts(datasets)
    if replay_artifact is not None:
        embedded_blocks += render_embedded_replay_script(replay_artifact[0], replay_artifact[1])
    if not embedded_blocks:
        return template_html
    return template_html[:insert_index] + embedded_blocks + template_html[insert_index:]


def embed_existing_artifacts_into_build_order_html(
    template_html: str,
    artifacts: EmbeddedReportArtifacts,
    page_title: str | None = None,
) -> str:
    body_close_index = template_html.lower().rfind("</body>")
    if body_close_index == -1:
        raise ValueError("build-order template is missing </body>")

    body_open_index = template_html.lower().find("<body")
    if body_open_index == -1:
        raise ValueError("build-order template is missing <body>")

    body_start = template_html.find(">", body_open_index)
    if body_start == -1:
        raise ValueError("build-order template has malformed <body> tag")
    body_start += 1

    script_insert_index = template_html.lower().find("<script", body_start, body_close_index)
    insert_index = script_insert_index if script_insert_index != -1 else body_close_index
    embedded_blocks = ""
    effective_title = page_title if page_title is not None else artifacts.page_title
    if effective_title:
        embedded_blocks += render_embedded_page_meta_script(effective_title)
    embedded_blocks += render_existing_embedded_dataset_scripts(artifacts.datasets)
    if artifacts.replay is not None:
        embedded_blocks += render_existing_embedded_replay_script(artifacts.replay)
    if not embedded_blocks:
        return template_html
    return template_html[:insert_index] + embedded_blocks + template_html[insert_index:]


def write_embedded_build_order_html(
    output_path: Path,
    template_path: Path,
    owners: Iterable[int],
    race_by_owner: dict[int, str],
    name_by_owner: dict[int, str],
    economy: dict[int, list[dict[str, int | float]]],
    supply: dict[int, list[dict[str, int | float]]],
    unit_counts: dict[int, list[dict[str, Any]]],
    deaths: dict[int, list[dict[str, Any]]],
    events: Iterable[Event],
    replay_path: Path | None = None,
    page_title: str | None = None,
) -> None:
    template_html = template_path.read_text(encoding="utf-8")
    events_by_owner: dict[int, list[Event]] = defaultdict(list)
    for event in events:
        events_by_owner[event.owner].append(event)

    datasets = [
        embedded_dataset_files(
            owner,
            race_by_owner,
            name_by_owner,
            economy,
            supply,
            unit_counts,
            deaths,
            events_by_owner,
        )
        for owner in sorted(set(owners))
    ]
    replay_artifact: tuple[str, bytes] | None = None
    if replay_path is not None:
        replay_artifact = (replay_path.name, replay_path.read_bytes())
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        embed_datasets_into_build_order_html(
            template_html,
            datasets,
            replay_artifact=replay_artifact,
            page_title=page_title,
        ),
        encoding="utf-8",
    )


def refresh_embedded_build_order_html(
    input_path: Path,
    output_path: Path,
    template_path: Path,
    page_title: str | None = None,
) -> None:
    artifacts = extract_embedded_report_artifacts(input_path.read_text(encoding="utf-8"))
    refreshed_html = embed_existing_artifacts_into_build_order_html(
        template_path.read_text(encoding="utf-8"),
        artifacts,
        page_title=page_title,
    )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(refreshed_html, encoding="utf-8")


def write_player_bundles(
    output_dir: Path,
    owners: Iterable[int],
    race_by_owner: dict[int, str],
    name_by_owner: dict[int, str],
    economy: dict[int, list[dict[str, int | float]]],
    supply: dict[int, list[dict[str, int | float]]],
    unit_counts: dict[int, list[dict[str, Any]]],
    deaths: dict[int, list[dict[str, Any]]],
    events: Iterable[Event],
) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    events_by_owner: dict[int, list[Event]] = defaultdict(list)
    for event in events:
        events_by_owner[event.owner].append(event)

    for owner in sorted(set(owners)):
        files = player_bundle_files(
            owner,
            race_by_owner,
            name_by_owner,
            economy,
            supply,
            unit_counts,
            deaths,
            events_by_owner,
        )
        canonical_name = canonical_player_zip_name(owner)
        write_zip_file(output_dir / canonical_name, files)
        legacy_name = f"{output_stem(owner, race_by_owner, name_by_owner)}.zip"
        if legacy_name != canonical_name:
            write_zip_file(output_dir / legacy_name, files)


def write_replay_manifest(
    output_dir: Path,
    analysis: AnalysisResult,
    input_path: Path | None,
    replay_path: Path | None,
) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    manifest = manifest_payload(analysis, input_path, replay_path)
    (output_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


def existing_bundle_max_frame(bundle: zipfile.ZipFile) -> int | None:
    max_frame: int | None = None
    for filename in ("economy.json", "supply.json", "unit_counts.json", "deaths.json"):
        entry = bundle.getinfo(filename) if filename in bundle.namelist() else None
        if entry is None:
            continue
        payload = json.loads(bundle.read(filename).decode("utf-8"))
        for sample in payload.get("samples", []):
            frame = sample.get("frame")
            if isinstance(frame, int):
                max_frame = frame if max_frame is None else max(max_frame, frame)
    return max_frame


def load_existing_player_bundles(output_dir: Path) -> list[ExistingPlayerBundleInfo]:
    bundles_by_owner: dict[int, ExistingPlayerBundleInfo] = {}
    for zip_path in sorted(output_dir.glob("*.zip")):
        try:
            with zipfile.ZipFile(zip_path) as bundle:
                if "player.json" not in bundle.namelist():
                    continue
                player = json.loads(bundle.read("player.json").decode("utf-8"))
                owner = int(player["owner"])
                info = ExistingPlayerBundleInfo(
                    owner=owner,
                    name=str(player.get("name", f"Player {owner + 1}")),
                    race=str(player.get("race", "unknown")),
                    zip_filename=zip_path.name,
                    is_canonical=(zip_path.name == canonical_player_zip_name(owner)),
                    max_frame=existing_bundle_max_frame(bundle),
                )
        except (OSError, zipfile.BadZipFile, KeyError, ValueError, json.JSONDecodeError):
            continue

        current = bundles_by_owner.get(owner)
        if current is None or (info.is_canonical and not current.is_canonical):
            bundles_by_owner[owner] = info
    return [bundles_by_owner[owner] for owner in sorted(bundles_by_owner)]


def embedded_replay_bytes_from_html(report_path: Path) -> tuple[str | None, bytes | None]:
    try:
        artifacts = extract_embedded_report_artifacts(report_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, ValueError):
        return None, None
    if artifacts.replay is None or artifacts.replay.data_format != "zip-base64":
        return None, None
    try:
        replay_bundle = zipfile.ZipFile(io.BytesIO(base64.b64decode(artifacts.replay.payload)))
        with replay_bundle:
            return artifacts.replay.filename, replay_bundle.read(artifacts.replay.filename)
    except (ValueError, zipfile.BadZipFile, KeyError, OSError):
        return None, None


def manifest_from_existing_output_dir(output_dir: Path) -> dict[str, Any]:
    bundles = load_existing_player_bundles(output_dir)
    if not bundles:
        raise ValueError("output directory does not contain any readable player ZIP bundles")

    replay_report = next((path for path in sorted(output_dir.glob("*.html")) if is_embedded_report_html(path)), None)
    replay_filename: str | None = None
    replay_bytes: bytes | None = None
    if replay_report is not None:
        replay_filename, replay_bytes = embedded_replay_bytes_from_html(replay_report)

    max_frame: int | None = None
    for bundle in bundles:
        if bundle.max_frame is not None:
            max_frame = bundle.max_frame if max_frame is None else max(max_frame, bundle.max_frame)

    race_by_owner = {bundle.owner: bundle.race for bundle in bundles}
    source_filename = replay_filename
    replay_id = hashlib.sha256(replay_bytes).hexdigest() if replay_bytes is not None else hashlib.sha256(str(output_dir.resolve()).encode("utf-8")).hexdigest()
    return {
        "schema_version": "replay-analysis-manifest-v1",
        "replay_id": replay_id,
        "source": {
            "filename": source_filename,
            "path": None,
        },
        "matchup": manifest_matchup([bundle.owner for bundle in bundles], race_by_owner),
        "map": None,
        "duration_seconds": frame_to_seconds(max_frame) if max_frame is not None else None,
        "players": [
            {
                "owner": bundle.owner,
                "name": bundle.name,
                "race": bundle.race,
                "zip_filename": bundle.zip_filename,
            }
            for bundle in bundles
        ],
    }


def collect_manifestable_output_dirs(input_dir: Path) -> list[Path]:
    output_dirs: dict[Path, None] = {}
    for report_path in collect_refreshable_html_files(input_dir):
        output_dirs[report_path.parent] = None
    return sorted(output_dirs)


def write_manifest_from_existing_output_dir(output_dir: Path) -> None:
    manifest = manifest_from_existing_output_dir(output_dir)
    (output_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


def render_events(events: Iterable[Event], include_owner: bool) -> str:
    lines = []
    seen: set[tuple[int, int, str]] = set()
    for event in events:
        key = (event.frame, event.owner, event.name)
        if key in seen:
            continue
        seen.add(key)
        prefix = f"{format_timestamp(event.frame)} "
        owner = f"P{event.owner} " if include_owner else ""
        lines.append(f"{prefix}{owner}{event.name}")
    return "\n".join(lines) + ("\n" if lines else "")


def is_replay_path(path: Path) -> bool:
    return path.suffix.lower() == ".rep"


def replay_export_command(replay_path: Path, replay_export_speed: int) -> list[str]:
    replay_path = replay_path.resolve()
    packaged_replay_engine = os.environ.get("BW_FORGE_REPLAY_ENGINE_EXE")
    if packaged_replay_engine:
        packaged_path = Path(packaged_replay_engine).expanduser().resolve()
        if packaged_path.is_file():
            return [
                str(packaged_path),
                "--replay-export",
                str(replay_path),
                "--replay-export-speed",
                str(replay_export_speed),
                "--replay-export-disable-render",
                "1",
            ]

    pnpm_executable = shutil.which("pnpm.cmd") or shutil.which("pnpm") or shutil.which("corepack.cmd") or shutil.which("corepack")
    if pnpm_executable is None:
        raise OSError("could not find pnpm or corepack on PATH")

    node_executable = shutil.which("node.exe") or shutil.which("node")
    if node_executable is not None:
        node_dir = Path(node_executable).resolve().parent
        corepack_pnpm = node_dir / "node_modules" / "corepack" / "dist" / "pnpm.js"
        if corepack_pnpm.is_file():
            command = [str(Path(node_executable).resolve()), str(corepack_pnpm)]
        else:
            command = [pnpm_executable]
            if Path(pnpm_executable).stem.lower().startswith("corepack"):
                command.append("pnpm")
    else:
        command = [pnpm_executable]
        if Path(pnpm_executable).stem.lower().startswith("corepack"):
            command.append("pnpm")

    command.extend(
        [
            "run",
            "replay-export",
            "--",
            str(replay_path),
            "--replay-export-speed",
            str(replay_export_speed),
        ]
    )
    return command


def export_replay_timeline(
    replay_path: Path,
    timeline_path: Path,
    shieldbattery_dir: Path,
    replay_export_speed: int,
    timeline_format: str,
) -> None:
    env = os.environ.copy()
    env["SB_UNIT_TIMELINE"] = "1"
    env["SB_UNIT_TIMELINE_FORMAT"] = timeline_format
    env["SB_UNIT_TIMELINE_OUT"] = str(timeline_path)
    env["SB_UNIT_TIMELINE_TIME_UNIT"] = "frames"
    env["SB_UNIT_TIMELINE_STRIDE"] = "1"

    process = subprocess.Popen(
        replay_export_command(replay_path, replay_export_speed),
        cwd=os.environ.get("BW_FORGE_REPLAY_ENGINE_CWD", str(shieldbattery_dir)),
        env=env,
    )
    start_time = time.perf_counter()
    last_report = start_time
    while True:
        return_code = process.poll()
        now = time.perf_counter()
        if return_code is not None:
            if return_code != 0:
                raise subprocess.CalledProcessError(return_code, process.args)
            break
        if now - last_report >= 2.0:
            print(f"[replay-export] running... elapsed {now - start_time:.1f}s", flush=True)
            last_report = now
        time.sleep(0.2)

    if not timeline_path.is_file():
        raise ValueError(f"replay export did not produce timeline output: {timeline_path}")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="ShieldBattery timeline/replay input, or embedded HTML report input in refresh mode")
    parser.add_argument("output_dir", type=Path, nargs="?", help="Directory for per-owner zip bundles")
    parser.add_argument(
        "--refresh-embedded-html",
        action="store_true",
        help="Rebuild existing embedded standalone HTML report(s) onto the current build-order template without re-analyzing data",
    )
    parser.add_argument(
        "--refresh-manifests",
        action="store_true",
        help="Backfill manifest.json for existing replay output folder(s) without rewriting ZIPs or HTML",
    )
    parser.add_argument("--owner", type=int, action="append", help="Owner/player id to include; repeatable")
    parser.add_argument("--include-initial", action="store_true", help="Emit units from the first snapshot")
    parser.add_argument("--include-tech", action="store_true", help="Include tech research events")
    parser.add_argument(
        "--shieldbattery-dir",
        type=Path,
        default=DEFAULT_SHIELDBATTERY_DIR,
        help="ShieldBattery repo directory used to run replay export",
    )
    parser.add_argument(
        "--replay-export-speed",
        type=int,
        default=DEFAULT_REPLAY_EXPORT_SPEED,
        help="Replay export speed multiplier when input is a .rep file",
    )
    parser.add_argument(
        "--timeline-format",
        choices=["msgpack", "jsonl"],
        default=DEFAULT_TIMELINE_FORMAT,
        help="Replay export timeline format when input is a .rep file",
    )
    parser.add_argument(
        "--build-order-template",
        type=Path,
        default=DEFAULT_BUILD_ORDER_TEMPLATE,
        help="Path to the build-order.html template used for embedded standalone output",
    )
    parser.add_argument(
        "--embedded-html-output",
        type=Path,
        help="Output path for the standalone HTML file; in refresh mode only supported for single-file input",
    )
    parser.add_argument(
        "--embedded-replay-input",
        type=Path,
        help="Optional replay file to embed in the standalone HTML; defaults to the input replay when input is a .rep file",
    )
    parser.add_argument(
        "--page-title",
        help="Optional standalone HTML page title; defaults to the input filename stem",
    )
    parser.add_argument(
        "--skip-existing",
        action="store_true",
        help="In replay-directory batch mode, skip replays whose computed output subdirectory already exists",
    )
    parser.add_argument(
        "--include-unit-appearances",
        action="store_true",
        help="Emit non-building unit first appearances as well as queue-start events",
    )
    return parser.parse_args(argv)


def process_input(
    args: argparse.Namespace,
    input_path: Path,
    output_dir: Path,
    embedded_html_output: Path,
    embedded_replay_input: Path | None,
    page_title: str,
) -> None:
    owners = set(args.owner) if args.owner else None
    analyzer = Analyzer(
        owners=owners,
        include_initial=args.include_initial,
        include_tech=args.include_tech,
        include_unit_appearances=args.include_unit_appearances,
    )
    timeline_path = input_path
    cleanup_timeline_dir: tempfile.TemporaryDirectory[str] | None = None
    try:
        if is_replay_path(input_path):
            replay_export_start = time.perf_counter()
            cleanup_timeline_dir = tempfile.TemporaryDirectory(prefix="replay-analysis-")
            timeline_extension = ".sbtl" if args.timeline_format == "msgpack" else ".jsonl"
            timeline_path = Path(cleanup_timeline_dir.name) / f"sb-unit-timeline{timeline_extension}"
            export_replay_timeline(
                input_path,
                timeline_path,
                args.shieldbattery_dir,
                args.replay_export_speed,
                args.timeline_format,
            )
            print(f"[replay-export] complete in {time.perf_counter() - replay_export_start:.1f}s", flush=True)
            print("[pipeline] 50.0% replay export complete", flush=True)

        analysis_progress = AnalysisProgressReporter(timeline_path.stat().st_size)
        analysis_start = time.perf_counter()
        analysis_progress.start()
        analysis = analyze_timeline(timeline_path, analyzer, owners, progress=analysis_progress.update)
        analysis_progress.finish()
        if analysis.sampling.max_frame_delta > 1:
            print(
                f"warning: input timeline skips frames (max delta {analysis.sampling.max_frame_delta}); "
                "build-order timestamps may be approximate unless ShieldBattery exports every frame",
                file=sys.stderr,
            )
        write_player_bundles(
            output_dir,
            analysis.output_owners,
            analysis.race_by_owner,
            analysis.name_by_owner,
            analysis.economy,
            analysis.supply,
            analysis.unit_counts,
            analysis.deaths,
            analysis.events,
        )
        write_replay_manifest(output_dir, analysis, input_path, embedded_replay_input)
        write_embedded_build_order_html(
            embedded_html_output,
            args.build_order_template,
            analysis.output_owners,
            analysis.race_by_owner,
            analysis.name_by_owner,
            analysis.economy,
            analysis.supply,
            analysis.unit_counts,
            analysis.deaths,
            analysis.events,
            replay_path=embedded_replay_input,
            page_title=page_title,
        )
        print(f"[analysis] complete in {time.perf_counter() - analysis_start:.1f}s", flush=True)
    finally:
        if cleanup_timeline_dir is not None:
            cleanup_timeline_dir.cleanup()


def validate_refresh_args(args: argparse.Namespace) -> str | None:
    if args.output_dir is not None:
        return "refresh mode does not use output_dir; use --embedded-html-output for single-file output overrides"
    if args.owner:
        return "--owner is not supported in refresh mode"
    if args.include_initial:
        return "--include-initial is not supported in refresh mode"
    if args.include_tech:
        return "--include-tech is not supported in refresh mode"
    if args.include_unit_appearances:
        return "--include-unit-appearances is not supported in refresh mode"
    if args.embedded_replay_input is not None:
        return "--embedded-replay-input is not supported in refresh mode"
    if args.shieldbattery_dir != DEFAULT_SHIELDBATTERY_DIR:
        return "--shieldbattery-dir is not supported in refresh mode"
    if args.replay_export_speed != DEFAULT_REPLAY_EXPORT_SPEED:
        return "--replay-export-speed is not supported in refresh mode"
    if args.timeline_format != DEFAULT_TIMELINE_FORMAT:
        return "--timeline-format is not supported in refresh mode"
    return None


def refresh_manifest_reports(args: argparse.Namespace) -> int:
    validation_error = validate_refresh_args(args)
    if validation_error is not None:
        print(f"error: {validation_error}", file=sys.stderr)
        return 1

    if args.embedded_html_output is not None:
        print("error: --embedded-html-output is not supported when refreshing manifests", file=sys.stderr)
        return 1

    if args.input.is_dir():
        output_dirs = collect_manifestable_output_dirs(args.input)
        if not output_dirs:
            print(f"error: no embedded HTML reports found under {args.input}", file=sys.stderr)
            return 1

        refresh_start = time.perf_counter()
        failures: list[tuple[Path, str]] = []
        print(f"[manifest-refresh] found {len(output_dirs)} replay output folder(s)", flush=True)
        for index, output_dir in enumerate(output_dirs, start=1):
            relative_path = output_dir.relative_to(args.input)
            print(f"[manifest-refresh] {index}/{len(output_dirs)} {relative_path}", flush=True)
            try:
                write_manifest_from_existing_output_dir(output_dir)
            except (OSError, ValueError) as e:
                failures.append((output_dir, str(e)))
                print(f"[manifest-refresh] failed: {relative_path}: {e}", file=sys.stderr, flush=True)

        success_count = len(output_dirs) - len(failures)
        print(
            f"[manifest-refresh] complete: {success_count} succeeded, {len(failures)} failed in {time.perf_counter() - refresh_start:.1f}s",
            flush=True,
        )
        for output_dir, message in failures:
            print(f"[manifest-refresh] failure: {output_dir.relative_to(args.input)}: {message}", file=sys.stderr, flush=True)
        return 1 if failures else 0

    output_dir = args.input.parent if args.input.is_file() else args.input
    try:
        write_manifest_from_existing_output_dir(output_dir)
    except OSError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    except ValueError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    print(f"[manifest-refresh] wrote {output_dir / 'manifest.json'}", flush=True)
    return 0


def refresh_embedded_html_reports(args: argparse.Namespace) -> int:
    validation_error = validate_refresh_args(args)
    if validation_error is not None:
        print(f"error: {validation_error}", file=sys.stderr)
        return 1

    if args.input.is_dir():
        if args.embedded_html_output is not None:
            print("error: --embedded-html-output is not supported when refreshing a directory", file=sys.stderr)
            return 1
        report_paths = collect_refreshable_html_files(args.input)
        if not report_paths:
            print(f"error: no embedded HTML reports found under {args.input}", file=sys.stderr)
            return 1

        refresh_start = time.perf_counter()
        failures: list[tuple[Path, str]] = []
        print(f"[refresh] found {len(report_paths)} embedded report(s)", flush=True)
        for index, report_path in enumerate(report_paths, start=1):
            relative_path = report_path.relative_to(args.input)
            print(f"[refresh] {index}/{len(report_paths)} {relative_path}", flush=True)
            try:
                refresh_embedded_build_order_html(
                    report_path,
                    report_path,
                    args.build_order_template,
                    page_title=args.page_title,
                )
            except (OSError, ValueError) as e:
                failures.append((report_path, str(e)))
                print(f"[refresh] failed: {relative_path}: {e}", file=sys.stderr, flush=True)

        success_count = len(report_paths) - len(failures)
        print(
            f"[refresh] complete: {success_count} succeeded, {len(failures)} failed in {time.perf_counter() - refresh_start:.1f}s",
            flush=True,
        )
        for report_path, message in failures:
            print(f"[refresh] failure: {report_path.relative_to(args.input)}: {message}", file=sys.stderr, flush=True)
        return 1 if failures else 0

    output_path = args.embedded_html_output or args.input
    try:
        refresh_embedded_build_order_html(
            args.input,
            output_path,
            args.build_order_template,
            page_title=args.page_title,
        )
    except OSError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    except ValueError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    print(f"[refresh] wrote {output_path}", flush=True)
    return 0


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    if args.refresh_embedded_html and args.refresh_manifests:
        print("error: choose only one of --refresh-embedded-html or --refresh-manifests", file=sys.stderr)
        return 1
    if args.refresh_embedded_html:
        return refresh_embedded_html_reports(args)
    if args.refresh_manifests:
        return refresh_manifest_reports(args)

    if args.output_dir is None:
        print("error: output_dir is required unless --refresh-embedded-html or --refresh-manifests is used", file=sys.stderr)
        return 1

    if args.input.is_dir():
        if args.embedded_html_output is not None:
            print("error: --embedded-html-output is not supported when input is a replay directory", file=sys.stderr)
            return 1
        if args.embedded_replay_input is not None:
            print("error: --embedded-replay-input is not supported when input is a replay directory", file=sys.stderr)
            return 1

        replay_paths = collect_replay_files(args.input)
        if not replay_paths:
            print(f"error: no replay files found under {args.input}", file=sys.stderr)
            return 1

        batch_start = time.perf_counter()
        output_names = unique_batch_output_dirs(replay_paths)
        failures: list[tuple[Path, str]] = []
        skipped_count = 0
        print(f"[batch] found {len(replay_paths)} replay(s)", flush=True)
        for index, replay_path in enumerate(replay_paths, start=1):
            relative_path = replay_path.relative_to(args.input)
            replay_output_dir = args.output_dir / output_names[replay_path]
            embedded_html_output = replay_output_dir / default_embedded_html_name(replay_path)
            page_title = args.page_title or replay_path.stem
            print(f"[batch] {index}/{len(replay_paths)} {relative_path}", flush=True)
            if args.skip_existing and replay_output_dir.exists():
                skipped_count += 1
                print(f"[batch] skipped: {relative_path}: output dir already exists", flush=True)
                continue
            try:
                process_input(
                    args,
                    replay_path,
                    replay_output_dir,
                    embedded_html_output,
                    replay_path,
                    page_title,
                )
            except (subprocess.CalledProcessError, OSError, ValueError) as e:
                message = f"replay export failed with exit code {e.returncode}" if isinstance(e, subprocess.CalledProcessError) else str(e)
                failures.append((replay_path, message))
                print(f"[batch] failed: {relative_path}: {message}", file=sys.stderr, flush=True)

        success_count = len(replay_paths) - len(failures) - skipped_count
        print(
            f"[batch] complete: {success_count} succeeded, {skipped_count} skipped, {len(failures)} failed in {time.perf_counter() - batch_start:.1f}s",
            flush=True,
        )
        for replay_path, message in failures:
            print(f"[batch] failure: {replay_path.relative_to(args.input)}: {message}", file=sys.stderr, flush=True)
        return 1 if failures else 0

    embedded_html_output = args.embedded_html_output or (args.output_dir / default_embedded_html_name(args.input))
    embedded_replay_input = args.embedded_replay_input or (args.input if is_replay_path(args.input) else None)
    page_title = args.page_title or args.input.stem
    try:
        process_input(
            args,
            args.input,
            args.output_dir,
            embedded_html_output,
            embedded_replay_input,
            page_title,
        )
    except subprocess.CalledProcessError as e:
        print(f"error: replay export failed with exit code {e.returncode}", file=sys.stderr)
        return 1
    except OSError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    except ValueError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

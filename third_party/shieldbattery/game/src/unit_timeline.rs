use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fs::File;
use std::io::{self, BufWriter, Write};
use std::path::PathBuf;

use parking_lot::Mutex;
use rmp::encode::{
    ValueWriteError, write_array_len, write_i16, write_i32, write_nil, write_str, write_u8,
    write_u16, write_u32,
};
use serde::Serialize;

use bw_dat::{Race, UnitArray, UnitId};

use crate::bw::unit::Unit;
use crate::bw::{self, Bw};
use crate::bw_scr::BwScr;

const SCHEMA_VERSION: &str = "sb-unit-timeline-v2";
const MSGPACK_MAGIC: &str = "sbtl";
const MSGPACK_VERSION: u32 = 2;
const FRAMES_PER_SECOND: u32 = 24;
const CATEGORY_NAMES: &[&str] = &[
    "building", "worker", "resource", "powerup", "subunit", "air", "unit",
];

#[derive(Clone, Copy, Default)]
enum TimeUnit {
    #[default]
    Frames,
    Seconds,
}

#[derive(Clone, Copy, Default, Eq, PartialEq)]
enum OutputFormat {
    #[default]
    Jsonl,
    Msgpack,
}

#[derive(Clone, Default)]
pub struct Config {
    enabled: bool,
    format: OutputFormat,
    output_path: Option<PathBuf>,
    start_frame: u32,
    end_frame: Option<u32>,
    stride: u32,
    owners: Option<BTreeSet<u8>>,
}

pub struct State {
    config: Config,
    writer: Mutex<Option<Writer>>,
    last_emitted_frame: Mutex<Option<u32>>,
    previous_units: Mutex<BTreeMap<u32, UnitRecord>>,
    gathered_resources: Mutex<BTreeMap<u8, GatheredResources>>,
}

struct Writer {
    inner: WriterImpl,
}

enum WriterImpl {
    Jsonl(BufWriter<File>),
    Msgpack(BufWriter<File>),
}

#[derive(Serialize)]
struct Snapshot {
    schema_version: &'static str,
    frame: u32,
    owners: BTreeMap<u8, OwnerSnapshot>,
    deaths: Vec<UnitRecord>,
}

#[derive(Serialize)]
struct OwnerSnapshot {
    name: String,
    minerals: u32,
    gas: u32,
    gathered_minerals: u32,
    gathered_gas: u32,
    supply_current: u32,
    supply_max: u32,
    workers_alive: u32,
    unit_counts: BTreeMap<String, u32>,
    units: Vec<UnitRecord>,
}

#[derive(Clone, Copy, Default)]
struct GatheredResources {
    minerals: u32,
    gas: u32,
}

#[derive(Serialize, Clone)]
struct UnitRecord {
    id: u32,
    owner: u8,
    unit_type: &'static str,
    killer_unit_type: Option<&'static str>,
    #[serde(skip_serializing)]
    killer_unit_type_id: Option<u16>,
    unit_type_id: u16,
    morph_target_unit_type: Option<&'static str>,
    morph_target_unit_type_id: Option<u16>,
    category: &'static str,
    #[serde(skip_serializing)]
    category_id: u8,
    #[serde(skip_serializing)]
    binary_flags: u16,
    completed: bool,
    dying: bool,
    morphing_building: bool,
    constructing_building: bool,
    disabled: bool,
    burrowed: bool,
    cloaked_or_burrowed: bool,
    hallucination: bool,
    in_transport: bool,
    in_bunker: bool,
    lifted: bool,
    hp_raw: i32,
    shields_raw: i32,
    energy_raw: u16,
    pos_x: i16,
    pos_y: i16,
    move_target_x: i16,
    move_target_y: i16,
    move_target_unit_id: u32,
    order_target_x: i16,
    order_target_y: i16,
    order_target_unit_id: u32,
    main_order_id: u8,
    main_order_state: u8,
    main_order_timer: u8,
    secondary_order_id: u8,
    secondary_order_state: u8,
    secondary_order_timer: u8,
    connected_unit_id: u32,
    current_build_unit_id: u32,
    subunit_id: u32,
    loaded_unit_ids: Vec<u32>,
    build_queue_unit_ids: Vec<u16>,
    build_time: Option<u32>,
    remaining_build_time: Option<u32>,
    tech_in_progress: Option<u16>,
    upgrade_in_progress: Option<u16>,
    status_flags: Vec<String>,
}

impl Config {
    pub fn from_environment() -> Self {
        let format = OutputFormat::from_environment();
        let output_path =
            env_path("SB_UNIT_TIMELINE_OUT").or_else(|| Some(format.default_output_path()));
        let enabled = env::var("SB_UNIT_TIMELINE")
            .ok()
            .map(|x| x != "0")
            .unwrap_or(true);
        let time_unit = TimeUnit::from_environment();
        let start_frame = time_unit.to_frame_count(env_u32("SB_UNIT_TIMELINE_START").unwrap_or(0));
        let end_frame = env_u32("SB_UNIT_TIMELINE_END").map(|x| time_unit.to_frame_count(x));
        let stride = time_unit
            .to_frame_count(env_u32("SB_UNIT_TIMELINE_STRIDE").unwrap_or(1))
            .max(1);
        let owners = env::var("SB_UNIT_TIMELINE_OWNERS")
            .ok()
            .map(|x| {
                x.split(',')
                    .filter_map(|part| part.trim().parse::<u8>().ok())
                    .collect::<BTreeSet<_>>()
            })
            .filter(|x| !x.is_empty());
        Self {
            enabled,
            format,
            output_path,
            start_frame,
            end_frame,
            stride,
            owners,
        }
    }
}

impl TimeUnit {
    fn from_environment() -> Self {
        match env::var("SB_UNIT_TIMELINE_TIME_UNIT")
            .ok()
            .map(|x| x.trim().to_ascii_lowercase())
            .as_deref()
        {
            Some("second") | Some("seconds") | Some("sec") | Some("s") => Self::Seconds,
            _ => Self::Frames,
        }
    }

    fn to_frame_count(self, value: u32) -> u32 {
        match self {
            Self::Frames => value,
            Self::Seconds => value.saturating_mul(FRAMES_PER_SECOND),
        }
    }
}

impl OutputFormat {
    fn from_environment() -> Self {
        match env::var("SB_UNIT_TIMELINE_FORMAT")
            .ok()
            .map(|x| x.trim().to_ascii_lowercase())
            .as_deref()
        {
            Some("msgpack") | Some("mpk") | Some("mp") => Self::Msgpack,
            _ => Self::Jsonl,
        }
    }

    fn default_output_path(self) -> PathBuf {
        match self {
            Self::Jsonl => PathBuf::from(r"C:\Windows\Temp\sb-unit-timeline.jsonl"),
            Self::Msgpack => PathBuf::from(r"C:\Windows\Temp\sb-unit-timeline.sbtl"),
        }
    }
}

impl State {
    pub fn from_environment() -> Self {
        Self {
            config: Config::from_environment(),
            writer: Mutex::new(None),
            last_emitted_frame: Mutex::new(None),
            previous_units: Mutex::new(BTreeMap::new()),
            gathered_resources: Mutex::new(BTreeMap::new()),
        }
    }

    pub fn reset_for_game(&self) {
        *self.last_emitted_frame.lock() = None;
        self.previous_units.lock().clear();
        self.gathered_resources.lock().clear();
        *self.writer.lock() = None;
    }

    pub fn record_minerals_gathered(&self, owner: u8, amount: u32) {
        self.record_gathered(owner, amount, 0);
    }

    pub fn record_gas_gathered(&self, owner: u8, amount: u32) {
        self.record_gathered(owner, 0, amount);
    }

    fn record_gathered(&self, owner: u8, minerals: u32, gas: u32) {
        if !self.config.enabled || (minerals == 0 && gas == 0) {
            return;
        }
        let mut gathered = self.gathered_resources.lock();
        let entry = gathered.entry(owner).or_default();
        entry.minerals = entry.minerals.saturating_add(minerals);
        entry.gas = entry.gas.saturating_add(gas);
    }

    pub fn emit_if_enabled(&self, bw: &BwScr) {
        if !self.config.enabled {
            return;
        }

        let frame = unsafe { (*bw.game()).frame_count };
        if !self.should_emit_frame(frame) {
            return;
        }
        {
            let mut last_emitted_frame = self.last_emitted_frame.lock();
            if *last_emitted_frame == Some(frame) {
                return;
            }
            *last_emitted_frame = Some(frame);
        }

        let mut writer = self.writer.lock();
        if writer.is_none() {
            *writer = self.open_writer();
        }

        let Some(writer) = writer.as_mut() else {
            return;
        };

        let mut snapshot = capture_snapshot(bw, self, &self.config, frame);
        let mut previous_units = self.previous_units.lock();
        let mut current_units = BTreeMap::new();

        for owner in snapshot.owners.values() {
            for unit in &owner.units {
                current_units.insert(unit.id, unit.clone());
            }
        }

        let mut deaths = Vec::new();
        for (id, unit) in previous_units.iter() {
            if !current_units.contains_key(id) {
                deaths.push(unit.clone());
            }
        }

        snapshot.deaths = deaths;
        *previous_units = current_units;

        if let Err(err) = writer.write_snapshot(&snapshot) {
            warn!("SB unit timeline write failed: {}", err);
        }
    }

    pub fn flush(&self) {
        let mut writer = self.writer.lock();
        if let Some(writer) = writer.as_mut() {
            let _ = writer.flush();
        }
    }

    fn should_emit_frame(&self, frame: u32) -> bool {
        if frame < self.config.start_frame {
            return false;
        }
        if let Some(end_frame) = self.config.end_frame {
            if frame > end_frame {
                return false;
            }
        }
        (frame - self.config.start_frame) % self.config.stride == 0
    }

    fn open_writer(&self) -> Option<Writer> {
        let path = self.config.output_path.as_ref()?;
        match File::create(path) {
            Ok(file) => Writer::open(BufWriter::new(file), self.config.format),
            Err(e) => {
                warn!(
                    "Failed to open SB unit timeline output {}: {}",
                    path.display(),
                    e
                );
                None
            }
        }
    }
}

impl Writer {
    fn open(output: BufWriter<File>, format: OutputFormat) -> Option<Self> {
        let inner = match format {
            OutputFormat::Jsonl => WriterImpl::Jsonl(output),
            OutputFormat::Msgpack => {
                let mut output = output;
                if let Err(err) = write_msgpack_header(&mut output) {
                    warn!(
                        "Failed to write SB unit timeline MessagePack header: {}",
                        err
                    );
                    return None;
                }
                WriterImpl::Msgpack(output)
            }
        };
        Some(Self { inner })
    }

    fn write_snapshot(&mut self, snapshot: &Snapshot) -> io::Result<()> {
        match &mut self.inner {
            WriterImpl::Jsonl(output) => {
                serde_json::to_writer(&mut *output, snapshot).map_err(io::Error::other)?;
                output.write_all(b"\n")
            }
            WriterImpl::Msgpack(output) => write_msgpack_snapshot(output, snapshot),
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        match &mut self.inner {
            WriterImpl::Jsonl(output) | WriterImpl::Msgpack(output) => output.flush(),
        }
    }
}

fn capture_snapshot(bw: &BwScr, state: &State, config: &Config, frame: u32) -> Snapshot {
    let units = bw.unit_array();
    let game = unsafe { bw_dat::Game::from_ptr(bw.game()) };
    let loaded_refs = collect_loaded_refs(&units);
    let mut owners = BTreeMap::<u8, OwnerSnapshot>::new();

    for index in 0..units.len() {
        let Some(unit) = units.get_by_index(index as u32) else {
            continue;
        };
        if !should_capture_unit(unit, &units, &loaded_refs) {
            continue;
        }

        let owner = unit.player();
        if let Some(owner_filter) = config.owners.as_ref() {
            if !owner_filter.contains(&owner) {
                continue;
            }
        }

        let owner_snapshot = owners
            .entry(owner)
            .or_insert_with(|| owner_snapshot(bw, state, game, owner));

        let unit_record = capture_unit(unit, &units);
        *owner_snapshot
            .unit_counts
            .entry(unit_record.unit_type.to_string())
            .or_insert(0) += 1;
        owner_snapshot.units.push(unit_record);
    }

    for owner in owners.values_mut() {
        owner.units.sort_by_key(|unit| unit.id);
    }
    owners.retain(|_, owner| !is_resource_pseudo_owner(owner));

    Snapshot {
        schema_version: SCHEMA_VERSION,
        frame,
        owners,
        deaths: Vec::new(),
    }
}

fn is_resource_pseudo_owner(owner: &OwnerSnapshot) -> bool {
    owner.unit_counts.contains_key("vespene_geyser")
}

fn owner_snapshot(bw: &BwScr, state: &State, game: bw_dat::Game, owner: u8) -> OwnerSnapshot {
    let (supply_current, supply_max) = owner_supply(bw, game, owner);
    let gathered = state
        .gathered_resources
        .lock()
        .get(&owner)
        .copied()
        .unwrap_or_default();
    let workers_alive = [bw_dat::unit::SCV, bw_dat::unit::PROBE, bw_dat::unit::DRONE]
        .iter()
        .map(|&id| game.completed_count(owner, id))
        .sum();
    OwnerSnapshot {
        name: owner_name(bw, owner),
        minerals: game.minerals(owner),
        gas: game.gas(owner),
        gathered_minerals: gathered.minerals,
        gathered_gas: gathered.gas,
        supply_current,
        supply_max,
        workers_alive,
        unit_counts: BTreeMap::new(),
        units: Vec::new(),
    }
}

fn owner_name(bw: &BwScr, owner: u8) -> String {
    let player = unsafe { bw.players().add(owner as usize) };
    let name = unsafe { bw::player_name(player) };
    if name.is_empty() {
        format!("Player {}", owner + 1)
    } else {
        name.into_owned()
    }
}

fn owner_supply(bw: &BwScr, game: bw_dat::Game, owner: u8) -> (u32, u32) {
    let race = owner_race(bw, owner);
    let used = game.supply_used(owner, race);
    let max = game
        .supply_provided(owner, race)
        .min(game.supply_max(owner, race));
    (used.wrapping_add(1) / 2, max / 2)
}

fn owner_race(bw: &BwScr, owner: u8) -> Race {
    let race = unsafe { (*bw.players().add(owner as usize)).race };
    match race {
        0 => Race::Zerg,
        1 => Race::Terran,
        2 => Race::Protoss,
        _ => Race::Zerg,
    }
}

fn should_capture_unit(unit: Unit, units: &UnitArray, loaded_refs: &BTreeSet<u32>) -> bool {
    if UnitId::optional(unit.id().0 as u32).is_none() || unit.is_dying() {
        return false;
    }

    unit.sprite().is_some()
        || unit.in_transport()
        || unit.in_bunker()
        || loaded_refs.contains(&unique_id(unit, units))
}

fn capture_unit(unit: Unit, units: &UnitArray) -> UnitRecord {
    let pos = unit.position();
    let move_target = unsafe { &(**unit).flingy.move_target };
    let morph_target = morph_target_unit_id(unit);
    let build_progress = build_progress(unit);
    let killer_unit_type_id =
        unsafe { Unit::from_ptr((**unit).previous_attacker) }.map(|attacker| attacker.id().0);
    let killer_unit_type = killer_unit_type_id.map(|id| unit_type_name(UnitId(id)));
    let category = unit_category(unit.id());

    UnitRecord {
        id: unique_id(unit, units),
        owner: unit.player(),
        unit_type: unit_type_name(unit.id()),
        killer_unit_type,
        killer_unit_type_id,
        unit_type_id: unit.id().0,
        morph_target_unit_type: morph_target.map(unit_type_name),
        morph_target_unit_type_id: morph_target.map(|x| x.0),
        category,
        category_id: unit_category_id(category),
        binary_flags: unit_binary_flags(unit),
        completed: unit.is_completed(),
        dying: false,
        morphing_building: unit.is_morphing_building(),
        constructing_building: unit.is_constructing_building(),
        disabled: unit.is_disabled(),
        burrowed: unit.is_burrowed(),
        cloaked_or_burrowed: unit.is_invisible(),
        hallucination: unit.is_hallucination(),
        in_transport: unit.in_transport(),
        in_bunker: unit.in_bunker(),
        lifted: unit.id().is_building() && !unit.is_landed_building(),
        hp_raw: unit.hitpoints(),
        shields_raw: unit.shields(),
        energy_raw: unit.energy(),
        pos_x: pos.x,
        pos_y: pos.y,
        move_target_x: move_target.pos.x,
        move_target_y: move_target.pos.y,
        move_target_unit_id: related_id(unsafe { Unit::from_ptr(move_target.unit) }, units),
        order_target_x: unit.target_pos().x,
        order_target_y: unit.target_pos().y,
        order_target_unit_id: related_id(unit.target(), units),
        main_order_id: unit.order().0,
        main_order_state: unit.order_state(),
        main_order_timer: unsafe { (**unit).order_timer },
        secondary_order_id: unit.secondary_order().0,
        secondary_order_state: unsafe { (**unit).secondary_order_state },
        secondary_order_timer: unsafe { (**unit).secondary_order_wait },
        connected_unit_id: related_id(unit.related(), units),
        current_build_unit_id: related_id(unit.currently_building(), units),
        subunit_id: related_id(unit.subunit_linked(), units),
        loaded_unit_ids: raw_loaded_unit_ids(unit, units),
        build_queue_unit_ids: build_queue_unit_ids(unit),
        build_time: build_progress.map(|x| x.build_time),
        remaining_build_time: build_progress.map(|x| x.remaining_build_time),
        tech_in_progress: unit.tech_in_progress().map(|x| x.0),
        upgrade_in_progress: unit.upgrade_in_progress().map(|x| x.0),
        status_flags: status_flags(unit.flags()),
    }
}

#[derive(Clone, Copy)]
struct BuildProgress {
    build_time: u32,
    remaining_build_time: u32,
}

fn unique_id(unit: Unit, units: &UnitArray) -> u32 {
    units.to_unique_id(unit)
}

fn related_id(unit: Option<Unit>, units: &UnitArray) -> u32 {
    unit.map(|x| unique_id(x, units)).unwrap_or(0)
}

fn collect_loaded_refs(units: &UnitArray) -> BTreeSet<u32> {
    let mut out = BTreeSet::new();
    for index in 0..units.len() {
        let Some(unit) = units.get_by_index(index as u32) else {
            continue;
        };
        if UnitId::optional(unit.id().0 as u32).is_none()
            || unit.is_dying()
            || unit.sprite().is_none()
        {
            continue;
        }
        out.extend(raw_loaded_unit_ids(unit, units));
    }
    out
}

fn raw_loaded_unit_ids(unit: Unit, units: &UnitArray) -> Vec<u32> {
    let high_bits = if units.len() > 1700 {
        unsafe { (**unit).scr_carried_unit_high_bits }
    } else {
        0
    };
    unsafe { (**unit).loaded_units }
        .iter()
        .copied()
        .enumerate()
        .filter_map(|(i, low)| {
            if low == 0 {
                return None;
            }
            let id = low as u32 | (((high_bits >> (i * 2)) as u32 & 0x3) << 16);
            get_by_unique_id_loose(units, id).map(|_| id)
        })
        .collect()
}

fn get_by_unique_id_loose(units: &UnitArray, id: u32) -> Option<Unit> {
    let long_id = units.len() > 1700;
    let (index, minor) = if long_id {
        ((id & 0x1fff) as usize, (id >> 0xd) as u8)
    } else {
        ((id & 0x7ff) as usize, (id >> 0xb) as u8)
    };
    if index > units.len() || index == 0 {
        return None;
    }

    let unit = units.get_by_index((index - 1) as u32)?;
    if UnitId::optional(unit.id().0 as u32).is_some()
        && !unit.is_dying()
        && unsafe { (**unit).minor_unique_index == minor }
    {
        Some(unit)
    } else {
        None
    }
}

fn build_queue_unit_ids(unit: Unit) -> Vec<u16> {
    (0..5)
        .filter_map(|slot| unit.nth_queued_unit(slot).map(|id| id.0))
        .collect()
}

fn morph_target_unit_id(unit: Unit) -> Option<UnitId> {
    if !unit.is_morphing_building() {
        return None;
    }
    unit.first_queued_unit()
        .filter(|target| target.is_building() && *target != unit.id())
}

fn build_progress(unit: Unit) -> Option<BuildProgress> {
    let (build_target, progress_unit) =
        if unit.is_morphing_building() || unit.is_constructing_building() {
            (unit.first_queued_unit().unwrap_or_else(|| unit.id()), unit)
        } else if let Some(child) = unit.currently_building() {
            (
                child.first_queued_unit().unwrap_or_else(|| child.id()),
                child,
            )
        } else {
            return None;
        };

    Some(BuildProgress {
        build_time: build_target.build_time(),
        remaining_build_time: unsafe { (**progress_unit).remaining_build_time as u32 },
    })
}

fn unit_category(id: UnitId) -> &'static str {
    if id.is_building() {
        "building"
    } else if id.is_worker() {
        "worker"
    } else if id.is_resource_container() {
        "resource"
    } else if id.is_powerup() {
        "powerup"
    } else if id.is_subunit() {
        "subunit"
    } else if id.is_air() {
        "air"
    } else {
        "unit"
    }
}

fn unit_category_id(category: &str) -> u8 {
    match category {
        "building" => 0,
        "worker" => 1,
        "resource" => 2,
        "powerup" => 3,
        "subunit" => 4,
        "air" => 5,
        _ => 6,
    }
}

fn unit_binary_flags(unit: Unit) -> u16 {
    let mut out = 0u16;
    for (bit, present) in [
        (0, unit.is_completed()),
        (1, false),
        (2, unit.is_morphing_building()),
        (3, unit.is_constructing_building()),
        (4, unit.is_disabled()),
        (5, unit.is_burrowed()),
        (6, unit.is_invisible()),
        (7, unit.is_hallucination()),
        (8, unit.in_transport()),
        (9, unit.in_bunker()),
        (10, unit.id().is_building() && !unit.is_landed_building()),
    ] {
        if present {
            out |= 1 << bit;
        }
    }
    out
}

fn unit_type_name(id: UnitId) -> &'static str {
    UNIT_TYPE_NAMES
        .get(id.0 as usize)
        .copied()
        .unwrap_or("unknown_unit")
}

fn status_flags(flags: u32) -> Vec<String> {
    const KNOWN_FLAGS: &[(u32, &str)] = &[
        (0x0000_0001, "completed"),
        (0x0000_0002, "landed_building"),
        (0x0000_0004, "air"),
        (0x0000_0010, "burrowed"),
        (0x0000_0020, "in_bunker"),
        (0x0000_0040, "in_transport"),
        (0x0000_0100, "cloaked"),
        (0x0000_0200, "requires_detection"),
        (0x0000_0400, "disabled"),
        (0x0000_0800, "free_cloak"),
        (0x0000_8000, "under_dweb"),
        (0x0002_0000, "smart_flag"),
        (0x0400_0000, "invincible"),
        (0x4000_0000, "hallucination"),
    ];

    let mut out = Vec::new();
    let mut known_mask = 0;
    for &(mask, name) in KNOWN_FLAGS {
        known_mask |= mask;
        if flags & mask != 0 {
            out.push(name.to_string());
        }
    }

    let mut unknown = flags & !known_mask;
    while unknown != 0 {
        let bit = unknown & unknown.wrapping_neg();
        out.push(format!("unknown_{bit:#010x}"));
        unknown &= !bit;
    }
    out
}

fn write_msgpack_header(output: &mut BufWriter<File>) -> io::Result<()> {
    mp(write_array_len(output, 5))?;
    mp(write_u8(output, 0))?;
    mp(write_str(output, MSGPACK_MAGIC))?;
    mp(write_u32(output, MSGPACK_VERSION))?;
    write_string_array(output, CATEGORY_NAMES)?;
    write_string_array(output, UNIT_TYPE_NAMES)?;
    Ok(())
}

fn write_msgpack_snapshot(output: &mut BufWriter<File>, snapshot: &Snapshot) -> io::Result<()> {
    mp(write_array_len(output, 4))?;
    mp(write_u8(output, 1))?;
    mp(write_u32(output, snapshot.frame))?;
    write_msgpack_owners(output, &snapshot.owners)?;
    write_msgpack_units(output, &snapshot.deaths)?;
    Ok(())
}

fn write_msgpack_owners(
    output: &mut BufWriter<File>,
    owners: &BTreeMap<u8, OwnerSnapshot>,
) -> io::Result<()> {
    mp(write_array_len(output, len_to_u32(owners.len())?))?;
    for (&owner_id, owner) in owners {
        mp(write_array_len(output, 11))?;
        mp(write_u8(output, owner_id))?;
        mp(write_str(output, &owner.name))?;
        mp(write_u32(output, owner.minerals))?;
        mp(write_u32(output, owner.gas))?;
        mp(write_u32(output, owner.gathered_minerals))?;
        mp(write_u32(output, owner.gathered_gas))?;
        mp(write_u32(output, owner.supply_current))?;
        mp(write_u32(output, owner.supply_max))?;
        mp(write_u32(output, owner.workers_alive))?;
        write_msgpack_unit_counts(output, owner)?;
        write_msgpack_units(output, &owner.units)?;
    }
    Ok(())
}

fn write_msgpack_unit_counts(
    output: &mut BufWriter<File>,
    owner: &OwnerSnapshot,
) -> io::Result<()> {
    let mut counts = BTreeMap::<u16, u32>::new();
    for unit in &owner.units {
        *counts.entry(unit.unit_type_id).or_insert(0) += 1;
    }
    mp(write_array_len(
        output,
        len_to_u32(counts.len().saturating_mul(2))?,
    ))?;
    for (&unit_type_id, &count) in &counts {
        mp(write_u16(output, unit_type_id))?;
        mp(write_u32(output, count))?;
    }
    Ok(())
}

fn write_msgpack_units(output: &mut BufWriter<File>, units: &[UnitRecord]) -> io::Result<()> {
    mp(write_array_len(output, len_to_u32(units.len())?))?;
    for unit in units {
        mp(write_array_len(output, 33))?;
        mp(write_u32(output, unit.id))?;
        mp(write_u8(output, unit.owner))?;
        mp(write_u16(output, unit.unit_type_id))?;
        write_optional_u16(output, unit.killer_unit_type_id)?;
        write_optional_u16(output, unit.morph_target_unit_type_id)?;
        mp(write_u8(output, unit.category_id))?;
        mp(write_u16(output, unit.binary_flags))?;
        mp(write_i32(output, unit.hp_raw))?;
        mp(write_i32(output, unit.shields_raw))?;
        mp(write_u16(output, unit.energy_raw))?;
        mp(write_i16(output, unit.pos_x))?;
        mp(write_i16(output, unit.pos_y))?;
        mp(write_i16(output, unit.move_target_x))?;
        mp(write_i16(output, unit.move_target_y))?;
        mp(write_u32(output, unit.move_target_unit_id))?;
        mp(write_i16(output, unit.order_target_x))?;
        mp(write_i16(output, unit.order_target_y))?;
        mp(write_u32(output, unit.order_target_unit_id))?;
        mp(write_u8(output, unit.main_order_id))?;
        mp(write_u8(output, unit.main_order_state))?;
        mp(write_u8(output, unit.main_order_timer))?;
        mp(write_u8(output, unit.secondary_order_id))?;
        mp(write_u8(output, unit.secondary_order_state))?;
        mp(write_u8(output, unit.secondary_order_timer))?;
        mp(write_u32(output, unit.connected_unit_id))?;
        mp(write_u32(output, unit.current_build_unit_id))?;
        mp(write_u32(output, unit.subunit_id))?;
        write_u32_vec(output, &unit.loaded_unit_ids)?;
        write_u16_vec(output, &unit.build_queue_unit_ids)?;
        write_optional_u32(output, unit.build_time)?;
        write_optional_u32(output, unit.remaining_build_time)?;
        write_optional_u16(output, unit.tech_in_progress)?;
        write_optional_u16(output, unit.upgrade_in_progress)?;
    }
    Ok(())
}

fn write_string_array(output: &mut BufWriter<File>, values: &[&str]) -> io::Result<()> {
    mp(write_array_len(output, len_to_u32(values.len())?))?;
    for value in values {
        mp(write_str(output, value))?;
    }
    Ok(())
}

fn write_u32_vec(output: &mut BufWriter<File>, values: &[u32]) -> io::Result<()> {
    mp(write_array_len(output, len_to_u32(values.len())?))?;
    for &value in values {
        mp(write_u32(output, value))?;
    }
    Ok(())
}

fn write_u16_vec(output: &mut BufWriter<File>, values: &[u16]) -> io::Result<()> {
    mp(write_array_len(output, len_to_u32(values.len())?))?;
    for &value in values {
        mp(write_u16(output, value))?;
    }
    Ok(())
}

fn write_optional_u16(output: &mut BufWriter<File>, value: Option<u16>) -> io::Result<()> {
    match value {
        Some(value) => mp(write_u16(output, value)),
        None => write_nil(output),
    }
}

fn write_optional_u32(output: &mut BufWriter<File>, value: Option<u32>) -> io::Result<()> {
    match value {
        Some(value) => mp(write_u32(output, value)),
        None => write_nil(output),
    }
}

fn len_to_u32(len: usize) -> io::Result<u32> {
    u32::try_from(len).map_err(|_| io::Error::other("length exceeds u32"))
}

fn mp<T>(result: Result<T, ValueWriteError>) -> io::Result<T> {
    result.map_err(io::Error::other)
}

const UNIT_TYPE_NAMES: &[&str] = &[
    "marine",
    "ghost",
    "vulture",
    "goliath",
    "goliath_turret",
    "siege_tank_tank",
    "siege_tank_turret",
    "scv",
    "wraith",
    "science_vessel",
    "gui_montag",
    "dropship",
    "battlecruiser",
    "spider_mine",
    "nuclear_missile",
    "civilian",
    "sarah_kerrigan",
    "alan_schezar",
    "schezar_turret",
    "jim_raynor_vulture",
    "jim_raynor_marine",
    "tom_kazansky",
    "magellan",
    "edmund_duke_tank",
    "edmund_duke_tank_turret",
    "edmund_duke_siege",
    "edmund_duke_siege_turret",
    "arcturus_mengsk",
    "hyperion",
    "norad_ii",
    "siege_tank_siege",
    "siege_tank_siege_turret",
    "firebat",
    "scanner_sweep",
    "medic",
    "larva",
    "egg",
    "zergling",
    "hydralisk",
    "ultralisk",
    "broodling",
    "drone",
    "overlord",
    "mutalisk",
    "guardian",
    "queen",
    "defiler",
    "scourge",
    "torrasque",
    "matriarch",
    "infested_terran",
    "infested_kerrigan",
    "unclean_one",
    "hunter_killer",
    "devouring_one",
    "kukulza_mutalisk",
    "kukulza_guardian",
    "yggdrasill",
    "valkyrie",
    "cocoon",
    "corsair",
    "dark_templar",
    "devourer",
    "dark_archon",
    "probe",
    "zealot",
    "dragoon",
    "high_templar",
    "archon",
    "shuttle",
    "scout",
    "arbiter",
    "carrier",
    "interceptor",
    "dark_templar_hero",
    "zeratul",
    "tassadar_zeratul",
    "fenix_zealot",
    "fenix_dragoon",
    "tassadar",
    "mojo",
    "warbringer",
    "gantrithor",
    "reaver",
    "observer",
    "scarab",
    "danimoth",
    "aldaris",
    "artanis",
    "rhynadon",
    "bengalaas",
    "cargo_ship",
    "mercenary_gunship",
    "scantid",
    "kakaru",
    "ragnasaur",
    "ursadon",
    "lurker_egg",
    "raszagal",
    "samir_duran",
    "alexei_stukov",
    "map_revealer",
    "gerard_dugalle",
    "lurker",
    "infested_duran",
    "disruption_web",
    "command_center",
    "comsat_station",
    "nuclear_silo",
    "supply_depot",
    "refinery",
    "barracks",
    "academy",
    "factory",
    "starport",
    "control_tower",
    "science_facility",
    "covert_ops",
    "physics_lab",
    "starbase",
    "machine_shop",
    "repair_bay",
    "engineering_bay",
    "armory",
    "missile_turret",
    "bunker",
    "norad_ii_crashed",
    "ion_cannon",
    "uraj_crystal",
    "khalis_crystal",
    "infested_command_center",
    "hatchery",
    "lair",
    "hive",
    "nydus_canal",
    "hydralisk_den",
    "defiler_mound",
    "greater_spire",
    "queens_nest",
    "evolution_chamber",
    "ultralisk_cavern",
    "spire",
    "spawning_pool",
    "creep_colony",
    "spore_colony",
    "unused_zerg_building_1",
    "sunken_colony",
    "overmind_with_shell",
    "overmind",
    "extractor",
    "mature_chrysalis",
    "cerebrate",
    "cerebrate_daggoth",
    "unused_zerg_building_2",
    "nexus",
    "robotics_facility",
    "pylon",
    "assimilator",
    "unused_protoss_building_1",
    "observatory",
    "gateway",
    "unused_protoss_building_2",
    "photon_cannon",
    "citadel_of_adun",
    "cybernetics_core",
    "templar_archives",
    "forge",
    "stargate",
    "stasis_cell",
    "fleet_beacon",
    "arbiter_tribunal",
    "robotics_support_bay",
    "shield_battery",
    "khaydarin_crystal_formation",
    "temple",
    "xelnaga_temple",
    "mineral_field_1",
    "mineral_field_2",
    "mineral_field_3",
    "cave",
    "cave_in",
    "cantina",
    "mining_platform",
    "independent_command_center",
    "independent_starport",
    "jump_gate_unused",
    "ruins",
    "kyadarin_crystal_formation_unused",
    "vespene_geyser",
    "warp_gate",
    "psi_disrupter",
    "zerg_marker",
    "terran_marker",
    "protoss_marker",
    "zerg_beacon",
    "terran_beacon",
    "protoss_beacon",
    "zerg_flag_beacon",
    "terran_flag_beacon",
    "protoss_flag_beacon",
    "power_generator",
    "overmind_cocoon",
    "dark_swarm",
    "floor_missile_trap",
    "floor_hatch",
    "left_upper_level_door",
    "right_upper_level_door",
    "left_pit_door",
    "right_pit_door",
    "floor_gun_trap",
    "left_wall_missile_trap",
    "left_wall_flame_trap",
    "right_wall_missile_trap",
    "right_wall_flame_trap",
    "start_location",
    "flag",
    "young_chrysalis",
    "psi_emitter",
    "data_disc",
    "khaydarin_crystal",
    "mineral_chunk_1",
    "mineral_chunk_2",
    "vespene_orb_1",
    "vespene_orb_2",
    "vespene_sac_1",
    "vespene_sac_2",
    "vespene_tank_1",
    "vespene_tank_2",
];

fn env_path(key: &str) -> Option<PathBuf> {
    env::var_os(key)
        .filter(|x| !x.is_empty())
        .map(PathBuf::from)
}

fn env_u32(key: &str) -> Option<u32> {
    env::var(key).ok().and_then(|x| x.parse::<u32>().ok())
}

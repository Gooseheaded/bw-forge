use std::collections::{BTreeMap, VecDeque};
use std::env;
use std::fs::File;
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};

use parking_lot::Mutex;
use serde::Serialize;

use bw_dat::{Image, UnitArray};

use crate::bw::Bw;
use crate::bw::unit::Unit;
use crate::bw_scr::BwScr;
use crate::game_thread;

pub const PAYLOAD_VERSION: &str = "tickhash-v1";
pub const HASH_ALGORITHM: &str = "fnv1a64";
const ENGINE: &str = "scr";

#[derive(Clone, Default)]
pub struct Config {
    pub enabled: bool,
    pub output_path: Option<PathBuf>,
    pub compare_path: Option<PathBuf>,
    pub dump_prefix: Option<PathBuf>,
    pub dump_window: usize,
    pub hidden_trace: HiddenTraceConfig,
}

#[derive(Clone, Default)]
pub struct HiddenTraceConfig {
    pub enabled: bool,
    pub output_path: Option<PathBuf>,
    pub start_frame: Option<u32>,
    pub end_frame: Option<u32>,
    pub watch_uids: Vec<u32>,
    pub radius: i16,
}

#[derive(Serialize, Clone)]
struct UnitRecord {
    id: u32,
    owner: u8,
    unit_type: u16,
    pos_x: i16,
    pos_y: i16,
    hp_raw: i32,
    shields_raw: i32,
    energy_raw: u16,
    main_order_id: u8,
    main_order_state: u8,
    main_order_timer: u8,
    secondary_order_id: u8,
    secondary_order_state: u8,
    secondary_order_timer: u8,
    move_target_x: i16,
    move_target_y: i16,
    move_target_unit_id: u32,
    order_target_x: i16,
    order_target_y: i16,
    order_target_unit_id: u32,
    connected_unit_id: u32,
    current_build_unit_id: u32,
    subunit_id: u32,
    loaded_unit_ids: [u32; 8],
    status_flags: u32,
}

#[derive(Serialize, Clone)]
struct Payload {
    frame: u32,
    rng_state: u32,
    units: Vec<UnitRecord>,
}

#[derive(Serialize)]
struct JsonlRecord<'a> {
    frame: u32,
    engine: &'a str,
    hash: String,
    hash_algorithm: &'a str,
    unit_count: usize,
    rng_state: u32,
    payload_version: &'a str,
}

#[derive(Serialize)]
struct DumpRecord<'a> {
    frame: u32,
    engine: &'a str,
    payload_version: &'a str,
    mismatch_frame: u32,
    actual_hash: &'a str,
    expected_hash: &'a str,
    payload: &'a Payload,
}

#[derive(Clone)]
struct BufferedPayload {
    frame: u32,
    payload: Payload,
}

#[derive(Clone)]
struct CompareRecord {
    hash: String,
}

pub struct Writer {
    output: Option<BufWriter<File>>,
    dump: Option<BufWriter<File>>,
    compare: BTreeMap<u32, CompareRecord>,
    recent_payloads: VecDeque<BufferedPayload>,
    mismatch_frame: Option<u32>,
    mismatch_actual_hash: String,
    mismatch_expected_hash: String,
    dump_window: usize,
    dump_prefix: Option<PathBuf>,
}

pub struct State {
    config: Config,
    writer: Mutex<Option<Writer>>,
    hidden_writer: Mutex<Option<HiddenTraceWriter>>,
}

#[derive(Serialize, Clone)]
struct HiddenImageRecord {
    ptr: usize,
    image_id: u16,
    is_main: bool,
    animation: u8,
    wait: u8,
    iscript_pos: u16,
    iscript_return_pos: u16,
    flags: u16,
    x_offset: i8,
    y_offset: i8,
}

#[derive(Serialize, Clone)]
struct HiddenUnitRecord {
    id: u32,
    owner: u8,
    unit_type: u16,
    pos_x: i16,
    pos_y: i16,
    exact_pos_x_raw: i32,
    exact_pos_y_raw: i32,
    facing_direction: u8,
    movement_direction: u8,
    new_direction: u8,
    target_direction: u8,
    current_speed: i32,
    next_speed: i32,
    current_speed_x: i32,
    current_speed_y: i32,
    movement_state: u8,
    move_target_update_timer: u8,
    path_frame: u8,
    pathing_flags: u8,
    flingy_flags: u8,
    move_target_x: i16,
    move_target_y: i16,
    next_move_waypoint_x: i16,
    next_move_waypoint_y: i16,
    at_move_target: bool,
    sprite_ptr: usize,
    main_image_ptr: usize,
    image_count: usize,
    images: Vec<HiddenImageRecord>,
}

#[derive(Serialize, Clone, Default)]
struct HiddenEvent {
    kind: &'static str,
    unit_id: u32,
    image_ptr: usize,
    image_id: u16,
    from_ptr: usize,
    to_ptr: usize,
    from_wait: u8,
    to_wait: u8,
    from_pos: u16,
    to_pos: u16,
}

#[derive(Serialize)]
struct HiddenTraceRecord<'a> {
    frame: u32,
    engine: &'a str,
    watched_unit_ids: &'a [u32],
    units: &'a [HiddenUnitRecord],
    events: &'a [HiddenEvent],
}

struct HiddenTraceWriter {
    output: BufWriter<File>,
    config: HiddenTraceConfig,
    previous_units: BTreeMap<u32, HiddenUnitRecord>,
}

impl Config {
    pub fn from_environment() -> Self {
        let output_path = env_path("OPENBW_TICK_HASH_OUT");
        let compare_path = env_path("OPENBW_TICK_HASH_COMPARE");
        let dump_prefix = env_path("OPENBW_TICK_HASH_DUMP_PREFIX");
        let dump_window = env::var("OPENBW_TICK_HASH_DUMP_WINDOW")
            .ok()
            .and_then(|x| x.parse::<usize>().ok())
            .unwrap_or(0);
        let enabled_flag = env::var("OPENBW_TICK_HASH")
            .ok()
            .map(|x| x != "0")
            .unwrap_or(false);
        let enabled = enabled_flag
            || output_path.is_some()
            || compare_path.is_some()
            || dump_prefix.is_some();
        let hidden_trace = HiddenTraceConfig::from_environment();
        Self {
            enabled,
            output_path,
            compare_path,
            dump_prefix,
            dump_window,
            hidden_trace,
        }
    }
}

impl HiddenTraceConfig {
    pub fn from_environment() -> Self {
        let output_path = env_path("OPENBW_HIDDEN_TRACE_OUT");
        let start_frame = env_u32("OPENBW_HIDDEN_TRACE_START");
        let end_frame = env_u32("OPENBW_HIDDEN_TRACE_END");
        let radius = env::var("OPENBW_HIDDEN_TRACE_RADIUS")
            .ok()
            .and_then(|x| x.parse::<i16>().ok())
            .unwrap_or(160)
            .max(0);
        let watch_uids = env_u32_list("OPENBW_HIDDEN_TRACE_UIDS");
        let enabled_flag = env::var("OPENBW_HIDDEN_TRACE")
            .ok()
            .map(|x| x != "0")
            .unwrap_or(false);
        let enabled = enabled_flag || output_path.is_some();
        Self {
            enabled,
            output_path,
            start_frame,
            end_frame,
            watch_uids,
            radius,
        }
    }

    fn should_emit_frame(&self, frame: u32) -> bool {
        if let Some(start) = self.start_frame
            && frame < start
        {
            return false;
        }
        if let Some(end) = self.end_frame
            && frame > end
        {
            return false;
        }
        true
    }
}

impl State {
    pub fn from_environment() -> Self {
        Self {
            config: Config::from_environment(),
            writer: Mutex::new(None),
            hidden_writer: Mutex::new(None),
        }
    }

    pub fn emit_if_enabled(&self, bw: &BwScr) {
        if !self.config.enabled {
            return;
        }
        if !game_thread::is_replay() {
            return;
        }
        let mut guard = self.writer.lock();
        if guard.is_none() {
            *guard = Some(Writer::new(&self.config));
        }
        if let Some(writer) = guard.as_mut() {
            writer.emit(bw);
        }
    }

    pub fn emit_hidden_if_enabled(&self, bw: &BwScr) {
        if !self.config.hidden_trace.enabled {
            return;
        }
        if !game_thread::is_replay() || self.config.hidden_trace.watch_uids.is_empty() {
            return;
        }
        let frame = unsafe { (*bw.game()).frame_count };
        if !self.config.hidden_trace.should_emit_frame(frame) {
            return;
        }
        let mut guard = self.hidden_writer.lock();
        if guard.is_none() {
            *guard = Some(HiddenTraceWriter::new(&self.config.hidden_trace));
        }
        if let Some(writer) = guard.as_mut() {
            writer.emit(bw);
        }
    }

    pub fn flush(&self) {
        let mut writer = self.writer.lock();
        if let Some(writer) = writer.as_mut() {
            writer.flush();
        }
        let mut hidden_writer = self.hidden_writer.lock();
        if let Some(writer) = hidden_writer.as_mut() {
            writer.flush();
        }
    }
}

impl Writer {
    fn new(config: &Config) -> Self {
        let output = config.output_path.as_ref().map(|path| {
            BufWriter::new(File::create(path).unwrap_or_else(|e| {
                panic!(
                    "tick hash: unable to create output file {}: {e}",
                    path.display()
                )
            }))
        });
        let compare = config
            .compare_path
            .as_ref()
            .map(|path| load_compare_trace(path))
            .unwrap_or_default();
        Self {
            output,
            dump: None,
            compare,
            recent_payloads: VecDeque::new(),
            mismatch_frame: None,
            mismatch_actual_hash: String::new(),
            mismatch_expected_hash: String::new(),
            dump_window: config.dump_window,
            dump_prefix: config.dump_prefix.clone(),
        }
    }

    fn emit(&mut self, bw: &BwScr) {
        let payload = capture_payload(bw);
        let hash = hash_payload(&payload);
        if let Some(output) = self.output.as_mut() {
            let record = JsonlRecord {
                frame: payload.frame,
                engine: ENGINE,
                hash: hash.clone(),
                hash_algorithm: HASH_ALGORITHM,
                unit_count: payload.units.len(),
                rng_state: payload.rng_state,
                payload_version: PAYLOAD_VERSION,
            };
            serde_json::to_writer(&mut *output, &record).expect("tick hash: json write failed");
            output
                .write_all(b"\n")
                .expect("tick hash: newline write failed");
        }

        let expected_hash = self
            .compare
            .get(&payload.frame)
            .map(|x| x.hash.as_str())
            .unwrap_or("")
            .to_string();
        let mismatch = !self.compare.is_empty() && expected_hash != hash;
        if mismatch && self.mismatch_frame.is_none() {
            self.mismatch_frame = Some(payload.frame);
            self.mismatch_actual_hash = hash.clone();
            self.mismatch_expected_hash = expected_hash.clone();
            self.open_dump();
            if self.dump.is_some() {
                let cached: Vec<_> = self.recent_payloads.iter().cloned().collect();
                for entry in cached {
                    let actual_hash = self.mismatch_actual_hash.clone();
                    let expected_hash = self.mismatch_expected_hash.clone();
                    self.write_dump(&entry.payload, &actual_hash, &expected_hash);
                }
            }
        }

        if self.mismatch_frame.is_some() && self.dump.is_some() {
            let actual_hash = if mismatch {
                hash.clone()
            } else {
                self.mismatch_actual_hash.clone()
            };
            let expected_hash = if mismatch {
                expected_hash.clone()
            } else {
                self.mismatch_expected_hash.clone()
            };
            self.write_dump(&payload, &actual_hash, &expected_hash);
        }

        self.recent_payloads.push_back(BufferedPayload {
            frame: payload.frame,
            payload,
        });
        while self.recent_payloads.len() > self.dump_window {
            self.recent_payloads.pop_front();
        }

        if let Some(mismatch_frame) = self.mismatch_frame {
            if self.dump_window == 0
                || self.recent_payloads.back().map(|x| x.frame).unwrap_or(0)
                    >= mismatch_frame + self.dump_window as u32
            {
                if let Some(dump) = self.dump.as_mut() {
                    dump.flush().expect("tick hash: dump flush failed");
                }
            }
        }
    }

    fn flush(&mut self) {
        if let Some(output) = self.output.as_mut() {
            output.flush().expect("tick hash: flush failed");
        }
        if let Some(dump) = self.dump.as_mut() {
            dump.flush().expect("tick hash: dump flush failed");
        }
    }

    fn open_dump(&mut self) {
        if self.dump.is_some() || self.dump_prefix.is_none() || self.dump_window == 0 {
            return;
        }
        let path = self.dump_prefix.as_ref().unwrap().with_extension("jsonl");
        self.dump = Some(BufWriter::new(File::create(&path).unwrap_or_else(|e| {
            panic!(
                "tick hash: unable to create dump file {}: {e}",
                path.display()
            )
        })));
    }

    fn write_dump(&mut self, payload: &Payload, actual_hash: &str, expected_hash: &str) {
        let mismatch_frame = self
            .mismatch_frame
            .expect("tick hash: mismatch frame missing");
        let record = DumpRecord {
            frame: payload.frame,
            engine: ENGINE,
            payload_version: PAYLOAD_VERSION,
            mismatch_frame,
            actual_hash,
            expected_hash,
            payload,
        };
        if let Some(dump) = self.dump.as_mut() {
            serde_json::to_writer(&mut *dump, &record).expect("tick hash: dump write failed");
            dump.write_all(b"\n")
                .expect("tick hash: dump newline write failed");
        }
    }
}

impl HiddenTraceWriter {
    fn new(config: &HiddenTraceConfig) -> Self {
        let path = config
            .output_path
            .as_ref()
            .expect("hidden trace: output path missing");
        let output = BufWriter::new(File::create(path).unwrap_or_else(|e| {
            panic!(
                "hidden trace: unable to create output file {}: {e}",
                path.display()
            )
        }));
        Self {
            output,
            config: config.clone(),
            previous_units: BTreeMap::new(),
        }
    }

    fn emit(&mut self, bw: &BwScr) {
        let units = capture_hidden_units(bw, &self.config);
        let events = derive_hidden_events(&self.previous_units, &units);
        let record = HiddenTraceRecord {
            frame: unsafe { (*bw.game()).frame_count },
            engine: ENGINE,
            watched_unit_ids: &self.config.watch_uids,
            units: &units,
            events: &events,
        };
        serde_json::to_writer(&mut self.output, &record).expect("hidden trace: json write failed");
        self.output
            .write_all(b"\n")
            .expect("hidden trace: newline write failed");
        self.previous_units = units.into_iter().map(|x| (x.id, x)).collect();
    }

    fn flush(&mut self) {
        self.output.flush().expect("hidden trace: flush failed");
    }
}

fn env_path(key: &str) -> Option<PathBuf> {
    env::var_os(key)
        .filter(|x| !x.is_empty())
        .map(PathBuf::from)
}

fn env_u32(key: &str) -> Option<u32> {
    env::var(key).ok().and_then(|x| x.parse::<u32>().ok())
}

fn env_u32_list(key: &str) -> Vec<u32> {
    let Some(value) = env::var_os(key) else {
        return Vec::new();
    };
    let value = value.to_string_lossy();
    let mut out = Vec::new();
    for part in value.split([',', ';', ' ', '\t']) {
        if part.is_empty() {
            continue;
        }
        let parsed = if let Some(hex) = part.strip_prefix("0x") {
            u32::from_str_radix(hex, 16)
        } else if let Some(hex) = part.strip_prefix("0X") {
            u32::from_str_radix(hex, 16)
        } else {
            part.parse::<u32>()
        };
        let Ok(parsed) = parsed else {
            continue;
        };
        out.push(parsed);
    }
    out.sort_unstable();
    out.dedup();
    out
}

fn within_radius(a: (i16, i16), b: (i16, i16), radius: i16) -> bool {
    (a.0 - b.0).abs() <= radius && (a.1 - b.1).abs() <= radius
}

fn capture_hidden_units(bw: &BwScr, config: &HiddenTraceConfig) -> Vec<HiddenUnitRecord> {
    let units = unit_array(bw);
    let mut watched_positions = Vec::new();
    for uid in &config.watch_uids {
        if let Some(unit) = units.get_by_unique_id(*uid) {
            if !should_capture_unit(unit) {
                continue;
            }
            let pos = unit.position();
            watched_positions.push((pos.x, pos.y));
        }
    }

    let mut out = Vec::new();
    for index in 0..units.len() {
        let Some(unit) = units.get_by_index(index as u32) else {
            continue;
        };
        if !should_capture_unit(unit) {
            continue;
        }
        let id = unique_id(unit, &units);
        let pos = unit.position();
        let watched = config.watch_uids.binary_search(&id).is_ok();
        let nearby = !watched
            && watched_positions
                .iter()
                .any(|&anchor| within_radius(anchor, (pos.x, pos.y), config.radius));
        if !watched && !nearby {
            continue;
        }
        out.push(capture_hidden_unit(unit, id));
    }
    out.sort_by_key(|x| x.id);
    out
}

fn capture_hidden_unit(unit: Unit, id: u32) -> HiddenUnitRecord {
    let sprite = unit.sprite().expect("hidden trace unit missing sprite");
    let sprite_ptr = *sprite as usize;
    let main_image_ptr = sprite.main_image().map(|x| *x as usize).unwrap_or(0);
    let pos = unit.position();
    let exact_pos = unsafe { (**unit).flingy.exact_position };
    let move_target = unsafe { &(**unit).flingy.move_target };
    let next_move_waypoint = unsafe { (**unit).flingy.next_move_waypoint };
    let images: Vec<_> = sprite
        .images()
        .map(|image| capture_hidden_image(image, main_image_ptr))
        .collect();
    HiddenUnitRecord {
        id,
        owner: unit.player(),
        unit_type: unit.id().0,
        pos_x: pos.x,
        pos_y: pos.y,
        exact_pos_x_raw: exact_pos.x,
        exact_pos_y_raw: exact_pos.y,
        facing_direction: unsafe { (**unit).flingy.facing_direction },
        movement_direction: unsafe { (**unit).flingy.movement_direction },
        new_direction: unsafe { (**unit).flingy.new_direction },
        target_direction: unsafe { (**unit).flingy.target_direction },
        current_speed: unsafe { (**unit).flingy.current_speed },
        next_speed: unsafe { (**unit).flingy.next_speed },
        current_speed_x: unsafe { (**unit).flingy.current_speed_x },
        current_speed_y: unsafe { (**unit).flingy.current_speed_y },
        movement_state: unsafe { (**unit).movement_state },
        move_target_update_timer: unsafe { (**unit).move_target_update_timer },
        path_frame: unsafe { (**unit).path_frame },
        pathing_flags: unsafe { (**unit).pathing_flags },
        flingy_flags: unsafe { (**unit).flingy.flingy_flags },
        move_target_x: move_target.pos.x,
        move_target_y: move_target.pos.y,
        next_move_waypoint_x: next_move_waypoint.x,
        next_move_waypoint_y: next_move_waypoint.y,
        at_move_target: pos == move_target.pos,
        sprite_ptr,
        main_image_ptr,
        image_count: images.len(),
        images,
    }
}

fn capture_hidden_image(image: Image, main_image_ptr: usize) -> HiddenImageRecord {
    HiddenImageRecord {
        ptr: *image as usize,
        image_id: image.id().0,
        is_main: (*image as usize) == main_image_ptr,
        animation: unsafe { (**image).iscript.animation },
        wait: unsafe { (**image).iscript.wait },
        iscript_pos: unsafe { (**image).iscript.pos },
        iscript_return_pos: unsafe { (**image).iscript.return_pos },
        flags: image.flags(),
        x_offset: unsafe { (**image).x_offset },
        y_offset: unsafe { (**image).y_offset },
    }
}

fn derive_hidden_events(
    previous: &BTreeMap<u32, HiddenUnitRecord>,
    current: &[HiddenUnitRecord],
) -> Vec<HiddenEvent> {
    let mut out = Vec::new();
    let current_ids: BTreeMap<u32, ()> = current.iter().map(|x| (x.id, ())).collect();
    for unit in current {
        if let Some(prev) = previous.get(&unit.id) {
            if prev.main_image_ptr != unit.main_image_ptr {
                out.push(HiddenEvent {
                    kind: "main_image_changed",
                    unit_id: unit.id,
                    from_ptr: prev.main_image_ptr,
                    to_ptr: unit.main_image_ptr,
                    ..Default::default()
                });
            }
            let prev_images: BTreeMap<usize, &HiddenImageRecord> =
                prev.images.iter().map(|x| (x.ptr, x)).collect();
            let cur_images: BTreeMap<usize, &HiddenImageRecord> =
                unit.images.iter().map(|x| (x.ptr, x)).collect();
            for image in unit.images.iter() {
                if !prev_images.contains_key(&image.ptr) {
                    out.push(HiddenEvent {
                        kind: "image_created",
                        unit_id: unit.id,
                        image_ptr: image.ptr,
                        image_id: image.image_id,
                        ..Default::default()
                    });
                }
            }
            for image in prev.images.iter() {
                if !cur_images.contains_key(&image.ptr) {
                    out.push(HiddenEvent {
                        kind: "image_destroyed",
                        unit_id: unit.id,
                        image_ptr: image.ptr,
                        image_id: image.image_id,
                        ..Default::default()
                    });
                }
            }
            for image in unit.images.iter() {
                let Some(prev_image) = prev_images.get(&image.ptr) else {
                    continue;
                };
                if prev_image.wait != image.wait || prev_image.iscript_pos != image.iscript_pos {
                    out.push(HiddenEvent {
                        kind: "image_wait_changed",
                        unit_id: unit.id,
                        image_ptr: image.ptr,
                        image_id: image.image_id,
                        from_wait: prev_image.wait,
                        to_wait: image.wait,
                        from_pos: prev_image.iscript_pos,
                        to_pos: image.iscript_pos,
                        ..Default::default()
                    });
                }
            }
        } else {
            for image in unit.images.iter() {
                out.push(HiddenEvent {
                    kind: "image_created",
                    unit_id: unit.id,
                    image_ptr: image.ptr,
                    image_id: image.image_id,
                    ..Default::default()
                });
            }
        }
    }
    for (&unit_id, prev) in previous.iter() {
        if current_ids.contains_key(&unit_id) {
            continue;
        }
        for image in prev.images.iter() {
            out.push(HiddenEvent {
                kind: "image_destroyed",
                unit_id,
                image_ptr: image.ptr,
                image_id: image.image_id,
                ..Default::default()
            });
        }
    }
    out
}

fn unit_array(bw: &BwScr) -> UnitArray {
    bw.unit_array()
}

fn unique_id(unit: Unit, units: &UnitArray) -> u32 {
    units.to_unique_id(unit)
}

fn related_id(unit: Option<Unit>, units: &UnitArray) -> u32 {
    unit.map(|x| unique_id(x, units)).unwrap_or(0)
}

fn should_capture_unit(unit: Unit) -> bool {
    unit.sprite().is_some() && !unit.is_dying()
}

fn capture_payload(bw: &BwScr) -> Payload {
    let units = unit_array(bw);
    let mut out = Vec::new();

    for index in 0..units.len() {
        let Some(unit) = units.get_by_index(index as u32) else {
            continue;
        };
        if !should_capture_unit(unit) {
            continue;
        }

        let pos = unit.position();
        let move_target = unsafe { &(**unit).flingy.move_target };
        let mut loaded = [0u32; 8];
        for (i, value) in unsafe { (**unit).loaded_units }.iter().copied().enumerate() {
            if value == 0 {
                continue;
            }
            let high_bits = if units.len() > 1700 {
                unsafe { (**unit).scr_carried_unit_high_bits }
            } else {
                0
            };
            let id = value as u32 | (((high_bits >> (i * 2)) as u32 & 0x3) << 16);
            loaded[i] = units
                .get_by_unique_id(id)
                .map(|x| unique_id(x, &units))
                .unwrap_or(0);
        }

        out.push(UnitRecord {
            id: unique_id(unit, &units),
            owner: unit.player(),
            unit_type: unit.id().0,
            pos_x: pos.x,
            pos_y: pos.y,
            hp_raw: unit.hitpoints(),
            shields_raw: unit.shields(),
            energy_raw: unit.energy(),
            main_order_id: unit.order().0,
            main_order_state: unit.order_state(),
            main_order_timer: unsafe { (**unit).order_timer },
            secondary_order_id: unit.secondary_order().0,
            secondary_order_state: unsafe { (**unit).secondary_order_state },
            secondary_order_timer: unsafe { (**unit).secondary_order_wait },
            move_target_x: move_target.pos.x,
            move_target_y: move_target.pos.y,
            move_target_unit_id: related_id(unsafe { Unit::from_ptr(move_target.unit) }, &units),
            order_target_x: unit.target_pos().x,
            order_target_y: unit.target_pos().y,
            order_target_unit_id: related_id(unit.target(), &units),
            connected_unit_id: related_id(unit.related(), &units),
            current_build_unit_id: related_id(unit.currently_building(), &units),
            subunit_id: related_id(unit.subunit_linked(), &units),
            loaded_unit_ids: loaded,
            status_flags: unsafe { (**unit).flags } & canonical_flags_mask(),
        });
    }

    out.sort_by_key(|x| x.id);

    let frame = unsafe { (*bw.game()).frame_count };
    Payload {
        frame,
        rng_state: bw.rng_seed(),
        units: out,
    }
}

fn canonical_flags_mask() -> u32 {
    0xeffb_ff76
}

fn append_u8(out: &mut Vec<u8>, value: u8) {
    out.push(value);
}

fn append_u16(out: &mut Vec<u8>, value: u16) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn append_i16(out: &mut Vec<u8>, value: i16) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn append_u32(out: &mut Vec<u8>, value: u32) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn append_i32(out: &mut Vec<u8>, value: i32) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn serialize_payload(payload: &Payload) -> Vec<u8> {
    let mut out = Vec::with_capacity(32 + payload.units.len() * 128);
    append_u32(&mut out, payload.frame);
    append_u32(&mut out, payload.rng_state);
    append_u32(&mut out, payload.units.len() as u32);
    for unit in &payload.units {
        append_u32(&mut out, unit.id);
        append_u8(&mut out, unit.owner);
        append_u16(&mut out, unit.unit_type);
        append_i16(&mut out, unit.pos_x);
        append_i16(&mut out, unit.pos_y);
        append_i32(&mut out, unit.hp_raw);
        append_i32(&mut out, unit.shields_raw);
        append_u16(&mut out, unit.energy_raw);
        append_u8(&mut out, unit.main_order_id);
        append_u8(&mut out, unit.main_order_state);
        append_u8(&mut out, unit.main_order_timer);
        append_u8(&mut out, unit.secondary_order_id);
        append_u8(&mut out, unit.secondary_order_state);
        append_u8(&mut out, unit.secondary_order_timer);
        append_i16(&mut out, unit.move_target_x);
        append_i16(&mut out, unit.move_target_y);
        append_u32(&mut out, unit.move_target_unit_id);
        append_i16(&mut out, unit.order_target_x);
        append_i16(&mut out, unit.order_target_y);
        append_u32(&mut out, unit.order_target_unit_id);
        append_u32(&mut out, unit.connected_unit_id);
        append_u32(&mut out, unit.current_build_unit_id);
        append_u32(&mut out, unit.subunit_id);
        for value in unit.loaded_unit_ids {
            append_u32(&mut out, value);
        }
        append_u32(&mut out, unit.status_flags);
    }
    out
}

fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    for &byte in bytes {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn hash_payload(payload: &Payload) -> String {
    format!("{:016x}", fnv1a64(&serialize_payload(payload)))
}

fn load_compare_trace(path: &Path) -> BTreeMap<u32, CompareRecord> {
    let file = File::open(path).unwrap_or_else(|e| {
        panic!(
            "tick hash: unable to open compare trace {}: {e}",
            path.display()
        )
    });
    let reader = BufReader::new(file);
    let mut out = BTreeMap::new();
    for line in reader.lines() {
        let line = line.expect("tick hash: compare trace read failed");
        if line.is_empty() {
            continue;
        }
        let value: serde_json::Value =
            serde_json::from_str(&line).expect("tick hash: invalid compare trace json");
        let payload_version = value
            .get("payload_version")
            .and_then(|x| x.as_str())
            .unwrap_or("");
        let hash_algorithm = value
            .get("hash_algorithm")
            .and_then(|x| x.as_str())
            .unwrap_or("");
        if payload_version != PAYLOAD_VERSION {
            panic!(
                "tick hash: compare trace payload version {} does not match {}",
                payload_version, PAYLOAD_VERSION
            );
        }
        if hash_algorithm != HASH_ALGORITHM {
            panic!(
                "tick hash: compare trace hash algorithm {} does not match {}",
                hash_algorithm, HASH_ALGORITHM
            );
        }
        let frame = value
            .get("frame")
            .and_then(|x| x.as_u64())
            .expect("tick hash: compare trace missing frame") as u32;
        let hash = value
            .get("hash")
            .and_then(|x| x.as_str())
            .expect("tick hash: compare trace missing hash")
            .to_string();
        out.insert(frame, CompareRecord { hash });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_is_stable_for_known_payload() {
        let payload = Payload {
            frame: 12,
            rng_state: 34,
            units: vec![UnitRecord {
                id: 56,
                owner: 1,
                unit_type: 2,
                pos_x: 3,
                pos_y: 4,
                hp_raw: 5,
                shields_raw: 6,
                energy_raw: 7,
                main_order_id: 8,
                main_order_state: 9,
                main_order_timer: 10,
                secondary_order_id: 11,
                secondary_order_state: 12,
                secondary_order_timer: 13,
                move_target_x: 14,
                move_target_y: 15,
                move_target_unit_id: 16,
                order_target_x: 17,
                order_target_y: 18,
                order_target_unit_id: 19,
                connected_unit_id: 20,
                current_build_unit_id: 21,
                subunit_id: 22,
                loaded_unit_ids: [30, 31, 32, 33, 34, 35, 36, 37],
                status_flags: 38,
            }],
        };
        assert_eq!(hash_payload(&payload), "a143c6788fc7df73");
    }

    #[test]
    fn canonical_mask_drops_non_v1_flag_bits() {
        assert_eq!(0x8u32 & canonical_flags_mask(), 0);
        assert_ne!(0x4u32 & canonical_flags_mask(), 0);
    }
}

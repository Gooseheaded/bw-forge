import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/db/sqlite.js";
import { UnknownReplayEventKeyError, resolveReplayEventKey } from "../src/domain/eventCatalog.js";
import { before, event, supplyBefore } from "../src/query/facts.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "corpus-facts-"));
  const { db } = await openDatabase(join(root, "facts.sqlite"));
  db.run(`
    CREATE TABLE unit_types(unit_type_id INTEGER PRIMARY KEY,unit_key TEXT NOT NULL UNIQUE,display_name TEXT NOT NULL);
    CREATE TABLE build_events(observation_id INTEGER NOT NULL,occurrence INTEGER NOT NULL,unit_type_id INTEGER NOT NULL,
      frame INTEGER,time_seconds INTEGER NOT NULL,frame_min INTEGER NOT NULL,frame_max INTEGER NOT NULL,
      timing_basis TEXT NOT NULL,raw_line TEXT NOT NULL,PRIMARY KEY(observation_id,occurrence));
    CREATE TABLE stream_coverage(observation_id INTEGER NOT NULL,stream TEXT NOT NULL,start_frame INTEGER NOT NULL,
      end_frame INTEGER NOT NULL,basis TEXT NOT NULL,PRIMARY KEY(observation_id,stream,start_frame));
    CREATE TABLE supply_changes(observation_id INTEGER NOT NULL,frame INTEGER NOT NULL,current INTEGER NOT NULL,
      max INTEGER NOT NULL,PRIMARY KEY(observation_id,frame));
    INSERT INTO unit_types VALUES
      (1,'hatchery','Hatchery'),(2,'extractor','Extractor'),(3,'spawning_pool','Spawning Pool'),
      (4,'supply_depot','Supply Depot'),(5,'barracks','Barracks'),
      (6,'Metabolic Boost','Metabolic Boost'),(7,'Lair','Lair'),(8,'Siege Mode','Siege Mode'),
      (9,'Infantry Weapons','Infantry Weapons');
    INSERT INTO build_events VALUES
      (1,0,1,100,4,100,100,'exact_frame','Hatchery'),
      (1,1,2,NULL,5,120,125,'legacy_second_floor','Extractor'),
      (1,2,3,NULL,5,123,130,'legacy_second_floor','Spawning Pool'),
      (1,3,1,NULL,6,140,150,'legacy_second_floor','Hatchery'),
      (1,4,6,NULL,7,160,170,'legacy_second_floor','Metabolic Boost'),
      (1,5,7,NULL,8,190,200,'legacy_second_floor','Lair'),
      (2,0,4,100,4,100,100,'exact_frame','Supply Depot'),
      (3,0,5,50,2,50,50,'exact_frame','Barracks'),
      (4,0,8,NULL,12,286,309,'legacy_second_floor','Siege Mode'),
      (5,0,9,NULL,10,238,261,'legacy_second_floor','Infantry Weapons'),
      (5,2,9,NULL,20,476,499,'legacy_second_floor','Infantry Weapons'),
      (5,5,9,NULL,30,714,737,'legacy_second_floor','Infantry Weapons');
    INSERT INTO stream_coverage VALUES
      (1,'supply',0,200,'verified'),(2,'supply',0,200,'verified'),(3,'supply',100,200,'verified');
    INSERT INTO supply_changes VALUES
      (1,0,9,18),(1,50,11,18),(1,100,10,18),(1,110,13,18),(1,145,12,18),
      (2,0,9,18),(2,100,9,18),(3,100,10,18);
  `);
  return { db, async [Symbol.asyncDispose]() { db.close(); await rm(root, { recursive: true, force: true }); } };
}

test("event finds an exact occurrence by canonical building key", async () => {
  await using f = await fixture();
  const found = event(f.db, { observationId: 1, unitKey: "hatchery", occurrence: 1 });
  assert.equal(found.kind, "event");
  if (found.kind === "event") {
    assert.deepEqual(found.eventType, {
      key: "hatchery", displayName: "Hatchery", kind: "building", race: "zerg",
      sourceId: 131, sourceNamespace: "unit_type"
    });
    assert.deepEqual(found.unitType, { id: 1, key: "hatchery", displayName: "Hatchery" });
    assert.equal(found.occurrence, 1);
    assert.equal(found.sourceOccurrence, 0);
    assert.deepEqual(found.timing, { kind: "exact", frame: 100 });
  }
});

test("event resolves canonical upgrade keys to display-valued Corpus v2 rows", async () => {
  await using f = await fixture();
  const found = event(f.db, { observationId: 1, unitKey: "metabolic_boost", occurrence: 1 });
  assert.equal(found.kind, "event");
  if (found.kind === "event") {
    assert.deepEqual(found.eventType, {
      key: "metabolic_boost", displayName: "Metabolic Boost", kind: "upgrade", race: "zerg",
      sourceId: 27, sourceNamespace: "upgrade"
    });
    assert.equal(found.unitType.key, "Metabolic Boost");
  }
});

test("unknown and display-valued identifiers fail deterministically before observation lookup", async () => {
  await using f = await fixture();
  for (const key of ["not_a_real_event", "Metabolic Boost"]) {
    assert.throws(
      () => event(f.db, { observationId: 1, unitKey: key, occurrence: 1 }),
      (error: unknown) => error instanceof UnknownReplayEventKeyError
        && error.code === "UNKNOWN_EVENT_KEY" && error.eventKey === key
    );
  }
});

test("catalog metadata distinguishes unit, building, upgrade and tech", () => {
  assert.equal(resolveReplayEventKey("science_vessel").kind, "unit");
  assert.equal(resolveReplayEventKey("observer").race, "protoss");
  assert.equal(resolveReplayEventKey("valkyrie").race, "terran");
  assert.equal(resolveReplayEventKey("devourer").race, "zerg");
  assert.equal(resolveReplayEventKey("hatchery").kind, "building");
  assert.equal(resolveReplayEventKey("singularity_charge").kind, "upgrade");
  assert.deepEqual(resolveReplayEventKey("siege_mode"), {
    key: "siege_mode", displayName: "Siege Mode", kind: "tech", race: "terran",
    sourceId: 5, sourceNamespace: "tech"
  });
});

test("before compares canonical events across upgrade and building kinds", async () => {
  await using f = await fixture();
  const boost = event(f.db, { observationId: 1, unitKey: "metabolic_boost", occurrence: 1 });
  const lair = event(f.db, { observationId: 1, unitKey: "lair", occurrence: 1 });
  assert.deepEqual(before(boost, lair), { kind: "known", certainty: "definitely_true", value: true });
});

test("tech events use the same canonical lookup path", async () => {
  await using f = await fixture();
  const found = event(f.db, { observationId: 4, unitKey: "siege_mode", occurrence: 1 });
  assert.equal(found.kind, "event");
  if (found.kind === "event") assert.equal(found.eventType.kind, "tech");
});

test("repeated upgrade occurrence remains nth observed start, independent of global order", async () => {
  await using f = await fixture();
  const found = event(f.db, { observationId: 5, unitKey: "infantry_weapons", occurrence: 2 });
  assert.equal(found.kind, "event");
  if (found.kind === "event") {
    assert.equal(found.occurrence, 2);
    assert.equal(found.sourceOccurrence, 2);
    assert.equal(found.recordedTimeSeconds, 20);
  }
});

test("event returns event_not_present for a missing occurrence", async () => {
  await using f = await fixture();
  const missing = event(f.db, { observationId: 1, unitKey: "hatchery", occurrence: 3 });
  assert.deepEqual(missing, {
    kind: "event_not_present", request: { observationId: 1, unitKey: "hatchery", occurrence: 3 }
  });
  assert.deepEqual(supplyBefore(f.db, missing), { kind: "event_not_present" });
});

test("event preserves interval timing and counts occurrences per unit", async () => {
  await using f = await fixture();
  const found = event(f.db, { observationId: 1, unitKey: "hatchery", occurrence: 2 });
  assert.equal(found.kind, "event");
  if (found.kind === "event") {
    assert.equal(found.sourceOccurrence, 3);
    assert.deepEqual(found.timing, { kind: "interval", frameMin: 140, frameMax: 150 });
    assert.equal(found.timingBasis, "legacy_second_floor");
  }
});

test("before is definitely true for disjoint forward ranges", async () => {
  await using f = await fixture();
  const hatch = event(f.db, { observationId: 1, unitKey: "hatchery", occurrence: 1 });
  const extractor = event(f.db, { observationId: 1, unitKey: "extractor", occurrence: 1 });
  assert.deepEqual(before(hatch, extractor), { kind: "known", certainty: "definitely_true", value: true });
});

test("before is definitely false when the left event is wholly at or after the right", async () => {
  await using f = await fixture();
  const hatch = event(f.db, { observationId: 1, unitKey: "hatchery", occurrence: 1 });
  const extractor = event(f.db, { observationId: 1, unitKey: "extractor", occurrence: 1 });
  assert.deepEqual(before(extractor, hatch), { kind: "known", certainty: "definitely_false", value: false });
});

test("before remains ambiguous for overlapping intervals", async () => {
  await using f = await fixture();
  const extractor = event(f.db, { observationId: 1, unitKey: "extractor", occurrence: 1 });
  const pool = event(f.db, { observationId: 1, unitKey: "spawning_pool", occurrence: 1 });
  assert.deepEqual(before(extractor, pool), { kind: "ambiguous", certainty: "ambiguous" });
});

test("before reports missing events separately from timing ambiguity", async () => {
  await using f = await fixture();
  const missing = event(f.db, { observationId: 1, unitKey: "hatchery", occurrence: 3 });
  const hatch = event(f.db, { observationId: 1, unitKey: "hatchery", occurrence: 1 });
  assert.deepEqual(before(missing, hatch), { kind: "event_not_present", missing: ["left"] });
});

test("supplyBefore uses F-1 for an exact Zerg event without a +1 correction", async () => {
  await using f = await fixture();
  const hatch = event(f.db, { observationId: 1, unitKey: "hatchery", occurrence: 1 });
  assert.deepEqual(supplyBefore(f.db, hatch), { kind: "known", supply: 11, preEventFrames: { min: 99, max: 99 } });
});

test("supplyBefore returns known when supply is invariant across an event interval", async () => {
  await using f = await fixture();
  const extractor = event(f.db, { observationId: 1, unitKey: "extractor", occurrence: 1 });
  assert.deepEqual(supplyBefore(f.db, extractor), { kind: "known", supply: 13, preEventFrames: { min: 119, max: 124 } });
});

test("supplyBefore returns all possible values when supply changes inside an event interval", async () => {
  await using f = await fixture();
  const hatch = event(f.db, { observationId: 1, unitKey: "hatchery", occurrence: 2 });
  assert.deepEqual(supplyBefore(f.db, hatch), {
    kind: "ambiguous", values: [12, 13], min: 12, max: 13, preEventFrames: { min: 139, max: 149 }
  });
});

test("supplyBefore is unavailable when stream coverage does not establish pre-event supply", async () => {
  await using f = await fixture();
  const barracks = event(f.db, { observationId: 3, unitKey: "barracks", occurrence: 1 });
  assert.deepEqual(supplyBefore(f.db, barracks), {
    kind: "unavailable", availability: ["before_coverage"], preEventFrames: { min: 49, max: 49 }
  });
});

test("supplyBefore preserves unchanged Terran supply", async () => {
  await using f = await fixture();
  const depot = event(f.db, { observationId: 2, unitKey: "supply_depot", occurrence: 1 });
  assert.deepEqual(supplyBefore(f.db, depot), { kind: "known", supply: 9, preEventFrames: { min: 99, max: 99 } });
});

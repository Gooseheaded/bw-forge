import type { Database } from "../db/sqlite.js";
import { sqlRows } from "../db/backend.js";
import { supplyAtFrame, type Availability } from "./v2.js";

export interface EventRequest {
  observationId: number;
  /** Normalized unit_types.unit_key, matched case-insensitively. */
  unitKey: string;
  /** One-based occurrence within this unit type. */
  occurrence: number;
}

/** A non-null source frame is exact; otherwise the persisted bounds remain an interval. */
export type EventTiming =
  | { kind: "exact"; frame: number }
  | { kind: "interval"; frameMin: number; frameMax: number };

export interface EventFact {
  kind: "event";
  observationId: number;
  occurrence: number;
  /** Corpus emission order, which is independent of per-unit occurrence. */
  sourceOccurrence: number;
  unitType: { id: number; key: string; displayName: string };
  timing: EventTiming;
  recordedTimeSeconds: number;
  timingBasis: string;
  frameMin: number;
  frameMax: number;
  rawLine: string;
}

export interface EventNotPresent {
  kind: "event_not_present";
  request: EventRequest;
}

export type EventLookupResult = EventFact | EventNotPresent;

export type EventOrderResult =
  | { kind: "known"; certainty: "definitely_true" | "definitely_false"; value: boolean }
  | { kind: "ambiguous"; certainty: "ambiguous" }
  | { kind: "event_not_present"; missing: Array<"left" | "right"> };

export type SupplyBeforeResult =
  | { kind: "known"; supply: number; preEventFrames: { min: number; max: number } }
  | { kind: "ambiguous"; values: number[]; min: number; max: number; preEventFrames: { min: number; max: number } }
  | { kind: "unavailable"; availability: Availability[]; preEventFrames: { min: number; max: number } }
  | { kind: "event_not_present" };

/** Locate a corpus-emitted event; starting units/buildings are never synthesized. */
export function event(db: Database, request: EventRequest): EventLookupResult {
  if (!Number.isInteger(request.observationId) || request.observationId < 0) {
    throw new Error("observationId must be a non-negative integer");
  }
  if (!request.unitKey.trim()) throw new Error("unitKey must not be empty");
  if (!Number.isInteger(request.occurrence) || request.occurrence < 1) {
    throw new Error("occurrence must be a positive integer");
  }

  const row = sqlRows(db, `SELECT b.occurrence AS source_occurrence,b.frame,b.time_seconds,b.frame_min,b.frame_max,
      b.timing_basis,b.raw_line,u.unit_type_id,u.unit_key,u.display_name
    FROM build_events b JOIN unit_types u ON u.unit_type_id=b.unit_type_id
    WHERE b.observation_id=? AND u.unit_key=? COLLATE NOCASE
    ORDER BY b.occurrence LIMIT 1 OFFSET ?`,
    [request.observationId, request.unitKey, request.occurrence - 1])[0];
  if (!row) return { kind: "event_not_present", request: { ...request } };

  const frameMin = Number(row.frame_min);
  const frameMax = Number(row.frame_max);
  const timing: EventTiming = row.frame == null
    ? { kind: "interval", frameMin, frameMax }
    : { kind: "exact", frame: Number(row.frame) };
  return {
    kind: "event",
    observationId: request.observationId,
    occurrence: request.occurrence,
    sourceOccurrence: Number(row.source_occurrence),
    unitType: { id: Number(row.unit_type_id), key: String(row.unit_key), displayName: String(row.display_name) },
    timing,
    recordedTimeSeconds: Number(row.time_seconds),
    timingBasis: String(row.timing_basis),
    frameMin,
    frameMax,
    rawLine: String(row.raw_line)
  };
}

function bounds(fact: EventFact): { min: number; max: number } {
  return fact.timing.kind === "exact"
    ? { min: fact.timing.frame, max: fact.timing.frame }
    : { min: fact.timing.frameMin, max: fact.timing.frameMax };
}

/**
 * Three-valued strict ordering: true when all left frames precede all right
 * frames, false when all left frames are at/after all right frames, otherwise
 * ambiguous. Missing events are a separate result.
 */
export function before(left: EventLookupResult, right: EventLookupResult): EventOrderResult {
  if (left.kind !== "event" || right.kind !== "event") {
    const missing: Array<"left" | "right"> = [];
    if (left.kind !== "event") missing.push("left");
    if (right.kind !== "event") missing.push("right");
    return { kind: "event_not_present", missing };
  }
  const a = bounds(left);
  const b = bounds(right);
  if (a.max < b.min) return { kind: "known", certainty: "definitely_true", value: true };
  if (a.min >= b.max) return { kind: "known", certainty: "definitely_false", value: false };
  return { kind: "ambiguous", certainty: "ambiguous" };
}

/**
 * Conventional build-order supply is used supply at F-1. For interval timing,
 * every possible event frame is evaluated; disagreement remains ambiguous and
 * any insufficient supply coverage makes the result unavailable. No race-based
 * adjustment is applied.
 */
export function supplyBefore(db: Database, result: EventLookupResult): SupplyBeforeResult {
  if (result.kind !== "event") return { kind: "event_not_present" };
  const eventFrames = bounds(result);
  const preEventFrames = { min: eventFrames.min - 1, max: eventFrames.max - 1 };
  const values = new Set<number>();
  const unavailable = new Set<Availability>();
  for (let frame = preEventFrames.min; frame <= preEventFrames.max; frame += 1) {
    const sample = supplyAtFrame(db, result.observationId, frame);
    if (sample.availability !== "known" || !sample.sample) unavailable.add(sample.availability);
    else values.add(sample.sample.current);
  }
  if (unavailable.size) return { kind: "unavailable", availability: [...unavailable], preEventFrames };
  const possible = [...values].sort((a, b) => a - b);
  if (possible.length === 1) return { kind: "known", supply: possible[0]!, preEventFrames };
  return { kind: "ambiguous", values: possible, min: possible[0]!, max: possible[possible.length - 1]!, preEventFrames };
}

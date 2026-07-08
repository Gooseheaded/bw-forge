import { readFile } from "node:fs/promises";
import { openDatabase } from "../db/sqlite.js";
import { assertCorpusSchema } from "../db/schema.js";
import {
  findFirstEvent,
  findNthEvent,
  findReplays,
  getDeathsBetween,
  getEconomyAtOrBefore,
  getUnitCountAtOrBefore,
  type BuildEventFilters,
  type ReplayFilters
} from "../query/query.js";
import * as z from "zod/v4";

const plannerSchemaValue = "query-planner-v1" as const;
const resultSchemaValue = "query-executor-result-v1" as const;
const perspectiveEnum = z.enum(["self", "enemy"]);
const intentEnum = z.enum(["find_replays_matching_pattern", "gather_evidence_for_replays"]);
const limitationStatusEnum = z.enum(["unsupported", "approximate"]);
const summariesEnum = z.enum([
  "total_count",
  "count_by_unit_type",
  "count_by_category",
  "first_time_seconds",
  "last_time_seconds"
]);
const positiveInteger = z.number().int().positive();

const assumptionSchema = z.object({
  phrase: z.string().trim().min(1),
  meaning: z.string().trim().min(1)
}).strict();

const limitationSchema = z.object({
  phrase: z.string().trim().min(1),
  status: limitationStatusEnum,
  reason: z.string().trim().min(1)
}).strict();

const replaySetSchema = z.object({
  matchup: z.string().trim().min(1).optional(),
  player: z.string().trim().min(1).optional(),
  race: z.string().trim().min(1).optional(),
  replay_ids: z.array(z.string().trim().min(1)).nonempty().optional()
}).strict();

const baseConstraintSchema = {
  id: z.string().trim().regex(/^[a-z0-9_]+$/).min(1),
  perspective: perspectiveEnum
};

const firstEventSelectorSchema = z.object({
  type: z.literal("first_event"),
  perspective: perspectiveEnum,
  item: z.string().trim().min(1)
}).strict();

const nthEventSelectorSchema = z.object({
  type: z.literal("nth_event"),
  perspective: perspectiveEnum,
  item: z.string().trim().min(1),
  n: positiveInteger
}).strict();

const eventSelectorSchema = z.discriminatedUnion("type", [firstEventSelectorSchema, nthEventSelectorSchema]);

const firstEventBeforeConstraintSchema = z.object({
  ...baseConstraintSchema,
  type: z.literal("first_event_before"),
  item: z.string().trim().min(1),
  before_seconds: z.number().finite()
}).strict();

const firstEventAfterConstraintSchema = z.object({
  ...baseConstraintSchema,
  type: z.literal("first_event_after"),
  item: z.string().trim().min(1),
  after_seconds: z.number().finite()
}).strict();

const unitCountAtLeastConstraintSchema = z.object({
  ...baseConstraintSchema,
  type: z.literal("unit_count_at_least_at"),
  unit: z.string().trim().min(1),
  at_seconds: z.number().finite(),
  count_at_least: z.number().finite()
}).strict();

const unitCountAtMostConstraintSchema = z.object({
  ...baseConstraintSchema,
  type: z.literal("unit_count_at_most_at"),
  unit: z.string().trim().min(1),
  at_seconds: z.number().finite(),
  count_at_most: z.number().finite()
}).strict();

const economyWorkersAtLeastConstraintSchema = z.object({
  ...baseConstraintSchema,
  type: z.literal("economy_workers_at_least_at"),
  at_seconds: z.number().finite(),
  workers_at_least: z.number().finite()
}).strict();

const economyWorkersAtMostConstraintSchema = z.object({
  ...baseConstraintSchema,
  type: z.literal("economy_workers_at_most_at"),
  at_seconds: z.number().finite(),
  workers_at_most: z.number().finite()
}).strict();

const deathsCountAtLeastConstraintSchema = z.object({
  ...baseConstraintSchema,
  type: z.literal("deaths_count_at_least_between"),
  from_seconds: z.number().finite(),
  to_seconds: z.number().finite(),
  count_at_least: z.number().finite()
}).strict().refine((value) => value.from_seconds <= value.to_seconds, {
  message: "from_seconds must be less than or equal to to_seconds",
  path: ["from_seconds"]
});

const deathsCountAtMostConstraintSchema = z.object({
  ...baseConstraintSchema,
  type: z.literal("deaths_count_at_most_between"),
  from_seconds: z.number().finite(),
  to_seconds: z.number().finite(),
  count_at_most: z.number().finite()
}).strict().refine((value) => value.from_seconds <= value.to_seconds, {
  message: "from_seconds must be less than or equal to to_seconds",
  path: ["from_seconds"]
});

const eventBeforeEventConstraintSchema = z.object({
  ...baseConstraintSchema,
  type: z.literal("event_before_event"),
  left_event: eventSelectorSchema,
  right_event: eventSelectorSchema
}).strict();

const firstEventEvidenceSchema = z.object({
  id: z.string().trim().regex(/^[a-z0-9_]+$/).min(1),
  type: z.literal("first_event"),
  perspective: perspectiveEnum,
  item: z.string().trim().min(1),
  include_raw: z.boolean().optional()
}).strict();

const unitCountEvidenceSchema = z.object({
  id: z.string().trim().regex(/^[a-z0-9_]+$/).min(1),
  type: z.literal("unit_count_at"),
  perspective: perspectiveEnum,
  unit: z.string().trim().min(1),
  at_seconds: z.number().finite(),
  include_raw: z.boolean().optional()
}).strict();

const economyEvidenceSchema = z.object({
  id: z.string().trim().regex(/^[a-z0-9_]+$/).min(1),
  type: z.literal("economy_at"),
  perspective: perspectiveEnum,
  at_seconds: z.number().finite(),
  include_raw: z.boolean().optional()
}).strict();

const unitCountAtEventTimeEvidenceSchema = z.object({
  id: z.string().trim().regex(/^[a-z0-9_]+$/).min(1),
  type: z.literal("unit_count_at_event_time"),
  perspective: perspectiveEnum,
  unit: z.string().trim().min(1),
  event: eventSelectorSchema,
  include_raw: z.boolean().optional()
}).strict();

const economyAtEventTimeEvidenceSchema = z.object({
  id: z.string().trim().regex(/^[a-z0-9_]+$/).min(1),
  type: z.literal("economy_at_event_time"),
  perspective: perspectiveEnum,
  event: eventSelectorSchema,
  include_raw: z.boolean().optional()
}).strict();

const deathsEvidenceSchema = z.object({
  id: z.string().trim().regex(/^[a-z0-9_]+$/).min(1),
  type: z.literal("deaths_between"),
  perspective: perspectiveEnum,
  from_seconds: z.number().finite(),
  to_seconds: z.number().finite(),
  include_raw: z.boolean(),
  summaries: z.array(summariesEnum)
}).strict().refine((value) => value.from_seconds <= value.to_seconds, {
  message: "from_seconds must be less than or equal to to_seconds",
  path: ["from_seconds"]
}).refine((value) => value.include_raw || value.summaries.length > 0, {
  message: "summaries must be non-empty when include_raw is false",
  path: ["summaries"]
});

const constraintSchema = z.discriminatedUnion("type", [
  firstEventBeforeConstraintSchema,
  firstEventAfterConstraintSchema,
  unitCountAtLeastConstraintSchema,
  unitCountAtMostConstraintSchema,
  economyWorkersAtLeastConstraintSchema,
  economyWorkersAtMostConstraintSchema,
  deathsCountAtLeastConstraintSchema,
  deathsCountAtMostConstraintSchema,
  eventBeforeEventConstraintSchema
]);

const evidenceSchema = z.discriminatedUnion("type", [
  firstEventEvidenceSchema,
  unitCountEvidenceSchema,
  economyEvidenceSchema,
  deathsEvidenceSchema,
  unitCountAtEventTimeEvidenceSchema,
  economyAtEventTimeEvidenceSchema
]);

const queryPlanSchema = z.object({
  planner_schema: z.literal(plannerSchemaValue),
  query: z.object({
    original_text: z.string().trim().min(1),
    intent: intentEnum
  }).strict(),
  replay_set: replaySetSchema,
  constraints: z.array(constraintSchema),
  evidence_requests: z.array(evidenceSchema),
  assumptions: z.array(assumptionSchema),
  unsupported_or_approximate: z.array(limitationSchema)
}).strict();

export type QueryPlanV1 = z.infer<typeof queryPlanSchema>;
export type QueryExecutorMode = "normal" | "debug";
type Constraint = QueryPlanV1["constraints"][number];
type EvidenceRequest = QueryPlanV1["evidence_requests"][number];
type EventSelector = z.infer<typeof eventSelectorSchema>;
type EventRow = NonNullable<ReturnType<typeof findFirstEvent>[number]["event"]>;
type UnitCountSample = NonNullable<ReturnType<typeof getUnitCountAtOrBefore>[number]["sample"]>;
type EconomySample = NonNullable<ReturnType<typeof getEconomyAtOrBefore>[number]["sample"]>;
type DeathRow = ReturnType<typeof getDeathsBetween>[number]["deaths"][number];

type ConstraintResultValue =
  | { event: ReturnType<typeof findFirstEvent>[number]["event"] }
  | { sample: ReturnType<typeof getUnitCountAtOrBefore>[number]["sample"] | ReturnType<typeof getEconomyAtOrBefore>[number]["sample"] }
  | { deaths: ReturnType<typeof getDeathsBetween>[number]["deaths"] }
  | { left_event: ReturnType<typeof findFirstEvent>[number]["event"]; right_event: ReturnType<typeof findFirstEvent>[number]["event"] };

type EvidenceValue =
  | { event: ReturnType<typeof findFirstEvent>[number]["event"] }
  | { sample: ReturnType<typeof getUnitCountAtOrBefore>[number]["sample"] | ReturnType<typeof getEconomyAtOrBefore>[number]["sample"] }
  | {
      deaths?: ReturnType<typeof getDeathsBetween>[number]["deaths"];
      summaries?: Record<string, unknown>;
    }
  | {
      event: ReturnType<typeof findFirstEvent>[number]["event"];
      sample: ReturnType<typeof getUnitCountAtOrBefore>[number]["sample"] | ReturnType<typeof getEconomyAtOrBefore>[number]["sample"];
    };

type QueryError = { kind: "validation_error" | "execution_error"; message: string } | null;

export interface QueryExecutorResultV1 {
  result_schema: typeof resultSchemaValue;
  plan: QueryPlanV1;
  coarse_replay_ids: string[];
  replay_results: Array<{
    replay_id: string;
    source_replay_filename: string | null;
    source_replay_path: string | null;
    matchup: string | null;
    self_player_name: string | null;
    self_owner: number | null;
    enemy_player_name: string | null;
    enemy_owner: number | null;
    matched: boolean;
    constraint_results: Record<
      string,
      {
        passed: boolean;
        value: ConstraintResultValue | null;
        error: QueryError;
      }
    >;
    evidence: Record<
      string,
      {
        value: EvidenceValue | null;
        error: QueryError;
      }
    >;
  }>;
  unsupported_or_approximate: QueryPlanV1["unsupported_or_approximate"];
}

type ReplayRow = ReturnType<typeof findReplays>[number];

export function validateQueryPlan(plan: unknown): QueryPlanV1 {
  const parsed = queryPlanSchema.parse(plan);
  const allIds = [...parsed.constraints.map((item) => item.id), ...parsed.evidence_requests.map((item) => item.id)];
  const duplicateId = allIds.find((id, index) => allIds.indexOf(id) !== index);
  if (duplicateId) {
    throw new Error(`Duplicate planner item id: ${duplicateId}`);
  }
  if ((parsed.constraints.length > 0 || parsed.evidence_requests.length > 0) && !parsed.replay_set.player) {
    throw new Error("replay_set.player is required when constraints or evidence_requests are present in v1");
  }
  const contradiction = findConstraintContradiction(parsed.constraints);
  if (contradiction) {
    throw new Error(contradiction);
  }
  return parsed;
}

export async function executeQueryPlan(input: {
  dbPath: string;
  plan: unknown;
  mode?: QueryExecutorMode;
}): Promise<QueryExecutorResultV1> {
  const plan = validateQueryPlan(input.plan);
  const mode = input.mode ?? "normal";
  const { db } = await openDatabase(input.dbPath, { readOnly: true, timeoutMs: 3000 });
  try {
    assertCorpusSchema(db);
    const coarseReplays = findReplays(db, toReplayFilters(plan.replay_set));
    const coarseReplayIds = coarseReplays.map((replay) => replay.replay_id);
    const coarseReplayIdSet = new Set(coarseReplayIds);
    const helperCache = new Map<string, unknown>();
    const replayResults: QueryExecutorResultV1["replay_results"] = [];

    for (const replay of coarseReplays) {
      const identity = resolveReplayIdentity(replay, plan.replay_set.player ?? null);
      const constraintResults: QueryExecutorResultV1["replay_results"][number]["constraint_results"] = {};
      let matched = true;

      for (const constraint of plan.constraints) {
        const evaluation = evaluateConstraint(db, helperCache, coarseReplayIdSet, plan, constraint, replay);
        constraintResults[constraint.id] = evaluation;
        if (!evaluation.passed) {
          matched = false;
        }
      }

      if (mode === "normal" && !matched) {
        continue;
      }

      const evidence: QueryExecutorResultV1["replay_results"][number]["evidence"] = {};
      if (matched) {
        for (const request of plan.evidence_requests) {
          evidence[request.id] = evaluateEvidence(db, helperCache, coarseReplayIdSet, plan, request, replay);
        }
      }

      replayResults.push({
        replay_id: replay.replay_id,
        source_replay_filename: replay.source_replay_filename,
        source_replay_path: replay.source_replay_path,
        matchup: replay.matchup,
        self_player_name: identity.self_player_name,
        self_owner: identity.self_owner,
        enemy_player_name: identity.enemy_player_name,
        enemy_owner: identity.enemy_owner,
        matched,
        constraint_results: constraintResults,
        evidence
      });
    }

    return {
      result_schema: resultSchemaValue,
      plan,
      coarse_replay_ids: coarseReplayIds,
      replay_results: replayResults,
      unsupported_or_approximate: plan.unsupported_or_approximate
    };
  } finally {
    const close = (db as { close?: () => void }).close;
    if (typeof close === "function") {
      close.call(db);
    }
  }
}

export async function readQueryPlanFile(planPath: string): Promise<QueryPlanV1> {
  const contents = await readFile(planPath, "utf8");
  return validateQueryPlan(JSON.parse(contents));
}

function toReplayFilters(replaySet: QueryPlanV1["replay_set"]): ReplayFilters {
  return {
    ...(replaySet.matchup ? { matchup: replaySet.matchup } : {}),
    ...(replaySet.player ? { player: replaySet.player } : {}),
    ...(replaySet.race ? { race: replaySet.race } : {}),
    ...(replaySet.replay_ids ? { replay_ids: replaySet.replay_ids } : {})
  };
}

function resolveReplayIdentity(
  replay: ReplayRow,
  selectedPlayer: string | null
): {
  self_player_name: string | null;
  self_owner: number | null;
  enemy_player_name: string | null;
  enemy_owner: number | null;
} {
  if (!selectedPlayer) {
    return {
      self_player_name: null,
      self_owner: null,
      enemy_player_name: null,
      enemy_owner: null
    };
  }
  const selfPlayers = replay.players.filter((player) => player.name.localeCompare(selectedPlayer, undefined, { sensitivity: "accent" }) === 0 || player.name.toLowerCase() === selectedPlayer.toLowerCase());
  const selfPlayer = selfPlayers.length === 1 ? selfPlayers[0] : null;
  const enemyPlayers = selfPlayer ? replay.players.filter((player) => player.owner !== selfPlayer.owner) : [];
  const enemyPlayer = enemyPlayers.length === 1 ? enemyPlayers[0] : null;
  return {
    self_player_name: selfPlayer?.name ?? null,
    self_owner: selfPlayer?.owner ?? null,
    enemy_player_name: enemyPlayer?.name ?? null,
    enemy_owner: enemyPlayer?.owner ?? null
  };
}

function evaluateConstraint(
  db: Awaited<ReturnType<typeof openDatabase>>["db"],
  cache: Map<string, unknown>,
  coarseReplayIds: Set<string>,
  plan: QueryPlanV1,
  constraint: Constraint,
  replay: ReplayRow
): {
  passed: boolean;
  value: ConstraintResultValue | null;
  error: QueryError;
} {
  switch (constraint.type) {
    case "first_event_before": {
      const row = getFirstEventRow(db, cache, coarseReplayIds, plan, constraint, replay.replay_id);
      return {
        passed: row?.event !== null && row?.event !== undefined && row.event.time_seconds < constraint.before_seconds,
        value: { event: row?.event ?? null },
        error: null
      };
    }
    case "first_event_after": {
      const row = getFirstEventRow(db, cache, coarseReplayIds, plan, constraint, replay.replay_id);
      return {
        passed: row?.event !== null && row?.event !== undefined && row.event.time_seconds > constraint.after_seconds,
        value: { event: row?.event ?? null },
        error: null
      };
    }
    case "unit_count_at_least_at": {
      const row = getUnitCountRow(db, cache, coarseReplayIds, plan, constraint, replay.replay_id);
      return {
        passed: row?.sample !== null && row?.sample !== undefined && row.sample.count >= constraint.count_at_least,
        value: { sample: row?.sample ?? null },
        error: null
      };
    }
    case "unit_count_at_most_at": {
      const row = getUnitCountRow(db, cache, coarseReplayIds, plan, constraint, replay.replay_id);
      return {
        passed: row?.sample !== null && row?.sample !== undefined && row.sample.count <= constraint.count_at_most,
        value: { sample: row?.sample ?? null },
        error: null
      };
    }
    case "economy_workers_at_least_at": {
      const row = getEconomyRow(db, cache, coarseReplayIds, plan, constraint, replay.replay_id);
      const workers = row?.sample?.workers ?? null;
      return {
        passed: workers !== null && workers >= constraint.workers_at_least,
        value: { sample: row?.sample ?? null },
        error: null
      };
    }
    case "economy_workers_at_most_at": {
      const row = getEconomyRow(db, cache, coarseReplayIds, plan, constraint, replay.replay_id);
      const workers = row?.sample?.workers ?? null;
      return {
        passed: workers !== null && workers <= constraint.workers_at_most,
        value: { sample: row?.sample ?? null },
        error: null
      };
    }
    case "deaths_count_at_least_between": {
      const row = getDeathsRow(db, cache, coarseReplayIds, plan, constraint, replay.replay_id);
      return {
        passed: (row?.deaths.length ?? 0) >= constraint.count_at_least,
        value: { deaths: row?.deaths ?? [] },
        error: null
      };
    }
    case "deaths_count_at_most_between": {
      const row = getDeathsRow(db, cache, coarseReplayIds, plan, constraint, replay.replay_id);
      return {
        passed: (row?.deaths.length ?? 0) <= constraint.count_at_most,
        value: { deaths: row?.deaths ?? [] },
        error: null
      };
    }
    case "event_before_event": {
      const leftEvent = resolveEventSelector(db, cache, coarseReplayIds, plan, constraint.left_event, replay.replay_id);
      const rightEvent = resolveEventSelector(db, cache, coarseReplayIds, plan, constraint.right_event, replay.replay_id);
      return {
        passed:
          leftEvent !== null &&
          rightEvent !== null &&
          leftEvent.time_seconds < rightEvent.time_seconds,
        value: {
          left_event: leftEvent,
          right_event: rightEvent
        },
        error: null
      };
    }
  }
}

function evaluateEvidence(
  db: Awaited<ReturnType<typeof openDatabase>>["db"],
  cache: Map<string, unknown>,
  coarseReplayIds: Set<string>,
  plan: QueryPlanV1,
  request: EvidenceRequest,
  replay: ReplayRow
): {
  value: EvidenceValue | null;
  error: QueryError;
} {
  switch (request.type) {
    case "first_event": {
      const row = getFirstEventRow(db, cache, coarseReplayIds, plan, request, replay.replay_id);
      return { value: { event: row?.event ?? null }, error: null };
    }
    case "unit_count_at": {
      const row = getUnitCountRow(db, cache, coarseReplayIds, plan, request, replay.replay_id);
      return { value: { sample: row?.sample ?? null }, error: null };
    }
    case "economy_at": {
      const row = getEconomyRow(db, cache, coarseReplayIds, plan, request, replay.replay_id);
      return { value: { sample: row?.sample ?? null }, error: null };
    }
    case "deaths_between": {
      const row = getDeathsRow(db, cache, coarseReplayIds, plan, request, replay.replay_id);
      const summaries = summarizeDeaths(row?.deaths ?? [], request.summaries);
      return {
        value: {
          ...(request.include_raw ? { deaths: row?.deaths ?? [] } : {}),
          ...(request.summaries.length > 0 ? { summaries } : {})
        },
        error: null
      };
    }
    case "economy_at_event_time": {
      const event = resolveEventSelector(db, cache, coarseReplayIds, plan, request.event, replay.replay_id);
      const sample =
        event === null
          ? null
          : getEconomySampleAtReplayTime(db, cache, replay, plan.replay_set.player!, request.perspective, event.time_seconds);
      return {
        value: {
          event,
          sample
        },
        error: null
      };
    }
    case "unit_count_at_event_time": {
      const event = resolveEventSelector(db, cache, coarseReplayIds, plan, request.event, replay.replay_id);
      const sample =
        event === null
          ? null
          : getUnitCountSampleAtReplayTime(db, cache, replay, plan.replay_set.player!, request.perspective, request.unit, event.time_seconds);
      return {
        value: {
          event,
          sample
        },
        error: null
      };
    }
  }
}

function getFirstEventRow(
  db: Awaited<ReturnType<typeof openDatabase>>["db"],
  cache: Map<string, unknown>,
  coarseReplayIds: Set<string>,
  plan: QueryPlanV1,
  item: { perspective: "self" | "enemy"; item: string },
  replayId: string
): ReturnType<typeof findFirstEvent>[number] | undefined {
  const key = JSON.stringify(["first-event", item.perspective, item.item, plan.replay_set.player, plan.replay_set.matchup, plan.replay_set.race, plan.replay_set.replay_ids ?? null]);
  const rows = getOrCreate(cache, key, () =>
    toReplayIdMap(
      findFirstEvent(db, {
        player: plan.replay_set.player!,
        item: item.item,
        ...(plan.replay_set.matchup ? { matchup: plan.replay_set.matchup } : {}),
        ...(plan.replay_set.race ? { race: plan.replay_set.race } : {}),
        as: item.perspective
      }).filter((row) => coarseReplayIds.has(row.replay_id))
    )
  );
  return rows.get(replayId) as ReturnType<typeof findFirstEvent>[number] | undefined;
}

function getNthEventRow(
  db: Awaited<ReturnType<typeof openDatabase>>["db"],
  cache: Map<string, unknown>,
  coarseReplayIds: Set<string>,
  plan: QueryPlanV1,
  item: { perspective: "self" | "enemy"; item: string; n: number },
  replayId: string
): ReturnType<typeof findNthEvent>[number] | undefined {
  const key = JSON.stringify(["nth-event", item.perspective, item.item, item.n, plan.replay_set.player, plan.replay_set.matchup, plan.replay_set.race, plan.replay_set.replay_ids ?? null]);
  const rows = getOrCreate(cache, key, () =>
    toReplayIdMap(
      findNthEvent(db, {
        player: plan.replay_set.player!,
        item: item.item,
        n: item.n,
        ...(plan.replay_set.matchup ? { matchup: plan.replay_set.matchup } : {}),
        ...(plan.replay_set.race ? { race: plan.replay_set.race } : {}),
        as: item.perspective
      }).filter((row) => coarseReplayIds.has(row.replay_id))
    )
  );
  return rows.get(replayId) as ReturnType<typeof findNthEvent>[number] | undefined;
}

function getUnitCountRow(
  db: Awaited<ReturnType<typeof openDatabase>>["db"],
  cache: Map<string, unknown>,
  coarseReplayIds: Set<string>,
  plan: QueryPlanV1,
  item: { perspective: "self" | "enemy"; unit: string; at_seconds: number },
  replayId: string
): ReturnType<typeof getUnitCountAtOrBefore>[number] | undefined {
  const key = JSON.stringify(["unit-count", item.perspective, item.unit, item.at_seconds, plan.replay_set.player, plan.replay_set.matchup, plan.replay_set.race, plan.replay_set.replay_ids ?? null]);
  const rows = getOrCreate(cache, key, () =>
    toReplayIdMap(
      getUnitCountAtOrBefore(db, {
        player: plan.replay_set.player!,
        unit: item.unit,
        at: item.at_seconds,
        ...(plan.replay_set.matchup ? { matchup: plan.replay_set.matchup } : {}),
        ...(plan.replay_set.race ? { race: plan.replay_set.race } : {}),
        as: item.perspective
      }).filter((row) => coarseReplayIds.has(row.replay_id))
    )
  );
  return rows.get(replayId) as ReturnType<typeof getUnitCountAtOrBefore>[number] | undefined;
}

function getEconomyRow(
  db: Awaited<ReturnType<typeof openDatabase>>["db"],
  cache: Map<string, unknown>,
  coarseReplayIds: Set<string>,
  plan: QueryPlanV1,
  item: { perspective: "self" | "enemy"; at_seconds: number },
  replayId: string
): ReturnType<typeof getEconomyAtOrBefore>[number] | undefined {
  const key = JSON.stringify(["economy", item.perspective, item.at_seconds, plan.replay_set.player, plan.replay_set.matchup, plan.replay_set.race, plan.replay_set.replay_ids ?? null]);
  const rows = getOrCreate(cache, key, () =>
    toReplayIdMap(
      getEconomyAtOrBefore(db, {
        player: plan.replay_set.player!,
        at: item.at_seconds,
        ...(plan.replay_set.matchup ? { matchup: plan.replay_set.matchup } : {}),
        ...(plan.replay_set.race ? { race: plan.replay_set.race } : {}),
        as: item.perspective
      }).filter((row) => coarseReplayIds.has(row.replay_id))
    )
  );
  return rows.get(replayId) as ReturnType<typeof getEconomyAtOrBefore>[number] | undefined;
}

function getDeathsRow(
  db: Awaited<ReturnType<typeof openDatabase>>["db"],
  cache: Map<string, unknown>,
  coarseReplayIds: Set<string>,
  plan: QueryPlanV1,
  item: { perspective: "self" | "enemy"; from_seconds: number; to_seconds: number },
  replayId: string
): ReturnType<typeof getDeathsBetween>[number] | undefined {
  const key = JSON.stringify(["deaths", item.perspective, item.from_seconds, item.to_seconds, plan.replay_set.player, plan.replay_set.matchup, plan.replay_set.race, plan.replay_set.replay_ids ?? null]);
  const rows = getOrCreate(cache, key, () =>
    toReplayIdMap(
      getDeathsBetween(db, {
        player: plan.replay_set.player!,
        from: item.from_seconds,
        to: item.to_seconds,
        ...(plan.replay_set.matchup ? { matchup: plan.replay_set.matchup } : {}),
        ...(plan.replay_set.race ? { race: plan.replay_set.race } : {}),
        as: item.perspective
      }).filter((row) => coarseReplayIds.has(row.replay_id))
    )
  );
  return rows.get(replayId) as ReturnType<typeof getDeathsBetween>[number] | undefined;
}

function resolveEventSelector(
  db: Awaited<ReturnType<typeof openDatabase>>["db"],
  cache: Map<string, unknown>,
  coarseReplayIds: Set<string>,
  plan: QueryPlanV1,
  selector: EventSelector,
  replayId: string
): EventRow | null {
  switch (selector.type) {
    case "first_event":
      return getFirstEventRow(db, cache, coarseReplayIds, plan, selector, replayId)?.event ?? null;
    case "nth_event":
      return getNthEventRow(db, cache, coarseReplayIds, plan, selector, replayId)?.event ?? null;
  }
}

function getEconomySampleAtReplayTime(
  db: Awaited<ReturnType<typeof openDatabase>>["db"],
  cache: Map<string, unknown>,
  replay: ReplayRow,
  selectedPlayer: string,
  perspective: "self" | "enemy",
  atSeconds: number
): EconomySample | null {
  const targetOwner = resolvePerspectiveOwner(replay, selectedPlayer, perspective);
  if (targetOwner === null) {
    return null;
  }
  const key = JSON.stringify(["economy-at-event-time", replay.replay_id, targetOwner, atSeconds]);
  return getOrCreate(cache, key, () => {
    const statement = db.prepare(
      `SELECT time_seconds, minerals, gas, gathered_minerals, gathered_gas, workers
       FROM economy_samples
       WHERE replay_id = ? AND owner = ? AND time_seconds <= ?
       ORDER BY time_seconds DESC
       LIMIT 1;`
    );
    try {
      return firstRow(statement, [replay.replay_id, targetOwner, atSeconds], (row) => ({
        time_seconds: Number(row.time_seconds),
        minerals: Number(row.minerals),
        gas: Number(row.gas),
        gathered_minerals: toNullableNumber(row.gathered_minerals),
        gathered_gas: toNullableNumber(row.gathered_gas),
        workers: toNullableNumber(row.workers)
      }));
    } finally {
      statement.free();
    }
  }) as EconomySample | null;
}

function getUnitCountSampleAtReplayTime(
  db: Awaited<ReturnType<typeof openDatabase>>["db"],
  cache: Map<string, unknown>,
  replay: ReplayRow,
  selectedPlayer: string,
  perspective: "self" | "enemy",
  unit: string,
  atSeconds: number
): UnitCountSample | null {
  const targetOwner = resolvePerspectiveOwner(replay, selectedPlayer, perspective);
  if (targetOwner === null) {
    return null;
  }
  const key = JSON.stringify(["unit-count-at-event-time", replay.replay_id, targetOwner, unit, atSeconds]);
  return getOrCreate(cache, key, () => {
    const statement = db.prepare(
      `SELECT time_seconds, unit_type, count
       FROM unit_count_samples
       WHERE replay_id = ? AND owner = ? AND unit_type = ? COLLATE NOCASE AND time_seconds <= ?
       ORDER BY time_seconds DESC
       LIMIT 1;`
    );
    try {
      return firstRow(statement, [replay.replay_id, targetOwner, unit, atSeconds], (row) => ({
        time_seconds: Number(row.time_seconds),
        unit_type: String(row.unit_type),
        count: Number(row.count)
      }));
    } finally {
      statement.free();
    }
  }) as UnitCountSample | null;
}

function resolvePerspectiveOwner(
  replay: ReplayRow,
  selectedPlayer: string,
  perspective: "self" | "enemy"
): number | null {
  const normalizedSelectedPlayer = selectedPlayer.toLowerCase();
  const selfPlayers = replay.players.filter((player) => player.name.toLowerCase() === normalizedSelectedPlayer);
  const selfPlayer = selfPlayers.length === 1 ? selfPlayers[0] : null;
  if (!selfPlayer) {
    return null;
  }
  if (perspective === "self") {
    return selfPlayer.owner;
  }
  const enemyPlayers = replay.players.filter((player) => player.owner !== selfPlayer.owner);
  return enemyPlayers.length === 1 ? enemyPlayers[0]?.owner ?? null : null;
}

function getOrCreate<T>(cache: Map<string, unknown>, key: string, factory: () => T): T {
  const cached = cache.get(key);
  if (cached !== undefined) {
    return cached as T;
  }
  const value = factory();
  cache.set(key, value);
  return value;
}

function firstRow<T>(
  statement: { bind: (params: unknown[]) => void; step: () => boolean; getAsObject: () => Record<string, unknown>; reset: () => void },
  params: unknown[],
  mapper: (row: Record<string, unknown>) => T
): T | null {
  statement.bind(params);
  const row = statement.step() ? mapper(statement.getAsObject()) : null;
  statement.reset();
  return row;
}

function toNullableNumber(value: unknown): number | null {
  return value === null ? null : Number(value);
}

function toReplayIdMap<T extends { replay_id: string }>(rows: T[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const row of rows) {
    if (!map.has(row.replay_id)) {
      map.set(row.replay_id, row);
    }
  }
  return map;
}

function summarizeDeaths(
  deaths: Array<{ time_seconds: number; unit_type: string; category: string }>,
  summaries: Array<z.infer<typeof summariesEnum>>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const summary of summaries) {
    switch (summary) {
      case "total_count":
        result.total_count = deaths.length;
        break;
      case "count_by_unit_type": {
        const countByUnitType: Record<string, number> = {};
        for (const death of deaths) {
          countByUnitType[death.unit_type] = (countByUnitType[death.unit_type] ?? 0) + 1;
        }
        result.count_by_unit_type = countByUnitType;
        break;
      }
      case "count_by_category": {
        const countByCategory: Record<string, number> = {};
        for (const death of deaths) {
          countByCategory[death.category] = (countByCategory[death.category] ?? 0) + 1;
        }
        result.count_by_category = countByCategory;
        break;
      }
      case "first_time_seconds":
        result.first_time_seconds = deaths.length > 0 ? deaths[0]?.time_seconds ?? null : null;
        break;
      case "last_time_seconds":
        result.last_time_seconds = deaths.length > 0 ? deaths[deaths.length - 1]?.time_seconds ?? null : null;
        break;
    }
  }
  return result;
}

function findConstraintContradiction(constraints: Constraint[]): string | null {
  const firstEventBounds = new Map<string, { maxBefore?: number; minAfter?: number }>();
  const unitCountBounds = new Map<string, { min?: number; max?: number }>();
  const economyBounds = new Map<string, { min?: number; max?: number }>();
  const deathsBounds = new Map<string, { min?: number; max?: number }>();

  for (const constraint of constraints) {
    switch (constraint.type) {
      case "first_event_before": {
        const key = `${constraint.perspective}|${constraint.item}`;
        const bounds = firstEventBounds.get(key) ?? {};
        bounds.maxBefore = Math.min(bounds.maxBefore ?? Number.POSITIVE_INFINITY, constraint.before_seconds);
        firstEventBounds.set(key, bounds);
        if (bounds.minAfter !== undefined && bounds.maxBefore <= bounds.minAfter) {
          return `Contradictory first_event constraints for ${key}`;
        }
        break;
      }
      case "first_event_after": {
        const key = `${constraint.perspective}|${constraint.item}`;
        const bounds = firstEventBounds.get(key) ?? {};
        bounds.minAfter = Math.max(bounds.minAfter ?? Number.NEGATIVE_INFINITY, constraint.after_seconds);
        firstEventBounds.set(key, bounds);
        if (bounds.maxBefore !== undefined && bounds.maxBefore <= bounds.minAfter) {
          return `Contradictory first_event constraints for ${key}`;
        }
        break;
      }
      case "unit_count_at_least_at": {
        const key = `${constraint.perspective}|${constraint.unit}|${constraint.at_seconds}`;
        const bounds = unitCountBounds.get(key) ?? {};
        bounds.min = Math.max(bounds.min ?? Number.NEGATIVE_INFINITY, constraint.count_at_least);
        unitCountBounds.set(key, bounds);
        if (bounds.max !== undefined && bounds.min > bounds.max) {
          return `Contradictory unit_count constraints for ${key}`;
        }
        break;
      }
      case "unit_count_at_most_at": {
        const key = `${constraint.perspective}|${constraint.unit}|${constraint.at_seconds}`;
        const bounds = unitCountBounds.get(key) ?? {};
        bounds.max = Math.min(bounds.max ?? Number.POSITIVE_INFINITY, constraint.count_at_most);
        unitCountBounds.set(key, bounds);
        if (bounds.min !== undefined && bounds.min > bounds.max) {
          return `Contradictory unit_count constraints for ${key}`;
        }
        break;
      }
      case "economy_workers_at_least_at": {
        const key = `${constraint.perspective}|${constraint.at_seconds}`;
        const bounds = economyBounds.get(key) ?? {};
        bounds.min = Math.max(bounds.min ?? Number.NEGATIVE_INFINITY, constraint.workers_at_least);
        economyBounds.set(key, bounds);
        if (bounds.max !== undefined && bounds.min > bounds.max) {
          return `Contradictory economy_workers constraints for ${key}`;
        }
        break;
      }
      case "economy_workers_at_most_at": {
        const key = `${constraint.perspective}|${constraint.at_seconds}`;
        const bounds = economyBounds.get(key) ?? {};
        bounds.max = Math.min(bounds.max ?? Number.POSITIVE_INFINITY, constraint.workers_at_most);
        economyBounds.set(key, bounds);
        if (bounds.min !== undefined && bounds.min > bounds.max) {
          return `Contradictory economy_workers constraints for ${key}`;
        }
        break;
      }
      case "deaths_count_at_least_between": {
        const key = `${constraint.perspective}|${constraint.from_seconds}|${constraint.to_seconds}`;
        const bounds = deathsBounds.get(key) ?? {};
        bounds.min = Math.max(bounds.min ?? Number.NEGATIVE_INFINITY, constraint.count_at_least);
        deathsBounds.set(key, bounds);
        if (bounds.max !== undefined && bounds.min > bounds.max) {
          return `Contradictory deaths_count constraints for ${key}`;
        }
        break;
      }
      case "deaths_count_at_most_between": {
        const key = `${constraint.perspective}|${constraint.from_seconds}|${constraint.to_seconds}`;
        const bounds = deathsBounds.get(key) ?? {};
        bounds.max = Math.min(bounds.max ?? Number.POSITIVE_INFINITY, constraint.count_at_most);
        deathsBounds.set(key, bounds);
        if (bounds.min !== undefined && bounds.min > bounds.max) {
          return `Contradictory deaths_count constraints for ${key}`;
        }
        break;
      }
    }
  }

  return null;
}

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Database } from "../db/sqlite.js";
import {
  countReplaysWithEventBeforeEvent,
  getEventTimingDistribution
} from "../analytics/buildTimings.js";
import {
  getCompositionSnapshot,
  getEconomyDistribution
} from "../analytics/compositions.js";
import { getDeathSummary } from "../analytics/deaths.js";
import {
  getCorpusSummary,
  listBuildItems,
  listMatchups,
  listPlayers,
  listUnitTypes,
  searchBuildItems
} from "../analytics/discovery.js";
import { getPlayerReplayCard } from "../analytics/replayCard.js";
import { assertCorpusSchema, ensureSchema } from "../db/schema.js";
import { openDatabase, saveDatabase } from "../db/sqlite.js";
import { ingestAnalysisRoot, type IngestBatchSummary } from "../ingest/ingest.js";
import { executeQueryPlan, type QueryPlanV1 } from "../query-plan/executor.js";
import { exportQueryPlanZip } from "../query-plan/export.js";
import {
  findFirstEvent,
  findNthEvent,
  findReplays,
  getDeathsBetween,
  getEconomyAtOrBefore,
  getUnitCountAtOrBefore,
  listBuildEvents
} from "../query/query.js";
import { listQueryExamples, type QueryExampleTopic } from "../sql/queryExamples.js";
import {
  buildReadonlySqlExecutionPlan,
  clampMaxRows,
  getReadonlySqlDefaults,
  validateReadonlySql
} from "../sql/readonlySql.js";
import { describeSchema, getSchemaNotes, type SchemaNotesTopic } from "../sql/schemaDescription.js";
import {
  formatCompositionSnapshotText,
  formatCorpusSummaryText,
  formatDeathSummaryText,
  formatEconomyDistributionText,
  formatEventBeforeEventText,
  formatEventTimingDistributionText,
  formatExecuteReadonlySqlText,
  formatDescribeSchemaText,
  formatListQueryExamplesText,
  formatListBuildItemsText,
  formatListMatchupsText,
  formatListPlayersText,
  formatListUnitTypesText,
  formatReplayCardText,
  formatSchemaNotesText,
  formatPrimitiveToolText,
  formatSearchBuildItemsText,
  formatServerInfoText,
  formatValidateReadonlySqlText
} from "./textFormat.js";
import * as z from "zod/v4";

const nonEmptyString = z.string().trim().min(1);
const optionalNonEmptyString = nonEmptyString.optional();
const replayIdsSchema = z.array(nonEmptyString).nonempty().optional();
const perspectiveSchema = z.enum(["self", "enemy"]).optional();
const finiteSeconds = z.number().finite();
const limitSchema = z.number().int().positive().max(500).optional();

const corpusFilterInputSchema = {
  player: optionalNonEmptyString,
  opponent: optionalNonEmptyString,
  race: optionalNonEmptyString,
  opponentRace: optionalNonEmptyString,
  matchup: optionalNonEmptyString,
  map: optionalNonEmptyString,
  replay_ids: replayIdsSchema
};

const findReplaysInputSchema = {
  db_path: optionalNonEmptyString,
  matchup: optionalNonEmptyString,
  player: optionalNonEmptyString,
  race: optionalNonEmptyString,
  replay_ids: replayIdsSchema
};

const perspectiveInputSchema = {
  db_path: optionalNonEmptyString,
  player: nonEmptyString,
  matchup: optionalNonEmptyString,
  race: optionalNonEmptyString,
  replay_ids: replayIdsSchema,
  as: perspectiveSchema
};
const optionalFiniteSeconds = finiteSeconds.optional();
const positiveInteger = z.number().int().positive();
const resourceOptionalDbPathSchema = optionalNonEmptyString;

const getDeathsInputSchema = z.object({
  db_path: optionalNonEmptyString,
  player: nonEmptyString,
  from_seconds: finiteSeconds,
  to_seconds: finiteSeconds,
  matchup: optionalNonEmptyString,
  race: optionalNonEmptyString,
  replay_ids: replayIdsSchema,
  as: perspectiveSchema
}).refine((value) => value.from_seconds <= value.to_seconds, {
  message: "from_seconds must be less than or equal to to_seconds",
  path: ["from_seconds"]
});

const listBuildEventsInputSchema = z.object({
  db_path: optionalNonEmptyString,
  player: nonEmptyString,
  matchup: optionalNonEmptyString,
  race: optionalNonEmptyString,
  replay_ids: replayIdsSchema,
  as: perspectiveSchema,
  item: optionalNonEmptyString,
  from_seconds: optionalFiniteSeconds,
  to_seconds: optionalFiniteSeconds
}).refine(
  (value) =>
    value.from_seconds === undefined ||
    value.to_seconds === undefined ||
    value.from_seconds <= value.to_seconds,
  {
    message: "from_seconds must be less than or equal to to_seconds",
    path: ["from_seconds"]
  }
);

const findFirstEventInputSchema = z.object({
  ...perspectiveInputSchema,
  item: nonEmptyString
});

const findNthEventInputSchema = z.object({
  ...perspectiveInputSchema,
  item: nonEmptyString,
  n: positiveInteger
});

const getUnitCountInputSchema = z.object({
  ...perspectiveInputSchema,
  unit: nonEmptyString,
  at_seconds: finiteSeconds
});

const getEconomyInputSchema = z.object({
  ...perspectiveInputSchema,
  at_seconds: finiteSeconds
});

const discoveryInputSchema = z.object({
  db_path: optionalNonEmptyString,
  ...corpusFilterInputSchema
});

const listPlayersInputSchema = z.object({
  db_path: optionalNonEmptyString,
  ...corpusFilterInputSchema,
  limit: limitSchema
});

const listMatchupsInputSchema = z.object({
  db_path: optionalNonEmptyString,
  ...corpusFilterInputSchema,
  limit: limitSchema
});

const listBuildItemsInputSchema = z.object({
  db_path: optionalNonEmptyString,
  ...corpusFilterInputSchema,
  limit: limitSchema
});

const searchBuildItemsInputSchema = z.object({
  db_path: optionalNonEmptyString,
  ...corpusFilterInputSchema,
  query: nonEmptyString,
  limit: limitSchema
});

const listUnitTypesInputSchema = z.object({
  db_path: optionalNonEmptyString,
  ...corpusFilterInputSchema,
  source: z.enum(["unit_counts", "deaths", "both"]).optional(),
  limit: limitSchema
});

const getEventTimingDistributionInputSchema = z.object({
  db_path: optionalNonEmptyString,
  ...corpusFilterInputSchema,
  item: nonEmptyString,
  n: positiveInteger.optional(),
  startSeconds: optionalFiniteSeconds,
  endSeconds: optionalFiniteSeconds,
  limitExamples: z.number().int().positive().max(25).optional()
}).refine(
  (value) => value.startSeconds === undefined || value.endSeconds === undefined || value.startSeconds <= value.endSeconds,
  {
    message: "startSeconds must be less than or equal to endSeconds",
    path: ["startSeconds"]
  }
);

const countReplaysWithEventBeforeEventInputSchema = z.object({
  db_path: optionalNonEmptyString,
  ...corpusFilterInputSchema,
  firstItem: nonEmptyString,
  firstN: positiveInteger.optional(),
  secondItem: nonEmptyString,
  secondN: positiveInteger.optional(),
  limitExamples: z.number().int().positive().max(25).optional()
});

const getCompositionSnapshotInputSchema = z.object({
  db_path: optionalNonEmptyString,
  ...corpusFilterInputSchema,
  timeSeconds: finiteSeconds,
  units: z.array(nonEmptyString).optional(),
  limitExamples: z.number().int().positive().max(25).optional()
});

const getEconomyDistributionInputSchema = z.object({
  db_path: optionalNonEmptyString,
  ...corpusFilterInputSchema,
  timeSeconds: finiteSeconds,
  limitExamples: z.number().int().positive().max(25).optional()
});

const getDeathSummaryInputSchema = z.object({
  db_path: optionalNonEmptyString,
  ...corpusFilterInputSchema,
  startSeconds: finiteSeconds,
  endSeconds: finiteSeconds,
  limitExamples: z.number().int().positive().max(25).optional()
}).refine((value) => value.startSeconds <= value.endSeconds, {
  message: "startSeconds must be less than or equal to endSeconds",
  path: ["startSeconds"]
});

const getPlayerReplayCardInputSchema = z.object({
  db_path: optionalNonEmptyString,
  replayId: optionalNonEmptyString,
  filenameContains: optionalNonEmptyString,
  player: nonEmptyString,
  includeBuildAnchors: z.boolean().optional(),
  includeEconomyBenchmarks: z.boolean().optional(),
  includeCombatSummary: z.boolean().optional()
}).refine((value) => value.replayId !== undefined || value.filenameContains !== undefined, {
  message: "Provide replayId or filenameContains",
  path: ["replayId"]
});

const sqlParamSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
const schemaTopicSchema = z.enum(["all", "joins", "deaths", "timings", "unit_counts", "economy", "build_order", "paths"]);
const queryExampleTopicSchema = z.enum(["all", "players", "matchups", "build_timings", "event_sequences", "economy", "composition", "deaths", "replay_cards"]);

const describeSchemaInputSchema = z.object({
  db_path: optionalNonEmptyString,
  includeIndexes: z.boolean().optional(),
  includeSampleRows: z.boolean().optional(),
  includeJoinHints: z.boolean().optional()
});

const getSchemaNotesInputSchema = z.object({
  db_path: optionalNonEmptyString,
  topic: schemaTopicSchema.optional()
});

const listQueryExamplesInputSchema = z.object({
  db_path: optionalNonEmptyString,
  topic: queryExampleTopicSchema.optional(),
  limit: z.number().int().positive().max(50).optional()
});

const validateReadonlySqlInputSchema = z.object({
  db_path: optionalNonEmptyString,
  sql: nonEmptyString,
  maxRows: z.number().int().positive().max(500).optional()
});

const executeReadonlySqlInputSchema = z.object({
  db_path: optionalNonEmptyString,
  sql: nonEmptyString,
  params: z.array(sqlParamSchema).optional(),
  maxRows: z.number().int().positive().max(500).optional(),
  includeSchema: z.boolean().optional()
});

type ToolPayload = {
  count: number;
  results: unknown[];
};

type IngestCorpusPayload = {
  db_path: string;
  analysis_output_root: string;
  manifests_discovered: number;
  replays_ingested: number;
  players_inserted: number;
  batch_size: number;
  batches: IngestBatchSummary[];
  warnings: string[];
  errors: string[];
};

type ExecuteQueryPlanPayload = Awaited<ReturnType<typeof executeQueryPlan>>;
type ExportQueryPlanZipPayload = Awaited<ReturnType<typeof exportQueryPlanZip>>;
type ExecuteReadonlySqlPayload = {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
  maxRows: number;
  executionMs: number;
  warnings: string[];
  schema?: Array<{ name: string }>;
};
type StructuredContentRecord = Record<string, unknown>;
type ResourcePayload = StructuredContentRecord;
type CompatibilityUrl = Pick<URL, "searchParams" | "toString"> & { kind: string };

const RESOURCE_MIME_TYPE = "application/json";
const DEFAULT_RESOURCE_DB_ENV_VAR = "BW_REPLAY_DB_PATH";
const DEFAULT_RESOURCE_DB_FILENAME = "corpus.sqlite";

const SUPPORTED_TOOL_NAMES = [
  "server_info",
  "ingest_corpus",
  "describe_schema",
  "get_schema_notes",
  "list_query_examples",
  "validate_readonly_sql",
  "execute_readonly_sql",
  "get_corpus_summary",
  "list_players",
  "list_matchups",
  "list_build_items",
  "search_build_items",
  "list_unit_types",
  "get_event_timing_distribution",
  "count_replays_with_event_before_event",
  "get_composition_snapshot",
  "get_economy_distribution",
  "get_death_summary",
  "get_player_replay_card",
  "find_replays",
  "find_first_event",
  "list_build_events",
  "find_nth_event",
  "get_unit_count",
  "get_economy",
  "get_deaths",
  "execute_query_plan",
  "export_query_plan_zip"
] as const;

export function createReplayCorpusMcpServer(): McpServer {
  const serverInfo = loadServerInfo();
  const server = new McpServer({
    name: serverInfo.package_name,
    version: serverInfo.package_version
  });

  registerCompatibilityResources(server, serverInfo);
  server.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (!request.params.uri.startsWith("bw_replay://")) {
      throw new McpError(ErrorCode.InvalidParams, `Resource ${request.params.uri} not found`);
    }

    return await readCompatibilityResource(request.params.uri, serverInfo);
  });

  server.registerTool(
    "server_info",
    {
      description: "Return package/build metadata and the supported MCP tool surface for this server.",
      inputSchema: {}
    },
    async () =>
      runStructuredTool(async () => ({
        content: [
          {
            type: "text" as const,
            text: formatServerInfoText(serverInfo)
          }
        ],
        structuredContent: serverInfo as unknown as StructuredContentRecord
      }))
  );

  server.registerTool(
    "describe_schema",
    {
      description: "Return model-friendly schema documentation for the corpus database, including tables, columns, and join hints.",
      inputSchema: describeSchemaInputSchema.shape
    },
    async (args) =>
      runStructuredTool(async () => {
        const result = await withReadOnlyDb(resolveDbPathForAnalytics(args), (db) =>
          describeSchema(db, {
            ...(args.includeIndexes !== undefined ? { includeIndexes: args.includeIndexes } : {}),
            ...(args.includeSampleRows !== undefined ? { includeSampleRows: args.includeSampleRows } : {}),
            ...(args.includeJoinHints !== undefined ? { includeJoinHints: args.includeJoinHints } : {})
          })
        );
        return {
          content: [
            {
              type: "text" as const,
              text: formatDescribeSchemaText(result)
            }
          ],
          structuredContent: result as unknown as StructuredContentRecord
        };
      })
  );

  server.registerTool(
    "get_schema_notes",
    {
      description: "Return semantic notes and gotchas about the corpus schema that are not obvious from raw table definitions.",
      inputSchema: getSchemaNotesInputSchema.shape
    },
    async (args) =>
      runStructuredTool(async () => {
        const result = getSchemaNotes((args.topic ?? "all") as SchemaNotesTopic);
        return {
          content: [
            {
              type: "text" as const,
              text: formatSchemaNotesText(result)
            }
          ],
          structuredContent: result as unknown as StructuredContentRecord
        };
      })
  );

  server.registerTool(
    "list_query_examples",
    {
      description: "Return curated SQL query examples that can be copied and adapted for replay analytics questions.",
      inputSchema: listQueryExamplesInputSchema.shape
    },
    async (args) =>
      runStructuredTool(async () => {
        const result = listQueryExamples((args.topic ?? "all") as QueryExampleTopic, args.limit ?? 10);
        return {
          content: [
            {
              type: "text" as const,
              text: formatListQueryExamplesText(result)
            }
          ],
          structuredContent: result as unknown as StructuredContentRecord
        };
      })
  );

  server.registerTool(
    "validate_readonly_sql",
    {
      description: "Validate whether a SQL query is acceptable for bounded read-only execution against the corpus database.",
      inputSchema: validateReadonlySqlInputSchema.shape
    },
    async (args) =>
      runStructuredTool(async () => {
        const result = validateReadonlySql(args.sql, args.maxRows);
        return {
          content: [
            {
              type: "text" as const,
              text: formatValidateReadonlySqlText(result)
            }
          ],
          structuredContent: result as unknown as StructuredContentRecord
        };
      })
  );

  server.registerTool(
    "execute_readonly_sql",
    {
      description: "Execute a validated, bounded, read-only SQL query against the corpus database.",
      inputSchema: executeReadonlySqlInputSchema.shape
    },
    async (args) =>
      runStructuredTool(async () => {
        const result = await withReadOnlyDb(resolveDbPathForAnalytics(args), (db) =>
          executeReadonlySql(db, {
            sql: args.sql,
            params: normalizeSqlParams(args.params ?? []),
            ...(args.maxRows !== undefined ? { maxRows: args.maxRows } : {}),
            includeSchema: args.includeSchema ?? false
          })
        );
        return {
          content: [
            {
              type: "text" as const,
              text: formatExecuteReadonlySqlText(result)
            }
          ],
          structuredContent: result as unknown as StructuredContentRecord
        };
      })
  );

  server.registerTool(
    "ingest_corpus",
    {
      description: "Recursively discover replay-analysis manifests and ingest them into a SQLite corpus database.",
      inputSchema: {
        analysis_output_root: nonEmptyString,
        db_path: nonEmptyString,
        batch_size: positiveInteger.optional()
      }
    },
    async (args) =>
      runStructuredTool(async () => {
        const resolvedRoot = resolve(args.analysis_output_root);
        if (!existsSync(resolvedRoot)) {
          throw new Error(`Analysis output root not found: ${resolvedRoot}`);
        }

        const { db } = await openDatabase(args.db_path);
        try {
          ensureSchema(db);
          const result = await ingestAnalysisRoot(db, resolvedRoot, {
            ...(args.batch_size !== undefined ? { batchSize: args.batch_size } : {}),
            onBatchPersist: async () => {
              await saveDatabase(db, args.db_path);
            }
          });
          await saveDatabase(db, args.db_path);
          const summary: IngestCorpusPayload = {
            db_path: resolve(args.db_path),
            analysis_output_root: resolvedRoot,
            manifests_discovered: result.manifestsDiscovered,
            replays_ingested: result.replaysIngested,
            players_inserted: result.playersInserted,
            batch_size: result.batchSize,
            batches: result.batches,
            warnings: result.warnings,
            errors: result.errors
          };
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `Discovered ${summary.manifests_discovered} manifest` +
                  `${summary.manifests_discovered === 1 ? "" : "s"} and ingested ${summary.replays_ingested} replay` +
                  `${summary.replays_ingested === 1 ? "" : "s"} into ${summary.db_path} in ${summary.batches.length} batch` +
                  `${summary.batches.length === 1 ? "" : "es"} of up to ${summary.batch_size}.`
              }
            ],
            structuredContent: summary as unknown as StructuredContentRecord
          };
        } finally {
          const close = (db as { close?: () => void }).close;
          if (typeof close === "function") {
            close.call(db);
          }
        }
      })
  );

  server.registerTool(
    "get_corpus_summary",
    {
      description: "Return a compact overview of the loaded replay corpus, including replay counts, players, matchups, races, maps, and data availability.",
      inputSchema: discoveryInputSchema.shape
    },
    async (args) =>
      runStructuredTool(async () => {
        const summary = await withReadOnlyDb(resolveDbPathForAnalytics(args), (db) =>
          getCorpusSummary(db, {
            ...(args.player ? { player: args.player } : {}),
            ...(args.opponent ? { opponent: args.opponent } : {}),
            ...(args.race ? { race: args.race } : {}),
            ...(args.opponentRace ? { opponentRace: args.opponentRace } : {}),
            ...(args.matchup ? { matchup: args.matchup } : {}),
            ...(args.map ? { map: args.map } : {}),
            ...(args.replay_ids ? { replayIds: args.replay_ids } : {})
          })
        );
        return {
          content: [
            {
              type: "text" as const,
              text: formatCorpusSummaryText(summary)
            }
          ],
          structuredContent: summary as unknown as StructuredContentRecord
        };
      })
  );

  server.registerTool(
    "list_players",
    {
      description: "List known players in the corpus, with race and matchup distributions.",
      inputSchema: listPlayersInputSchema.shape
    },
    async (args) =>
      runStructuredTool(async () => {
        const result = await withReadOnlyDb(resolveDbPathForAnalytics(args), (db) =>
          listPlayers(db, {
            ...(args.player ? { player: args.player } : {}),
            ...(args.opponent ? { opponent: args.opponent } : {}),
            ...(args.race ? { race: args.race } : {}),
            ...(args.opponentRace ? { opponentRace: args.opponentRace } : {}),
            ...(args.matchup ? { matchup: args.matchup } : {}),
            ...(args.map ? { map: args.map } : {}),
            ...(args.replay_ids ? { replayIds: args.replay_ids } : {}),
            ...(args.limit !== undefined ? { limit: args.limit } : {})
          })
        );
        return {
          content: [
            {
              type: "text" as const,
              text: formatListPlayersText(result)
            }
          ],
          structuredContent: result as unknown as StructuredContentRecord
        };
      })
  );

  server.registerTool(
    "list_matchups",
    {
      description: "List matchup values present in the corpus under the given filters.",
      inputSchema: listMatchupsInputSchema.shape
    },
    async (args) =>
      runStructuredTool(async () => {
        const result = await withReadOnlyDb(resolveDbPathForAnalytics(args), (db) =>
          listMatchups(db, {
            ...(args.player ? { player: args.player } : {}),
            ...(args.opponent ? { opponent: args.opponent } : {}),
            ...(args.race ? { race: args.race } : {}),
            ...(args.opponentRace ? { opponentRace: args.opponentRace } : {}),
            ...(args.matchup ? { matchup: args.matchup } : {}),
            ...(args.map ? { map: args.map } : {}),
            ...(args.replay_ids ? { replayIds: args.replay_ids } : {}),
            ...(args.limit !== undefined ? { limit: args.limit } : {})
          })
        );
        return {
          content: [
            {
              type: "text" as const,
              text: formatListMatchupsText(result)
            }
          ],
          structuredContent: result as unknown as StructuredContentRecord
        };
      })
  );

  server.registerTool(
    "list_build_items",
    {
      description: "List build-order item names available in the filtered corpus, with occurrence and replay counts.",
      inputSchema: listBuildItemsInputSchema.shape
    },
    async (args) =>
      runStructuredTool(async () => {
        const result = await withReadOnlyDb(resolveDbPathForAnalytics(args), (db) =>
          listBuildItems(db, {
            ...(args.player ? { player: args.player } : {}),
            ...(args.opponent ? { opponent: args.opponent } : {}),
            ...(args.race ? { race: args.race } : {}),
            ...(args.opponentRace ? { opponentRace: args.opponentRace } : {}),
            ...(args.matchup ? { matchup: args.matchup } : {}),
            ...(args.map ? { map: args.map } : {}),
            ...(args.replay_ids ? { replayIds: args.replay_ids } : {}),
            ...(args.limit !== undefined ? { limit: args.limit } : {})
          })
        );
        return {
          content: [
            {
              type: "text" as const,
              text: formatListBuildItemsText(result)
            }
          ],
          structuredContent: result as unknown as StructuredContentRecord
        };
      })
  );

  server.registerTool(
    "search_build_items",
    {
      description: "Search build-order item names by case-insensitive substring match to help find valid query item names.",
      inputSchema: searchBuildItemsInputSchema.shape
    },
    async (args) =>
      runStructuredTool(async () => {
        const result = await withReadOnlyDb(resolveDbPathForAnalytics(args), (db) =>
          searchBuildItems(db, {
            query: args.query,
            ...(args.player ? { player: args.player } : {}),
            ...(args.opponent ? { opponent: args.opponent } : {}),
            ...(args.race ? { race: args.race } : {}),
            ...(args.opponentRace ? { opponentRace: args.opponentRace } : {}),
            ...(args.matchup ? { matchup: args.matchup } : {}),
            ...(args.map ? { map: args.map } : {}),
            ...(args.replay_ids ? { replayIds: args.replay_ids } : {}),
            ...(args.limit !== undefined ? { limit: args.limit } : {})
          })
        );
        return {
          content: [
            {
              type: "text" as const,
              text: formatSearchBuildItemsText(result)
            }
          ],
          structuredContent: result as unknown as StructuredContentRecord
        };
      })
  );

  server.registerTool(
    "list_unit_types",
    {
      description: "List unit names available in unit-count and death-event data for the filtered corpus.",
      inputSchema: listUnitTypesInputSchema.shape
    },
    async (args) =>
      runStructuredTool(async () => {
        const result = await withReadOnlyDb(resolveDbPathForAnalytics(args), (db) =>
          listUnitTypes(db, {
            ...(args.player ? { player: args.player } : {}),
            ...(args.opponent ? { opponent: args.opponent } : {}),
            ...(args.race ? { race: args.race } : {}),
            ...(args.opponentRace ? { opponentRace: args.opponentRace } : {}),
            ...(args.matchup ? { matchup: args.matchup } : {}),
            ...(args.map ? { map: args.map } : {}),
            ...(args.replay_ids ? { replayIds: args.replay_ids } : {}),
            ...(args.source ? { source: args.source } : {}),
            ...(args.limit !== undefined ? { limit: args.limit } : {})
          })
        );
        return {
          content: [
            {
              type: "text" as const,
              text: formatListUnitTypesText(result)
            }
          ],
          structuredContent: result as unknown as StructuredContentRecord
        };
      })
  );

  server.registerTool(
    "get_event_timing_distribution",
    {
      description: "Aggregate timing stats for the nth occurrence of a build-order event across the filtered corpus.",
      inputSchema: getEventTimingDistributionInputSchema.shape
    },
    async (args) =>
      runStructuredTool(async () => {
        const result = await withReadOnlyDb(resolveDbPathForAnalytics(args), (db) =>
          getEventTimingDistribution(db, {
            item: args.item,
            ...(args.player ? { player: args.player } : {}),
            ...(args.opponent ? { opponent: args.opponent } : {}),
            ...(args.race ? { race: args.race } : {}),
            ...(args.opponentRace ? { opponentRace: args.opponentRace } : {}),
            ...(args.matchup ? { matchup: args.matchup } : {}),
            ...(args.map ? { map: args.map } : {}),
            ...(args.replay_ids ? { replayIds: args.replay_ids } : {}),
            ...(args.n !== undefined ? { n: args.n } : {}),
            ...(args.startSeconds !== undefined ? { startSeconds: args.startSeconds } : {}),
            ...(args.endSeconds !== undefined ? { endSeconds: args.endSeconds } : {}),
            ...(args.limitExamples !== undefined ? { limitExamples: args.limitExamples } : {})
          })
        );
        return {
          content: [
            {
              type: "text" as const,
              text: formatEventTimingDistributionText(result)
            }
          ],
          structuredContent: result as unknown as StructuredContentRecord
        };
      })
  );

  server.registerTool(
    "count_replays_with_event_before_event",
    {
      description: "Count how often one build-order event occurs before another across the filtered corpus.",
      inputSchema: countReplaysWithEventBeforeEventInputSchema.shape
    },
    async (args) =>
      runStructuredTool(async () => {
        const result = await withReadOnlyDb(resolveDbPathForAnalytics(args), (db) =>
          countReplaysWithEventBeforeEvent(db, {
            firstItem: args.firstItem,
            secondItem: args.secondItem,
            ...(args.player ? { player: args.player } : {}),
            ...(args.opponent ? { opponent: args.opponent } : {}),
            ...(args.race ? { race: args.race } : {}),
            ...(args.opponentRace ? { opponentRace: args.opponentRace } : {}),
            ...(args.matchup ? { matchup: args.matchup } : {}),
            ...(args.map ? { map: args.map } : {}),
            ...(args.replay_ids ? { replayIds: args.replay_ids } : {}),
            ...(args.firstN !== undefined ? { firstN: args.firstN } : {}),
            ...(args.secondN !== undefined ? { secondN: args.secondN } : {}),
            ...(args.limitExamples !== undefined ? { limitExamples: args.limitExamples } : {})
          })
        );
        return {
          content: [
            {
              type: "text" as const,
              text: formatEventBeforeEventText(result)
            }
          ],
          structuredContent: result as unknown as StructuredContentRecord
        };
      })
  );

  server.registerTool(
    "get_composition_snapshot",
    {
      description: "Return aggregate unit-count distributions at or before a timestamp for the filtered corpus.",
      inputSchema: getCompositionSnapshotInputSchema.shape
    },
    async (args) =>
      runStructuredTool(async () => {
        const result = await withReadOnlyDb(resolveDbPathForAnalytics(args), (db) =>
          getCompositionSnapshot(db, {
            timeSeconds: args.timeSeconds,
            ...(args.player ? { player: args.player } : {}),
            ...(args.opponent ? { opponent: args.opponent } : {}),
            ...(args.race ? { race: args.race } : {}),
            ...(args.opponentRace ? { opponentRace: args.opponentRace } : {}),
            ...(args.matchup ? { matchup: args.matchup } : {}),
            ...(args.map ? { map: args.map } : {}),
            ...(args.replay_ids ? { replayIds: args.replay_ids } : {}),
            ...(args.units ? { units: args.units } : {}),
            ...(args.limitExamples !== undefined ? { limitExamples: args.limitExamples } : {})
          })
        );
        return {
          content: [
            {
              type: "text" as const,
              text: formatCompositionSnapshotText(result)
            }
          ],
          structuredContent: result as unknown as StructuredContentRecord
        };
      })
  );

  server.registerTool(
    "get_economy_distribution",
    {
      description: "Aggregate economy distributions at or before a timestamp for the filtered corpus.",
      inputSchema: getEconomyDistributionInputSchema.shape
    },
    async (args) =>
      runStructuredTool(async () => {
        const result = await withReadOnlyDb(resolveDbPathForAnalytics(args), (db) =>
          getEconomyDistribution(db, {
            timeSeconds: args.timeSeconds,
            ...(args.player ? { player: args.player } : {}),
            ...(args.opponent ? { opponent: args.opponent } : {}),
            ...(args.race ? { race: args.race } : {}),
            ...(args.opponentRace ? { opponentRace: args.opponentRace } : {}),
            ...(args.matchup ? { matchup: args.matchup } : {}),
            ...(args.map ? { map: args.map } : {}),
            ...(args.replay_ids ? { replayIds: args.replay_ids } : {}),
            ...(args.limitExamples !== undefined ? { limitExamples: args.limitExamples } : {})
          })
        );
        return {
          content: [
            {
              type: "text" as const,
              text: formatEconomyDistributionText(result)
            }
          ],
          structuredContent: result as unknown as StructuredContentRecord
        };
      })
  );

  server.registerTool(
    "get_death_summary",
    {
      description: "Aggregate lost and killed unit counts in a time window across the filtered corpus.",
      inputSchema: getDeathSummaryInputSchema.shape
    },
    async (args) =>
      runStructuredTool(async () => {
        const result = await withReadOnlyDb(resolveDbPathForAnalytics(args), (db) =>
          getDeathSummary(db, {
            startSeconds: args.startSeconds,
            endSeconds: args.endSeconds,
            ...(args.player ? { player: args.player } : {}),
            ...(args.opponent ? { opponent: args.opponent } : {}),
            ...(args.race ? { race: args.race } : {}),
            ...(args.opponentRace ? { opponentRace: args.opponentRace } : {}),
            ...(args.matchup ? { matchup: args.matchup } : {}),
            ...(args.map ? { map: args.map } : {}),
            ...(args.replay_ids ? { replayIds: args.replay_ids } : {}),
            ...(args.limitExamples !== undefined ? { limitExamples: args.limitExamples } : {})
          })
        );
        return {
          content: [
            {
              type: "text" as const,
              text: formatDeathSummaryText(result)
            }
          ],
          structuredContent: result as unknown as StructuredContentRecord
        };
      })
  );

  server.registerTool(
    "get_player_replay_card",
    {
      description: "Return a compact replay/player digest with build anchors, economy benchmarks, and a small combat summary.",
      inputSchema: getPlayerReplayCardInputSchema.shape
    },
    async (args) =>
      runStructuredTool(async () => {
        const result = await withReadOnlyDb(resolveDbPathForAnalytics(args), (db) =>
          getPlayerReplayCard(db, {
            player: args.player,
            ...(args.replayId ? { replayId: args.replayId } : {}),
            ...(args.filenameContains ? { filenameContains: args.filenameContains } : {}),
            ...(args.includeBuildAnchors !== undefined ? { includeBuildAnchors: args.includeBuildAnchors } : {}),
            ...(args.includeEconomyBenchmarks !== undefined ? { includeEconomyBenchmarks: args.includeEconomyBenchmarks } : {}),
            ...(args.includeCombatSummary !== undefined ? { includeCombatSummary: args.includeCombatSummary } : {})
          })
        );
        return {
          content: [
            {
              type: "text" as const,
              text: formatReplayCardText(result)
            }
          ],
          structuredContent: result as unknown as StructuredContentRecord
        };
      })
  );

  server.registerTool(
    "execute_query_plan",
    {
      description: "Validate and execute a query-planner-v1 replay-centric plan against an existing corpus SQLite database.",
      inputSchema: {
        db_path: optionalNonEmptyString,
        plan: z.unknown(),
        mode: z.enum(["normal", "debug"]).optional()
      }
    },
    async (args) =>
      runStructuredTool(async () => {
        const result = await executeQueryPlan({
          dbPath: resolveDbPathForAnalytics(args),
          plan: coercePlanArgument(args.plan),
          ...(args.mode ? { mode: args.mode } : {})
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `Executed plan over ${result.coarse_replay_ids.length} coarse replay${result.coarse_replay_ids.length === 1 ? "" : "s"} and returned ${result.replay_results.length} replay result${result.replay_results.length === 1 ? "" : "s"}.`
            }
          ],
          structuredContent: result as unknown as StructuredContentRecord
        };
      })
  );

  server.registerTool(
    "export_query_plan_zip",
    {
      description: "Validate and execute a query-planner-v1 plan, then package matched replay results and HTML artifacts into a ZIP file.",
      inputSchema: {
        db_path: optionalNonEmptyString,
        plan: z.unknown(),
        html_root: nonEmptyString,
        out_path: nonEmptyString,
        mode: z.enum(["normal", "debug"]).optional()
      }
    },
    async (args) =>
      runStructuredTool(async () => {
        const result = await exportQueryPlanZip({
          dbPath: resolveDbPathForAnalytics(args),
          plan: coercePlanArgument(args.plan) as QueryPlanV1,
          htmlRoot: args.html_root,
          outPath: args.out_path,
          ...(args.mode ? { mode: args.mode } : {})
        });
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Exported ZIP to ${result.out_path} with ${result.matched_count} matched replay` +
                `${result.matched_count === 1 ? "" : "s"} and ${result.html_files_added} HTML artifact` +
                `${result.html_files_added === 1 ? "" : "s"}.`
            }
          ],
          structuredContent: result as unknown as StructuredContentRecord
        };
      })
  );

  server.registerTool(
    "find_replays",
    {
      description: "Find replay records by matchup, player name, and player race.",
      inputSchema: findReplaysInputSchema
    },
    async (args) =>
      runToolQuery("find_replays", resolveDbPathForAnalytics(args), (db) =>
        findReplays(db, {
          ...(args.matchup ? { matchup: args.matchup } : {}),
          ...(args.player ? { player: args.player } : {}),
          ...(args.race ? { race: args.race } : {}),
          ...(args.replay_ids ? { replay_ids: args.replay_ids } : {})
        })
      )
  );

  server.registerTool(
    "find_first_event",
    {
      description: "Find the first matching build-order event for a player or enemy perspective.",
      inputSchema: findFirstEventInputSchema.shape
    },
    async (args) =>
      runToolQuery("find_first_event", resolveDbPathForAnalytics(args), (db) =>
        findFirstEvent(db, {
          player: args.player,
          item: args.item,
          ...(args.matchup ? { matchup: args.matchup } : {}),
          ...(args.race ? { race: args.race } : {}),
          ...(args.replay_ids ? { replay_ids: args.replay_ids } : {}),
          ...(args.as ? { as: args.as } : {})
        })
      )
  );

  server.registerTool(
    "list_build_events",
    {
      description: "List ordered build-order events for a player or enemy perspective, optionally filtered by item and time range.",
      inputSchema: listBuildEventsInputSchema.shape
    },
    async (args) =>
      runToolQuery("list_build_events", resolveDbPathForAnalytics(args), (db) =>
        listBuildEvents(db, {
          player: args.player,
          ...(args.matchup ? { matchup: args.matchup } : {}),
          ...(args.race ? { race: args.race } : {}),
          ...(args.replay_ids ? { replay_ids: args.replay_ids } : {}),
          ...(args.as ? { as: args.as } : {}),
          ...(args.item ? { item: args.item } : {}),
          ...(args.from_seconds !== undefined ? { from: args.from_seconds } : {}),
          ...(args.to_seconds !== undefined ? { to: args.to_seconds } : {})
        })
      )
  );

  server.registerTool(
    "find_nth_event",
    {
      description: "Find the nth matching build-order event per replay for a player or enemy perspective.",
      inputSchema: findNthEventInputSchema.shape
    },
    async (args) =>
      runToolQuery("find_nth_event", resolveDbPathForAnalytics(args), (db) =>
        findNthEvent(db, {
          player: args.player,
          item: args.item,
          n: args.n,
          ...(args.matchup ? { matchup: args.matchup } : {}),
          ...(args.race ? { race: args.race } : {}),
          ...(args.replay_ids ? { replay_ids: args.replay_ids } : {}),
          ...(args.as ? { as: args.as } : {})
        })
      )
  );

  server.registerTool(
    "get_unit_count",
    {
      description: "Get the latest unit-count sample at or before a timestamp.",
      inputSchema: getUnitCountInputSchema.shape
    },
    async (args) =>
      runToolQuery("get_unit_count", resolveDbPathForAnalytics(args), (db) =>
        getUnitCountAtOrBefore(db, {
          player: args.player,
          unit: args.unit,
          at: args.at_seconds,
          ...(args.matchup ? { matchup: args.matchup } : {}),
          ...(args.race ? { race: args.race } : {}),
          ...(args.replay_ids ? { replay_ids: args.replay_ids } : {}),
          ...(args.as ? { as: args.as } : {})
        })
      )
  );

  server.registerTool(
    "get_economy",
    {
      description: "Get the latest economy sample at or before a timestamp.",
      inputSchema: getEconomyInputSchema.shape
    },
    async (args) =>
      runToolQuery("get_economy", resolveDbPathForAnalytics(args), (db) =>
        getEconomyAtOrBefore(db, {
          player: args.player,
          at: args.at_seconds,
          ...(args.matchup ? { matchup: args.matchup } : {}),
          ...(args.race ? { race: args.race } : {}),
          ...(args.replay_ids ? { replay_ids: args.replay_ids } : {}),
          ...(args.as ? { as: args.as } : {})
        })
      )
  );

  server.registerTool(
    "get_deaths",
    {
      description: "Get death events between two timestamps for a player or enemy perspective.",
      inputSchema: getDeathsInputSchema
    },
    async (args) =>
      runToolQuery("get_deaths", resolveDbPathForAnalytics(args), (db) =>
        getDeathsBetween(db, {
          player: args.player,
          from: args.from_seconds,
          to: args.to_seconds,
          ...(args.matchup ? { matchup: args.matchup } : {}),
          ...(args.race ? { race: args.race } : {}),
          ...(args.replay_ids ? { replay_ids: args.replay_ids } : {}),
          ...(args.as ? { as: args.as } : {})
        })
      )
  );

  return server;
}

function registerCompatibilityResources(
  server: McpServer,
  serverInfo: ReturnType<typeof loadServerInfo>
): void {
  server.registerResource(
    "server_info_resource",
    "bw_replay://server_info",
    {
      title: "Server Info",
      description: "Read-only compatibility resource equivalent to the server_info MCP tool.",
      mimeType: RESOURCE_MIME_TYPE
    },
    async (uri) => await readCompatibilityResource(uri.toString(), serverInfo)
  );

  server.registerResource(
    "find_replays_resource",
    new ResourceTemplate("bw_replay://find_replays{?db_path,player,matchup,race,replay,replay_id,replay_ids}", {
      list: undefined
    }),
    {
      title: "Find Replays",
      description:
        "Read-only compatibility resource equivalent to find_replays. Query params: player, matchup, race, replay/replay_id/replay_ids, optional db_path.",
      mimeType: RESOURCE_MIME_TYPE
    },
    async (uri) => await readCompatibilityResource(uri.toString(), serverInfo)
  );

  server.registerResource(
    "build_events_resource",
    new ResourceTemplate("bw_replay://build_events{?db_path,replay,replay_id,replay_ids,player,matchup,race,as,item,start,end}", {
      list: undefined
    }),
    {
      title: "Build Events",
      description:
        "Read-only compatibility resource equivalent to list_build_events. Query params: player, replay/replay_id/replay_ids, matchup, race, as, item, start, end, optional db_path.",
      mimeType: RESOURCE_MIME_TYPE
    },
    async (uri) => await readCompatibilityResource(uri.toString(), serverInfo)
  );

  server.registerResource(
    "deaths_resource",
    new ResourceTemplate("bw_replay://deaths{?db_path,replay,replay_id,replay_ids,player,matchup,race,as,start,end}", {
      list: undefined
    }),
    {
      title: "Deaths",
      description:
        "Read-only compatibility resource equivalent to get_deaths. Query params: player, replay/replay_id/replay_ids, matchup, race, as, start, end, optional db_path.",
      mimeType: RESOURCE_MIME_TYPE
    },
    async (uri) => await readCompatibilityResource(uri.toString(), serverInfo)
  );

  server.registerResource(
    "economy_resource",
    new ResourceTemplate("bw_replay://economy{?db_path,replay,replay_id,replay_ids,player,matchup,race,as,time}", {
      list: undefined
    }),
    {
      title: "Economy",
      description:
        "Read-only compatibility resource equivalent to get_economy. Query params: player, replay/replay_id/replay_ids, matchup, race, as, time, optional db_path.",
      mimeType: RESOURCE_MIME_TYPE
    },
    async (uri) => await readCompatibilityResource(uri.toString(), serverInfo)
  );

  server.registerResource(
    "unit_count_resource",
    new ResourceTemplate("bw_replay://unit_count{?db_path,replay,replay_id,replay_ids,player,matchup,race,as,unit,time}", {
      list: undefined
    }),
    {
      title: "Unit Count",
      description:
        "Read-only compatibility resource equivalent to get_unit_count. Query params: player, unit, time, replay/replay_id/replay_ids, matchup, race, as, optional db_path.",
      mimeType: RESOURCE_MIME_TYPE
    },
    async (uri) => await readCompatibilityResource(uri.toString(), serverInfo)
  );

  server.registerResource(
    "first_event_resource",
    new ResourceTemplate("bw_replay://first_event{?db_path,replay,replay_id,replay_ids,player,matchup,race,as,event}", {
      list: undefined
    }),
    {
      title: "First Event",
      description:
        "Read-only compatibility resource equivalent to find_first_event. Query params: player, event, replay/replay_id/replay_ids, matchup, race, as, optional db_path.",
      mimeType: RESOURCE_MIME_TYPE
    },
    async (uri) => await readCompatibilityResource(uri.toString(), serverInfo)
  );

  server.registerResource(
    "nth_event_resource",
    new ResourceTemplate("bw_replay://nth_event{?db_path,replay,replay_id,replay_ids,player,matchup,race,as,event,n}", {
      list: undefined
    }),
    {
      title: "Nth Event",
      description:
        "Read-only compatibility resource equivalent to find_nth_event. Query params: player, event, n, replay/replay_id/replay_ids, matchup, race, as, optional db_path.",
      mimeType: RESOURCE_MIME_TYPE
    },
    async (uri) => await readCompatibilityResource(uri.toString(), serverInfo)
  );
}

async function readCompatibilityResource(
  rawUri: string,
  serverInfo: ReturnType<typeof loadServerInfo>
): Promise<{
  contents: Array<{ uri: string; mimeType: string; text: string }>;
}> {
  const uri = parseCompatibilityResourceUri(rawUri);
  if (!uri) {
    throw new McpError(ErrorCode.InvalidParams, `Resource ${rawUri} not found`);
  }

  switch (uri.kind) {
    case "server_info":
      return await runResourceQuery(uri, async () => serverInfo as unknown as ResourcePayload);
    case "find_replays":
      return await runResourceQuery(uri, async () => {
        const dbPath = resolveResourceDbPath(uri);
        const args = z.object({
          db_path: resourceOptionalDbPathSchema,
          matchup: optionalNonEmptyString,
          player: optionalNonEmptyString,
          race: optionalNonEmptyString,
          replay_ids: replayIdsSchema
        }).parse({
          db_path: dbPath,
          matchup: getOptionalStringQueryParam(uri, "matchup"),
          player: getOptionalStringQueryParam(uri, "player"),
          race: getOptionalStringQueryParam(uri, "race"),
          replay_ids: getOptionalReplayIdsQueryParam(uri)
        });

        return await executeReadOnlyQuery(dbPath, (db) =>
          findReplays(db, {
            ...(args.matchup ? { matchup: args.matchup } : {}),
            ...(args.player ? { player: args.player } : {}),
            ...(args.race ? { race: args.race } : {}),
            ...(args.replay_ids ? { replay_ids: args.replay_ids } : {})
          })
        );
      });
    case "build_events":
      return await runResourceQuery(uri, async () => {
        const dbPath = resolveResourceDbPath(uri);
        const args = listBuildEventsInputSchema.parse({
          db_path: dbPath,
          player: requireStringQueryParam(uri, "player"),
          matchup: getOptionalStringQueryParam(uri, "matchup"),
          race: getOptionalStringQueryParam(uri, "race"),
          replay_ids: getOptionalReplayIdsQueryParam(uri),
          as: getOptionalStringQueryParam(uri, "as"),
          item: getOptionalStringQueryParam(uri, "item"),
          from_seconds: getOptionalNumberQueryParam(uri, "start", "from", "from_seconds"),
          to_seconds: getOptionalNumberQueryParam(uri, "end", "to", "to_seconds")
        });

        return await executeReadOnlyQuery(dbPath, (db) =>
          listBuildEvents(db, {
            player: args.player,
            ...(args.matchup ? { matchup: args.matchup } : {}),
            ...(args.race ? { race: args.race } : {}),
            ...(args.replay_ids ? { replay_ids: args.replay_ids } : {}),
            ...(args.as ? { as: args.as } : {}),
            ...(args.item ? { item: args.item } : {}),
            ...(args.from_seconds !== undefined ? { from: args.from_seconds } : {}),
            ...(args.to_seconds !== undefined ? { to: args.to_seconds } : {})
          })
        );
      });
    case "deaths":
      return await runResourceQuery(uri, async () => {
        const dbPath = resolveResourceDbPath(uri);
        const args = getDeathsInputSchema.parse({
          db_path: dbPath,
          player: requireStringQueryParam(uri, "player"),
          from_seconds: requireNumberQueryParam(uri, "start", "from", "from_seconds"),
          to_seconds: requireNumberQueryParam(uri, "end", "to", "to_seconds"),
          matchup: getOptionalStringQueryParam(uri, "matchup"),
          race: getOptionalStringQueryParam(uri, "race"),
          replay_ids: getOptionalReplayIdsQueryParam(uri),
          as: getOptionalStringQueryParam(uri, "as")
        });

        return await executeReadOnlyQuery(dbPath, (db) =>
          getDeathsBetween(db, {
            player: args.player,
            from: args.from_seconds,
            to: args.to_seconds,
            ...(args.matchup ? { matchup: args.matchup } : {}),
            ...(args.race ? { race: args.race } : {}),
            ...(args.replay_ids ? { replay_ids: args.replay_ids } : {}),
            ...(args.as ? { as: args.as } : {})
          })
        );
      });
    case "economy":
      return await runResourceQuery(uri, async () => {
        const dbPath = resolveResourceDbPath(uri);
        const args = getEconomyInputSchema.parse({
          db_path: dbPath,
          player: requireStringQueryParam(uri, "player"),
          at_seconds: requireNumberQueryParam(uri, "time", "at", "at_seconds"),
          matchup: getOptionalStringQueryParam(uri, "matchup"),
          race: getOptionalStringQueryParam(uri, "race"),
          replay_ids: getOptionalReplayIdsQueryParam(uri),
          as: getOptionalStringQueryParam(uri, "as")
        });

        return await executeReadOnlyQuery(dbPath, (db) =>
          getEconomyAtOrBefore(db, {
            player: args.player,
            at: args.at_seconds,
            ...(args.matchup ? { matchup: args.matchup } : {}),
            ...(args.race ? { race: args.race } : {}),
            ...(args.replay_ids ? { replay_ids: args.replay_ids } : {}),
            ...(args.as ? { as: args.as } : {})
          })
        );
      });
    case "unit_count":
      return await runResourceQuery(uri, async () => {
        const dbPath = resolveResourceDbPath(uri);
        const args = getUnitCountInputSchema.parse({
          db_path: dbPath,
          player: requireStringQueryParam(uri, "player"),
          unit: requireStringQueryParam(uri, "unit"),
          at_seconds: requireNumberQueryParam(uri, "time", "at", "at_seconds"),
          matchup: getOptionalStringQueryParam(uri, "matchup"),
          race: getOptionalStringQueryParam(uri, "race"),
          replay_ids: getOptionalReplayIdsQueryParam(uri),
          as: getOptionalStringQueryParam(uri, "as")
        });

        return await executeReadOnlyQuery(dbPath, (db) =>
          getUnitCountAtOrBefore(db, {
            player: args.player,
            unit: args.unit,
            at: args.at_seconds,
            ...(args.matchup ? { matchup: args.matchup } : {}),
            ...(args.race ? { race: args.race } : {}),
            ...(args.replay_ids ? { replay_ids: args.replay_ids } : {}),
            ...(args.as ? { as: args.as } : {})
          })
        );
      });
    case "first_event":
      return await runResourceQuery(uri, async () => {
        const dbPath = resolveResourceDbPath(uri);
        const args = findFirstEventInputSchema.parse({
          db_path: dbPath,
          player: requireStringQueryParam(uri, "player"),
          item: requireStringQueryParam(uri, "event", "item"),
          matchup: getOptionalStringQueryParam(uri, "matchup"),
          race: getOptionalStringQueryParam(uri, "race"),
          replay_ids: getOptionalReplayIdsQueryParam(uri),
          as: getOptionalStringQueryParam(uri, "as")
        });

        return await executeReadOnlyQuery(dbPath, (db) =>
          findFirstEvent(db, {
            player: args.player,
            item: args.item,
            ...(args.matchup ? { matchup: args.matchup } : {}),
            ...(args.race ? { race: args.race } : {}),
            ...(args.replay_ids ? { replay_ids: args.replay_ids } : {}),
            ...(args.as ? { as: args.as } : {})
          })
        );
      });
    case "nth_event":
      return await runResourceQuery(uri, async () => {
        const dbPath = resolveResourceDbPath(uri);
        const args = findNthEventInputSchema.parse({
          db_path: dbPath,
          player: requireStringQueryParam(uri, "player"),
          item: requireStringQueryParam(uri, "event", "item"),
          n: requireIntegerQueryParam(uri, "n"),
          matchup: getOptionalStringQueryParam(uri, "matchup"),
          race: getOptionalStringQueryParam(uri, "race"),
          replay_ids: getOptionalReplayIdsQueryParam(uri),
          as: getOptionalStringQueryParam(uri, "as")
        });

        return await executeReadOnlyQuery(dbPath, (db) =>
          findNthEvent(db, {
            player: args.player,
            item: args.item,
            n: args.n,
            ...(args.matchup ? { matchup: args.matchup } : {}),
            ...(args.race ? { race: args.race } : {}),
            ...(args.replay_ids ? { replay_ids: args.replay_ids } : {}),
            ...(args.as ? { as: args.as } : {})
          })
        );
      });
    default:
      throw new McpError(ErrorCode.InvalidParams, `Resource ${rawUri} not found`);
  }
}

function parseCompatibilityResourceUri(rawUri: string): CompatibilityUrl | null {
  const match = /^bw_replay:\/\/([^?]+)(?:\?(.*))?$/u.exec(rawUri);
  if (!match) {
    return null;
  }

  const kind = match[1];
  if (!kind) {
    return null;
  }

  return {
    kind,
    searchParams: new URLSearchParams(match[2] ?? ""),
    toString: () => rawUri
  };
}

async function runToolQuery(
  toolName: string,
  dbPath: string,
  query: (db: Database) => unknown[]
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  structuredContent: StructuredContentRecord;
  isError?: boolean;
}> {
  return runStructuredTool(async () => {
    const resolvedPath = resolve(dbPath);
    if (!existsSync(resolvedPath)) {
      throw new Error(`Database file not found: ${resolvedPath}`);
    }

    const { db } = await openDatabase(resolvedPath, { readOnly: true, timeoutMs: 3000 });
    try {
      assertCorpusSchema(db);
      const results = query(db);
      return {
        content: [
          {
            type: "text" as const,
            text: formatPrimitiveToolText(toolName, {
              count: results.length,
              results
            })
          }
        ],
        structuredContent: {
          count: results.length,
          results
        } as StructuredContentRecord
      };
    } finally {
      const close = (db as { close?: () => void }).close;
      if (typeof close === "function") {
        close.call(db);
      }
    }
  });
}

async function withReadOnlyDb<T>(dbPath: string, query: (db: Database) => T | Promise<T>): Promise<T> {
  const resolvedPath = resolve(dbPath);
  if (!existsSync(resolvedPath)) {
    throw new Error(`Database file not found: ${resolvedPath}`);
  }

  const { db } = await openDatabase(resolvedPath, { readOnly: true, timeoutMs: 3000 });
  try {
    assertCorpusSchema(db);
    return await query(db);
  } finally {
    const close = (db as { close?: () => void }).close;
    if (typeof close === "function") {
      close.call(db);
    }
  }
}

function resolveDbPathForAnalytics(args: { db_path?: string | undefined }): string {
  if (args.db_path) {
    return args.db_path;
  }

  const envDbPath = process.env[DEFAULT_RESOURCE_DB_ENV_VAR]?.trim();
  if (envDbPath) {
    return envDbPath;
  }

  const defaultDbPath = resolve(DEFAULT_RESOURCE_DB_FILENAME);
  if (existsSync(defaultDbPath)) {
    return defaultDbPath;
  }

  throw new Error(
    `No corpus database was resolved. Provide db_path, set ${DEFAULT_RESOURCE_DB_ENV_VAR}, or place ${DEFAULT_RESOURCE_DB_FILENAME} in ${process.cwd()}.`
  );
}

function executeReadonlySql(
  db: Database,
  args: {
    sql: string;
    params: Array<string | number | null>;
    maxRows?: number;
    includeSchema: boolean;
  }
): ExecuteReadonlySqlPayload {
  const plan = buildReadonlySqlExecutionPlan(args.sql, args.maxRows);
  const statement = db.prepare(plan.normalizedSql);
  const startedAt = Date.now();

  try {
    statement.bind(args.params);
    const rows: unknown[][] = [];
    let columns: string[] = [];
    let truncated = false;

    while (statement.step()) {
      const rowObject = statement.getAsObject();
      if (columns.length === 0) {
        columns = Object.keys(rowObject);
      }

      if (rows.length < plan.effectiveMaxRows) {
        rows.push(columns.map((column) => rowObject[column] ?? null));
      } else {
        truncated = true;
        break;
      }
    }

    return {
      columns,
      rows,
      rowCount: rows.length,
      truncated,
      maxRows: plan.effectiveMaxRows,
      executionMs: Date.now() - startedAt,
      warnings: plan.warnings,
      ...(args.includeSchema ? { schema: columns.map((name) => ({ name })) } : {})
    };
  } finally {
    statement.free();
  }
}

function normalizeSqlParams(params: Array<string | number | boolean | null>): Array<string | number | null> {
  return params.map((value) => {
    if (typeof value === "boolean") {
      return value ? 1 : 0;
    }
    return value;
  });
}

async function runResourceQuery(
  uri: CompatibilityUrl,
  action: () => Promise<ResourcePayload>
): Promise<{
  contents: Array<{ uri: string; mimeType: string; text: string }>;
}> {
  try {
    return createJsonResource(uri, await action());
  } catch (error) {
    if (error instanceof McpError) {
      throw error;
    }

    if (error instanceof z.ZodError) {
      throw new McpError(ErrorCode.InvalidParams, formatZodError(error));
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new McpError(ErrorCode.InternalError, message);
  }
}

async function executeReadOnlyQuery(
  dbPath: string,
  query: (db: Database) => unknown[]
): Promise<ResourcePayload> {
  const resolvedPath = resolve(dbPath);
  if (!existsSync(resolvedPath)) {
    throw new McpError(ErrorCode.InvalidParams, `Database file not found: ${resolvedPath}`);
  }

  const { db } = await openDatabase(resolvedPath, { readOnly: true, timeoutMs: 3000 });
  try {
    assertCorpusSchema(db);
    const results = query(db);
    return {
      count: results.length,
      results
    };
  } finally {
    const close = (db as { close?: () => void }).close;
    if (typeof close === "function") {
      close.call(db);
    }
  }
}

function createJsonResource(
  uri: CompatibilityUrl,
  payload: ResourcePayload
): {
  contents: Array<{ uri: string; mimeType: string; text: string }>;
} {
  return {
    contents: [
      {
        uri: uri.toString(),
        mimeType: RESOURCE_MIME_TYPE,
        text: JSON.stringify(payload, null, 2)
      }
    ]
  };
}

function resolveResourceDbPath(uri: CompatibilityUrl): string {
  const explicitDbPath = getOptionalStringQueryParam(uri, "db_path");
  if (explicitDbPath) {
    return explicitDbPath;
  }

  const envDbPath = process.env[DEFAULT_RESOURCE_DB_ENV_VAR]?.trim();
  if (envDbPath) {
    return envDbPath;
  }

  const defaultDbPath = resolve(DEFAULT_RESOURCE_DB_FILENAME);
  if (existsSync(defaultDbPath)) {
    return defaultDbPath;
  }

  throw new McpError(
    ErrorCode.InvalidParams,
    `No corpus database was resolved for ${uri.toString()}. Provide ?db_path=..., set ${DEFAULT_RESOURCE_DB_ENV_VAR}, or place ${DEFAULT_RESOURCE_DB_FILENAME} in ${process.cwd()}.`
  );
}

function getOptionalReplayIdsQueryParam(uri: CompatibilityUrl): string[] | undefined {
  const values = [
    ...getAllTrimmedQueryParamValues(uri, "replay"),
    ...getAllTrimmedQueryParamValues(uri, "replay_id"),
    ...getAllTrimmedQueryParamValues(uri, "replay_ids").flatMap((value) =>
      value.split(",").map((part) => part.trim()).filter(Boolean)
    )
  ];

  if (values.length === 0) {
    return undefined;
  }

  return [...new Set(values)];
}

function getOptionalStringQueryParam(uri: CompatibilityUrl, ...names: string[]): string | undefined {
  for (const name of names) {
    const values = getAllTrimmedQueryParamValues(uri, name);
    if (values.length > 0) {
      return values[0];
    }
  }

  return undefined;
}

function requireStringQueryParam(uri: CompatibilityUrl, ...names: string[]): string {
  const value = getOptionalStringQueryParam(uri, ...names);
  if (!value) {
    throw new McpError(ErrorCode.InvalidParams, `Missing required query parameter: ${names[0]}`);
  }

  return value;
}

function getOptionalNumberQueryParam(uri: CompatibilityUrl, ...names: string[]): number | undefined {
  const rawValue = getOptionalStringQueryParam(uri, ...names);
  if (rawValue === undefined) {
    return undefined;
  }

  const numericValue = Number(rawValue);
  if (!Number.isFinite(numericValue)) {
    throw new McpError(ErrorCode.InvalidParams, `Query parameter "${names[0]}" must be a finite number.`);
  }

  return numericValue;
}

function requireNumberQueryParam(uri: CompatibilityUrl, ...names: string[]): number {
  const numericValue = getOptionalNumberQueryParam(uri, ...names);
  if (numericValue === undefined) {
    throw new McpError(ErrorCode.InvalidParams, `Missing required query parameter: ${names[0]}`);
  }

  return numericValue;
}

function requireIntegerQueryParam(uri: CompatibilityUrl, ...names: string[]): number {
  const numericValue = requireNumberQueryParam(uri, ...names);
  if (!Number.isInteger(numericValue)) {
    throw new McpError(ErrorCode.InvalidParams, `Query parameter "${names[0]}" must be an integer.`);
  }

  return numericValue;
}

function getAllTrimmedQueryParamValues(uri: CompatibilityUrl, name: string): string[] {
  return uri.searchParams
    .getAll(name)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "input";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

async function runStructuredTool<T extends ToolPayload | IngestCorpusPayload | ExecuteQueryPlanPayload | ExportQueryPlanZipPayload>(
  action: () => Promise<{
    content: Array<{ type: "text"; text: string }>;
    structuredContent: StructuredContentRecord;
  }>
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  structuredContent: StructuredContentRecord;
  isError?: boolean;
}> {
  try {
    return await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: "text",
          text: message
        }
      ],
      structuredContent: {
        error: {
          message
        }
      } as StructuredContentRecord,
      isError: true
    };
  }
}

function coercePlanArgument(plan: unknown): unknown {
  if (typeof plan !== "string") {
    return plan;
  }

  try {
    return JSON.parse(plan);
  } catch (error) {
    throw new Error(`Invalid plan JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function loadServerInfo(): {
  package_name: string;
  package_version: string;
  build_timestamp: string | null;
  supported_tools: string[];
  current_working_directory: string;
  node_version: string;
} {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const packageJsonPath = resolve(moduleDir, "..", "..", "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    name?: string;
    version?: string;
  };

  let buildTimestamp: string | null = null;
  const buildInfoPath = resolve(moduleDir, "..", "build-info.json");
  if (existsSync(buildInfoPath)) {
    const buildInfo = JSON.parse(readFileSync(buildInfoPath, "utf8")) as { build_timestamp?: unknown };
    buildTimestamp = typeof buildInfo.build_timestamp === "string" ? buildInfo.build_timestamp : null;
  }

  return {
    package_name: packageJson.name ?? "unknown-package",
    package_version: packageJson.version ?? "0.0.0",
    build_timestamp: buildTimestamp,
    supported_tools: [...SUPPORTED_TOOL_NAMES],
    current_working_directory: process.cwd(),
    node_version: process.version
  };
}

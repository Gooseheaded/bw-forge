import { createHash } from "node:crypto";

/** Privacy-safe structured event normalization for operator diagnostics.
 * Unknown fields are dropped rather than stringified: this is deliberate because
 * model/tool values, exception messages, paths and replay identities are untrusted.
 */
export type SafeEvent = Record<string, string | number | boolean | null | string[]>;
export type SafeEventSink = (event: SafeEvent) => void;
export type SafeLoggerOptions = { diagnostic?: boolean; provider?: string; model?: string; corpusIds?: readonly string[] };

const EVENTS = new Set([
  "turn_started", "turn_completed", "turn_failed", "provider_request", "provider_retry",
  "tool_call_started", "tool_call_completed", "tool_call_failed", "tool_call_rejected",
  "upload_accepted", "upload_failed", "replay_validated", "replay_enqueued", "ingestion_retry",
  "upload_recovery_retry", "job_observed", "job_observation_retry", "report_delivered",
  "report_delivery_retry", "failure_notification_retry", "replay_ingestion_failed",
  "corpus_configuration_failed", "bot_storage_failed", "discord_connection_failed", "shutdown_failed",
  "coordinator_retry", "mcp_unavailable", "mcp_process_closed", "unknown_event",
]);
const TOOLS = new Set([
  "get_economy", "get_economy_distribution", "get_unit_count", "get_deaths", "list_build_events",
  "get_event_timing_distribution", "get_composition_snapshot", "get_corpus_summary", "list_players",
  "list_matchups", "list_build_items", "count_replays_with_event_before_event", "get_death_summary",
  "get_player_replay_card",
]);
const CODES = new Set([
  "UNKNOWN", "network", "timeout", "rate_limit", "invalid_request", "provider_error", "mcp_tool_error", "unknown_player_group", "unknown_query_scope", "replay_player_not_found",
  "MCP_TIMEOUT", "MCP_CANCELLED", "MCP_PROCESS_CLOSED", "http_400", "http_408", "http_409", "http_429", "http_500", "http_502", "http_503", "http_504", "oversized_response", "invalid_response", "cancelled", "provider_failed", "SQLITE_BUSY", "SQLITE_CORRUPT", "SQLITE_NOTADB",
  "SQLITE_CANTOPEN", "SQLITE_IOERR", "SQLITE_ERROR", "SQLITE_CONSTRAINT", "REPLAY_STAGING_INVALID",
  "SQLITE_OPEN_OR_MIGRATION",
]);
const ARG_KEYS = new Set(["corpus_id", "timeSeconds", "race", "opponentRace", "matchup", "replay_number", "at_seconds", "player"]);
const ARG_KINDS = new Set(["null", "empty_string", "string", "number", "boolean", "array", "object"]);
const ID_KEYS = new Set(["turnId", "sessionId", "messageId", "toolCallId", "uploadId", "jobId", "correlationId"]);
const NUM_KEYS = new Set(["durationMs", "attempt", "attempts", "totalTokens", "inputTokens", "outputTokens", "toolCalls", "retryCount", "resultBytes", "accepted", "rejected", "estimatedCostMicros"]);
const EVENT_ALIASES: Record<string, string> = {
  "turn started": "turn_started", "turn completed": "turn_completed", "turn failed": "turn_failed",
  "analytical tool call completed": "tool_call_completed", "analytical tool call failed": "tool_call_failed",
  "analytical tool call rejected": "tool_call_rejected", "tool argument diagnostic": "tool_call_started",
  "analytical MCP unavailable; using conversation-only mode": "mcp_unavailable",
  "some analytical corpora are unavailable": "mcp_unavailable", "configured model rejected tool calling; using conversation-only mode": "provider_request",
  "failure notification could not be delivered": "failure_notification_retry", "response delivery retry limit exceeded": "report_delivery_retry",
  "session pump failed": "turn_failed", "queue inspection failed": "turn_failed",
};

function boundedId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(value) ? value : undefined;
}
function correlationId(value: unknown): string | undefined {
  const raw = typeof value === "string" ? value : undefined;
  if (!raw || raw.length > 256) return undefined;
  return `ref-${createHash("sha256").update(raw).digest("hex").slice(0, 16)}`;
}
function boundedLabel(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 120 && /^[A-Za-z0-9._:/-]+$/.test(value) ? value : undefined;
}
function boundedNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1_000_000_000 ? value : undefined;
}

export function sanitizeEvent(event: string, details: Record<string, unknown> = {}, options: SafeLoggerOptions | boolean = {}): SafeEvent {
  const config: SafeLoggerOptions = typeof options === "boolean" ? { diagnostic: options } : options;
  const diagnostic = config.diagnostic === true;
  const rawName = typeof details.event === "string" ? details.event : event;
  const name = EVENTS.has(rawName) ? rawName : EVENT_ALIASES[rawName] ?? "unknown_event";
  const safe: SafeEvent = { event: name };
  for (const key of ID_KEYS) {
    const value = key === "toolCallId" ? correlationId(details[key]) : boundedId(details[key]);
    if (value !== undefined) safe[key] = value;
  }
  for (const key of NUM_KEYS) { const value = boundedNumber(details[key]); if (value !== undefined) safe[key] = value; }
  if (typeof details.retryable === "boolean") safe.retryable = details.retryable;
  if (typeof details.success === "boolean") safe.success = details.success;
  if (typeof details.replayIdentityPresent === "boolean") safe.replayIdentityPresent = details.replayIdentityPresent;
  for (const key of ["provider", "model", "corpusId", "mcpErrorCode", "code", "status"]) {
    const value = boundedLabel(details[key]);
    if (value === undefined) continue;
    if (key === "code" || key === "mcpErrorCode") { if (CODES.has(value)) safe[key] = value; }
    else if (key === "provider" && (!config.provider || value === config.provider)) safe[key] = value;
    else if (key === "model" && (!config.model || value === config.model)) safe[key] = value;
    else if (key === "corpusId" && (!config.corpusIds || config.corpusIds.includes(value))) safe[key] = value;
    else if (key === "status") safe[key] = value;
  }
  if (typeof details.budgetExhausted === "boolean") safe.budgetExhausted = details.budgetExhausted;
  if (typeof details.tool === "string" && TOOLS.has(details.tool)) safe.tool = details.tool;
  if (diagnostic && Array.isArray(details.argumentKeys)) {
    const keys = details.argumentKeys.filter((value): value is string => typeof value === "string" && ARG_KEYS.has(value));
    if (keys.length) safe.argumentKeys = [...new Set(keys)];
  }
  if (diagnostic && details.argumentValueKinds && typeof details.argumentValueKinds === "object") {
    const kinds: string[] = [];
    for (const [key, value] of Object.entries(details.argumentValueKinds as Record<string, unknown>)) {
      if (ARG_KEYS.has(key) && typeof value === "string" && ARG_KINDS.has(value)) kinds.push(value);
    }
    if (kinds.length) safe.argumentKinds = [...new Set(kinds)];
  }
  if (diagnostic && Array.isArray(details.argumentKinds)) {
    const kinds = details.argumentKinds.filter((value): value is string => typeof value === "string" && ARG_KINDS.has(value));
    if (kinds.length) safe.argumentKinds = [...new Set(kinds)];
  }
  return safe;
}

export function createSafeLogger(sink: SafeEventSink, options: SafeLoggerOptions | boolean = {}): (event: string, details?: Record<string, unknown>) => void {
  return (event, details = {}) => sink(sanitizeEvent(event, details, options));
}

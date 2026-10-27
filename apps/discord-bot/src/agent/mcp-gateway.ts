import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export type CorpusReplayRef = { corpusId: string; replaySha256: string; replayNumber?: number };
export type McpTool = { name: string; description?: string; inputSchema?: Record<string, unknown> };
export type McpCallResult = { content?: unknown[]; structuredContent?: unknown; isError?: boolean; [key: string]: unknown };

export interface McpTransport {
  connect(): Promise<void>;
  request(method: string, params?: unknown, timeoutMs?: number, signal?: AbortSignal): Promise<any>;
  close(): Promise<void>;
}

export type StdioMcpTransportOptions = { command: string; args?: string[]; cwd?: string; env?: Record<string, string | undefined> };

/** Minimal MCP stdio JSON-RPC transport used by the trusted operator-configured server. */
export class StdioMcpTransport implements McpTransport {
  private child?: ChildProcessWithoutNullStreams;
  private stdoutBuffer = "";
  private readonly stdoutDecoder = new StringDecoder("utf8");
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; signal?: AbortSignal; abort?: () => void }>();
  private closed = false;
  constructor(private readonly options: StdioMcpTransportOptions) {}
  async connect(): Promise<void> {
    if (this.child && !this.closed) return;
    this.closed = false;
    const child = spawn(this.options.command, this.options.args ?? [], { cwd: this.options.cwd, env: { ...mcpProcessEnvironment(), ...this.options.env }, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    child.stdout.on("data", (chunk: Buffer) => { if (this.child === child) this.handleChunk(chunk); });
    child.stderr.on("data", () => { /* drain diagnostics; never mix stderr into JSON-RPC */ });
    child.on("error", (error) => {
      if (this.child !== child) return;
      this.closed = true;
      this.failPending(error instanceof Error ? error : new Error("MCP process error"));
    });
    child.on("close", (code, signal) => {
      if (this.child !== child) return;
      this.closed = true;
      if (this.pending.size) this.failPending(new Error(`MCP process closed (${signal ?? code ?? "unknown"})`));
    });
    await this.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "bw-forge-discord-agent", version: "1.0.0" } });
    await this.notify("notifications/initialized", {});
  }
  async request(method: string, params?: unknown, timeoutMs = 10_000, signal?: AbortSignal): Promise<any> {
    const child = this.child;
    if (!child || this.closed) throw new Error("MCP transport is not connected");
    if (signal?.aborted) throw new Error("MCP request cancelled");
    const id = this.nextId++;
    return await new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        const current = this.pending.get(id);
        if (current) this.pending.delete(id);
        clearTimeout(timer);
        if (signal && abort) signal.removeEventListener("abort", abort);
      };
      const finishReject = (error: Error) => { if (settled) return; settled = true; cleanup(); reject(error); };
      const finishResolve = (value: any) => { if (settled) return; settled = true; cleanup(); resolve(value); };
      const timer = setTimeout(() => {
        finishReject(new Error(`MCP request timed out: ${method}`));
        // A timed-out request may still be executing in the server. Tear down
        // the session so the next call cannot consume a stale response.
        void this.close();
      }, timeoutMs);
      const abort = () => {
        finishReject(new Error("MCP request cancelled"));
        void this.close();
      };
      this.pending.set(id, { resolve: finishResolve, reject: finishReject, timer, signal, abort });
      if (signal) {
        if (signal.aborted) { abort(); return; }
        else signal.addEventListener("abort", abort, { once: true });
      }
      try {
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }) + "\n");
      } catch (error) {
        finishReject(error instanceof Error ? error : new Error("MCP request could not be sent"));
        void this.close();
      }
    });
  }
  private async notify(method: string, params?: unknown): Promise<void> {
    if (!this.child || this.closed) throw new Error("MCP transport is not connected");
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) }) + "\n");
  }
  private handleChunk(chunk: Buffer): void {
    if (Buffer.byteLength(this.stdoutBuffer, "utf8") + chunk.byteLength > 256_000) {
      void this.close();
      return;
    }
    this.stdoutBuffer += this.stdoutDecoder.write(chunk);
    let newline = this.stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      this.handleLine(line);
      newline = this.stdoutBuffer.indexOf("\n");
    }
  }
  private handleLine(line: string): void {
    if (!line.trim()) return;
    let value: any; try { value = JSON.parse(line); } catch {
      this.closed = true;
      this.failPending(new Error("MCP returned malformed JSON"));
      void this.close();
      return;
    }
    if (!value || typeof value !== "object" || value.jsonrpc !== "2.0") {
      this.closed = true;
      this.failPending(new Error("MCP returned an invalid JSON-RPC response"));
      void this.close();
      return;
    }
    if (typeof value.id !== "number" || !Number.isSafeInteger(value.id)) return;
    const pending = this.pending.get(value.id); if (!pending) return;
    this.pending.delete(value.id); clearTimeout(pending.timer);
    if (pending.signal && pending.abort) pending.signal.removeEventListener("abort", pending.abort);
    // Never pass server-controlled error text across the gateway boundary.
    if (value.error && typeof value.error === "object") pending.reject(new Error("MCP request failed"));
    else if (Object.prototype.hasOwnProperty.call(value, "result")) pending.resolve(value.result);
    else pending.reject(new Error("MCP returned an invalid JSON-RPC response"));
  }
  private failPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      if (pending.signal && pending.abort) pending.signal.removeEventListener("abort", pending.abort);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
  async close(): Promise<void> {
    this.closed = true; this.stdoutBuffer = ""; this.failPending(new Error("MCP transport closed"));
    const child = this.child; this.child = undefined;
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
      child.kill("SIGTERM");
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([exited, new Promise<void>((resolve) => { timer = setTimeout(resolve, 1000); })]);
      if (timer) clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }
}

export type CorpusEndpoint = {
  id: string;
  transport?: McpTransport;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  dbPath?: string;
  readable?: boolean;
};
export type GatewayLimits = { requestTimeoutMs?: number; maxResultBytes?: number; maxCallsPerTurn?: number };
export type GatewayToolDefinition = McpTool & { corpusRequired: true; corpusId?: string; corpusIds?: string[] };

export const ALLOWED_TOOLS = new Set([
  "get_economy", "get_unit_count", "get_deaths", "list_build_events", "get_event_timing_distribution",
  "get_composition_snapshot", "get_corpus_summary", "list_players", "list_matchups", "list_build_items",
  "count_replays_with_event_before_event", "get_death_summary", "get_player_replay_card", "get_economy_distribution"
]);

const MODEL_ECONOMY_DISTRIBUTION_KEYS = new Set(["timeSeconds", "race", "opponentRace", "matchup"]);
const MODEL_ECONOMY_DISTRIBUTION_DESCRIPTION = "Ordinary corpus-wide economy benchmark. Supply timeSeconds and only the requested optional filters: race, opponentRace, and matchup. Omit all other arguments. Advanced player, map, identity-group, scope, chronology, replay, and example-limit filters remain available through the direct MCP interface, not this Discord agent tool.";
const MUTATING_NAMES = /(?:ingest|enqueue|write|delete|remove|execute_query_plan|export_query_plan|sql|validate_build_rules|admin)/i;
const REPLAY_SCOPED_TOOLS = new Set(["get_economy", "get_unit_count", "get_deaths", "list_build_events", "get_player_replay_card"]);

export class McpGateway {
  private readonly endpoints = new Map<string, CorpusEndpoint>();
  private readonly connections = new Map<string, McpTransport>();
  private readonly connecting = new Map<string, Promise<McpTransport>>();
  private readonly discovered = new Map<string, GatewayToolDefinition[]>();
  private readonly schemas = new Map<string, Record<string, unknown>>();
  private readonly unavailable = new Map<string, string>();
  private shuttingDown = false;
  private readonly calls = new Map<string, number>();
  private readonly limits: Required<GatewayLimits>;
  constructor(endpoints: CorpusEndpoint[], limits: GatewayLimits = {}) {
    this.limits = { requestTimeoutMs: limits.requestTimeoutMs ?? 10_000, maxResultBytes: limits.maxResultBytes ?? 32_000, maxCallsPerTurn: limits.maxCallsPerTurn ?? 8 };
    for (const endpoint of endpoints) {
      if (!endpoint.id || this.endpoints.has(endpoint.id)) throw new Error(`Duplicate MCP corpus: ${endpoint.id}`);
      if (endpoint.readable === false) continue;
      if (!endpoint.transport && !endpoint.command) throw new Error(`MCP corpus ${endpoint.id} has no trusted transport`);
      this.endpoints.set(endpoint.id, endpoint);
    }
  }
  async listTools(corpusId?: string): Promise<GatewayToolDefinition[]> {
    const ids = corpusId ? [corpusId] : [...this.endpoints.keys()]; const all: GatewayToolDefinition[] = [];
    const byName = new Map<string, GatewayToolDefinition>();
    for (const id of ids) {
      const endpoint = this.requireEndpoint(id);
      try {
        const tools = await this.discover(endpoint);
        this.unavailable.delete(id);
        if (tools.length) for (const tool of tools) {
          const existing = byName.get(tool.name);
          if (existing) existing.corpusIds = [...new Set([...(existing.corpusIds ?? (existing.corpusId ? [existing.corpusId] : [])), ...(tool.corpusId ? [tool.corpusId] : [])])];
          else { byName.set(tool.name, tool); all.push(tool); }
        }
        else this.unavailable.set(id, "MCP server exposed no approved analytical tools");
      } catch (error) {
        this.unavailable.set(id, error instanceof Error ? error.message : String(error));
        if (corpusId) throw new Error(`MCP corpus ${id} is unavailable`);
      }
    }
    for (const tool of all) {
      const idsForTool = tool.corpusIds ?? (tool.corpusId ? [tool.corpusId] : []);
      const properties = (tool.inputSchema as any)?.properties;
      if (properties?.corpus_id) properties.corpus_id.enum = idsForTool;
    }
    if (!all.length) throw new Error("No configured MCP corpus has usable analytical tools");
    return all;
  }
  /** Operator-safe availability diagnostics; excludes commands, paths, and credentials. */
  getUnavailableCorpora(): string[] { return [...this.unavailable.keys()]; }
  resetTurnBudget(turnKey = "default"): void { this.calls.set(turnKey, 0); }
  releaseTurnBudget(turnKey = "default"): void { this.calls.delete(turnKey); }
  async call(input: { corpusId: string; name: string; arguments?: Record<string, unknown>; allowedReplayRefs?: CorpusReplayRef[]; signal?: AbortSignal; turnKey?: string }): Promise<McpCallResult> {
    const turnKey = input.turnKey ?? "default";
    const calls = (this.calls.get(turnKey) ?? 0) + 1;
    this.calls.set(turnKey, calls);
    if (calls > this.limits.maxCallsPerTurn) throw new Error("MCP tool-call budget exhausted");
    const endpoint = this.requireEndpoint(input.corpusId);
    if (!ALLOWED_TOOLS.has(input.name) || MUTATING_NAMES.test(input.name)) throw new Error(`MCP tool is not allowed: ${input.name}`);
    if (!(await this.discover(endpoint)).some((tool) => tool.name === input.name)) throw new Error(`MCP tool is unavailable for corpus ${input.corpusId}`);
    const args = this.validateArguments(input.name, input.arguments ?? {}, input.allowedReplayRefs ?? [], endpoint);
    if (input.signal?.aborted) throw new Error("MCP tool call cancelled");
    let transport = await this.connection(endpoint);
    let result: any;
    try {
      result = await transport.request("tools/call", { name: input.name, arguments: args }, this.limits.requestTimeoutMs, input.signal);
    } catch (error) {
      if (input.signal?.aborted || /cancelled/i.test(String((error as Error)?.message))) throw error;
      if (this.connections.get(endpoint.id) === transport) this.connections.delete(endpoint.id);
      await transport.close().catch(() => undefined);
      transport = await this.connection(endpoint);
      result = await transport.request("tools/call", { name: input.name, arguments: args }, this.limits.requestTimeoutMs, input.signal);
    }
    if (result?.isError) return {
      isError: true,
      content: [{ type: "text", text: "The analytical query failed." }],
      structuredContent: { error: { code: classifyMcpToolError(result) } },
    };
    const safeResult = stripInternalPaths(result ?? null);
    if (Buffer.byteLength(JSON.stringify(safeResult), "utf8") > this.limits.maxResultBytes) throw new Error("MCP tool result exceeds configured size limit");
    return safeResult as McpCallResult;
  }
  async close(): Promise<void> {
    this.shuttingDown = true;
    const transports = [...this.connections.values()];
    const openings = [...this.connecting.values()];
    await Promise.all([
      ...transports.map((transport) => transport.close().catch(() => undefined)),
      ...openings.map((opening) => opening.then((transport) => transport.close().catch(() => undefined)).catch(() => undefined)),
    ]);
    this.connections.clear();
    this.connecting.clear();
  }
  private requireEndpoint(id: string): CorpusEndpoint { const endpoint = this.endpoints.get(id); if (!endpoint) throw new Error(`Unknown or unreadable corpus: ${id}`); return endpoint; }
  private async connection(endpoint: CorpusEndpoint): Promise<McpTransport> {
    if (this.shuttingDown) throw new Error("MCP gateway is closed");
    let transport = this.connections.get(endpoint.id);
    if (transport && !this.connecting.has(endpoint.id)) return transport;
    const pending = this.connecting.get(endpoint.id);
    if (pending) return pending;
    transport ??= endpoint.transport ?? new StdioMcpTransport({ command: endpoint.command!, args: endpoint.args, cwd: endpoint.cwd, env: endpoint.env });
    this.connections.set(endpoint.id, transport);
    const opening = transport.connect().then(() => {
      if (this.shuttingDown) throw new Error("MCP gateway is closed");
      return transport!;
    }).catch(async (error) => {
      if (this.connections.get(endpoint.id) === transport) this.connections.delete(endpoint.id);
      await transport!.close().catch(() => undefined);
      throw error;
    }).finally(() => this.connecting.delete(endpoint.id));
    this.connecting.set(endpoint.id, opening);
    return opening;
  }
  private async discover(endpoint: CorpusEndpoint): Promise<GatewayToolDefinition[]> {
    const cached = this.discovered.get(endpoint.id); if (cached) return cached;
    let transport = await this.connection(endpoint);
    let response: any;
    try {
      response = await transport.request("tools/list", {}, this.limits.requestTimeoutMs);
    } catch (error) {
      if (/cancelled/i.test(String((error as Error)?.message))) throw error;
      if (this.connections.get(endpoint.id) === transport) this.connections.delete(endpoint.id);
      await transport.close().catch(() => undefined);
      transport = await this.connection(endpoint);
      response = await transport.request("tools/list", {}, this.limits.requestTimeoutMs);
    }
    const result = (Array.isArray(response?.tools) ? response.tools : []).filter((tool: any) => {
      if (typeof tool?.name !== "string" || !ALLOWED_TOOLS.has(tool.name) || MUTATING_NAMES.test(tool.name)) return false;
      if (!tool.inputSchema || typeof tool.inputSchema !== "object" || tool.inputSchema.type !== "object" || typeof tool.inputSchema.properties !== "object") return false;
      return true;
    }).map((tool: McpTool) => {
      this.schemas.set(`${endpoint.id}:${tool.name}`, tool.inputSchema!);
      return { ...tool, ...(tool.name === "get_economy_distribution" ? { description: MODEL_ECONOMY_DISTRIBUTION_DESCRIPTION } : {}), inputSchema: this.modelSchema(tool.name, tool.inputSchema!, REPLAY_SCOPED_TOOLS.has(tool.name), [endpoint.id]), corpusRequired: true as const, corpusId: endpoint.id };
    });
    this.discovered.set(endpoint.id, result); return result;
  }
  private validateArguments(name: string, raw: Record<string, unknown>, refs: CorpusReplayRef[], endpoint: CorpusEndpoint): Record<string, unknown> {
    const args = { ...raw }; delete args.db_path; delete args.corpus_id; if (endpoint.dbPath) args.db_path = endpoint.dbPath;
    if ("replay_number" in raw && !REPLAY_SCOPED_TOOLS.has(name)) throw new Error(`${name} does not accept replay_number; this is a corpus-wide query. Omit replay_number.`);
    if (name === "get_economy_distribution") {
      const unexpected = Object.keys(raw).filter((key) => key !== "corpus_id" && !MODEL_ECONOMY_DISTRIBUTION_KEYS.has(key));
      if (unexpected.length) throw new Error("get_economy_distribution in the Discord agent only accepts corpus_id, timeSeconds, race, opponentRace, and matchup. Omit additional arguments; advanced filters remain available through the direct MCP interface.");
    }
    if (REPLAY_SCOPED_TOOLS.has(name) && ["player_group", "opponent_group", "scope"].some((key) => key in raw)) {
      throw new Error(`${name} in the Discord agent requires an exact observed player name; group filters are unavailable for replay-scoped calls.`);
    }
    if (REPLAY_SCOPED_TOOLS.has(name) && !("replay_number" in args)) throw new Error(`${name} requires a replay_number from this session`);
    const schema = this.schemas.get(`${endpoint.id}:${name}`);
    const schemaProperties = (schema?.properties && typeof schema.properties === "object" ? schema.properties : {}) as Record<string, unknown>;
    for (const key of ["replay_id", "replay_ids", "replaySha256", "replayId"]) if (key in raw) throw new Error(`${key} must be supplied as replay_number`);
    // Natural replay numbers are resolved against the session inventory here;
    // the MCP server only receives the canonical corpus replay hash.
    if ("replay_number" in args) {
      if (!Number.isInteger(args.replay_number) || Number(args.replay_number) < 1) throw new Error("replay_number must be a positive integer");
      const scoped = refs.filter((candidate) => candidate.corpusId === endpoint.id);
      const ref = scoped.find((candidate) => candidate.replayNumber === Number(args.replay_number)) ??
        (scoped.every((candidate) => candidate.replayNumber === undefined) ? scoped[Number(args.replay_number) - 1] : undefined);
      if (!ref) throw new Error("Replay number is outside the authorized session inventory");
      if ("replayId" in schemaProperties) args.replayId = ref.replaySha256;
      else if ("replay_ids" in schemaProperties) args.replay_ids = [ref.replaySha256];
      else throw new Error("Replay number is not supported by this tool schema");
      delete args.replay_number;
    }
    for (const key of ["limit", "limitExamples"]) if (key in args && (!Number.isInteger(args[key]) || Number(args[key]) < 1 || Number(args[key]) > 100)) throw new Error(`${key} is outside the allowed range`);
    for (const key of ["n", "firstN", "secondN"]) if (key in args && (!Number.isInteger(args[key]) || Number(args[key]) < 1 || Number(args[key]) > 100)) throw new Error(`${key} is outside the allowed range`);
    for (const key of ["at_seconds", "timeSeconds", "startSeconds", "endSeconds", "from_seconds", "to_seconds"]) if (key in args && (!Number.isFinite(args[key]) || Number(args[key]) < 0 || Number(args[key]) > 86400)) throw new Error(`${key} is outside the allowed range`);
    if (!schema || !this.validateSchema(schema, args)) throw new Error(`Arguments rejected by MCP schema for ${name}`);
    return args;
  }

  private modelSchema(name: string, schema: Record<string, unknown>, replaySpecific: boolean, corpusIds: string[]): Record<string, unknown> {
    const copy = JSON.parse(JSON.stringify(schema)) as Record<string, any>;
    const properties = copy.properties ?? {};
    if (name === "get_economy_distribution") {
      const exposed = Object.fromEntries(["timeSeconds", "race", "opponentRace", "matchup"].filter((key) => properties[key]).map((key) => [key, properties[key]]));
      if (!exposed.timeSeconds) exposed.timeSeconds = { type: "number", description: "Timestamp in seconds; required." };
      exposed.race = { ...(exposed.race ?? { type: "string" }), description: "Optional current-player race filter." };
      exposed.opponentRace = { ...(exposed.opponentRace ?? { type: "string" }), description: "Optional opponent race filter." };
      exposed.matchup = { ...(exposed.matchup ?? { type: "string" }), description: "Optional stored matchup label such as ZvP." };
      copy.properties = exposed;
      copy.required = ["timeSeconds"];
      copy.description = MODEL_ECONOMY_DISTRIBUTION_DESCRIPTION;
    }
    for (const key of ["replay_id", "replay_ids", "replaySha256", "replayId"]) delete properties[key];
    if (replaySpecific) properties.replay_number = { type: "integer", minimum: 1, maximum: 10000, description: "Session-local replay number" };
    if (name === "get_player_replay_card") delete properties.filenameContains;
    if (replaySpecific) {
      // Identity groups are configured catalog keys, not player display names.
      // Hide them from replay-scoped Discord calls so the model uses the exact
      // participant name supplied by the session replay inventory.
      for (const key of ["player_group", "opponent_group", "scope"]) delete properties[key];
      if (properties.player && typeof properties.player === "object") {
        properties.player.description = "Exact observed player name from the selected replay; this is not a player-group key.";
      }
      if (name === "get_economy") {
        copy.description = `${typeof copy.description === "string" ? copy.description : "Get economy at the requested time."} Use the exact observed player name in player. Do not pass player_group, opponent_group, or scope filters to this replay query.`;
      }
    }
    properties.corpus_id = { type: "string", enum: corpusIds };
    if (name === "get_economy_distribution") (copy.properties as Record<string, unknown>).corpus_id = properties.corpus_id;
    if (name !== "get_economy_distribution") copy.properties = properties;
    if (Array.isArray(copy.required)) copy.required = copy.required.filter((key: string) => !["replay_id", "replay_ids", "replaySha256", "replayId"].includes(key));
    if (REPLAY_SCOPED_TOOLS.has(name)) copy.required = [...new Set([...(Array.isArray(copy.required) ? copy.required : []), "replay_number"])];
    copy.additionalProperties = false;
    return copy;
  }

  private validateSchema(schema: Record<string, unknown>, args: Record<string, unknown>): boolean {
    const properties = (schema.properties && typeof schema.properties === "object" ? schema.properties : {}) as Record<string, any>;
    for (const key of Object.keys(args)) {
      if (key === "db_path") continue;
      const rule = properties[key]; if (!rule || !this.validateValue(rule, args[key])) return false;
    }
    const required = Array.isArray(schema.required) ? schema.required as string[] : [];
    return required.every((key) => key in args || key === "db_path");
  }

  private validateValue(rule: Record<string, any>, value: unknown): boolean {
    if (Array.isArray(rule.enum) && !rule.enum.some((item) => Object.is(item, value))) return false;
    switch (rule.type) {
      case "string":
        return typeof value === "string" && value.length <= 1000 && (rule.minLength === undefined || value.length >= rule.minLength) && (rule.maxLength === undefined || value.length <= rule.maxLength);
      case "number":
      case "integer":
        return typeof value === "number" && Number.isFinite(value) && (rule.type !== "integer" || Number.isInteger(value)) && (rule.minimum === undefined || value >= rule.minimum) && (rule.maximum === undefined || value <= rule.maximum);
      case "boolean": return typeof value === "boolean";
      case "array":
        return Array.isArray(value) && value.length <= 100 && (rule.minItems === undefined || value.length >= rule.minItems) && (rule.maxItems === undefined || value.length <= rule.maxItems) && (!rule.items || value.every((item) => this.validateValue(rule.items, item)));
      case "object": {
        if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
        const object = value as Record<string, unknown>;
        const nested = (rule.properties && typeof rule.properties === "object" ? rule.properties : {}) as Record<string, any>;
        for (const key of Object.keys(object)) if (!nested[key] || !this.validateValue(nested[key], object[key])) return false;
        const required = Array.isArray(rule.required) ? rule.required as string[] : [];
        return required.every((key) => key in object);
      }
      default: return false;
    }
  }
}

function stripInternalPaths(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripInternalPaths);
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (/(?:^|_)(?:path|root|directory)$/i.test(key) || /^(?:db_path|path)$/i.test(key)) continue;
    output[key] = stripInternalPaths(item);
  }
  return output;
}

function classifyMcpToolError(result: McpCallResult): string {
  const structured = result.structuredContent && typeof result.structuredContent === "object"
    ? result.structuredContent as Record<string, unknown> : {};
  const error = structured.error && typeof structured.error === "object" ? structured.error as Record<string, unknown> : {};
  const allowedCodes = new Set([
    "NOT_SUPPORTED_FOR_CORPUS_V1", "NOT_SUPPORTED_FOR_CORPUS_V2", "AMBIGUOUS_PLAYER_SELECTOR",
    "SQLITE_BUSY", "SQLITE_CORRUPT", "SQLITE_NOTADB", "SQLITE_CANTOPEN", "SQLITE_IOERR", "SQLITE_ERROR", "SQLITE_CONSTRAINT",
  ]);
  if (typeof error.code === "string" && allowedCodes.has(error.code)) return error.code.toLowerCase();
  const text = [error.message, ...(Array.isArray(result.content) ? result.content.map((item) => item && typeof item === "object" ? (item as Record<string, unknown>).text : undefined) : [])]
    .filter((value): value is string => typeof value === "string").join("\n");
  const categories: Array<[RegExp, string]> = [
    [/Covered economy segment has no baseline/i, "economy_coverage_invariant"],
    [/Unknown player group:/i, "unknown_player_group"],
    [/Unknown query scope:/i, "unknown_query_scope"],
    [/Invalid played_(?:from|before)|played_from must be earlier than played_before/i, "invalid_chronology_filter"],
    [/unable to open database|SQLITE_CANTOPEN|no such file/i, "corpus_database_open_error"],
    [/database is locked|SQLITE_BUSY/i, "corpus_database_busy"],
    [/malformed|not a database|SQLITE_CORRUPT|SQLITE_NOTADB/i, "corpus_database_error"],
    [/no such table|no such column|schema mismatch/i, "corpus_schema_error"],
    [/disk i\/o|SQLITE_IOERR/i, "corpus_database_io_error"],
  ];
  for (const [pattern, code] of categories) if (pattern.test(text)) return code;
  return "mcp_tool_error";
}

function mcpProcessEnvironment(): Record<string, string> {
  const allowed = new Set(["path", "home", "tmpdir", "tmp", "temp", "systemroot", "windir", "userprofile", "appdata", "localappdata", "lang", "lc_all"]);
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (allowed.has(key.toLowerCase()) && value !== undefined) environment[key] = value;
  return environment;
}

import { describe, expect, test } from "bun:test";
import { McpGateway, StdioMcpTransport, type McpTransport } from "../src/agent/mcp-gateway.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";

const fixtureSource = String.raw`const mode = process.env.MCP_FIXTURE_MODE || "normal";
let initialized = false;
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
    if (!line.trim()) continue;
    if (mode === "malformed") { process.stdout.write("{not-json}\n"); continue; }
    if (mode === "null") { process.stdout.write("null\n"); continue; }
    if (mode === "invalid-envelope") { process.stdout.write(JSON.stringify({ id: req.id, result: {} }) + "\n"); continue; }
    const req = JSON.parse(line);
    if (mode === "crash") process.exit(17);
    if (mode === "huge") { process.stdout.write("x".repeat(300000) + "\n"); continue; }
    if (mode === "hang" || (mode === "hangcall" && req.method === "tools/call") || (mode === "slowinit" && req.method === "initialize")) continue;
    if (req.method === "initialize") initialized = true;
    if (req.id === undefined) continue;
    const result = req.method === "tools/list" ? { tools: [{ name: "get_economy_distribution", inputSchema: { type: "object", properties: { timeSeconds: { type: "number" } } } }] } : { content: [{ type: "text", text: "ok" }] };
    const emit = () => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }) + "\n");
    if (mode === "delaycall" && req.method === "tools/call") setTimeout(emit, 100); else emit();
  }
});`;

async function fixture(mode: string): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const path = join(tmpdir(), `bw-forge-mcp-${randomUUID()}.mjs`);
  await Bun.write(path, fixtureSource);
  return { path, cleanup: () => unlink(path).catch(() => undefined) };
}

function stdio(path: string, mode: string) {
  return new StdioMcpTransport({ command: process.execPath, args: ["run", path], env: { MCP_FIXTURE_MODE: mode } });
}

class FakeTransport implements McpTransport {
  readonly calls: { method: string; params: any }[] = [];
  connected = false;
  toolCallResult?: any;
  async connect() { this.connected = true; }
  async request(method: string, params?: unknown) {
    this.calls.push({ method, params });
    if (method === "tools/list") return { tools: [
      { name: "get_economy", description: "economy", inputSchema: { type: "object", properties: { player: { type: "string" }, at_seconds: { type: "number" }, replay_ids: { type: "array", items: { type: "string" }, maxItems: 100 } } } },
      { name: "get_economy_distribution", description: "aggregate economy", inputSchema: { type: "object", properties: { player: { type: "string" }, opponent: { type: "string" }, race: { type: "string" }, opponentRace: { type: "string" }, matchup: { type: "string" }, map: { type: "string" }, timeSeconds: { type: "number" }, limitExamples: { type: "integer", maximum: 25 }, replay_ids: { type: "array", items: { type: "string" } } } } },
      { name: "get_player_replay_card", description: "replay card", inputSchema: { type: "object", properties: { replayId: { type: "string" }, player: { type: "string" } }, required: ["replayId", "player"] } },
      { name: "execute_query_plan", description: "mutating", inputSchema: { type: "object", properties: {} } }
    ] };
    return this.toolCallResult ?? { content: [{ type: "text", text: "31 workers" }], structuredContent: { workers: 31 } };
  }
  async close() { this.connected = false; }
}

const ref = { corpusId: "community", replaySha256: "a".repeat(64) };

describe("MCP analytical gateway", () => {
  test("discovers only the read-only allowlist", async () => {
    const transport = new FakeTransport();
    const gateway = new McpGateway([{ id: "community", transport }]);
    const tools = await gateway.listTools("community");
    expect(tools.map((tool) => tool.name)).toEqual(["get_economy", "get_economy_distribution", "get_player_replay_card"]);
    const aggregateSchema = tools.find((tool) => tool.name === "get_economy_distribution")!.inputSchema as any;
    expect(tools.find((tool) => tool.name === "get_economy_distribution")!.description).toMatch(/only the requested optional filters/i);
    expect(Object.keys(aggregateSchema.properties).sort()).toEqual(["corpus_id", "matchup", "opponentRace", "race", "timeSeconds"]);
    expect(aggregateSchema.required).toEqual(["timeSeconds"]);
    expect(aggregateSchema.additionalProperties).toBe(false);
    expect(aggregateSchema.description).toMatch(/only the requested optional filters/i);
    expect(aggregateSchema.properties.replay_number).toBeUndefined();
    expect(aggregateSchema.required ?? []).not.toContain("replay_number");
    expect(aggregateSchema.properties.replay_ids).toBeUndefined();
  });

  test("routes a canonical replay number and strips model db paths", async () => {
    const transport = new FakeTransport();
    const gateway = new McpGateway([{ id: "community", transport, dbPath: "C:/trusted/community.sqlite" }]);
    await gateway.call({ corpusId: "community", name: "get_economy", arguments: { replay_number: 1, player: "z", at_seconds: 300, db_path: "C:/attacker.sqlite" }, allowedReplayRefs: [ref] });
    const call = transport.calls.find((item) => item.method === "tools/call")!;
    expect(call.params.arguments).toMatchObject({ replay_ids: [ref.replaySha256], db_path: "C:/trusted/community.sqlite" });
  });

  test("preserves explicit race and matchup filters for aggregate queries", async () => {
    const transport = new FakeTransport();
    const gateway = new McpGateway([{ id: "pro", transport, dbPath: "trusted-pro.sqlite" }]);
    await gateway.call({ corpusId: "pro", name: "get_economy_distribution", arguments: {
      race: "Zerg", matchup: "ZvP", timeSeconds: 300,
    } });
    const call = transport.calls.find((item) => item.method === "tools/call")!;
    expect(call.params.arguments).toMatchObject({ race: "Zerg", matchup: "ZvP", timeSeconds: 300, db_path: "trusted-pro.sqlite" });
  });

  test("rejects replay_number on a correctly filtered corpus-wide aggregate call", async () => {
    const transport = new FakeTransport();
    const gateway = new McpGateway([{ id: "pro", transport }]);
    const filters = { corpusId: "pro", name: "get_economy_distribution", arguments: {
      race: "zerg", opponentRace: "protoss", matchup: "ZvP", timeSeconds: 300, replay_number: 7,
    } };
    await expect(gateway.call(filters)).rejects.toThrow("get_economy_distribution does not accept replay_number; this is a corpus-wide query. Omit replay_number.");
    expect(transport.calls.some((call) => call.method === "tools/call")).toBe(false);
  });

  test("rejects advanced aggregate filters before MCP execution", async () => {
    const transport = new FakeTransport();
    const gateway = new McpGateway([{ id: "pro", transport }]);
    await expect(gateway.call({ corpusId: "pro", name: "get_economy_distribution", arguments: {
      race: "zerg", opponentRace: "protoss", matchup: "ZvP", timeSeconds: 300,
      played_from: "2024-01-01T00:00:00Z",
    } })).rejects.toThrow(/only accepts corpus_id, timeSeconds, race, opponentRace, and matchup/i);
    expect(transport.calls.some((call) => call.method === "tools/call")).toBe(false);
  });

  test("rejects model-supplied database paths for aggregate tools instead of silently dropping them", async () => {
    const transport = new FakeTransport();
    const gateway = new McpGateway([{ id: "pro", transport, dbPath: "trusted-pro.sqlite" }]);
    await expect(gateway.call({ corpusId: "pro", name: "get_economy_distribution", arguments: {
      race: "zerg", opponentRace: "protoss", matchup: "ZvP", timeSeconds: 300, db_path: "untrusted.sqlite",
    } })).rejects.toThrow(/only accepts corpus_id, timeSeconds, race, opponentRace, and matchup/i);
    expect(transport.calls.some((call) => call.method === "tools/call")).toBe(false);
  });

  test("returns only a safe error category for an MCP tool failure", async () => {
    const transport = new FakeTransport();
    transport.toolCallResult = { isError: true, content: [{ type: "text", text: "Unknown player group: PrivateGroup at C:/private/corpus.sqlite" }],
      structuredContent: { error: { message: "Unknown player group: PrivateGroup at C:/private/corpus.sqlite" } } };
    const gateway = new McpGateway([{ id: "pro", transport }]);
    const result = await gateway.call({ corpusId: "pro", name: "get_economy_distribution", arguments: {
      race: "zerg", opponentRace: "protoss", matchup: "ZvP", timeSeconds: 300,
    } });
    expect(result.isError).toBe(true);
    expect((result.structuredContent as any).error.code).toBe("unknown_player_group");
    expect(JSON.stringify(result)).not.toContain("PrivateGroup");
    expect(JSON.stringify(result)).not.toContain("private/corpus.sqlite");
  });

  test("rejects unknown corpus, mutating tools, and cross-session replay refs", async () => {
    const gateway = new McpGateway([{ id: "community", transport: new FakeTransport() }]);
    await expect(gateway.call({ corpusId: "pro", name: "get_economy" })).rejects.toThrow("Unknown");
    await expect(gateway.call({ corpusId: "community", name: "execute_query_plan" })).rejects.toThrow("not allowed");
    await expect(gateway.call({ corpusId: "community", name: "get_economy", arguments: { replay_id: "b".repeat(64) }, allowedReplayRefs: [ref] })).rejects.toThrow("replay_number");
  });

  test("enforces call and result bounds", async () => {
    const gateway = new McpGateway([{ id: "community", transport: new FakeTransport() }], { maxCallsPerTurn: 1 });
    const input = { corpusId: "community", name: "get_economy", arguments: { player: "z", at_seconds: 300, replay_number: 1 }, allowedReplayRefs: [ref] };
    await gateway.call(input);
    await expect(gateway.call(input)).rejects.toThrow("budget");
  });

  test("uses explicit session-local replay numbers and rejects unknown fields", async () => {
    const transport = new FakeTransport();
    const gateway = new McpGateway([{ id: "community", transport, dbPath: "trusted.sqlite" }]);
    const refs = [
      { corpusId: "community", replaySha256: "a".repeat(64), replayNumber: 2 },
      { corpusId: "community", replaySha256: "b".repeat(64), replayNumber: 7 }
    ];
    await gateway.call({ corpusId: "community", name: "get_economy", arguments: { replay_number: 7 }, allowedReplayRefs: refs });
    expect(transport.calls.at(-1)?.params.arguments.replay_ids).toEqual(["b".repeat(64)]);
    await expect(gateway.call({ corpusId: "community", name: "get_economy", arguments: { replay_number: 7, injected: "x" }, allowedReplayRefs: refs })).rejects.toThrow("schema");
    const tools = await gateway.listTools("community");
    expect((tools[0].inputSchema as any).properties.replay_number).toBeDefined();
  });

  test("uses singular replayId for replay-card schemas", async () => {
    const transport = new FakeTransport();
    const gateway = new McpGateway([{ id: "community", transport }]);
    await gateway.call({ corpusId: "community", name: "get_player_replay_card", arguments: { replay_number: 1, player: "z" }, allowedReplayRefs: [ref] });
    expect(transport.calls.at(-1)?.params.arguments.replayId).toBe(ref.replaySha256);
    expect(transport.calls.at(-1)?.params.arguments.replay_ids).toBeUndefined();
  });

  test("keeps healthy corpora available when another MCP server is down", async () => {
    const healthy = new FakeTransport();
    const offline: McpTransport = { connect: async () => {}, close: async () => {}, request: async () => { throw new Error("offline"); } };
    const gateway = new McpGateway([{ id: "community", transport: healthy }, { id: "pro", transport: offline }]);
    const tools = await gateway.listTools();
    expect([...new Set(tools.map((tool) => tool.corpusId))]).toEqual(["community"]);
    expect(gateway.getUnavailableCorpora()).toEqual(["pro"]);
    await gateway.close();
  });
  test("requires a session replay number for replay-scoped tools even with an empty inventory", async () => {
    const gateway = new McpGateway([{ id: "community", transport: new FakeTransport() }]);
    await expect(gateway.call({ corpusId: "community", name: "get_economy", arguments: { player: "z", at_seconds: 300 }, allowedReplayRefs: [] })).rejects.toThrow("requires a replay_number");
  });
  test("shares an in-flight corpus connection across simultaneous turns", async () => {
    const transport = new FakeTransport(); let connects = 0;
    transport.connect = async () => { connects++; await Bun.sleep(10); transport.connected = true; };
    const gateway = new McpGateway([{ id: "community", transport }]);
    await Promise.all([gateway.listTools("community"), gateway.listTools("community")]);
    expect(connects).toBe(1);
    await gateway.close();
  });

  test("stdio transport recovers after a timed out request and does not leak server errors", async () => {
      const f = await fixture("delaycall");
    try {
      const transport = stdio(f.path, "delaycall");
      await transport.connect();
      await expect(transport.request("tools/call", {}, 20)).rejects.toThrow(/timed out/i);
      await transport.close();
      const recovered = stdio(f.path, "normal");
      await recovered.connect();
      const recoveredResult = await recovered.request("tools/call", {}, 1000).catch((error) => error);
      expect(recoveredResult).not.toBeInstanceOf(Error);
      await recovered.close();
    } finally { await f.cleanup(); }
  });

  test("stdio transport cancels and terminates a hanging child", async () => {
    const f = await fixture("hangcall");
    try {
      const transport = stdio(f.path, "hangcall");
      const controller = new AbortController();
      await transport.connect();
      const child = (transport as any).child;
      const request = transport.request("tools/call", {}, 5000, controller.signal);
      await Bun.sleep(10);
      controller.abort();
      await expect(request).rejects.toThrow(/cancelled/i);
      await transport.close();
      await Bun.sleep(50);
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    } finally { await f.cleanup(); }
  });

  test("gateway reconnects a read-only call after its MCP child is killed", async () => {
    const f = await fixture("normal");
    try {
      const transport = stdio(f.path, "normal");
      const gateway = new McpGateway([{ id: "community", transport }], { requestTimeoutMs: 1000 });
      await gateway.listTools("community");
      const firstPid = (transport as any).child?.pid;
      (transport as any).child?.kill("SIGTERM");
      await Bun.sleep(40);
      const result = await gateway.call({ corpusId: "community", name: "get_economy_distribution", arguments: { timeSeconds: 300 }, allowedReplayRefs: [] });
      expect((result.content?.[0] as { text?: unknown } | undefined)?.text).toBe("ok");
      expect((transport as any).child?.pid).not.toBe(firstPid);
      await gateway.close();
    } finally { await f.cleanup(); }
  });

  test("stdio transport rejects malformed and oversized stdout", async () => {
    for (const mode of ["malformed", "huge", "null", "invalid-envelope"]) {
      const f = await fixture(mode);
      try {
        const transport = stdio(f.path, mode);
        await expect(transport.connect()).rejects.toThrow();
        await transport.close();
      } finally { await f.cleanup(); }
    }
  });

  test("stdio transport does not write a pre-cancelled request", async () => {
    const f = await fixture("normal");
    try {
      const transport = stdio(f.path, "normal");
      await transport.connect();
      const controller = new AbortController(); controller.abort();
      await expect(transport.request("tools/call", {}, 1000, controller.signal)).rejects.toThrow(/cancelled/i);
      await transport.close();
    } finally { await f.cleanup(); }
  });

  test("gateway closes an MCP process that is still initializing", async () => {
    const f = await fixture("slowinit");
    try {
      const gateway = new McpGateway([{ id: "community", command: process.execPath, args: ["run", f.path], env: { MCP_FIXTURE_MODE: "slowinit" } }]);
      const listing = gateway.listTools("community");
      const observed = listing.then(() => undefined, (error) => error);
      await Bun.sleep(30);
      await gateway.close();
      await expect(observed).resolves.toBeInstanceOf(Error);
    } finally { await f.cleanup(); }
  });
});

import { describe, expect, test } from "bun:test";
import { McpGateway, type McpTransport } from "../src/agent/mcp-gateway.ts";

class FakeTransport implements McpTransport {
  readonly calls: { method: string; params: any }[] = [];
  connected = false;
  async connect() { this.connected = true; }
  async request(method: string, params?: unknown) {
    this.calls.push({ method, params });
    if (method === "tools/list") return { tools: [
      { name: "get_economy", description: "economy", inputSchema: { type: "object", properties: { player: { type: "string" }, at_seconds: { type: "number" }, replay_ids: { type: "array", items: { type: "string" }, maxItems: 100 } } } },
      { name: "get_economy_distribution", description: "aggregate economy", inputSchema: { type: "object", properties: { player: { type: "string" }, opponent: { type: "string" }, race: { type: "string" }, opponentRace: { type: "string" }, matchup: { type: "string" }, map: { type: "string" }, timeSeconds: { type: "number" }, limitExamples: { type: "integer", maximum: 25 }, replay_ids: { type: "array", items: { type: "string" } } } } },
      { name: "get_player_replay_card", description: "replay card", inputSchema: { type: "object", properties: { replayId: { type: "string" }, player: { type: "string" } }, required: ["replayId", "player"] } },
      { name: "execute_query_plan", description: "mutating", inputSchema: { type: "object", properties: {} } }
    ] };
    return { content: [{ type: "text", text: "31 workers" }], structuredContent: { workers: 31 } };
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
});

import { describe, expect, it } from "bun:test";
import {
  TurnRuntime,
  type RuntimeStore,
  type RuntimeTurn,
  type RuntimeMessage,
  type LlmProvider,
  type LlmResponse,
  type ChatMessage,
} from "../src/agent/runtime.ts";
import { OpenRouterResponsesProvider } from "../src/llm/openrouter.ts";

class FakeStore implements RuntimeStore {
  queue: RuntimeTurn[] = [];
  completed: string[] = [];
  failed: string[] = [];
  skipped: string[] = [];
  async getReplayInventory(): Promise<Array<{ replayNumber: number; corpusId: string; replaySha256: string; displayName: string | null; analysisAvailable: boolean }>> { return []; }
  async enqueueMessage(message: RuntimeMessage) {
    const turn: RuntimeTurn = {
      id: message.messageId,
      message,
      status: "queued",
      attemptCount: 0,
    };
    this.queue.push(turn);
    return { accepted: true, turn };
  }
  async claimNextTurn(sessionId: string) {
    const i = this.queue.findIndex(
      (t) => t.message.sessionId === sessionId && t.status === "queued",
    );
    if (i < 0) return undefined;
    const t = this.queue[i];
    t.status = "running";
    t.attemptCount++;
    return t;
  }
  async listQueuedSessionIds() {
    return [
      ...new Set(
        this.queue
          .filter((t) => t.status === "queued")
          .map((t) => t.message.sessionId),
      ),
    ];
  }
  async getContext(_s: string, id: string): Promise<ChatMessage[]> {
    const t = this.queue.find((x) => x.id === id);
    return [
      { role: "system", content: "system" },
      { role: "user", content: t?.message.content ?? "" },
    ];
  }
  async completeTurn(id: string, _response: LlmResponse) {
    this.completed.push(id);
    const t = this.queue.find((x) => x.id === id);
    if (t) t.status = "completed";
  }
  async failTurn(id: string, _error: string, retryable: boolean) {
    this.failed.push(id);
    const t = this.queue.find((x) => x.id === id);
    if (t) t.status = retryable ? "queued" : "failed";
  }
  async skipTurn(id: string) {
    this.skipped.push(id);
    const t = this.queue.find((x) => x.id === id);
    if (t) t.status = "skipped";
  }
  async recoverRunningTurns() {}
}
const msg = (id: string, sessionId = "1"): RuntimeMessage => ({
  messageId: id,
  sessionId,
  threadId: sessionId,
  guildId: "g",
  parentChannelId: "p",
  authorId: "u",
  content: id,
});

describe("TurnRuntime", () => {
  it("preserves OpenRouter-provided aggregate filters through gateway dispatch", async () => {
    const store = new FakeStore();
    const gatewayInputs: any[] = [];
    const logs: Array<{ message: string; details?: Record<string, unknown> }> = [];
    let providerRequests = 0;
    const provider = new OpenRouterResponsesProvider("test-key", (async (_url: RequestInfo | URL, init?: RequestInit) => {
      providerRequests++;
      if (providerRequests > 1) return new Response(JSON.stringify({ status: "completed", output_text: "ZvP results." }));
      const body = JSON.parse(String(init?.body));
      expect(body.tools[0]).toMatchObject({ type: "function", name: "get_economy_distribution" });
      expect(body.tools[0].parameters.required).toContain("corpus_id");
      expect(body.tools[0].parameters.required).not.toContain("race");
      expect(body.tools[0].strict).toBeUndefined();
      expect(body.tool_choice).toBe("auto");
      return new Response(JSON.stringify({ status: "completed", output: [{ type: "function_call", call_id: "provider-call", name: "get_economy_distribution",
        arguments: '{"corpus_id":"pro","race":"zerg","opponentRace":"protoss","matchup":"ZvP","timeSeconds":300,"map":"SecretMap","player":"SecretPlayer"}' }] }));
    }) as unknown as typeof fetch);
    const gateway = {
      listTools: async () => [{ name: "get_economy_distribution", description: "aggregate", corpusRequired: true as const,
        corpusId: "pro", corpusIds: ["pro"], inputSchema: { type: "object", properties: {
          race: { type: "string" }, opponentRace: { type: "string" }, matchup: { type: "string" }, timeSeconds: { type: "number" },
          map: { type: "string" }, player: { type: "string" }, corpus_id: { type: "string" },
        } } }],
      resetTurnBudget: () => {},
      call: async (input: any) => { gatewayInputs.push(input); return { sampleSize: 4 }; },
    };
    const rt = new TurnRuntime({ store, provider, maxConcurrent: 1, requestTimeoutMs: 1000, model: "openrouter/model",
      authorization: { authorize: async () => true }, delivery: { send: async () => {}, failure: async () => {} },
      log: (message, details) => logs.push({ message, details }),
      agent: { gateway, maxRounds: 3, maxToolCalls: 3, maxParallelCalls: 1, turnTimeoutMs: 1000, maxToolResultBytes: 2000, diagnosticToolArguments: true },
    });
    await rt.enqueue({ ...msg("provider-gateway-boundary"), content: "Compare Zerg versus Protoss in the professional corpus." }); await Bun.sleep(40);
    expect(gatewayInputs).toHaveLength(1);
    expect(gatewayInputs[0]).toMatchObject({ corpusId: "pro", name: "get_economy_distribution", arguments: { race: "zerg", opponentRace: "protoss", matchup: "ZvP", timeSeconds: 300, map: "SecretMap", player: "SecretPlayer" } });
    const diagnostics = logs.filter((entry) => entry.message === "tool argument diagnostic").map((entry) => entry.details);
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0]).toMatchObject({ stage: "provider_adapter", argumentKeys: ["corpus_id", "map", "matchup", "opponentRace", "player", "race", "timeSeconds"], filters: { race: "zerg", opponentRace: "protoss", matchup: "ZvP", timeSeconds: 300, map: "[redacted]", player: "[redacted]" } });
    expect(diagnostics[1]).toMatchObject({ stage: "gateway_dispatch", argumentKeys: ["map", "matchup", "opponentRace", "player", "race", "timeSeconds"], filters: { race: "zerg", opponentRace: "protoss", matchup: "ZvP", timeSeconds: 300, map: "[redacted]", player: "[redacted]" } });
    expect(JSON.stringify(diagnostics)).not.toContain("test-key");
    expect(JSON.stringify(diagnostics)).not.toContain("SecretMap");
    expect(JSON.stringify(diagnostics)).not.toContain("SecretPlayer");
    expect(store.completed).toEqual(["provider-gateway-boundary"]);
  });

  it("rejects an omitted explicit race pair before MCP and caches repeated incomplete calls", async () => {
    const store = new FakeStore();
    const requests: any[] = [];
    const logs: Array<{ message: string; details?: Record<string, unknown> }> = [];
    let gatewayCalls = 0;
    const provider = new OpenRouterResponsesProvider("test-key", (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)); requests.push(body);
      if (requests.length <= 3) return new Response(JSON.stringify({ status: "completed", output: [{ type: "function_call", call_id: `omitted-${requests.length}`,
        name: "get_economy_distribution", arguments: '{"corpus_id":"pro","timeSeconds":300}' }] }));
      return new Response(JSON.stringify({ status: "completed", output_text: "I need the race and matchup filters before I can compare." }));
    }) as unknown as typeof fetch);
    const gateway = {
      listTools: async () => [{ name: "get_economy_distribution", description: "aggregate", corpusRequired: true as const,
        corpusId: "pro", inputSchema: { type: "object", properties: { race: { type: "string" }, opponentRace: { type: "string" }, matchup: { type: "string" }, corpus_id: { type: "string" } } } }],
      resetTurnBudget: () => {}, call: async () => { gatewayCalls++; return { sampleSize: 4766 }; },
    };
    const rt = new TurnRuntime({ store, provider, maxConcurrent: 1, requestTimeoutMs: 1000,
      authorization: { authorize: async () => true }, delivery: { send: async () => {}, failure: async () => {} },
      log: (message, details) => logs.push({ message, details }),
      agent: { gateway, maxRounds: 4, maxToolCalls: 4, maxParallelCalls: 1, turnTimeoutMs: 1000, maxToolResultBytes: 2000, diagnosticToolArguments: true },
    });
    await rt.enqueue({ ...msg("explicit-filters-required"), content: "Benchmark professional Zerg-versus-Protoss players at 5:00." }); await Bun.sleep(40);
    expect(gatewayCalls).toBe(0);
    const feedback = requests[1].input.find((message: any) => message.type === "function_call_output")?.output ?? "";
    expect(feedback).toContain("aggregate_filters_required");
    expect(feedback).toContain("matching race, opponentRace, matchup");
    expect(feedback).toContain("No filters were inferred or applied");
    expect(requests).toHaveLength(4);
    const providerDiagnostics = logs.filter((entry) => entry.message === "tool argument diagnostic").map((entry) => entry.details);
    expect(providerDiagnostics).toHaveLength(3);
    expect(providerDiagnostics[0]).toMatchObject({ stage: "provider_adapter", argumentKeys: ["corpus_id", "timeSeconds"], filters: { timeSeconds: 300 } });
    expect(JSON.stringify(providerDiagnostics)).not.toContain("test-key");
    expect(store.completed).toEqual(["explicit-filters-required"]);
  });

  it("reuses a repeated identical unfiltered aggregate result across model rounds", async () => {
    const store = new FakeStore();
    let gatewayCalls = 0;
    let modelCalls = 0;
    const provider: LlmProvider = { generate: async () => {
      modelCalls++;
      if (modelCalls <= 2) return { text: "", provider: "fake", model: "m", toolCalls: [{ id: `repeat-${modelCalls}`, name: "get_economy_distribution",
        arguments: modelCalls === 1 ? '{"corpus_id":"pro","timeSeconds":300}' : '{ "timeSeconds":300, "corpus_id":"pro" }' }] };
      return { text: "The unfiltered result has 4,766 rows.", provider: "fake", model: "m" };
    } };
    const gateway = {
      listTools: async () => [{ name: "get_economy_distribution", description: "aggregate", corpusRequired: true as const, corpusId: "pro",
        inputSchema: { type: "object", properties: { timeSeconds: { type: "number" }, corpus_id: { type: "string" } } } }],
      resetTurnBudget: () => {}, call: async () => { gatewayCalls++; return { sampleSize: 4766 }; },
    };
    const rt = new TurnRuntime({ store, provider, maxConcurrent: 1, requestTimeoutMs: 1000,
      authorization: { authorize: async () => true }, delivery: { send: async () => {}, failure: async () => {} },
      agent: { gateway, maxRounds: 4, maxToolCalls: 4, maxParallelCalls: 1, turnTimeoutMs: 1000, maxToolResultBytes: 2000 },
    });
    await rt.enqueue({ ...msg("dedupe-rounds"), content: "Show the professional economy distribution at 5:00." }); await Bun.sleep(40);
    expect(gatewayCalls).toBe(1);
    expect(modelCalls).toBe(3);
    expect(store.completed).toEqual(["dedupe-rounds"]);
  });

  it("executes a validated replay-aware tool call and returns the next model answer", async () => {
    const store = new FakeStore();
    const hashes = "a".repeat(64);
    store.getReplayInventory = async () => [{ replayNumber: 2, corpusId: "community", replaySha256: hashes, displayName: "two.rep", analysisAvailable: true }];
    const calls: any[] = [];
    const gateway = {
      listTools: async () => [{ name: "get_economy", description: "economy", corpusRequired: true as const, corpusId: "community", corpusIds: ["community"], inputSchema: { type: "object", properties: { replay_ids: { type: "array", items: { type: "string" } }, at_seconds: { type: "number" } } } }],
      resetTurnBudget: () => {},
      call: async (input: any) => { calls.push(input); return { workers: 31, replay_id: hashes }; },
    };
    const requests: any[] = [];
    let delivered = "";
    const provider: LlmProvider = { generate: async (request) => {
      requests.push(request);
      if (requests.length === 1) return { text: "", provider: "fake", model: "m", toolCalls: [{ id: "call-1", name: "get_economy", arguments: JSON.stringify({ corpus_id: "community", replay_number: 2, at_seconds: 300 }) }] };
      return { text: "Replay #2 had 31 workers at 5:00.", provider: "fake", model: "m" };
    } };
    const rt = new TurnRuntime({ store, provider, maxConcurrent: 1, requestTimeoutMs: 1000,
      authorization: { authorize: async () => true },
      delivery: { send: async ({ text }) => { delivered = text; }, failure: async () => {} },
      agent: { gateway, maxRounds: 3, maxToolCalls: 4, maxParallelCalls: 2, turnTimeoutMs: 1000, maxToolResultBytes: 1000 },
    });
    await rt.enqueue(msg("analysis")); await Bun.sleep(30);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ corpusId: "community", name: "get_economy", arguments: { replay_number: 2, at_seconds: 300 } });
    expect(calls[0].allowedReplayRefs).toEqual([{ replayNumber: 2, corpusId: "community", replaySha256: hashes }]);
    expect(requests[0].tools[0].parameters.required).toContain("corpus_id");
    expect(requests[1].messages.at(-1)).toMatchObject({ role: "tool", toolCallId: "call-1" });
    expect(delivered).toContain("31 workers");
    expect(store.completed).toEqual(["analysis"]);
  });

  it("deduplicates equivalent tool calls while preserving each tool-call result", async () => {
    const store = new FakeStore();
    let gatewayCalls = 0;
    const gateway = {
      listTools: async () => [{ name: "get_economy", description: "economy", corpusRequired: true as const,
        corpusId: "community", corpusIds: ["community"], inputSchema: { type: "object", properties: {} } }],
      resetTurnBudget: () => {},
      call: async () => { gatewayCalls++; return { workers: 15 }; },
    };
    const requests: any[] = [];
    const provider: LlmProvider = { generate: async (request) => {
      requests.push(request);
      if (requests.length === 1) return { text: "", provider: "fake", model: "m", toolCalls: [1, 2].map((n) => ({
        id: `duplicate-${n}`, name: "get_economy", arguments: JSON.stringify({ corpus_id: "community", at_seconds: 300 }),
      })) };
      return { text: "The measured economy was 15 workers.", provider: "fake", model: "m" };
    } };
    const rt = new TurnRuntime({ store, provider, maxConcurrent: 1, requestTimeoutMs: 1000,
      authorization: { authorize: async () => true },
      delivery: { send: async () => {}, failure: async () => {} },
      agent: { gateway, maxRounds: 3, maxToolCalls: 1, maxParallelCalls: 2, turnTimeoutMs: 1000, maxToolResultBytes: 1000 },
    });
    await rt.enqueue(msg("dedupe")); await Bun.sleep(30);
    expect(gatewayCalls).toBe(1);
    expect(requests[0].system).toContain("Choose the smallest relevant set of tools");
    expect(requests[0].system).toContain("Translate every user-specified race, matchup, player, and map constraint");
    expect(requests[1].messages.filter((message: any) => message.role === "tool")).toHaveLength(2);
    expect(requests[1].messages.filter((message: any) => message.role === "tool").map((message: any) => message.toolCallId))
      .toEqual(["duplicate-1", "duplicate-2"]);
    expect(store.completed).toEqual(["dedupe"]);
  });

  it("rejects missing explicit aggregate race-pair filters before an unfiltered query", async () => {
    const store = new FakeStore();
    const requests: any[] = [];
    const gateway = {
      listTools: async () => [{ name: "get_economy_distribution", description: "aggregate economy", corpusRequired: true as const,
        corpusId: "pro", corpusIds: ["pro"], inputSchema: { type: "object", properties: {
          race: { type: "string" }, opponentRace: { type: "string" }, timeSeconds: { type: "number" }, corpus_id: { type: "string" },
        } } }],
      resetTurnBudget: () => {},
      call: async () => { throw new Error("incomplete aggregate call must not execute"); },
    };
    const provider: LlmProvider = { generate: async (request) => {
      requests.push(request);
      if (requests.length === 1) return { text: "", provider: "fake", model: "m", toolCalls: [{ id: "aggregate", name: "get_economy_distribution", arguments: JSON.stringify({ corpus_id: "pro", timeSeconds: 300 }) }] };
      return { text: "The result was unfiltered; I need to rerun it with the requested race and opponent race filters.", provider: "fake", model: "m" };
    } };
    const rt = new TurnRuntime({ store, provider, maxConcurrent: 1, requestTimeoutMs: 1000,
      authorization: { authorize: async () => true }, delivery: { send: async () => {}, failure: async () => {} },
      agent: { gateway, maxRounds: 3, maxToolCalls: 3, maxParallelCalls: 1, turnTimeoutMs: 1000, maxToolResultBytes: 2000 },
    });
    await rt.enqueue({ ...msg("aggregate-feedback"), content: "Compare Zerg versus Protoss at 5:00." }); await Bun.sleep(30);
    const toolContent = requests[1].messages.find((message: any) => message.role === "tool")?.content ?? "";
    expect(toolContent).toContain("aggregate_filters_required");
    expect(toolContent).toContain("matching race, opponentRace, matchup");
    expect(toolContent).toContain("No filters were inferred or applied");
    expect(store.completed).toEqual(["aggregate-feedback"]);
  });

  it("rejects partial aggregate calls when explicit race-pair constraints are missing", async () => {
    const store = new FakeStore();
    const requests: any[] = [];
    const gateway = {
      listTools: async () => [{ name: "get_economy_distribution", description: "aggregate economy", corpusRequired: true as const,
        corpusId: "pro", corpusIds: ["pro"], inputSchema: { type: "object", properties: {} } }],
      resetTurnBudget: () => {},
      call: async () => ({ structuredContent: { filters: { race: "Zerg", opponentRace: null, matchup: null, player: null, opponent: null, map: null, timeSeconds: 300 }, sampleSize: 12 } }),
    };
    const provider: LlmProvider = { generate: async (request) => {
      requests.push(request);
      if (requests.length === 1) return { text: "", provider: "fake", model: "m", toolCalls: [{ id: "partial", name: "get_economy_distribution", arguments: JSON.stringify({ corpus_id: "pro", race: "Zerg", timeSeconds: 300 }) }] };
      return { text: "The response applied race but omitted opponentRace, so I cannot present it as the requested matchup benchmark.", provider: "fake", model: "m" };
    } };
    const rt = new TurnRuntime({ store, provider, maxConcurrent: 1, requestTimeoutMs: 1000,
      authorization: { authorize: async () => true }, delivery: { send: async () => {}, failure: async () => {} },
      agent: { gateway, maxRounds: 3, maxToolCalls: 3, maxParallelCalls: 1, turnTimeoutMs: 1000, maxToolResultBytes: 2000 },
    });
    await rt.enqueue({ ...msg("aggregate-partial"), content: "Compare Zerg versus Protoss at 5:00." }); await Bun.sleep(30);
    const toolContent = requests[1].messages.find((message: any) => message.role === "tool")?.content ?? "";
    expect(toolContent).toContain("aggregate_filters_required");
    expect(toolContent).toContain("matching opponentRace, matchup");
    expect(store.completed).toEqual(["aggregate-partial"]);
  });

  it("stops the agent turn when the role is revoked before MCP execution", async () => {
    const store = new FakeStore(); let authCalls = 0, modelCalls = 0, toolCalls = 0;
    const gateway = {
      listTools: async () => [{ name: "get_economy", description: "economy", corpusRequired: true as const, corpusId: "community", inputSchema: { type: "object", properties: { replay_ids: { type: "array", items: { type: "string" } }, at_seconds: { type: "number" } } } }],
      resetTurnBudget: () => {}, call: async () => { toolCalls++; return {}; },
    };
    const rt = new TurnRuntime({ store, provider: { generate: async () => { modelCalls++; return { text: "", provider: "fake", model: "m", toolCalls: [{ id: "call", name: "get_economy", arguments: JSON.stringify({ corpus_id: "community", replay_number: 1, player: "z", at_seconds: 300 }) }] }; } },
      maxConcurrent: 1, requestTimeoutMs: 1000,
      authorization: { authorize: async () => ++authCalls < 4 },
      delivery: { send: async () => {}, failure: async () => {} },
      agent: { gateway, maxRounds: 3, maxToolCalls: 3, maxParallelCalls: 1, turnTimeoutMs: 1000, maxToolResultBytes: 1000 },
    });
    await rt.enqueue(msg("revoked-agent")); await Bun.sleep(30);
    expect(authCalls).toBe(4); expect(modelCalls).toBe(1); expect(toolCalls).toBe(0);
    expect(store.skipped).toEqual(["revoked-agent"]);
  });

  it("enforces the simultaneous MCP call cap across sessions", async () => {
    const store = new FakeStore();
    store.getReplayInventory = async () => [{ replayNumber: 1, corpusId: "community", replaySha256: "a".repeat(64), displayName: null, analysisAvailable: true }];
    let active = 0, maximum = 0;
    const gateway = {
      listTools: async () => [{ name: "get_economy", description: "economy", corpusRequired: true as const, corpusId: "community", inputSchema: { type: "object", properties: { replay_ids: { type: "array", items: { type: "string" } }, at_seconds: { type: "number" } } } }],
      resetTurnBudget: () => {},
      call: async () => { active++; maximum = Math.max(maximum, active); await Bun.sleep(10); active--; return { workers: 31 }; },
    };
    const runtime = new TurnRuntime({ store, maxConcurrent: 2, requestTimeoutMs: 1000,
      provider: { generate: async (request) => request.messages.some((message) => message.role === "tool")
        ? { text: "done", provider: "mock", model: "m" }
        : { text: "", provider: "mock", model: "m", toolCalls: [1, 2].map((n) => ({ id: `call-${n}`, name: "get_economy", arguments: JSON.stringify({ corpus_id: "community", replay_number: 1, player: "z", at_seconds: 300 }) })) } },
      authorization: { authorize: async () => true }, delivery: { send: async () => {}, failure: async () => {} },
      agent: { gateway, maxRounds: 3, maxToolCalls: 3, maxParallelCalls: 1, turnTimeoutMs: 1000, maxToolResultBytes: 1000 },
    });
    await Promise.all([runtime.enqueue(msg("parallel-a", "1")), runtime.enqueue(msg("parallel-b", "2"))]);
    await Bun.sleep(120);
    expect(store.completed).toHaveLength(2);
    expect(maximum).toBe(1);
  });

  it("serializes a session while allowing another session to run", async () => {
    const store = new FakeStore();
    let active = 0;
    let max = 0;
    const provider: LlmProvider = {
      async generate(r) {
        active++;
        max = Math.max(max, active);
        await Bun.sleep(10);
        active--;
        return {
          text: r.messages.at(-1)?.content ?? "",
          provider: "fake",
          model: "fake",
        };
      },
    };
    const rt = new TurnRuntime({
      store,
      provider,
      maxConcurrent: 2,
      requestTimeoutMs: 1000,
      authorization: { authorize: async () => true },
      delivery: { send: async () => {}, failure: async () => {} },
    });
    await Promise.all([
      rt.enqueue(msg("a", "1")),
      rt.enqueue(msg("b", "1")),
      rt.enqueue(msg("c", "2")),
    ]);
    await Bun.sleep(80);
    expect(store.completed).toHaveLength(3);
    expect(max).toBe(2);
  });

  it("rechecks authorization before the paid request", async () => {
    const store = new FakeStore();
    let calls = 0;
    const rt = new TurnRuntime({
      store,
      provider: {
        generate: async () => {
          calls++;
          return { text: "x", provider: "f", model: "f" };
        },
      },
      maxConcurrent: 1,
      requestTimeoutMs: 1000,
      authorization: { authorize: async () => ++calls === 1 },
      delivery: { send: async () => {}, failure: async () => {} },
    });
    await rt.enqueue(msg("revoked"));
    await Bun.sleep(20);
    expect(calls).toBe(2);
    expect(store.skipped).toEqual(["revoked"]);
  });

  it("times out a provider that ignores cancellation", async () => {
    const store = new FakeStore();
    const rt = new TurnRuntime({
      store,
      provider: { generate: async () => new Promise<LlmResponse>(() => {}) },
      maxConcurrent: 1,
      requestTimeoutMs: 10,
      authorization: { authorize: async () => true },
      delivery: { send: async () => {}, failure: async () => {} },
      maxAttempts: 1,
    });
    await rt.enqueue(msg("slow"));
    await Bun.sleep(30);
    expect(store.failed).toEqual(["slow"]);
  });

  it("drains many independent sessions with a global limit of one", async () => {
    const store = new FakeStore();
    let completed = 0;
    const rt = new TurnRuntime({
      store,
      provider: {
        generate: async () => {
          await Bun.sleep(2);
          return { text: "ok", provider: "f", model: "m" };
        },
      },
      maxConcurrent: 1,
      requestTimeoutMs: 1000,
      authorization: { authorize: async () => true },
      delivery: {
        send: async () => {
          completed++;
        },
        failure: async () => {},
      },
    });
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        rt.enqueue(msg(`many-${i}`, String(i))),
      ),
    );
    await Bun.sleep(300);
    expect(completed).toBe(8);
  });
});

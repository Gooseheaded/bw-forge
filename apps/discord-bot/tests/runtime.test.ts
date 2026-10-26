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

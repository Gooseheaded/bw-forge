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

import { expect, test } from "bun:test";
import { createSafeLogger, sanitizeEvent } from "../src/observability.ts";

test("structured diagnostics drop arbitrary model values and sensitive identities", () => {
  const sentinel = "SECRET-CONTENT /srv/private/corpus.sqlite " + "f".repeat(64);
  const event = sanitizeEvent("tool call", {
    event: "tool_call_completed", toolName: "get_economy", toolCallId: "call-1", corpusId: "community",
    arguments: { password: sentinel }, argumentKeys: ["password", "replaySha256", "race"], argumentKinds: ["string", "secret", "number"],
    error: sentinel, path: sentinel, replaySha256: sentinel,
  }, { diagnostic: true, corpusIds: ["community"] });
  expect(event).toMatchObject({ event: "tool_call_completed", corpusId: "community", argumentKeys: ["race"], argumentKinds: ["string", "number"] });
  expect(String(event.toolCallId)).toMatch(/^ref-[0-9a-f]{16}$/);
  expect(JSON.stringify(event)).not.toContain(sentinel);
});

test("safe logger keeps known operational fields and rejects unsafe labels", () => {
  const seen: Record<string, unknown>[] = [];
  createSafeLogger((value) => seen.push(value), { diagnostic: true, provider: "openrouter", model: "provider/model", corpusIds: ["community"] })("turn completed", {
    event: "turn_completed", turnId: "turn-1", sessionId: "session-1", provider: "openrouter", model: "provider/model",
    durationMs: 42, totalTokens: 12, retryCount: 1, code: "network", message: "raw secret", argumentKeys: ["race", "evil"],
  });
  expect(seen[0]).toMatchObject({ event: "turn_completed", turnId: "turn-1", provider: "openrouter", model: "provider/model", durationMs: 42, totalTokens: 12, retryCount: 1, code: "network", argumentKeys: ["race"] });
  expect(seen[0]).not.toHaveProperty("message");
});

test("unknown event names are normalized without retaining attacker input", () => {
  const value = sanitizeEvent("evil\nsecret", { event: "evil\nsecret", corpusId: "SECRET", model: "SECRET" }, { corpusIds: ["community"], model: "provider/model" });
  expect(value).toEqual({ event: "unknown_event" });
});

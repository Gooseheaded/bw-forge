import { describe, expect, test } from "bun:test";
import { assembleContext } from "../src/agent/context.ts";
describe("context", () => {
  test("orders, deduplicates trigger, and bounds history", () => {
    const x = assembleContext({
      history: [
        { role: "user", content: "old", messageId: "1" },
        { role: "assistant", content: "answer", messageId: "2" },
        { role: "user", content: "new", messageId: "3" },
      ],
      triggeringMessage: { role: "user", content: "new", messageId: "3" },
      budget: 5000,
    });
    expect(x.messages.map((m) => m.content)).toEqual(["old", "answer", "new"]);
  });
  test("clips an oversized trigger", () => {
    const x = assembleContext({
      history: [],
      triggeringMessage: { role: "user", content: "x".repeat(1000) },
      budget: 5000,
    });
    expect(x.messages).toHaveLength(1);
    expect(
      new TextEncoder().encode(x.messages[0].content).byteLength,
    ).toBeLessThan(5000);
  });
  test("rejects an impossible budget", () => {
    expect(() =>
      assembleContext({
        history: [],
        triggeringMessage: { role: "user", content: "x" },
        budget: 10,
      }),
    ).toThrow("system instructions");
  });
  test("clips Unicode on code point boundaries", () => {
    const x = assembleContext({
      history: [],
      triggeringMessage: { role: "user", content: "😀".repeat(1000) },
      budget: 3500,
    });
    expect(x.messages[0].content).not.toContain("�");
  });
});

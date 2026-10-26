import { describe, expect, test } from "bun:test";
import { OpenAiResponsesProvider } from "../src/llm/openai.ts";
const request = (
  fetcher: (url: string, init: RequestInit) => Promise<Response>,
) => fetcher as unknown as typeof fetch;
const req = {
  model: "m",
  system: "system",
  messages: [{ role: "user" as const, content: "hi" }],
  maxOutputTokens: 20,
  timeoutMs: 1000,
};
describe("OpenAI provider", () => {
  test("sends stateless roles and parses response", async () => {
    let init: any;
    const p = new OpenAiResponsesProvider(
      "secret",
      "https://example.test",
      request(async (_u, i) => {
        init = i;
        return new Response(
          JSON.stringify({
            model: "m",
            output_text: "hello",
            usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
          }),
          { status: 200 },
        );
      }),
    );
    const result = await p.generate(req);
    expect(result.text).toBe("hello");
    const body = JSON.parse(String(init.body));
    expect(body.store).toBe(false);
    expect(body.instructions).toBe("system");
    expect(body.input[0].role).toBe("user");
    expect(body.input[0].content).toBe("hi");
  });
  test("serializes approved tools and parses structured calls", async () => {
    let body: any;
    const p = new OpenAiResponsesProvider("secret", "x", request(async (_u, i) => {
      body = JSON.parse(String(i.body));
      return new Response(JSON.stringify({
        status: "completed",
        output: [{ type: "function_call", call_id: "call-1", name: "get_economy", arguments: '{"time":300}' }],
      }));
    }));
    const result = await p.generate({
      ...req,
      tools: [{ name: "get_economy", description: "Read economy", parameters: { type: "object", properties: {} } }],
    });
    expect(body.tools[0]).toMatchObject({ type: "function", name: "get_economy" });
    expect(result.toolCalls).toEqual([{ id: "call-1", name: "get_economy", arguments: '{"time":300}' }]);
    expect(result.text).toBe("");
    expect(result.status).toBe("completed");
  });
  test("parses multiple structured tool requests from one response", async () => {
    const p = new OpenAiResponsesProvider("secret", "x", request(async () => new Response(JSON.stringify({
      status: "completed", output: [
        { type: "function_call", call_id: "call-a", name: "get_economy", arguments: '{"at_seconds":300}' },
        { type: "function_call", call_id: "call-b", name: "get_corpus_summary", arguments: "{}" },
      ],
    }))));
    const result = await p.generate({ ...req, tools: [
      { name: "get_economy", parameters: { type: "object" } },
      { name: "get_corpus_summary", parameters: { type: "object" } },
    ] });
    expect(result.toolCalls?.map((call) => [call.id, call.name])).toEqual([
      ["call-a", "get_economy"], ["call-b", "get_corpus_summary"],
    ]);
  });
  test("preserves aggregate filters exactly as returned by the provider", async () => {
    const argumentsJson = JSON.stringify({ corpus_id: "pro", race: "Zerg", matchup: "ZvP", timeSeconds: 300 });
    const p = new OpenAiResponsesProvider("secret", "x", request(async () => new Response(JSON.stringify({
      status: "completed", output: [
        { type: "function_call", call_id: "aggregate-call", name: "get_economy_distribution", arguments: argumentsJson },
      ],
    }))));
    const result = await p.generate({ ...req, tools: [
      { name: "get_economy_distribution", parameters: { type: "object" } },
    ] });
    expect(result.toolCalls?.[0]?.arguments).toBe(argumentsJson);
  });
  test("preserves function call outputs and incomplete status", async () => {
    let body: any;
    const p = new OpenAiResponsesProvider("secret", "x", request(async (_u, i) => {
      body = JSON.parse(String(i.body));
      return new Response(JSON.stringify({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] }));
    }));
    const result = await p.generate({
      ...req,
      messages: [
        { role: "user", content: "question" },
        { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "get_economy", arguments: "{}" }] },
        { role: "tool", toolCallId: "call-1", toolName: "get_economy", content: '{"workers":31}' },
      ],
    });
    expect(body.input).toEqual([
      { role: "user", content: "question" },
      { type: "function_call", call_id: "call-1", name: "get_economy", arguments: "{}" },
      { type: "function_call_output", call_id: "call-1", output: '{"workers":31}' },
    ]);
    expect(result.status).toBe("incomplete");
    expect(result.incompleteReason).toBe("max_output_tokens");
  });
  test("classifies provider failures without leaking body", async () => {
    const p401 = new OpenAiResponsesProvider(
      "secret",
      "x",
      request(async () => new Response("secret body", { status: 401 })),
    );
    await expect(p401.generate(req)).rejects.toMatchObject({
      code: "http_401",
      retryable: false,
    });
    const p429 = new OpenAiResponsesProvider(
      "secret",
      "x",
      request(async () => new Response("", { status: 429 })),
    );
    await expect(p429.generate(req)).rejects.toMatchObject({
      code: "http_429",
      retryable: true,
    });
  });
  test("handles malformed and empty responses", async () => {
    const bad = new OpenAiResponsesProvider(
      "secret",
      "x",
      request(async () => new Response("{", { status: 200 })),
    );
    await expect(bad.generate(req)).rejects.toMatchObject({
      code: "invalid_response",
    });
    const empty = new OpenAiResponsesProvider(
      "secret",
      "x",
      request(
        async () =>
          new Response(JSON.stringify({ output: [] }), { status: 200 }),
      ),
    );
    await expect(empty.generate(req)).rejects.toMatchObject({
      code: "empty_response",
    });
  });
  test("honors model, temperature, timeout, and caller cancellation", async () => {
    let body: any;
    const p = new OpenAiResponsesProvider(
      "secret",
      "x",
      request(async (_u, i) => {
        body = JSON.parse(String(i.body));
        return new Response(JSON.stringify({ output_text: "ok" }), {
          status: 200,
        });
      }),
    );
    await p.generate({ ...req, model: "chosen", temperature: 0.2 });
    expect(body.model).toBe("chosen");
    expect(body.temperature).toBe(0.2);
    const slow = new OpenAiResponsesProvider(
      "secret",
      "x",
      request(
        () =>
          new Promise<Response>((resolve) =>
            setTimeout(
              () =>
                resolve(new Response(JSON.stringify({ output_text: "late" }))),
              30,
            ),
          ),
      ),
    );
    await expect(slow.generate({ ...req, timeoutMs: 2 })).rejects.toMatchObject(
      { code: "timeout" },
    );
    const controller = new AbortController();
    controller.abort();
    await expect(
      p.generate({ ...req, signal: controller.signal }),
    ).rejects.toMatchObject({ code: "cancelled" });
  });
  test("cancels an in-flight request even when fetch ignores abort", async () => {
    let called = false;
    const controller = new AbortController();
    const p = new OpenAiResponsesProvider(
      "secret",
      "x",
      request(async () => {
        called = true;
        return new Promise<Response>(() => {});
      }),
    );
    const pending = p.generate({ ...req, signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 2));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    expect(called).toBe(true);
    let preCalled = false;
    const pre = new AbortController();
    pre.abort();
    const preProvider = new OpenAiResponsesProvider(
      "secret",
      "x",
      request(async () => {
        preCalled = true;
        return new Response();
      }),
    );
    await expect(
      preProvider.generate({ ...req, signal: pre.signal }),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(preCalled).toBe(false);
  });
  test("times out a stalled response body and ignores null output shapes", async () => {
    const stalled = new ReadableStream<Uint8Array>({ start() {} });
    const p = new OpenAiResponsesProvider(
      "secret",
      "x",
      request(async () => new Response(stalled)),
    );
    await expect(p.generate({ ...req, timeoutMs: 3 })).rejects.toMatchObject({
      code: "timeout",
    });
    const malformed = new OpenAiResponsesProvider(
      "secret",
      "x",
      request(
        async () =>
          new Response(JSON.stringify({ output: [null, { content: [null] }] })),
      ),
    );
    await expect(malformed.generate(req)).rejects.toMatchObject({
      code: "empty_response",
    });
  });
});

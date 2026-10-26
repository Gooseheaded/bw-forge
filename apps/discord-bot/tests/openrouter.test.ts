import { describe, expect, test } from "bun:test";
import { OpenRouterResponsesProvider } from "../src/llm/openrouter.ts";
import { createLlmProvider } from "../src/llm/factory.ts";
const req = {
  model: "router/model",
  system: "sys",
  messages: [
    { role: "user" as const, content: "one" },
    { role: "assistant" as const, content: "two" },
  ],
  maxOutputTokens: 32,
  timeoutMs: 100,
};
const mock = (response: Response, seen: { url?: string; init?: RequestInit }) =>
  (async (url: string, init: RequestInit) => {
    seen.url = url;
    seen.init = init;
    return response;
  }) as unknown as typeof fetch;
describe("OpenRouter provider", () => {
  test("uses official endpoint, auth, history, and usage", async () => {
    const seen: any = {};
    const p = new OpenRouterResponsesProvider(
      "secret",
      mock(
        new Response(
          JSON.stringify({
            model: "router/model",
            output_text: "ok",
            usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
          }),
        ),
        seen,
      ),
    );
    const out = await p.generate(req);
    expect(seen.url).toBe("https://openrouter.ai/api/v1/responses");
    expect((seen.init?.headers as any).authorization).toBe("Bearer secret");
    const body = JSON.parse(String(seen.init?.body));
    expect(body.store).toBe(false);
    expect(body.instructions).toBe("sys");
    expect(body.input).toEqual(req.messages);
    expect(body.max_output_tokens).toBe(32);
    expect(body.previous_response_id).toBeUndefined();
    expect(out.provider).toBe("openrouter");
    expect(out.model).toBe("router/model");
    expect(out.usage).toEqual({
      inputTokens: 2,
      outputTokens: 3,
      totalTokens: 5,
    });
  });
  test("factory selects provider endpoints and identities and rejects unknown selector", async () => {
    for (const [provider, endpoint] of [
      ["openai", "https://api.openai.com/v1/responses"],
      ["openrouter", "https://openrouter.ai/api/v1/responses"],
    ] as const) {
      const seen: { url?: string; init?: RequestInit } = {};
      const response = await createLlmProvider(
        { provider, apiKey: "x" },
        mock(new Response(JSON.stringify({ output_text: "ok" })), seen),
      ).generate(req);
      expect(seen.url).toBe(endpoint);
      expect(response.provider).toBe(provider);
    }
    expect(() =>
      createLlmProvider({ provider: "invalid" as any, apiKey: "x" }),
    ).toThrow();
  });
  test("supports the shared structured tool protocol and call correlation", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const p = new OpenRouterResponsesProvider("secret", mock(new Response(JSON.stringify({ status: "completed", output: [
      { type: "function_call", call_id: "router-call", name: "get_economy", arguments: '{"replay_number":1}' },
    ] })), seen));
    const response = await p.generate({ ...req, tools: [{ name: "get_economy", parameters: { type: "object", properties: {} } }] });
    expect(JSON.parse(String(seen.init?.body)).tools[0].name).toBe("get_economy");
    expect(response.toolCalls).toEqual([{ id: "router-call", name: "get_economy", arguments: '{"replay_number":1}' }]);
  });
  test("honors canonical top-level errors and embedded numeric credit errors", async () => {
    for (const [payload, retryable] of [
      [
        {
          status: "failed",
          error_type: "authentication",
          error: { code: "server_error", message: "secret" },
        },
        false,
      ],
      [
        {
          status: "failed",
          error_type: "invalid_request",
          error: { code: "server_error", message: "secret" },
        },
        false,
      ],
      [
        {
          status: "failed",
          error_type: "provider_unavailable",
          error: { code: "server_error", message: "secret" },
        },
        true,
      ],
      [{ error: { code: 402, message: "secret" } }, false],
      [{ error: { code: 429, message: "secret" } }, true],
    ] as const) {
      const provider = new OpenRouterResponsesProvider(
        "secret",
        mock(new Response(JSON.stringify(payload)), {}),
      );
      await expect(provider.generate(req)).rejects.toMatchObject({
        code: "provider_failed",
        retryable,
      });
    }
  });
  test("classifies HTTP and embedded errors without leaking body", async () => {
    for (const [status, retryable] of [
      [401, false],
      [402, false],
      [429, true],
      [503, true],
    ] as const) {
      const p = new OpenRouterResponsesProvider(
        "secret",
        mock(new Response("raw secret details", { status }), {}),
      );
      await expect(p.generate(req)).rejects.toMatchObject({
        code: `http_${status}`,
        retryable,
      });
    }
    for (const [error_type, retryable] of [
      ["authentication_error", false],
      ["rate_limit_exceeded", true],
      ["provider_unavailable", true],
    ] as const) {
      const p = new OpenRouterResponsesProvider(
        "secret",
        mock(
          new Response(
            JSON.stringify({
              error: {
                error_type,
                code: "server_error",
                message: "raw secret",
              },
            }),
            { status: 200 },
          ),
          {},
        ),
      );
      const error = await p.generate(req).catch((e) => e);
      expect(error.code).toBe("provider_failed");
      expect(error.retryable).toBe(retryable);
      expect(String(error)).not.toContain("raw secret");
    }
  });
  test("rejects failed responses even with partial output", async () => {
    const p = new OpenRouterResponsesProvider(
      "secret",
      mock(
        new Response(
          JSON.stringify({ status: "failed", output_text: "partial" }),
          { status: 200 },
        ),
        {},
      ),
    );
    await expect(p.generate(req)).rejects.toMatchObject({
      code: "provider_failed",
    });
  });
});

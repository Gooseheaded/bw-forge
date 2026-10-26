import {
  LlmProviderError,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
} from "./types.ts";
type ApiResponse = {
  model?: unknown;
  output?: unknown;
  output_text?: unknown;
  usage?: Record<string, unknown>;
};

async function bodyText(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > limit)
    throw new LlmProviderError(
      "LLM provider response was too large",
      "oversized_response",
      true,
    );
  if (!response.body) return response.text();
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new LlmProviderError(
          "LLM provider response was too large",
          "oversized_response",
          true,
        );
      }
      parts.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    bytes.set(p, offset);
    offset += p.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export class OpenAiResponsesProvider implements LlmProvider {
  constructor(
    private readonly apiKey: string,
    private readonly endpoint = "https://api.openai.com/v1/responses",
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  async generate(request: LlmRequest): Promise<LlmResponse> {
    if (request.signal?.aborted)
      throw new LlmProviderError(
        "LLM request was cancelled",
        "cancelled",
        true,
      );
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    request.signal?.addEventListener("abort", onAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectCancel!: (reason: unknown) => void;
    const cancel = new Promise<never>((_, reject) => {
      rejectCancel = reject;
    });
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new LlmProviderError("LLM request timed out", "timeout", true));
      }, request.timeoutMs);
    });
    const rejectOnAbort = () =>
      rejectCancel(
        new LlmProviderError("LLM request was cancelled", "cancelled", true),
      );
    request.signal?.addEventListener("abort", rejectOnAbort, { once: true });
    try {
      const input = request.messages.map((message) => ({
        role: message.role,
        content: message.content,
      }));
      const body: Record<string, unknown> = {
        model: request.model,
        instructions: request.system,
        input,
        max_output_tokens: request.maxOutputTokens,
        store: false,
      };
      if (request.temperature !== undefined)
        body.temperature = request.temperature;
      const operation = (async () => {
        let response: Response;
        try {
          response = await this.fetchImpl(this.endpoint, {
            method: "POST",
            headers: {
              authorization: `Bearer ${this.apiKey}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
        } catch (e) {
          if (e instanceof LlmProviderError) throw e;
          throw new LlmProviderError(
            "LLM request could not be sent",
            "network",
            true,
          );
        }
        if (!response.ok) {
          const retryable =
            response.status === 408 ||
            response.status === 409 ||
            response.status === 429 ||
            response.status >= 500;
          throw new LlmProviderError(
            `LLM provider returned HTTP ${response.status}`,
            `http_${response.status}`,
            retryable,
          );
        }
        let data: ApiResponse;
        try {
          data = JSON.parse(
            await bodyText(
              response,
              Math.max(4096, request.maxOutputTokens * 64),
            ),
          ) as ApiResponse;
        } catch (e) {
          if (e instanceof LlmProviderError) throw e;
          throw new LlmProviderError(
            "LLM provider returned invalid JSON",
            "invalid_response",
          );
        }
        if (!data || typeof data !== "object")
          throw new LlmProviderError(
            "LLM provider returned an invalid response",
            "invalid_response",
          );
        let text = typeof data.output_text === "string" ? data.output_text : "";
        if (!text && Array.isArray(data.output))
          for (const item of data.output)
            if (
              item &&
              typeof item === "object" &&
              Array.isArray((item as any).content)
            )
              for (const part of (item as any).content)
                if (
                  part &&
                  typeof part === "object" &&
                  part.type === "output_text" &&
                  typeof part.text === "string"
                )
                  text += part.text;
        if (!text.trim())
          throw new LlmProviderError(
            "LLM provider returned no text",
            "empty_response",
            true,
          );
        const u = data.usage;
        const usage = u
          ? {
              inputTokens:
                typeof u.input_tokens === "number" ? u.input_tokens : undefined,
              outputTokens:
                typeof u.output_tokens === "number"
                  ? u.output_tokens
                  : undefined,
              totalTokens:
                typeof u.total_tokens === "number" ? u.total_tokens : undefined,
            }
          : undefined;
        return {
          text,
          provider: "openai",
          model: typeof data.model === "string" ? data.model : request.model,
          usage,
        };
      })();
      return await Promise.race([operation, timeout, cancel]);
    } finally {
      if (timer) clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
      request.signal?.removeEventListener("abort", rejectOnAbort);
    }
  }
}

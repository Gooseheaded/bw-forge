import {
  LlmProviderError,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
} from "./types.ts";
export interface ResponsesOptions {
  apiKey: string;
  endpoint: string;
  provider: "openai" | "openrouter";
  fetchImpl?: typeof fetch;
}
type ApiResponse = {
  model?: unknown;
  status?: unknown;
  error?: unknown;
  error_type?: unknown;
  output?: unknown;
  output_text?: unknown;
  usage?: Record<string, unknown>;
};

function responseInput(request: LlmRequest): unknown[] {
  const input: unknown[] = [];
  for (const message of request.messages) {
    if (message.role === "tool") {
      if (message.toolCallId) {
        input.push({ type: "function_call_output", call_id: message.toolCallId, output: message.content });
      }
      continue;
    }
    if (message.toolCalls?.length) {
      for (const call of message.toolCalls) {
        input.push({ type: "function_call", call_id: call.id, name: call.name, arguments: call.arguments });
      }
      if (message.content) input.push({ role: message.role, content: message.content });
      continue;
    }
    input.push({ role: message.role, content: message.content });
  }
  return input;
}

// Only known classifications influence retries; provider text is never exposed.
function retryableFailure(data: ApiResponse): boolean {
  const error =
    data.error && typeof data.error === "object"
      ? (data.error as Record<string, unknown>)
      : {};
  const terminal = new Set([
    "authentication",
    "authentication_error",
    "invalid_api_key",
    "permission_denied",
    "forbidden",
    "payment_required",
    "insufficient_credits",
    "insufficient_quota",
    "invalid_request",
    "invalid_request_error",
    "invalid_prompt",
    "context_length_exceeded",
    "content_policy_violation",
    "image_content_policy_violation",
    "refusal",
    "not_found",
    "model_not_found",
    "invalid_model",
  ]);
  const transient = new Set([
    "rate_limit_exceeded",
    "rate_limit_error",
    "provider_overloaded",
    "provider_unavailable",
    "overloaded_error",
    "timeout",
    "request_timeout",
    "server",
    "server_error",
    "internal_server_error",
    "service_unavailable",
  ]);
  for (const type of [
    data.error_type,
    error.error_type,
    error.type,
    error.code,
  ]) {
    if (typeof type !== "string") continue;
    if (terminal.has(type)) return false;
    if (transient.has(type)) return true;
  }
  const status =
    typeof error.code === "number"
      ? error.code
      : typeof error.code === "string" && /^\d{3}$/.test(error.code)
        ? Number(error.code)
        : undefined;
  if (status !== undefined)
    return status === 408 || status === 409 || status === 429 || status >= 500;
  return true;
}

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

export class ResponsesProvider implements LlmProvider {
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly provider: "openai" | "openrouter";
  constructor(options: ResponsesOptions) {
    this.apiKey = options.apiKey;
    this.endpoint = options.endpoint;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.provider = options.provider;
  }
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
      const body: Record<string, unknown> = {
        model: request.model,
        instructions: request.system,
        input: responseInput(request),
        max_output_tokens: request.maxOutputTokens,
        store: false,
      };
      if (request.temperature !== undefined)
        body.temperature = request.temperature;
      if (request.tools?.length) {
        body.tools = request.tools.map((tool) => ({
          type: "function",
          name: tool.name,
          ...(tool.description ? { description: tool.description } : {}),
          parameters: tool.parameters,
        }));
        body.tool_choice = request.toolChoice ?? "auto";
      }
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
        if (!data || typeof data !== "object" || Array.isArray(data))
          throw new LlmProviderError(
            "LLM provider returned an invalid response",
            "invalid_response",
          );
        if (data.status === "failed" || data.error != null) {
          throw new LlmProviderError(
            "LLM provider reported a failed response",
            "provider_failed",
            retryableFailure(data),
          );
        }
        let text = typeof data.output_text === "string" ? data.output_text : "";
        const toolCalls: import("./types.ts").LlmToolCall[] = [];
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
        if (Array.isArray(data.output)) {
          for (const item of data.output) {
            if (!item || typeof item !== "object") continue;
            const value = item as Record<string, unknown>;
            if (value.type !== "function_call") continue;
            if (typeof value.call_id !== "string" || typeof value.name !== "string")
              throw new LlmProviderError("LLM provider returned an invalid tool call", "invalid_response");
            const args = typeof value.arguments === "string" ? value.arguments : JSON.stringify(value.arguments ?? {});
            toolCalls.push({ id: value.call_id, name: value.name, arguments: args });
          }
        }
        const incomplete = data.status === "incomplete" || data.status === "in_progress";
        const responseStatus: LlmResponse["status"] = incomplete ? "incomplete" : "completed";
        if (!text.trim() && !toolCalls.length && !incomplete)
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
          toolCalls: toolCalls.length ? toolCalls : undefined,
          status: responseStatus,
          incompleteReason: incomplete && typeof (data as any).incomplete_details?.reason === "string"
            ? (data as any).incomplete_details.reason : undefined,
          provider: this.provider,
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

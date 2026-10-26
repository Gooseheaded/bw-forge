export type LlmRole = "system" | "user" | "assistant";

/** Provider-neutral JSON schema exposed to a hosted model. */
export interface LlmToolDefinition {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

export interface LlmToolCall {
  id: string;
  name: string;
  /** JSON encoded arguments, retained as text until the gateway validates them. */
  arguments: string;
}

export interface LlmToolResult {
  toolCallId: string;
  name?: string;
  content: string;
  isError?: boolean;
}

export interface LlmMessage {
  role: LlmRole;
  content: string;
  toolCalls?: LlmToolCall[];
}

export interface LlmToolMessage {
  role: "tool";
  content: string;
  toolCallId: string;
  toolName?: string;
}

export type LlmInputMessage = LlmMessage | LlmToolMessage;

export interface LlmRequest {
  model: string;
  system: string;
  messages: LlmInputMessage[];
  maxOutputTokens: number;
  timeoutMs: number;
  temperature?: number;
  signal?: AbortSignal;
  tools?: LlmToolDefinition[];
  toolChoice?: "auto" | "none";
}

export interface LlmUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface LlmResponse {
  text: string;
  toolCalls?: LlmToolCall[];
  status?: "completed" | "incomplete";
  incompleteReason?: string;
  usage?: LlmUsage;
  provider: string;
  model: string;
}

export class LlmProviderError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status = "failed" as const;
  constructor(message: string, code = "provider_error", retryable = false) {
    super(message);
    this.name = "LlmProviderError";
    this.code = code;
    this.retryable = retryable;
  }
}

export interface LlmProvider {
  generate(request: LlmRequest): Promise<LlmResponse>;
}

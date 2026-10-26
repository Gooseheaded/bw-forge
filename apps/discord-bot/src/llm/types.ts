export type LlmRole = "system" | "user" | "assistant";

export interface LlmMessage {
  role: LlmRole;
  content: string;
}

export interface LlmRequest {
  model: string;
  system: string;
  messages: LlmMessage[];
  maxOutputTokens: number;
  timeoutMs: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface LlmUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface LlmResponse {
  text: string;
  usage?: LlmUsage;
  provider: string;
  model: string;
}

export class LlmProviderError extends Error {
  readonly code: string;
  readonly retryable: boolean;
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

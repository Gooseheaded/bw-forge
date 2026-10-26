import { OpenAiResponsesProvider } from "./openai.ts";
import { OpenRouterResponsesProvider } from "./openrouter.ts";
import type { LlmProvider } from "./types.ts";
export function createLlmProvider(
  o: { provider: "openai" | "openrouter"; apiKey: string },
  f?: typeof fetch,
): LlmProvider {
  switch (o.provider) {
    case "openrouter":
      return new OpenRouterResponsesProvider(o.apiKey, f);
    case "openai":
      return new OpenAiResponsesProvider(o.apiKey, undefined, f);
    default:
      throw new Error("Unsupported LLM provider");
  }
}

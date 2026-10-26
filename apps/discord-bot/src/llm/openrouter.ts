import { ResponsesProvider } from "./responses.ts";
export class OpenRouterResponsesProvider extends ResponsesProvider {
  constructor(apiKey: string, fetchImpl: typeof fetch = fetch) {
    super({
      apiKey,
      endpoint: "https://openrouter.ai/api/v1/responses",
      provider: "openrouter",
      fetchImpl,
    });
  }
}

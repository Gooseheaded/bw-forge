import { ResponsesProvider } from "./responses.ts";
export class OpenAiResponsesProvider extends ResponsesProvider {
  constructor(
    apiKey: string,
    endpoint = "https://api.openai.com/v1/responses",
    fetchImpl: typeof fetch = fetch,
  ) {
    super({ apiKey, endpoint, provider: "openai", fetchImpl });
  }
}

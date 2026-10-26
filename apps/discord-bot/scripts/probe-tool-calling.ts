import { createLlmProvider } from "../src/llm/factory.ts";
import type { LlmToolDefinition } from "../src/llm/types.ts";

const providerName = (process.env.BW_FORGE_LLM_PROVIDER ?? "openai").trim().toLowerCase();
if (providerName !== "openai" && providerName !== "openrouter") throw new Error("BW_FORGE_LLM_PROVIDER must be openai or openrouter");
const apiKey = process.env.LLM_API_KEY?.trim();
const model = process.env.LLM_MODEL?.trim();
if (!apiKey || !model) throw new Error("Set LLM_API_KEY and LLM_MODEL in the environment before running this probe");

const tool: LlmToolDefinition = {
  name: "get_corpus_summary",
  description: "Probe function calling only. Do not execute this function.",
  parameters: { type: "object", properties: { corpus_id: { type: "string" } }, required: ["corpus_id"], additionalProperties: false },
};
try {
  const response = await createLlmProvider({ provider: providerName, apiKey }).generate({
    model, system: "This is a protocol compatibility check. Request the provided function exactly once with corpus_id set to probe. Do not provide a natural language answer.",
    messages: [{ role: "user", content: "Call the provided function now." }], tools: [tool], toolChoice: "auto",
    maxOutputTokens: 300, timeoutMs: 30_000,
  });
  const report = { provider: response.provider, model: response.model, status: response.status ?? "completed",
    incompleteReason: response.incompleteReason, toolCallCount: response.toolCalls?.length ?? 0,
    requestedExpectedTool: response.toolCalls?.some((call) => call.name === tool.name) ?? false,
    usage: response.usage };
  console.log(JSON.stringify(report, null, 2));
  if (response.status === "incomplete" || !report.requestedExpectedTool) process.exitCode = 2;
} catch (error) {
  const value = error as { code?: string; retryable?: boolean };
  console.error(JSON.stringify({ event: "tool_call_probe_failed", code: value.code ?? "provider_error", retryable: !!value.retryable }));
  process.exitCode = 1;
}

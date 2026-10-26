import type { LlmMessage } from "../llm/types.ts";
import { SYSTEM_PROMPT } from "./prompt.ts";

export interface ContextHistoryItem {
  role: "user" | "assistant";
  content: string;
  messageId?: string;
  createdAt?: number;
}
export interface ContextMetadata {
  sessionId?: string;
  title?: string;
}
export interface ContextInput {
  history: ContextHistoryItem[];
  triggeringMessage: ContextHistoryItem;
  metadata?: ContextMetadata;
  budget: number;
}

/** Assemble deterministic context. Budget is a conservative UTF-8 byte-to-token upper bound. */
export function assembleContext(input: ContextInput): {
  system: string;
  messages: LlmMessage[];
  omittedMessages: number;
} {
  if (!Number.isInteger(input.budget) || input.budget < 1)
    throw new Error("Context budget must be a positive integer");
  // Titles are user-controlled and must never be promoted into instructions.
  // The opaque internal session id is sufficient metadata for this milestone.
  const metadata = input.metadata?.sessionId
    ? `Session identifier: ${input.metadata.sessionId}.`
    : "";
  const system = metadata ? `${SYSTEM_PROMPT}\n${metadata}` : SYSTEM_PROMPT;
  const trigger = input.triggeringMessage;
  const history = input.history.filter(
    (item) => !trigger.messageId || item.messageId !== trigger.messageId,
  );
  const candidates: LlmMessage[] = [...history, trigger].map((item) => ({
    role: item.role,
    content: item.content,
  }));
  // One token can be as little as one byte; account for a small role/envelope overhead.
  const encoder = new TextEncoder();
  const cost = (m: LlmMessage) =>
    encoder.encode(`${m.role}:${m.content}`).byteLength + 8;
  let used = encoder.encode(`system:${system}`).byteLength + 8;
  if (used > input.budget)
    throw new Error(
      "Context budget is too small for the required system instructions",
    );
  const kept: LlmMessage[] = [];
  for (let i = candidates.length - 1; i >= 0; i--) {
    const next = cost(candidates[i]);
    if (used + next > input.budget && kept.length > 0) break;
    if (used + next > input.budget && i === candidates.length - 1) {
      const available = Math.max(
        0,
        input.budget -
          used -
          (encoder.encode(`${candidates[i].role}:`).byteLength + 8),
      );
      let clipped = "";
      let bytesUsed = 0;
      for (const character of Array.from(candidates[i].content)) {
        const characterBytes = encoder.encode(character).byteLength;
        if (bytesUsed + characterBytes > available) break;
        clipped += character;
        bytesUsed += characterBytes;
      }
      kept.unshift({ role: candidates[i].role, content: clipped });
      used = input.budget;
      break;
    }
    kept.unshift(candidates[i]);
    used += next;
  }
  return {
    system,
    messages: kept,
    omittedMessages: candidates.length - kept.length,
  };
}

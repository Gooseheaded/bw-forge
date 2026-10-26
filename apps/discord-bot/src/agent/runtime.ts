/** Provider and transport-neutral conversational turn runtime. */

export type ChatRole = "system" | "user" | "assistant";
export interface ChatMessage {
  role: ChatRole;
  content: string;
}

import type { LlmProvider, LlmRequest, LlmResponse } from "../llm/types.ts";
export type { LlmProvider, LlmRequest, LlmResponse };
type SavedResponse = LlmResponse & { failed?: boolean };
const FAILURE_TEXT =
  "I couldn't complete that request. Please try again later.";

export interface RuntimeMessage {
  messageId: string;
  sessionId: string;
  threadId: string;
  guildId: string;
  parentChannelId: string;
  authorId: string;
  content: string;
  receivedAt?: number;
}
export interface RuntimeTurn {
  id: string;
  message: RuntimeMessage;
  status: "queued" | "running" | "completed" | "failed" | "skipped";
  attemptCount: number;
}
export interface RuntimeStore {
  /** Must be idempotent by messageId and return the existing turn on duplicates. */
  enqueueMessage(
    message: RuntimeMessage,
  ): Promise<{ accepted: boolean; turn: RuntimeTurn }>;
  claimNextTurn(
    sessionId: string,
    provider?: string,
    model?: string,
  ): Promise<RuntimeTurn | undefined>;
  listQueuedSessionIds(): Promise<string[]>;
  getContext(
    sessionId: string,
    triggeringMessageId: string,
  ): Promise<ChatMessage[]>;
  completeTurn(turnId: string, response: LlmResponse): Promise<void>;
  saveResponse?(turnId: string, response: SavedResponse): Promise<void>;
  getSavedResponse?(turnId: string): Promise<SavedResponse | undefined>;
  markDelivered?(turnId: string): Promise<void>;
  startProviderRequest?(turnId: string): Promise<number | void>;
  finishProviderRequest?(
    turnId: string,
    attempt: number | void,
    status: "completed" | "failed",
    error?: string,
  ): Promise<void>;
  failTurn(turnId: string, error: string, retryable: boolean): Promise<void>;
  skipTurn(turnId: string, reason: string): Promise<void>;
  recoverRunningTurns(): Promise<void>;
}

export interface RuntimeAuthorization {
  /** Must fetch or otherwise validate current guild membership. Errors deny access. */
  authorize(input: { guildId: string; userId: string }): Promise<boolean>;
}
export interface RuntimeDelivery {
  send(input: {
    threadId: string;
    text: string;
    turnId: string;
    signal?: AbortSignal;
  }): Promise<void>;
  failure(input: {
    threadId: string;
    turnId: string;
    signal?: AbortSignal;
  }): Promise<void>;
}
export interface RuntimeOptions {
  maxConcurrent: number;
  requestTimeoutMs: number;
  maxAttempts?: number;
  provider: LlmProvider;
  store: RuntimeStore;
  authorization: RuntimeAuthorization;
  delivery: RuntimeDelivery;
  model?: string;
  maxOutputTokens?: number;
  temperature?: number;
  providerName?: string;
  /** Optional logger; arguments must never contain secrets. */
  log?: (message: string, details?: Record<string, unknown>) => void;
}

function timeoutSignal(
  ms: number,
  parent?: AbortSignal,
): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("request timeout")),
    ms,
  );
  const cancel = () => {
    clearTimeout(timer);
    controller.abort();
  };
  if (parent) {
    if (parent.aborted) cancel();
    else parent.addEventListener("abort", cancel, { once: true });
  }
  return { signal: controller.signal, cancel };
}

async function withTimeout<T>(
  work: Promise<T>,
  signal: AbortSignal,
  ms: number,
): Promise<T> {
  if (signal.aborted) throw new Error("request cancelled");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("request timeout")), ms);
        signal.addEventListener(
          "abort",
          () => reject(new Error("request cancelled")),
          { once: true },
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Durable queue pump. A process may run one instance; persistence supplies recovery. */
export class TurnRuntime {
  private readonly options: Required<Pick<RuntimeOptions, "maxAttempts">> &
    RuntimeOptions;
  private readonly sessionPumps = new Set<string>();
  private active = 0;
  private stopped = false;
  private readonly waiters = new Set<() => void>();
  private readonly controllers = new Set<AbortController>();

  constructor(options: RuntimeOptions) {
    if (!Number.isInteger(options.maxConcurrent) || options.maxConcurrent < 1)
      throw new Error("maxConcurrent must be a positive integer");
    if (
      !Number.isFinite(options.requestTimeoutMs) ||
      options.requestTimeoutMs < 1
    )
      throw new Error("requestTimeoutMs must be positive");
    this.options = { ...options, maxAttempts: options.maxAttempts ?? 3 };
  }

  async start(): Promise<void> {
    await this.options.store.recoverRunningTurns();
    for (const id of await this.options.store.listQueuedSessionIds())
      this.pump(id);
  }

  async enqueue(message: RuntimeMessage): Promise<boolean> {
    if (this.stopped) return false;
    let authorized = false;
    try {
      authorized = await this.options.authorization.authorize({
        guildId: message.guildId,
        userId: message.authorId,
      });
    } catch {
      authorized = false;
    }
    if (!authorized || this.stopped) return false;
    const result = await this.options.store.enqueueMessage(message);
    this.pump(message.sessionId);
    return result.accepted;
  }

  async stop(timeoutMs = 5_000): Promise<void> {
    this.stopped = true;
    for (const wake of this.waiters) wake();
    this.waiters.clear();
    for (const c of this.controllers) c.abort();
    const started = Date.now();
    while (
      (this.active > 0 || this.sessionPumps.size > 0) &&
      Date.now() - started < timeoutMs
    )
      await Bun.sleep(10);
  }

  private pump(sessionId: string): void {
    if (this.sessionPumps.has(sessionId) || this.stopped) return;
    this.sessionPumps.add(sessionId);
    let healthy = true;
    void this.runSession(sessionId)
      .catch(() => {
        healthy = false;
        this.options.log?.("session pump failed", { sessionId });
      })
      .finally(() => {
        this.sessionPumps.delete(sessionId);
        if (!this.stopped && healthy)
          void this.options.store
            .listQueuedSessionIds()
            .then((ids) => {
              if (ids.includes(sessionId)) this.pump(sessionId);
            })
            .catch(() => this.options.log?.("queue inspection failed"));
      });
  }

  private async runSession(sessionId: string): Promise<void> {
    while (!this.stopped) {
      if (this.active >= this.options.maxConcurrent) {
        await new Promise<void>((resolve) => {
          this.waiters.add(resolve);
        });
        continue;
      }
      this.active++;
      try {
        const turn = await this.options.store.claimNextTurn(
          sessionId,
          this.options.providerName ?? "configured",
          this.options.model,
        );
        if (!turn) return;
        await this.process(turn);
      } finally {
        this.active--;
        for (const wake of this.waiters) wake();
        this.waiters.clear();
      }
    }
  }

  private async process(turn: RuntimeTurn): Promise<void> {
    let authorized = false;
    try {
      authorized = await this.options.authorization.authorize({
        guildId: turn.message.guildId,
        userId: turn.message.authorId,
      });
    } catch {
      authorized = false;
    }
    if (this.stopped) return;
    if (!authorized) {
      await this.options.store.skipTurn(turn.id, "authorization revoked");
      return;
    }
    const controller = new AbortController();
    this.controllers.add(controller);
    const { signal, cancel } = timeoutSignal(
      this.options.requestTimeoutMs,
      controller.signal,
    );
    let providerAttempt: number | void = undefined;
    let response: SavedResponse | undefined;
    let generated = false;
    try {
      response = await this.options.store.getSavedResponse?.(turn.id);
      if (!response) {
        const context = await this.options.store.getContext(
          turn.message.sessionId,
          turn.message.messageId,
        );
        let current = false;
        try {
          current = await this.options.authorization.authorize({
            guildId: turn.message.guildId,
            userId: turn.message.authorId,
          });
        } catch {
          current = false;
        }
        if (!current) {
          await this.options.store.skipTurn(turn.id, "authorization revoked");
          return;
        }
        providerAttempt = await this.options.store.startProviderRequest?.(
          turn.id,
        );
        if (this.stopped || signal.aborted)
          throw new Error("request cancelled");
        response = await withTimeout(
          this.options.provider.generate({
            model: this.options.model ?? "",
            system:
              context.find((m) => m.role === "system")?.content ??
              "You are BW Forge's conversational Brood War analyst.",
            messages: context.filter((m) => m.role !== "system"),
            maxOutputTokens: this.options.maxOutputTokens ?? 800,
            timeoutMs: this.options.requestTimeoutMs,
            temperature: this.options.temperature,
            signal,
          }),
          signal,
          this.options.requestTimeoutMs,
        );
        generated = true;
        await this.options.store.finishProviderRequest?.(
          turn.id,
          providerAttempt,
          "completed",
        );
        if (this.options.store.saveResponse)
          await this.options.store.saveResponse(turn.id, response);
      }
      await withTimeout(
        this.options.delivery.send({
          threadId: turn.message.threadId,
          text: response.text,
          turnId: turn.id,
          signal,
        }),
        signal,
        this.options.requestTimeoutMs,
      );
      await this.options.store.markDelivered?.(turn.id);
      if (response.failed)
        await this.options.store.failTurn(turn.id, "generation failed", false);
      else await this.options.store.completeTurn(turn.id, response);
    } catch (error) {
      const retryableFlag =
        !(error && typeof error === "object" && "retryable" in error) ||
        Boolean((error as { retryable?: unknown }).retryable);
      const retryable =
        retryableFlag &&
        turn.attemptCount < this.options.maxAttempts &&
        !this.stopped;
      try {
        if (!generated && providerAttempt !== undefined)
          await this.options.store.finishProviderRequest?.(
            turn.id,
            providerAttempt,
            "failed",
            "provider request failed",
          );
      } catch {
        /* best effort */
      }
      if (this.stopped) return; // Leave running work for startup recovery; do not send a shutdown error.
      if (retryable)
        await this.options.store.failTurn(
          turn.id,
          "request failed; retry scheduled",
          true,
        );
      else if (!response) {
        const failure: SavedResponse = {
          text: FAILURE_TEXT,
          provider: this.options.providerName ?? "configured",
          model: this.options.model ?? "",
          failed: true,
        };
        let notified = false;
        try {
          await this.options.store.saveResponse?.(turn.id, failure);
          // Generation may have consumed its deadline. Give this final notification its own bound.
          const notice = timeoutSignal(
            this.options.requestTimeoutMs,
            controller.signal,
          );
          try {
            await withTimeout(
              this.options.delivery.send({
                threadId: turn.message.threadId,
                text: failure.text,
                turnId: turn.id,
                signal: notice.signal,
              }),
              notice.signal,
              this.options.requestTimeoutMs,
            );
          } finally {
            notice.cancel();
          }
          await this.options.store.markDelivered?.(turn.id);
          notified = true;
        } catch {
          this.options.log?.("failure notification could not be delivered", {
            turnId: turn.id,
          });
        }
        await this.options.store.failTurn(
          turn.id,
          "generation failed",
          !notified && turn.attemptCount < this.options.maxAttempts,
        );
      } else {
        await this.options.store.failTurn(
          turn.id,
          "delivery retry limit exceeded",
          false,
        );
        this.options.log?.("response delivery retry limit exceeded", {
          turnId: turn.id,
        });
      }
    } finally {
      cancel();
      this.controllers.delete(controller);
    }
  }
}

/** Adapter for the production SQLite store. Kept here so the pump remains testable with RuntimeStore. */
import { BotStore } from "../storage/store.ts";
import { assembleContext } from "./context.ts";

export class SqliteRuntimeStore implements RuntimeStore {
  constructor(
    private readonly db: BotStore,
    private readonly contextBudget = 24_000,
  ) {}
  async enqueueMessage(m: RuntimeMessage) {
    const result = this.db.enqueueUserMessage({
      sessionId: Number(m.sessionId),
      discordMessageId: m.messageId,
      authorUserId: m.authorId,
      content: m.content,
    });
    return {
      accepted: !result.duplicate,
      turn: this.toTurn(result.turn, result.message, m),
    };
  }
  async claimNextTurn(sessionId: string, provider?: string, model?: string) {
    const t = this.db.claimNextTurn(Number(sessionId), provider, model);
    if (!t) return undefined;
    const msg = this.db.getMessage(t.triggeringMessageId);
    if (!msg) return undefined;
    const session = this.db.getSession(t.sessionId);
    if (!session?.threadId) return undefined;
    return this.toTurn(t, msg, {
      messageId: msg.discordMessageId ?? String(msg.id),
      sessionId: String(t.sessionId),
      threadId: session.threadId,
      guildId: session.guildId,
      parentChannelId: session.parentChannelId,
      authorId: msg.authorUserId,
      content: msg.content,
    });
  }
  async listQueuedSessionIds() {
    return [
      ...new Set(this.db.getPendingTurns().map((t) => String(t.sessionId))),
    ];
  }
  async getContext(
    sessionId: string,
    triggeringMessageId: string,
  ): Promise<ChatMessage[]> {
    const s = this.db.getSession(Number(sessionId));
    const trigger =
      this.db.getMessageByDiscordId(triggeringMessageId) ??
      this.db.getMessage(Number(triggeringMessageId));
    if (!s || !trigger) return [];
    const history = this.db
      .getConversationHistory(
        Number(sessionId),
        trigger.id,
        Math.max(1, Math.floor(this.contextBudget / 512)),
      )
      .map((m) => ({
        role:
          m.role === "assistant" ? ("assistant" as const) : ("user" as const),
        content: m.content,
        messageId: String(m.id),
      }));
    const assembled = assembleContext({
      history,
      triggeringMessage: {
        role: "user",
        content: trigger.content,
        messageId: String(trigger.id),
      },
      metadata: { sessionId, title: s.title ?? undefined },
      budget: this.contextBudget,
    });
    return [
      { role: "system", content: assembled.system },
      ...assembled.messages,
    ];
  }
  async completeTurn(turnId: string, response: LlmResponse) {
    const t = this.db.getTurn(Number(turnId));
    if (!t) return;
    if (!(await this.getSavedResponse(turnId)))
      this.db.saveTurnResponse(t.id, {
        text: response.text,
        provider: response.provider,
        model: response.model,
        tokenUsage: response.usage?.totalTokens,
      });
    this.db.completeTurn(t.id, response.usage?.totalTokens);
  }
  async saveResponse(turnId: string, response: SavedResponse) {
    if (await this.getSavedResponse(turnId)) return;
    this.db.db.transaction(() => {
      this.db.saveTurnResponse(Number(turnId), {
        text: response.text,
        provider: response.provider,
        model: response.model,
        tokenUsage: response.usage?.totalTokens,
      });
      if (response.failed)
        this.db.db
          .query(
            "UPDATE messages SET rejected=1 WHERE turn_id=? AND role='assistant'",
          )
          .run(Number(turnId));
    })();
  }
  async getSavedResponse(turnId: string): Promise<SavedResponse | undefined> {
    const t = this.db.getTurn(Number(turnId));
    if (!t) return undefined;
    const message = this.db.getAssistantForTurn(t.id);
    return message
      ? {
          text: message.content,
          provider: t.provider ?? "unknown",
          model: t.model ?? "unknown",
          failed: message.rejected,
          usage:
            t.tokenUsage === null ? undefined : { totalTokens: t.tokenUsage },
        }
      : undefined;
  }
  async markDelivered(_turnId: string) {
    /* delivery_attempts are marked by DiscordDelivery per chunk */
  }
  async startProviderRequest(turnId: string) {
    return this.db.startProviderRequest(Number(turnId));
  }
  async finishProviderRequest(
    turnId: string,
    attempt: number | void,
    status: "completed" | "failed",
    error?: string,
  ) {
    if (attempt !== undefined)
      this.db.finishProviderRequest(Number(turnId), attempt, status, error);
  }
  async failTurn(turnId: string, error: string, retryable: boolean) {
    this.db.failTurn(Number(turnId), error, retryable);
  }
  async skipTurn(turnId: string, reason: string) {
    this.db.cancelTurn(Number(turnId), reason);
  }
  async recoverRunningTurns() {
    /* BotStore migration performs durable recovery. */
  }
  private toTurn(
    t: import("../storage/store.ts").Turn,
    msg: import("../storage/store.ts").StoredMessage,
    m: RuntimeMessage,
  ): RuntimeTurn {
    return {
      id: String(t.id),
      status: t.status === "cancelled" ? "skipped" : t.status,
      attemptCount: t.attemptCount,
      message: m,
    };
  }
}

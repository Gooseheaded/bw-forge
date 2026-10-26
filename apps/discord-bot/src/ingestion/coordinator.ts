import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { BotStore, ReplayUpload } from "../storage/store.ts";
import { readReplayMetadata } from "../../../../packages/corpus-store/src/replay-metadata.ts";

export interface ReplayJobGateway {
  registerReplay(input: { corpusId: string; filePath: string; replaySha256: string; idempotencyKey: string }): Promise<{
    replaySha256?: string; jobId?: string; state?: "queued" | "running" | "succeeded" | "failed"; artifactPath?: string;
  }>;
  getJob?(input: { corpusId: string; jobId: string }): Promise<{
    state: "queued" | "running" | "succeeded" | "failed"; artifactPath?: string; error?: string;
  }>;
}
export interface UploadAttachment { id: string; name?: string; url: string; size?: number; contentType?: string; }
export interface DownloadOptions {
  maxBytes: number; timeoutMs: number; tempRoot: string;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  validateReplay?: (path: string) => Promise<unknown>;
}
export class PermanentUploadError extends Error {}

async function stagingRoot(requested: string): Promise<string> {
  await mkdir(requested, { recursive: true, mode: 0o700 });
  const entry = await lstat(requested), actual = await realpath(requested), expected = resolve(requested);
  const matches = process.platform === "win32" ? actual.toLowerCase() === expected.toLowerCase() : actual === expected;
  if (!entry.isDirectory() || entry.isSymbolicLink() || !matches) throw new PermanentUploadError("Replay staging directory must not contain symlinks.");
  return actual;
}
export { stagingRoot as validateStagingDirectory };

function validateAttachment(attachment: UploadAttachment, maxBytes: number) {
  if (!attachment.name || !/\.rep$/i.test(attachment.name)) throw new PermanentUploadError("Only .rep attachments are accepted.");
  let url: URL;
  try { url = new URL(attachment.url); } catch { throw new PermanentUploadError("Invalid Discord attachment URL."); }
  if (url.protocol !== "https:" || !["cdn.discordapp.com", "media.discordapp.net"].includes(url.hostname)
    || url.username || url.password || (url.port && url.port !== "443") || !url.pathname.startsWith("/attachments/")) {
    throw new PermanentUploadError("Only Discord attachment downloads are accepted.");
  }
  if (attachment.size !== undefined && (!Number.isSafeInteger(attachment.size) || attachment.size < 1 || attachment.size > maxBytes)) {
    throw new PermanentUploadError("Attachment exceeds the configured size limit or has an invalid size.");
  }
}

/** Bounded streaming, exclusive generated paths, exact CDN hosts and no redirects. */
export async function downloadReplayAttachment(attachment: UploadAttachment, options: DownloadOptions): Promise<{ path: string; sha256: string }> {
  validateAttachment(attachment, options.maxBytes);
  const path = join(await stagingRoot(options.tempRoot), `${randomUUID()}.rep`);
  const controller = new AbortController();
  let rejectTimeout!: (error: Error) => void;
  const timeout = new Promise<never>((_, reject) => { rejectTimeout = reject; });
  const timer = setTimeout(() => { controller.abort(); rejectTimeout(new Error("Attachment download timed out.")); }, options.timeoutMs);
  const bounded = <T>(operation: Promise<T>) => Promise.race([operation, timeout]);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const response = await bounded((options.fetch ?? fetch)(attachment.url, { signal: controller.signal, redirect: "manual" }));
    if (response.status >= 300 && response.status < 400) throw new PermanentUploadError("Attachment redirects are not permitted.");
    if (!response.ok || !response.body) {
      if ([400, 404].includes(response.status)) throw new PermanentUploadError("The Discord attachment is no longer available.");
      throw new Error("Discord attachment download is temporarily unavailable.");
    }
    const declared = response.headers.get("content-length");
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > options.maxBytes)) throw new PermanentUploadError("Attachment exceeds the configured size limit.");
    file = await open(path, "wx", 0o600);
    reader = response.body.getReader();
    const hash = createHash("sha256");
    let total = 0;
    for (;;) {
      const part = await bounded(reader.read());
      if (part.done) break;
      total += part.value.byteLength;
      if (total > options.maxBytes) throw new PermanentUploadError("Attachment exceeds the configured size limit.");
      hash.update(part.value);
      await file.writeFile(part.value);
    }
    if (!total || (declared !== null && total !== Number(declared))) throw new PermanentUploadError("Attachment download was incomplete.");
    await file.sync();
    await file.close(); file = undefined;
    clearTimeout(timer);
    try { await (options.validateReplay ?? readReplayMetadata)(path); }
    catch { throw new PermanentUploadError("Attachment is not a valid Brood War replay."); }
    return { path, sha256: hash.digest("hex") };
  } catch (error) {
    controller.abort();
    if (reader) void reader.cancel().catch(() => undefined);
    if (file) await file.close().catch(() => undefined);
    await rm(path, { force: true });
    throw error;
  } finally { clearTimeout(timer); }
}

type AcceptInput = {
  sessionId: number; threadId: string; messageId: string; userId: string; corpusId: string;
  attachment: UploadAttachment; authorize?: () => Promise<boolean>;
};
export interface CoordinatorOptions {
  store: BotStore; gateway: ReplayJobGateway; download: DownloadOptions;
  pollIntervalMs?: number; maxDeliveryAttempts?: number; maxDownloads?: number; maxPendingPerSession?: number;
  resolveAttachment?: (upload: ReplayUpload) => Promise<UploadAttachment | null>;
  authorizeUpload?: (upload: ReplayUpload) => Promise<boolean>;
  onFailure?: (upload: ReplayUpload, message: string) => Promise<void>;
  onReportReady?: (input: { uploadId: number; threadId: string; corpusId: string; artifactPath: string; label: string }) => Promise<string | void>;
  log?: (event: string, details: Record<string, unknown>) => void;
  clock?: () => number; retryBaseMs?: number;
  downloader?: typeof downloadReplayAttachment;
}

/** Bot coordination only; Corpus v2 remains the sole analysis queue. */
export class ReplayCoordinator {
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private ticking?: Promise<void>;
  private readonly tasks = new Map<number, Promise<void>>();
  private readonly recent = new Map<number, Pick<AcceptInput, "attachment" | "authorize">>();
  private readonly now: () => number;
  private stagingChecked = false;
  constructor(private readonly options: CoordinatorOptions) { this.now = options.clock ?? Date.now; }
  start() {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => { void this.tickOnce().catch(() => this.log("coordinator_retry")); }, this.options.pollIntervalMs ?? 5000);
    void this.tickOnce().catch(() => this.log("coordinator_retry"));
  }
  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.ticking;
    await this.drain();
  }
  async drain() { while (this.tasks.size) await Promise.allSettled([...this.tasks.values()]); }
  async tickOnce() {
    if (this.stopped) return;
    if (this.ticking) return this.ticking;
    this.ticking = this.tick().finally(() => { this.ticking = undefined; });
    return this.ticking;
  }
  async accept(input: AcceptInput): Promise<ReplayUpload> {
    const existing = this.options.store.getReplayUploadByAttachment(input.messageId, input.attachment.id);
    if (existing) return existing;
    if (this.stopped) throw new Error("Replay intake is stopping.");
    if (!input.authorize || !(await input.authorize())) throw new PermanentUploadError("You are not authorized to upload replays.");
    const pending = this.options.store.listReplayUploads(["received", "validating", "registering", "queued", "running"]);
    if (pending.length >= 256 || pending.filter(item => item.sessionId === input.sessionId).length >= (this.options.maxPendingPerSession ?? 8)) {
      throw new PermanentUploadError("This session has reached its pending replay limit. Please try again later.");
    }
    const upload = this.options.store.createReplayUpload({ sessionId: input.sessionId, discordMessageId: input.messageId,
      attachmentId: input.attachment.id, userId: input.userId, corpusId: input.corpusId,
      filename: basename((input.attachment.name ?? "replay.rep").replaceAll("\\", "/")).slice(0, 200) });
    try { validateAttachment(input.attachment, this.options.download.maxBytes); }
    catch (error) { await this.fail(upload, error instanceof Error ? error.message : "Invalid replay attachment."); return this.options.store.getReplayUpload(upload.id)!; }
    this.recent.set(upload.id, { attachment: input.attachment, authorize: input.authorize });
    this.log("upload_accepted", upload);
    return upload;
  }
  private due(date?: string | null) { return !date || Date.parse(date) <= this.now(); }
  private next(attempt: number) { return new Date(this.now() + Math.min(300000, (this.options.retryBaseMs ?? 1000) * 2 ** Math.min(attempt, 8))).toISOString(); }
  private log(event: string, upload?: ReplayUpload) {
    this.options.log?.(event, upload ? { uploadId: upload.id, sessionId: upload.sessionId, corpusId: upload.corpusId, replaySha256: upload.replaySha256, jobId: upload.jobId } : {});
  }
  private async authorized(upload: ReplayUpload) {
    const session = this.options.store.getSession(upload.sessionId);
    if (!session || session.status !== "active" || !session.threadId) return false;
    if (this.options.authorizeUpload) return this.options.authorizeUpload(upload);
    return this.recent.get(upload.id)?.authorize?.() ?? false;
  }
  private async checkedFile(upload: ReplayUpload) {
    const path = upload.filePath;
    if (!path || !upload.replaySha256) throw new PermanentUploadError("The staged replay is unavailable; please upload it again.");
    const root = await stagingRoot(this.options.download.tempRoot);
    if (dirname(resolve(path)) !== root || await realpath(path) !== resolve(path) || !(await lstat(path)).isFile()) {
      throw new PermanentUploadError("The staged replay is invalid; please upload it again.");
    }
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    if (hash.digest("hex") !== upload.replaySha256) throw new PermanentUploadError("The staged replay changed; please upload it again.");
    return path;
  }
  private async cleanup(upload: ReplayUpload) {
    if (!upload.filePath) return;
    const root = await stagingRoot(this.options.download.tempRoot);
    if (root && dirname(resolve(upload.filePath)) === root) await rm(upload.filePath, { force: true });
    this.options.store.updateReplayUpload(upload.id, { filePath: null });
  }
  private async fail(upload: ReplayUpload, message: string) {
    this.options.store.updateReplayUpload(upload.id, { state: "failed", error: message, nextAttemptAt: null });
    await this.cleanup(this.options.store.getReplayUpload(upload.id)!);
    this.recent.delete(upload.id);
    this.log("upload_failed", upload);
  }
  private async process(upload: ReplayUpload) {
    try {
      if (!(await this.authorized(upload))) throw new PermanentUploadError("Authorization was revoked before analysis could start.");
      if (upload.state !== "registering") {
        const attachment = this.recent.get(upload.id)?.attachment ?? await this.options.resolveAttachment?.(upload);
        if (!attachment) throw new PermanentUploadError("The original Discord attachment is unavailable; please upload it again.");
        this.options.store.updateReplayUpload(upload.id, { state: "validating" });
        const result = await (this.options.downloader ?? downloadReplayAttachment)(attachment, this.options.download);
        upload = this.options.store.updateReplayUpload(upload.id, { state: "registering", filePath: result.path, replaySha256: result.sha256 });
        this.log("replay_validated", upload);
      }
      const path = await this.checkedFile(upload);
      if (!(await this.authorized(upload))) throw new PermanentUploadError("Authorization was revoked before analysis could start.");
      // Durable path/hash precede registration; a retry reuses canonical bytes and the Corpus v2 job.
      const result = await this.options.gateway.registerReplay({ corpusId: upload.corpusId, filePath: path,
        replaySha256: upload.replaySha256!, idempotencyKey: `discord-upload:${upload.id}` });
      if (!result.jobId || (result.replaySha256 && result.replaySha256 !== upload.replaySha256)) throw new Error("Corpus registration returned an unexpected identity.");
      const session = this.options.store.getSession(upload.sessionId)!;
      this.options.store.db.transaction(() => {
        this.options.store.associateSessionReplay(upload.sessionId, upload.corpusId, upload.replaySha256!, upload.filename);
        this.options.store.updateReplayUpload(upload.id, { state: result.state ?? "queued", jobId: result.jobId, error: null, nextAttemptAt: null, attempts: 0 });
        if (result.state === "succeeded") this.options.store.ensureReportDelivery(upload.id, session.threadId!, result.artifactPath);
      })();
      await this.cleanup(upload);
      this.recent.delete(upload.id);
      this.log("replay_enqueued", this.options.store.getReplayUpload(upload.id)!);
    } catch (error) {
      const current = this.options.store.getReplayUpload(upload.id)!;
      if (error instanceof PermanentUploadError) await this.fail(current, error.message);
      else if (current.attempts >= 5) await this.fail(current, "Replay ingestion could not complete after several retries. Please upload it again later.");
      else {
        this.options.store.updateReplayUpload(upload.id, { attempts: current.attempts + 1,
          error: "Replay ingestion is temporarily unavailable; retry scheduled.", nextAttemptAt: this.next(current.attempts) });
        this.log("ingestion_retry", current);
      }
    }
  }
  private async tick() {
    const store = this.options.store;
    if (!this.stagingChecked) {
      const root = await stagingRoot(this.options.download.tempRoot);
      const referenced = new Set(store.getReplayStaging().map(upload => upload.filePath && resolve(upload.filePath)));
      for (const entry of await readdir(root, { withFileTypes: true })) {
        const path = join(root, entry.name);
        if (/^[a-f0-9-]{36}\.rep$/.test(entry.name) && entry.isFile() && !referenced.has(path)) await rm(path, { force: true });
      }
      this.stagingChecked = true;
    }
    for (const upload of store.getReplayStaging(true)) {
      if (upload.filePath) await this.cleanup(upload);
    }
    for (const upload of store.getReplayWork("ingestion", new Date(this.now()).toISOString())) {
      if (this.stopped || this.tasks.size >= (this.options.maxDownloads ?? 2)) break;
      if (this.tasks.has(upload.id) || !this.due(upload.nextAttemptAt)) continue;
      const task = this.process(upload).catch(() => this.log("upload_recovery_retry", upload)).finally(() => this.tasks.delete(upload.id));
      this.tasks.set(upload.id, task);
    }
    for (const upload of store.getReplayWork("observation", new Date(this.now()).toISOString())) {
      if (this.stopped) return;
      if (upload.state === "succeeded" && store.getReportDelivery(upload.id)) continue;
      if (!upload.jobId || !this.options.gateway.getJob || !this.due(upload.nextAttemptAt)) continue;
      try {
        const status = await this.options.gateway.getJob({ corpusId: upload.corpusId, jobId: upload.jobId });
        if (status.state === "failed") { await this.fail(upload, "Replay analysis failed. Please try another replay or contact an operator."); continue; }
        store.db.transaction(() => {
          store.updateReplayUpload(upload.id, { state: status.state, error: null, nextAttemptAt: new Date(this.now() + (this.options.pollIntervalMs ?? 5000)).toISOString(), attempts: 0 });
          if (status.state === "succeeded") {
            const thread = store.getSession(upload.sessionId)?.threadId;
            if (thread) store.ensureReportDelivery(upload.id, thread, status.artifactPath);
          }
        })();
        this.log("job_observed", upload);
      } catch {
        store.updateReplayUpload(upload.id, { attempts: upload.attempts + 1, nextAttemptAt: this.next(upload.attempts), error: "Corpus status or publication temporarily unavailable." });
        this.log("job_observation_retry", upload);
      }
    }
    for (const delivery of store.getPendingReportDeliveries(new Date(this.now()).toISOString())) {
      if (this.stopped || !this.options.onReportReady || !this.due(delivery.nextAttemptAt)) continue;
      const upload = store.getReplayUpload(delivery.uploadId)!;
      // Notifications continue accepted work in its original shared session after role revocation.
      store.recordReportDeliveryAttempt(upload.id);
      try {
        let artifactPath = delivery.artifactPath;
        if (!artifactPath && upload.jobId && this.options.gateway.getJob) artifactPath = (await this.options.gateway.getJob({ corpusId: upload.corpusId, jobId: upload.jobId })).artifactPath ?? null;
        if (!artifactPath) throw new Error("Published HTML report is unavailable.");
        const id = await this.options.onReportReady({ uploadId: upload.id, corpusId: upload.corpusId, threadId: delivery.threadId, artifactPath, label: upload.filename });
        if (id) store.markReportDelivered(upload.id, id);
        else if (store.getReportDelivery(upload.id)?.state !== "delivered") throw new Error("Report delivery was not checkpointed.");
        this.log("report_delivered", upload);
      } catch (error) {
        const e = error as { code?: number; status?: number; message?: string };
        const oversized = e.status === 413 || e.code === 40005 || /upload limit/.test(e.message ?? "");
        const terminal = delivery.attempts + 1 >= (this.options.maxDeliveryAttempts ?? 5)
          || oversized || e.code === 50013 || e.status === 403 || /outside.*root|symlink/.test(e.message ?? "");
        const message = oversized ? "Analysis completed, but the HTML report exceeds Discord's upload limit. Contact an operator to retrieve it."
          : "Analysis completed, but its HTML report could not be delivered. Contact an operator; the published report is preserved.";
        store.deferReportDelivery(upload.id, message, terminal ? null : this.next(delivery.attempts), terminal);
        if (terminal) store.updateReplayUpload(upload.id, { error: message, failureNotified: false, attempts: 0, nextAttemptAt: null });
        this.log("report_delivery_retry", upload);
      }
    }
    for (const upload of store.getReplayWork("notification", new Date(this.now()).toISOString())) {
      if (this.stopped || !upload.error || upload.failureNotified || !this.options.onFailure || !this.due(upload.nextAttemptAt)) continue;
      if (upload.state === "succeeded" && store.getReportDelivery(upload.id)?.state !== "failed") continue;
      try {
        await this.options.onFailure(upload, upload.error);
        store.updateReplayUpload(upload.id, { failureNotified: true, nextAttemptAt: null });
      } catch {
        store.updateReplayUpload(upload.id, { attempts: Math.min(upload.attempts + 1, 1000), nextAttemptAt: this.next(upload.attempts) });
        this.log("failure_notification_retry", upload);
      }
    }
  }
}

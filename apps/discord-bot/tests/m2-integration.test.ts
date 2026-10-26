import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAnalysisWorker, listAnalysisJobs } from "../../../packages/corpus-store/src/jobs.ts";
import { createReplayPublisher } from "../../../packages/corpus-store/src/publication.ts";
import { ingestReplayAnalysis } from "../../../packages/corpus-store/src/index.ts";
import { CorpusCore } from "../src/corpus/core.ts";
import { CorpusRegistry } from "../src/corpus/registry.ts";
import { ReplayCoordinator } from "../src/ingestion/coordinator.ts";
import { BotStore } from "../src/storage/store.ts";
import { DiscordReportDelivery } from "../src/discord/adapter.ts";

test("two Discord uploads traverse the real Corpus v2 queue/publication and deliver HTML, with restart and completed reuse", async () => {
  const root = await mkdtemp(join(tmpdir(), "bw-m2-end-to-end-"));
  const corpusRoot = join(root, "community"), proRoot = join(root, "professional");
  const dbPath = join(corpusRoot, "db", "corpus.sqlite"), botPath = join(root, "bot.sqlite");
  let store: BotStore | undefined;
  try {
    // Python fixture supplies deterministic analytical artifacts. Only simulation is injected;
    // downloads, replay validation, registration, jobs, worker fencing, publication and SQLite are real.
    const fixture = join(root, "fixture");
    const python = process.env.BW_FORGE_PYTHON ?? (process.platform === "win32" ? "python" : "python3");
    const generated = Bun.spawn([python, ...(python === "py" ? ["-3"] : []), resolve(import.meta.dir, "../../../packages/corpus-store/tests/publication_fixture.py"), fixture], { stdout: "pipe", stderr: "pipe" });
    const stderr = await new Response(generated.stderr).text();
    expect(await generated.exited, stderr).toBe(0);
    const replay = await readFile(resolve(import.meta.dir, "../../../fixtures/replays/191104,(4)KnockOut1.4.rep"));
    // Two parser-valid byte identities (the second adds ignored replay padding).
    const otherReplay = Buffer.concat([replay, Buffer.from([0])]);
    const sha = createHash("sha256").update(replay).digest("hex");
    await writeFile(join(fixture, "raw.rep"), replay);
    for (const filename of ["manifest.json", "replay-manifest.json"]) {
      const manifest = JSON.parse(await readFile(join(fixture, filename), "utf8"));
      manifest.replay_id = sha;
      if (filename === "replay-manifest.json") manifest.legacy.html_files = ["report.html"];
      await writeFile(join(fixture, filename), JSON.stringify(manifest));
    }
    await writeFile(join(fixture, "report.html"), "<!doctype html><html><body>standalone fixture report</body></html>");
    await mkdir(join(proRoot, "db"), { recursive: true });
    const proDbPath = join(proRoot, "db", "corpus.sqlite");
    await listAnalysisJobs(proDbPath);
    const pro = new Database(proDbPath); pro.exec("CREATE TABLE preserved(value TEXT); INSERT INTO preserved VALUES('professional')"); pro.close();
    const proBefore = await readFile(proDbPath), proTime = (await stat(proDbPath)).mtimeMs;
    const registry = new CorpusRegistry({
      community: { name: "Uploads", database: dbPath, corpusRoot, access: "read-write" },
      professional: { name: "Professional", database: proDbPath, corpusRoot: proRoot, access: "read-only" },
    }, botPath, "community");
    await registry.validateFilesystem();
    const core = new CorpusCore(registry);
    let now = Date.now();
    let loseCheckpointForUpload: number | undefined;
    store = new BotStore({ dbPath: botPath });
    const firstSession = store.reserveSession({ guildId: "guild", parentChannelId: "parent", creatorUserId: "one", creationKey: "one" });
    store.attachThread(firstSession.id, "thread-one");
    const secondSession = store.reserveSession({ guildId: "guild", parentChannelId: "parent", creatorUserId: "two", creationKey: "two" });
    store.attachThread(secondSession.id, "thread-two");
    const sent: Array<{ id: string; content: string; author: { id: string }; files: unknown[]; threadId: string }> = [];
    const client = { user: { id: "bot" }, channels: { fetch: async (threadId: string) => ({ isThread: () => true,
      messages: { fetch: async () => sent.filter(message => message.threadId === threadId) },
      send: async (input: any) => { const message = { ...input, id: `report-${sent.length + 1}`, author: { id: "bot" }, threadId }; sent.push(message); return message; },
    }) } };
    const transport = () => new DiscordReportDelivery(client as any, store!);
    const options = () => ({ store: store!, clock: () => now, download: { maxBytes: 16 * 1024 * 1024, timeoutMs: 1000, tempRoot: join(root, "uploads"),
      fetch: (async (url: string) => new Response(url.includes("/12/") ? otherReplay : replay)) }, authorizeUpload: async () => true,
      gateway: {
        registerReplay: async (input: any) => {
          const registered = await core.registerAndEnqueue({ corpusId: input.corpusId, replayPath: input.filePath, sourceRef: input.idempotencyKey });
          if (input.idempotencyKey === `discord-upload:${loseCheckpointForUpload}`) { loseCheckpointForUpload = undefined; throw new Error("lost result after successful core registration"); }
          return { jobId: registered.jobKey, replaySha256: registered.replaySha256, state: "queued" as const };
        },
        getJob: async (input: any) => { const { job } = await core.show(input.corpusId, input.jobId); return { state: job.status,
          artifactPath: job.status === "succeeded" ? await core.reportPath({ corpusId: input.corpusId, replaySha256: job.replaySha256, jobKey: input.jobId }) : undefined }; },
      }, onReportReady: async (input: any) => transport().deliver({ ...input, corpusRoot: registry.get(input.corpusId).corpusRoot }),
    });
    let coordinator = new ReplayCoordinator(options());
    const accept = (messageId: string, attachmentId: string, sessionId = firstSession.id, threadId = "thread-one") => coordinator.accept({ sessionId, threadId,
      messageId, userId: "one", corpusId: "community", authorize: async () => true,
      attachment: { id: attachmentId, name: "../../Professional.REP", size: attachmentId === "12" ? otherReplay.length : replay.length, url: `https://cdn.discordapp.com/attachments/1/${attachmentId}/game.rep` } });
    const first = await accept("message-one", "11");
    const second = await accept("message-one", "12");
    loseCheckpointForUpload = first.id;
    await coordinator.tickOnce(); await coordinator.drain();
    expect(store.getReplayUpload(first.id)?.state).toBe("registering");
    expect(store.getReplayUpload(first.id)?.jobId).toBeNull();
    expect(store.getReplayUpload(first.id)?.filePath).not.toBeNull();
    const queued = (await listAnalysisJobs(dbPath)).jobs;
    expect(queued).toHaveLength(2);
    const originalJob = queued.find(job => job.replaySha256 === sha)!.jobKey;
    // Bot restart while its independent worker still owns the analysis lifecycle.
    await coordinator.stop(); store.close(); store = new BotStore({ dbPath: botPath });
    now += 1001;
    coordinator = new ReplayCoordinator(options());
    await coordinator.tickOnce(); await coordinator.drain();
    expect(store.getReplayUpload(first.id)?.jobId).toBe(originalJob);
    let analysisCalls = 0;
    let releaseAnalysis!: () => void, analysisStarted!: () => void;
    const gate = new Promise<void>(resolve => { releaseAnalysis = resolve; });
    const started = new Promise<void>(resolve => { analysisStarted = resolve; });
    const publisher = createReplayPublisher({ specification: async () => ({ bw_forge_version: "fixture", reducer_version: "m2" }), ingest: ingestReplayAnalysis,
      analyze: async ({ outputRoot, replayPath }) => {
        analysisCalls++;
        if (analysisCalls === 1) { analysisStarted(); await gate; }
        const bytes = await readFile(replayPath), identity = createHash("sha256").update(bytes).digest("hex");
        const output = join(outputRoot, "replays", identity);
        await cp(fixture, output, { recursive: true });
        await writeFile(join(output, "raw.rep"), bytes);
        for (const name of ["manifest.json", "replay-manifest.json"]) {
          const manifest = JSON.parse(await readFile(join(output, name), "utf8")); manifest.replay_id = identity;
          await writeFile(join(output, name), JSON.stringify(manifest));
        }
      } });
    const worker = createAnalysisWorker({ analyze: publisher, log: () => undefined });
    const running = worker.once({ corpusRoot, dbPath, workerId: "m2-worker", leaseMs: 30000, heartbeatMs: 10000 });
    await started;
    now += 5001; await coordinator.tickOnce();
    expect(store.listReplayUploads(["running"])).toHaveLength(1);
    await coordinator.stop(); store.close(); store = new BotStore({ dbPath: botPath });
    coordinator = new ReplayCoordinator(options());
    releaseAnalysis();
    const result = await running;
    expect(result.status).toBe("succeeded");
    expect((await worker.once({ corpusRoot, dbPath, workerId: "m2-worker", leaseMs: 30000, heartbeatMs: 10000 })).status).toBe("succeeded");
    now += 5001;
    await coordinator.tickOnce();
    expect(sent).toHaveLength(2);
    expect(sent.every(message => message.files.length === 1)).toBe(true);
    expect(store.getReportDelivery(first.id)?.state).toBe("delivered");
    expect(store.getReportDelivery(second.id)?.state).toBe("delivered");
    // A different session reuses an already-completed publication without a second worker job.
    const third = await accept("message-two", "13", secondSession.id, "thread-two");
    await coordinator.tickOnce(); await coordinator.drain(); await coordinator.tickOnce();
    expect(store.getReplayUpload(third.id)?.jobId).toMatch(/^completed_/);
    expect(sent).toHaveLength(3); expect(sent[2].threadId).toBe("thread-two");
    expect(analysisCalls).toBe(2); expect((await listAnalysisJobs(dbPath)).jobs).toHaveLength(2);
    expect(store.db.query("SELECT * FROM session_replays").all()).toHaveLength(3);
    await coordinator.tickOnce(); expect(sent).toHaveLength(3);
    await coordinator.stop();
    expect(await readFile(proDbPath)).toEqual(proBefore); expect((await stat(proDbPath)).mtimeMs).toBe(proTime);
  } finally { store?.close(); store = undefined; Bun.gc(true); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}, 60000);

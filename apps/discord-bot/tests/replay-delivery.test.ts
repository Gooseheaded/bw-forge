import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BotStore } from "../src/storage/store.ts";
import { DiscordReportDelivery } from "../src/discord/adapter.ts";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "bwf-report-"));
  const store = new BotStore({ dbPath: join(root, "bot.sqlite") });
  const session = store.reserveSession({ guildId: "g", parentChannelId: "p", creatorUserId: "u", creationKey: "k" });
  store.attachThread(session.id, "thread");
  const upload = store.createReplayUpload({ sessionId: session.id, discordMessageId: "m", attachmentId: "a", userId: "u", corpusId: "community", filename: "Fight.rep" });
  return { root, store, upload };
}

describe("standalone report delivery", () => {
  test("reconciles send-before-checkpoint and ignores forged markers", async () => {
    const { root, store, upload } = setup();
    try {
      const artifact = join(root, "report.html"); writeFileSync(artifact, "<html>report</html>");
      const history: any[] = []; let sends = 0;
      const thread: any = { isThread: () => true, messages: { fetch: async () => history }, send: async (input: any) => {
        sends++; expect(input.enforceNonce).toBe(true); expect(input.nonce.length).toBeLessThanOrEqual(25);
        const message = { id: "sent-before-checkpoint", author: { id: "bot" }, content: input.content }; history.push(message); return message;
      } };
      const transport = new DiscordReportDelivery({ user: { id: "bot" }, channels: { fetch: async () => thread } } as any, store);
      const checkpoint = store.markReportDelivered.bind(store);
      store.markReportDelivered = () => { throw new Error("process crashed before checkpoint"); };
      await expect(transport.deliver({ uploadId: upload.id, threadId: "thread", artifactPath: artifact, corpusRoot: root, label: "../../Fight.rep" })).rejects.toThrow("checkpoint");
      expect(store.getReportDelivery(upload.id)?.state).toBe("pending");
      store.markReportDelivered = checkpoint;
      // A participant's forged marker must not be trusted; only the bot-authored copy reconciles.
      history.unshift({ id: "forged", author: { id: "participant" }, content: history[0].content });
      expect(await transport.deliver({ uploadId: upload.id, threadId: "thread", artifactPath: artifact, corpusRoot: root, label: "Fight.rep" })).toBe("sent-before-checkpoint");
      expect(sends).toBe(1);
    } finally { store.close(); Bun.gc(true); rmSync(root, { recursive: true, force: true }); }
  });

  test("rejects oversized reports before Discord transport", async () => {
    const { root, store, upload } = setup();
    try {
      const artifact = join(root, "report.html"); writeFileSync(artifact, "too big"); let calls = 0;
      const transport = new DiscordReportDelivery({ channels: { fetch: async () => { calls++; throw new Error("must not send"); } } } as any, store, 2);
      await expect(transport.deliver({ uploadId: upload.id, threadId: "thread", artifactPath: artifact, corpusRoot: root, label: "x.rep" })).rejects.toThrow("upload limit");
      expect(calls).toBe(0); expect(store.getReportDelivery(upload.id)?.state).toBe("pending");
    } finally { store.close(); Bun.gc(true); rmSync(root, { recursive: true, force: true }); }
  });

  test("attaches the report and persists Discord message ID", async () => {
    const { root, store, upload } = setup();
    const artifactRoot = join(root, "artifacts");
    const artifact = join(artifactRoot, "Fight.html");
    await Bun.write(artifact, "<html>ok</html>");
    const sent: any[] = [];
    const thread: any = { isThread: () => true, messages: { fetch: async () => [] }, send: async (input: any) => { sent.push(input); return { id: "discord-report-1" }; } };
    const transport = new DiscordReportDelivery({ user: { id: "bot" }, channels: { fetch: async () => thread } } as any, store);
    const id = await transport.deliver({ uploadId: upload.id, threadId: "thread", artifactPath: artifact, corpusRoot: artifactRoot, label: "Fight.rep" });
    expect(id).toBe("discord-report-1");
    expect(store.getReportDelivery(upload.id)?.discordMessageId).toBe("discord-report-1");
    expect(sent).toHaveLength(1);
    store.close(); rmSync(root, { recursive: true, force: true });
  });

  test("rejects missing and outside artifacts without sending", async () => {
    const { root, store, upload } = setup();
    const thread: any = { isThread: () => true, messages: { fetch: async () => [] }, send: async () => { throw new Error("must not send"); } };
    const transport = new DiscordReportDelivery({ user: { id: "bot" }, channels: { fetch: async () => thread } } as any, store);
    await expect(transport.deliver({ uploadId: upload.id, threadId: "thread", artifactPath: join(root, "missing.html"), corpusRoot: root, label: "x" })).rejects.toThrow();
    store.close(); rmSync(root, { recursive: true, force: true });
  });

  test("reconciles an already delivered report without duplicating", async () => {
    const { root, store, upload } = setup();
    const artifactRoot = join(root, "artifacts"), artifact = join(artifactRoot, "x.html");
    await Bun.write(artifact, "ok");
    let sends = 0;
    const sent: any[] = [];
    const thread: any = { isThread: () => true, messages: { fetch: async () => sent }, send: async (input: any) => { sends++; const message = { id: "r1", author: { id: "bot" }, content: input.content }; sent.push(message); return message; } };
    const transport = new DiscordReportDelivery({ user: { id: "bot" }, channels: { fetch: async () => thread } } as any, store);
    await transport.deliver({ uploadId: upload.id, threadId: "thread", artifactPath: artifact, corpusRoot: artifactRoot, label: "x" });
    await transport.deliver({ uploadId: upload.id, threadId: "thread", artifactPath: artifact, corpusRoot: artifactRoot, label: "x" });
    expect(sends).toBe(1);
    store.close(); rmSync(root, { recursive: true, force: true });
  });
});

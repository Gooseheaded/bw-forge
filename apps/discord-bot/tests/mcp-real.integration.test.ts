import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { McpGateway } from "../src/agent/mcp-gateway.ts";
import { TurnRuntime } from "../src/agent/runtime.ts";

describe("MCP gateway with the real corpus query server", () => {
  test("resolves the session replay and returns deterministic economy from SQLite", async () => {
    const root = mkdtempSync(join(tmpdir(), "bwf-m3-mcp-real-"));
    const communityDb = join(root, "community.sqlite"), proDb = join(root, "pro.sqlite");
    const createLegacyDb = (dbPath: string, replays: Array<{ id: string; name: string; workers: number }>) => {
      const db = new Database(dbPath);
      db.exec(`
      CREATE TABLE schema_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE replays(replay_id TEXT PRIMARY KEY,source_replay_filename TEXT,source_replay_path TEXT,matchup TEXT,map TEXT,duration_seconds REAL,manifest_path TEXT NOT NULL);
      CREATE TABLE players(replay_id TEXT NOT NULL,owner INTEGER NOT NULL,name TEXT NOT NULL COLLATE NOCASE,race TEXT NOT NULL COLLATE NOCASE,zip_path TEXT NOT NULL,PRIMARY KEY(replay_id,owner));
      CREATE TABLE build_order_events(replay_id TEXT,owner INTEGER,time_seconds REAL,supply_used INTEGER,supply_max INTEGER,item TEXT,raw_line TEXT);
      CREATE TABLE economy_samples(replay_id TEXT,owner INTEGER,time_seconds REAL,minerals INTEGER,gas INTEGER,gathered_minerals INTEGER,gathered_gas INTEGER,workers INTEGER);
      CREATE TABLE supply_samples(replay_id TEXT,owner INTEGER,time_seconds REAL,current INTEGER,max INTEGER);
      CREATE TABLE unit_count_samples(replay_id TEXT,owner INTEGER,time_seconds REAL,unit_type TEXT,count INTEGER);
      CREATE TABLE death_events(replay_id TEXT,owner INTEGER,frame INTEGER,time_seconds REAL,dead_owner INTEGER,unit_type TEXT,category TEXT);
      ${replays.map(({ id, name }, index) => `INSERT INTO replays VALUES('${id}','${name}.rep','','ZvP','Python',900,'fixture-${index}'); INSERT INTO players VALUES('${id}',0,'FixtureZerg','zerg','player.zip'); INSERT INTO players VALUES('${id}',1,'FixtureProtoss','protoss','enemy.zip'); INSERT INTO economy_samples VALUES('${id}',0,300,900,100,5000,500,${replays[index]!.workers});`).join("\n")}
      `);
      db.close();
    };
    const communityReplay = "a".repeat(64), proReplayOne = "b".repeat(64), proReplayTwo = "c".repeat(64);
    createLegacyDb(communityDb, [{ id: communityReplay, name: "practice", workers: 31 }]);
    createLegacyDb(proDb, [{ id: proReplayOne, name: "pro-one", workers: 28 }, { id: proReplayTwo, name: "pro-two", workers: 34 }]);
    const communityBefore = readFileSync(communityDb), proBefore = readFileSync(proDb);
    const repoRoot = resolve(import.meta.dir, "../../..");
    const queryRoot = join(repoRoot, "packages/corpus-query");
    const endpoint = (id: string, dbPath: string) => ({ id, dbPath, command: "node",
      args: [join(queryRoot, "node_modules/tsx/dist/cli.mjs"), "src/mcp/server.ts", "--db", dbPath, "--transport", "stdio"], cwd: queryRoot });
    const gateway = new McpGateway([endpoint("community", communityDb), endpoint("pro", proDb)], { requestTimeoutMs: 15000, maxCallsPerTurn: 3 });
    try {
      expect((await gateway.listTools()).some((tool) => tool.name === "get_economy_distribution" && tool.corpusIds?.includes("pro"))).toBe(true);
      const result = await gateway.call({ corpusId: "community", name: "get_economy",
        arguments: { player: "FixtureZerg", at_seconds: 300, replay_number: 1 },
        allowedReplayRefs: [{ replayNumber: 1, corpusId: "community", replaySha256: communityReplay }] });
      expect(JSON.stringify(result.structuredContent)).toContain('"workers":31');
      expect(JSON.stringify(result.structuredContent)).toContain(communityReplay);
      const comparison = await gateway.call({ corpusId: "pro", name: "get_economy_distribution",
        arguments: { race: "zerg", opponentRace: "protoss", matchup: "ZvP", timeSeconds: 300, limitExamples: 2 } });
      expect(comparison.structuredContent).toMatchObject({
        filters: { race: "zerg", opponentRace: "protoss", matchup: "ZvP" }, sampleSize: 2,
      });
      expect(JSON.stringify(comparison.structuredContent)).toContain('"mean":31');

      // The mock model supplies protocol requests; this verifies orchestration,
      // real MCP routing, session replay resolution, and delivery together. It
      // does not claim that a live model chose these tools autonomously.
      const turnMessage = { messageId: "m3-integration", sessionId: "9", threadId: "thread", guildId: "guild", parentChannelId: "parent", authorId: "user", content: "Compare replay #1 at five minutes with professional ZvP players." };
      const turn = { id: "turn-1", message: turnMessage, status: "queued" as const, attemptCount: 0 };
      let claimed = false, delivered = "", completed = false;
      const finished = new Promise<void>((resolve) => {
        const store = {
          enqueueMessage: async () => ({ accepted: true, turn }),
          claimNextTurn: async () => { if (claimed) return undefined; claimed = true; turn.status = "running" as any; turn.attemptCount++; return turn; },
          listQueuedSessionIds: async () => [],
          getContext: async () => [{ role: "system" as const, content: "System" }, { role: "user" as const, content: turnMessage.content }],
          getReplayInventory: async () => [{ replayNumber: 1, corpusId: "community", replaySha256: communityReplay, displayName: "practice.rep", analysisAvailable: true }],
          completeTurn: async () => { completed = true; resolve(); }, failTurn: async () => resolve(), skipTurn: async () => resolve(), recoverRunningTurns: async () => {},
        };
        const runtime = new TurnRuntime({ store: store as any,
          provider: { generate: async (request: any) => {
            if (!request.messages.some((message: any) => message.role === "tool")) return { text: "", provider: "mock", model: "mock", toolCalls: [
              { id: "community-call", name: "get_economy", arguments: JSON.stringify({ corpus_id: "community", replay_number: 1, player: "FixtureZerg", at_seconds: 300 }) },
              { id: "pro-call", name: "get_economy_distribution", arguments: JSON.stringify({ corpus_id: "pro", race: "zerg", opponentRace: "protoss", matchup: "ZvP", timeSeconds: 300, limitExamples: 2 }) },
            ] };
            const observations = request.messages.filter((message: any) => message.role === "tool").map((message: any) => JSON.parse(message.content));
            expect(observations).toHaveLength(2);
            expect(JSON.stringify(observations)).toContain('"sampleSize":2');
            return { text: "Replay #1 had 31 workers at 5:00. The professional ZvP sample also averaged 31 workers across 2 replays.", provider: "mock", model: "mock" };
          } }, maxConcurrent: 1, requestTimeoutMs: 15000,
          authorization: { authorize: async () => true },
          delivery: { send: async ({ text }: { text: string }) => { delivered = text; }, failure: async () => {} },
          agent: { gateway, maxRounds: 3, maxToolCalls: 4, maxParallelCalls: 2, turnTimeoutMs: 15000, maxToolResultBytes: 24000 },
        });
        void runtime.enqueue(turnMessage).then(() => setTimeout(() => { if (!completed) resolve(); }, 10000));
      });
      await finished;
      expect(completed).toBe(true);
      expect(delivered).toContain("31 workers");
      expect(delivered).toContain("2 replays");
      expect(readFileSync(communityDb)).toEqual(communityBefore);
      expect(readFileSync(proDb)).toEqual(proBefore);
    } finally {
      await gateway.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

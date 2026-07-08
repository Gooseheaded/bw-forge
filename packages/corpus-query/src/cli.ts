#!/usr/bin/env node
import { Command } from "commander";
import { readFile } from "node:fs/promises";
import { ensureSchema } from "./db/schema.js";
import { openDatabase, saveDatabase } from "./db/sqlite.js";
import { DEFAULT_INGEST_BATCH_SIZE, ingestAnalysisRoot } from "./ingest/ingest.js";
import {
  findFirstEvent,
  findMutaVesselCandidates,
  findReplays,
  getDeathsBetween,
  getEconomyAtOrBefore,
  getUnitCountAtOrBefore
} from "./query/query.js";
import { executeQueryPlan } from "./query-plan/executor.js";
import { exportQueryPlanZip } from "./query-plan/export.js";

const program = new Command();

program.name("replay-corpus");
program.description("Deterministic corpus ingest and query CLI for replay-analysis output");

program
  .command("ingest")
  .argument("<analysisOutputRoot>")
  .requiredOption("--db <path>")
  .option("--batch-size <count>", `number of replays to ingest per batch (default: ${DEFAULT_INGEST_BATCH_SIZE})`)
  .action(async (analysisOutputRoot: string, options: { db: string; batchSize?: string }) => {
    const { db } = await openDatabase(options.db);
    ensureSchema(db);
    const result = await ingestAnalysisRoot(db, analysisOutputRoot, {
      ...(options.batchSize ? { batchSize: Number(options.batchSize) } : {}),
      onBatchComplete: (update) => {
        console.error(
          `Ingest batch ${update.batch_number}: ${update.manifests_completed}/${update.manifests_discovered} replays processed`
        );
      },
      onBatchPersist: async (update) => {
        await saveDatabase(db, options.db);
        console.error(
          `Saved ingest batch ${update.batch_number} to ${options.db}`
        );
      }
    });
    await saveDatabase(db, options.db);
    console.log(
      JSON.stringify(
        {
          command: "ingest",
          analysis_output_root: analysisOutputRoot,
          db_path: options.db,
          ...result
        },
        null,
        2
      )
    );
  });

const queryCommand = program.command("query");
const queryPlanCommand = program.command("query-plan");

queryCommand
  .command("replays")
  .requiredOption("--db <path>")
  .option("--matchup <matchup>")
  .option("--player <player>")
  .option("--race <race>")
  .action(async (options: { db: string; matchup?: string; player?: string; race?: string }) => {
    const { db } = await openDatabase(options.db);
    ensureSchema(db);
    console.log(JSON.stringify(findReplays(db, options), null, 2));
  });

queryCommand
  .command("muta-vessel-candidates")
  .requiredOption("--db <path>")
  .requiredOption("--player <player>")
  .requiredOption("--muta-before <seconds>")
  .requiredOption("--vessel-before <seconds>")
  .requiredOption("--muta-count-at <seconds>")
  .requiredOption("--economy-at <seconds>")
  .requiredOption("--deaths-from <seconds>")
  .requiredOption("--deaths-to <seconds>")
  .option("--matchup <matchup>")
  .option("--race <race>")
  .action(
    async (options: {
      db: string;
      player: string;
      mutaBefore: string;
      vesselBefore: string;
      mutaCountAt: string;
      economyAt: string;
      deathsFrom: string;
      deathsTo: string;
      matchup?: string;
      race?: string;
    }) => {
      const { db } = await openDatabase(options.db);
      ensureSchema(db);
      console.log(
        JSON.stringify(
          findMutaVesselCandidates(db, {
            player: options.player,
            ...(options.matchup ? { matchup: options.matchup } : {}),
            ...(options.race ? { race: options.race } : {}),
            mutaBefore: Number(options.mutaBefore),
            vesselBefore: Number(options.vesselBefore),
            mutaCountAt: Number(options.mutaCountAt),
            economyAt: Number(options.economyAt),
            deathsFrom: Number(options.deathsFrom),
            deathsTo: Number(options.deathsTo)
          }),
          null,
          2
        )
      );
    }
  );

queryCommand
  .command("demo-pbjt-zvt-muta-vessel")
  .requiredOption("--db <path>")
  .action(async (options: { db: string }) => {
    const { db } = await openDatabase(options.db);
    ensureSchema(db);
    console.log(
      JSON.stringify(
        findMutaVesselCandidates(db, {
          player: "pbjt",
          matchup: "ZvT",
          race: "zerg",
          mutaBefore: 360,
          vesselBefore: 690,
          mutaCountAt: 420,
          economyAt: 300,
          deathsFrom: 300,
          deathsTo: 480
        }),
        null,
        2
      )
    );
  });

queryCommand
  .command("first-event")
  .requiredOption("--db <path>")
  .requiredOption("--player <player>")
  .requiredOption("--item <item>")
  .option("--matchup <matchup>")
  .option("--race <race>")
  .option("--as <perspective>", "self or enemy", "self")
  .action(
    async (options: { db: string; player: string; item: string; matchup?: string; race?: string; as?: "self" | "enemy" }) => {
      const { db } = await openDatabase(options.db);
      ensureSchema(db);
      console.log(JSON.stringify(findFirstEvent(db, options), null, 2));
    }
  );

queryCommand
  .command("unit-count")
  .requiredOption("--db <path>")
  .requiredOption("--player <player>")
  .requiredOption("--unit <unit>")
  .requiredOption("--at <seconds>")
  .option("--matchup <matchup>")
  .option("--race <race>")
  .option("--as <perspective>", "self or enemy", "self")
  .action(
    async (options: { db: string; player: string; unit: string; at: string; matchup?: string; race?: string; as?: "self" | "enemy" }) => {
      const { db } = await openDatabase(options.db);
      ensureSchema(db);
      console.log(
        JSON.stringify(
          getUnitCountAtOrBefore(db, { ...options, at: Number(options.at) }),
          null,
          2
        )
      );
    }
  );

queryCommand
  .command("economy")
  .requiredOption("--db <path>")
  .requiredOption("--player <player>")
  .requiredOption("--at <seconds>")
  .option("--matchup <matchup>")
  .option("--race <race>")
  .option("--as <perspective>", "self or enemy", "self")
  .action(async (options: { db: string; player: string; at: string; matchup?: string; race?: string; as?: "self" | "enemy" }) => {
    const { db } = await openDatabase(options.db);
    ensureSchema(db);
    console.log(
      JSON.stringify(
        getEconomyAtOrBefore(db, { ...options, at: Number(options.at) }),
        null,
        2
      )
    );
  });

queryCommand
  .command("deaths")
  .requiredOption("--db <path>")
  .requiredOption("--player <player>")
  .requiredOption("--from <seconds>")
  .requiredOption("--to <seconds>")
  .option("--matchup <matchup>")
  .option("--race <race>")
  .option("--as <perspective>", "self or enemy", "self")
  .action(
    async (options: {
      db: string;
      player: string;
      from: string;
      to: string;
      matchup?: string;
      race?: string;
      as?: "self" | "enemy";
    }) => {
      const { db } = await openDatabase(options.db);
      ensureSchema(db);
      console.log(
        JSON.stringify(
          getDeathsBetween(db, {
            ...options,
            from: Number(options.from),
            to: Number(options.to)
          }),
          null,
          2
        )
      );
    }
  );

queryPlanCommand
  .command("execute")
  .requiredOption("--db <path>")
  .requiredOption("--plan <path>")
  .option("--debug", "include rejected replay traces")
  .action(async (options: { db: string; plan: string; debug?: boolean }) => {
    const plan = JSON.parse(await readFile(options.plan, "utf8"));
    const result = await executeQueryPlan({
      dbPath: options.db,
      plan,
      mode: options.debug ? "debug" : "normal"
    });
    console.log(JSON.stringify(result, null, 2));
  });

queryPlanCommand
  .command("export-zip")
  .requiredOption("--db <path>")
  .requiredOption("--plan <path>")
  .requiredOption("--html-root <path>")
  .requiredOption("--out <path>")
  .option("--debug", "include rejected replay traces in query-result.json")
  .action(
    async (options: {
      db: string;
      plan: string;
      htmlRoot: string;
      out: string;
      debug?: boolean;
    }) => {
      const plan = JSON.parse(await readFile(options.plan, "utf8"));
      const summary = await exportQueryPlanZip({
        dbPath: options.db,
        plan,
        htmlRoot: options.htmlRoot,
        outPath: options.out,
        mode: options.debug ? "debug" : "normal"
      });
      console.log(
        JSON.stringify(
          {
            command: "query-plan export-zip",
            db_path: options.db,
            plan_path: options.plan,
            html_root: options.htmlRoot,
            ...summary
          },
          null,
          2
        )
      );
    }
  );

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

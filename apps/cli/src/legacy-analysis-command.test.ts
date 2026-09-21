import { describe, expect, test } from "bun:test";
import { buildLegacyReplayAnalysisArgs } from "./legacy-analysis-command.js";

describe("legacy replay analysis command", () => {
  test("normal production analysis enables tech research events", () => {
    const args = buildLegacyReplayAnalysisArgs({
      scriptPath: "replay_analysis.py",
      analysisInput: "timeline.sbtl",
      legacyDir: "legacy",
      templatePath: "build-order.html",
      embeddedReplayInput: "game.rep"
    });

    expect(args).toEqual([
      "replay_analysis.py",
      "timeline.sbtl",
      "legacy",
      "--include-tech",
      "--build-order-template",
      "build-order.html",
      "--embedded-replay-input",
      "game.rep"
    ]);
  });
});

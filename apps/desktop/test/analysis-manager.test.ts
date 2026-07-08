import { describe, expect, test } from "vitest";
import type { ChildResult, RunningChild } from "../src/main/child-process-runner";
import { AnalysisManager } from "../src/main/analysis-manager";
import { createDefaultSettings } from "../src/main/settings-store";

describe("analysis job state", () => {
  test("continues after a replay failure, ingests successes, and reports partial", async () => {
    const settings = await createDefaultSettings({
      documentsPath: "C:\\Users\\tester\\Documents",
      runtimeRoot: "C:\\runtime\\bw-forge"
    });
    const results: ChildResult[] = [
      { code: 1, signal: null },
      { code: 0, signal: null },
      { code: 0, signal: null }
    ];
    let refreshCount = 0;
    let finalState = new AnalysisManager({
      getSettings: () => settings,
      onUpdate: (state) => {
        finalStateValue = state;
      },
      refreshLibrary: async () => {
        refreshCount += 1;
      },
      startProcess: () => immediateChild(results.shift() ?? { code: 0, signal: null })
    });
    let finalStateValue = finalState.snapshot();

    finalState.start({
      replayPaths: ["C:\\replays\\bad.rep", "C:\\replays\\good.rep"]
    });
    await waitFor(() => finalStateValue.status === "partial");

    expect(finalStateValue.jobs.map((job) => job.status)).toEqual(["failed", "succeeded"]);
    expect(finalStateValue.ingestExitCode).toBe(0);
    expect(refreshCount).toBe(1);
  });

  test("cancellation marks queued work cancelled", async () => {
    const settings = await createDefaultSettings({
      documentsPath: "C:\\Users\\tester\\Documents",
      runtimeRoot: "C:\\runtime\\bw-forge"
    });
    let resolveChild: ((result: ChildResult) => void) | undefined;
    const manager = new AnalysisManager({
      getSettings: () => settings,
      onUpdate: () => {},
      refreshLibrary: async () => {},
      startProcess: () => {
        const completion = new Promise<ChildResult>((resolvePromise) => {
          resolveChild = resolvePromise;
        });
        return {
          completion,
          terminate: async () => {
            resolveChild?.({ code: null, signal: "SIGTERM" });
          }
        };
      }
    });
    manager.start({
      replayPaths: ["C:\\replays\\first.rep", "C:\\replays\\second.rep"]
    });
    await manager.cancel();
    await waitFor(() => manager.snapshot().status === "cancelled");
    expect(manager.snapshot().jobs.map((job) => job.status)).toEqual([
      "cancelled",
      "cancelled"
    ]);
  });
});

function immediateChild(result: ChildResult): RunningChild {
  return {
    completion: Promise.resolve(result),
    terminate: async () => {}
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for state transition");
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
}

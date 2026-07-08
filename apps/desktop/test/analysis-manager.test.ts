import { describe, expect, test } from "vitest";
import type { AnalysisRunState } from "../src/shared/contracts";
import type { ChildOutput, ChildResult, RunningChild } from "../src/main/child-process-runner";
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

  test("tracks exact replay and ingest progress from child output", async () => {
    const settings = await createDefaultSettings({
      documentsPath: "C:\\Users\\tester\\Documents",
      runtimeRoot: "C:\\runtime\\bw-forge"
    });
    let finalStateValue: AnalysisRunState;
    const manager = new AnalysisManager({
      getSettings: () => settings,
      onUpdate: (state) => {
        finalStateValue = state;
      },
      refreshLibrary: async () => {},
      startProcess: scriptedProcesses([
        {
          outputs: [
            { stream: "stdout", message: "[replay-export] progress gameId=abc frame=123/456 time=00:12 27.0%" },
            { stream: "stdout", message: "[analysis]  37.5% elapsed 4.0s" },
            { stream: "stdout", message: "[analysis] 100.0% elapsed 7.0s" }
          ],
          result: { code: 0, signal: null }
        },
        {
          outputs: [
            { stream: "stderr", message: "Ingest batch 1: 1/1 replays processed" }
          ],
          result: { code: 0, signal: null }
        }
      ])
    });
    finalStateValue = manager.snapshot();

    manager.start({
      replayPaths: ["C:\\replays\\good.rep"]
    });
    await waitFor(() => finalStateValue.status === "succeeded");

    expect(finalStateValue.jobs[0]?.progress?.phase).toBe("finalizing_replay");
    expect(finalStateValue.jobs[0]?.progress?.percent).toBe(100);
    expect(finalStateValue.queueProgress.percent).toBe(100);
    expect(finalStateValue.ingestExitCode).toBe(0);
  });

  test("uses estimated progress when replay export only emits heartbeats", async () => {
    const settings = await createDefaultSettings({
      documentsPath: "C:\\Users\\tester\\Documents",
      runtimeRoot: "C:\\runtime\\bw-forge"
    });
    let latestState: AnalysisRunState;
    let latest = new AnalysisManager({
      getSettings: () => settings,
      onUpdate: (state) => {
        latestState = state;
      },
      refreshLibrary: async () => {},
      startProcess: scriptedProcesses([
        {
          outputs: [
            { stream: "stdout", message: "[replay-export] running... elapsed 12.4s" }
          ],
          result: { code: 1, signal: null }
        }
      ])
    });
    latestState = latest.snapshot();

    latest.start({
      replayPaths: ["C:\\replays\\bad.rep"]
    });
    await waitFor(() => latestState.status === "failed");

    expect(latestState.jobs[0]?.progress?.phase).toBe("replay_export");
    expect(latestState.jobs[0]?.progress?.mode).toBe("estimated");
    expect((latestState.jobs[0]?.progress?.percent ?? 0)).toBeGreaterThan(0);
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

function scriptedProcesses(
  scripts: Array<{
    outputs?: ChildOutput[];
    result: ChildResult;
  }>
): (command: unknown, onOutput: (output: ChildOutput) => void) => RunningChild {
  return (_command, onOutput) => {
    const script = scripts.shift() ?? { result: { code: 0, signal: null } };
    for (const output of script.outputs ?? []) {
      onOutput(output);
    }
    return immediateChild(script.result);
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

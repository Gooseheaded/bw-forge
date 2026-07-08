import { describe, expect, test } from "vitest";
import {
  assertNoRunningStarcraftProcess,
  listRunningStarcraftProcesses,
  parseTasklistCsv
} from "../src/main/starcraft-process";

describe("starcraft process detection", () => {
  test("parses running StarCraft processes from tasklist CSV", () => {
    expect(
      parseTasklistCsv(
        '"StarCraft.exe","4242","Console","1","123,456 K"\n"Other.exe","1111","Console","1","4,096 K"\n'
      )
    ).toEqual([
      {
        imageName: "StarCraft.exe",
        pid: 4242
      }
    ]);
  });

  test("treats tasklist informational output as no running process", () => {
    expect(parseTasklistCsv("INFO: No tasks are running which match the specified criteria.\r\n")).toEqual([]);
  });

  test("throws a clear error when StarCraft is already running", async () => {
    await expect(
      assertNoRunningStarcraftProcess(async () => '"StarCraft.exe","4242","Console","1","123,456 K"\n')
    ).rejects.toThrow(
      "Close StarCraft before starting analysis. BW Forge needs to start its own copy of the game."
    );
  });

  test("allows analysis when no StarCraft process is running", async () => {
    await expect(
      listRunningStarcraftProcesses(
        async () => "INFO: No tasks are running which match the specified criteria.\r\n"
      )
    ).resolves.toEqual([]);
  });
});

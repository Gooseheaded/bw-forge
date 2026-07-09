import { describe, expect, test } from "bun:test";
import { buildCommandSpawnOptions } from "./child-process.js";

describe("buildCommandSpawnOptions", () => {
  test("hides Windows child-process windows without changing stdio or shell behavior", () => {
    const env = { TEST_VAR: "1" };
    const options = buildCommandSpawnOptions({
      cwd: "C:\\bw-forge",
      env
    });

    expect(options).toEqual({
      cwd: "C:\\bw-forge",
      env,
      stdio: "inherit",
      shell: false,
      windowsHide: true
    });
  });
});

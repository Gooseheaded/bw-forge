import { describe, expect, test } from "vitest";
import { hasDroppedFiles, normalizeDroppedReplayPaths } from "../src/renderer/src/analyze-drag-drop";

describe("analyze drag and drop helpers", () => {
  test("detects file drags", () => {
    expect(hasDroppedFiles({ types: ["Files"] } as unknown as DataTransfer)).toBe(true);
    expect(hasDroppedFiles({ types: ["text/plain"] } as unknown as DataTransfer)).toBe(false);
    expect(hasDroppedFiles(null)).toBe(false);
  });

  test("normalizes dropped paths by trimming and deduplicating", () => {
    expect(
      normalizeDroppedReplayPaths([
        " C:\\Replays\\Game.rep ",
        "c:\\replays\\game.rep",
        "",
        "C:\\Replays\\Other.rep"
      ])
    ).toEqual(["C:\\Replays\\Game.rep", "C:\\Replays\\Other.rep"]);
  });
});

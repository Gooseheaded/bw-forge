import { describe, expect, test } from "vitest";
import { shouldHighlightLibraryNav } from "../src/renderer/src/library-nav-highlight";

describe("library nav highlight", () => {
  test("highlights when the library count increases away from the library page", () => {
    expect(
      shouldHighlightLibraryNav({
        previousCount: 3,
        nextCount: 5,
        currentView: "analyze"
      })
    ).toBe(true);
  });

  test("does not highlight when already viewing the library", () => {
    expect(
      shouldHighlightLibraryNav({
        previousCount: 3,
        nextCount: 5,
        currentView: "library"
      })
    ).toBe(false);
  });

  test("does not highlight when the count stays the same", () => {
    expect(
      shouldHighlightLibraryNav({
        previousCount: 5,
        nextCount: 5,
        currentView: "analyze"
      })
    ).toBe(false);
  });
});

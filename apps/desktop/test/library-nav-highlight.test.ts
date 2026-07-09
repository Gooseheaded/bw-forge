import { describe, expect, test } from "vitest";
import { shouldHighlightLibraryNav } from "../src/renderer/src/library-nav-highlight";

describe("library nav highlight", () => {
  test("highlights when analysis completion refreshes the library away from the library page", () => {
    expect(
      shouldHighlightLibraryNav({
        triggeredByAnalysisCompletion: true,
        currentView: "analyze"
      })
    ).toBe(true);
  });

  test("does not highlight when already viewing the library", () => {
    expect(
      shouldHighlightLibraryNav({
        triggeredByAnalysisCompletion: true,
        currentView: "library"
      })
    ).toBe(false);
  });

  test("does not highlight when the refresh was not caused by analysis completion", () => {
    expect(
      shouldHighlightLibraryNav({
        triggeredByAnalysisCompletion: false,
        currentView: "analyze"
      })
    ).toBe(false);
  });
});

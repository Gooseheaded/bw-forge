export function shouldHighlightLibraryNav(params: {
  previousCount: number;
  nextCount: number;
  currentView: "analyze" | "library" | "mcp" | "settings";
}): boolean {
  return (
    params.currentView !== "library" &&
    params.nextCount > params.previousCount
  );
}

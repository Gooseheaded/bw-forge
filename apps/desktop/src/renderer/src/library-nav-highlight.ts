export function shouldHighlightLibraryNav(params: {
  triggeredByAnalysisCompletion: boolean;
  currentView: "analyze" | "library" | "mcp" | "settings";
}): boolean {
  return params.triggeredByAnalysisCompletion && params.currentView !== "library";
}

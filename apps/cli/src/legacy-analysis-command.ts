export interface LegacyReplayAnalysisArgs {
  scriptPath: string;
  analysisInput: string;
  legacyDir: string;
  templatePath: string;
  embeddedReplayInput: string;
}

/** Production replay analysis always includes research-start tech events. */
export function buildLegacyReplayAnalysisArgs(params: LegacyReplayAnalysisArgs): string[] {
  return [
    params.scriptPath,
    params.analysisInput,
    params.legacyDir,
    "--include-tech",
    "--build-order-template",
    params.templatePath,
    "--embedded-replay-input",
    params.embeddedReplayInput
  ];
}

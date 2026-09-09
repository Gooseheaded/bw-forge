/** Shared query facade; MCP and resource handlers do not select SQL dialects. */
import { detectCorpusBackend, requireV1 } from "../db/backend.js";
import * as legacy from "./legacyQuery.js";
import * as v2 from "./v2.js";
export type { ReplayFilters, PerspectiveFilters, BuildEventFilters, MutaVesselCandidateFilters } from "./legacyQuery.js";

export const findReplays = (...args: Parameters<typeof legacy.findReplays>) =>
  detectCorpusBackend(args[0]) === "v2" ? v2.findReplays(...args) : legacy.findReplays(...args);
export const findFirstEvent = (...args: Parameters<typeof legacy.findFirstEvent>) =>
  detectCorpusBackend(args[0]) === "v2" ? v2.findFirstEvent(...args) : legacy.findFirstEvent(...args);
export const findNthEvent = (...args: Parameters<typeof legacy.findNthEvent>) =>
  detectCorpusBackend(args[0]) === "v2" ? v2.findNthEvent(...args) : legacy.findNthEvent(...args);
export const listBuildEvents = (...args: Parameters<typeof legacy.listBuildEvents>) =>
  detectCorpusBackend(args[0]) === "v2" ? v2.listBuildEvents(...args) : legacy.listBuildEvents(...args);
export const getEconomyAtOrBefore = (...args: Parameters<typeof legacy.getEconomyAtOrBefore>) =>
  detectCorpusBackend(args[0]) === "v2" ? v2.getEconomyAtOrBefore(...args) : legacy.getEconomyAtOrBefore(...args);
export const getUnitCountAtOrBefore = (...args: Parameters<typeof legacy.getUnitCountAtOrBefore>) =>
  detectCorpusBackend(args[0]) === "v2" ? v2.getUnitCountAtOrBefore(...args) : legacy.getUnitCountAtOrBefore(...args);
export const getDeathsBetween = (...args: Parameters<typeof legacy.getDeathsBetween>) =>
  detectCorpusBackend(args[0]) === "v2" ? v2.getDeathsBetween(...args) : legacy.getDeathsBetween(...args);
export const findMutaVesselCandidates = (...args: Parameters<typeof legacy.findMutaVesselCandidates>) => {
  requireV1(args[0], "findMutaVesselCandidates");
  return legacy.findMutaVesselCandidates(...args);
};

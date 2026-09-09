import { detectCorpusBackend } from "../db/backend.js";
import * as legacy from "./legacy_discovery.js";
import * as v2 from "./v2.js";
export * from "./legacy_discovery.js";
export const getCorpusSummary = (...args: Parameters<typeof legacy.getCorpusSummary>) =>
  detectCorpusBackend(args[0]) === "v2" ? v2.getCorpusSummary(...args) : legacy.getCorpusSummary(...args);
export const listPlayers = (...args: Parameters<typeof legacy.listPlayers>) =>
  detectCorpusBackend(args[0]) === "v2" ? v2.listPlayers(...args) : legacy.listPlayers(...args);
export const listMatchups = (...args: Parameters<typeof legacy.listMatchups>) =>
  detectCorpusBackend(args[0]) === "v2" ? v2.listMatchups(...args) : legacy.listMatchups(...args);
export const listBuildItems = (...args: Parameters<typeof legacy.listBuildItems>) =>
  detectCorpusBackend(args[0]) === "v2" ? v2.listBuildItems(...args) : legacy.listBuildItems(...args);
export const searchBuildItems = (...args: Parameters<typeof legacy.searchBuildItems>) =>
  detectCorpusBackend(args[0]) === "v2" ? v2.searchBuildItems(...args) : legacy.searchBuildItems(...args);
export const listUnitTypes = (...args: Parameters<typeof legacy.listUnitTypes>) =>
  detectCorpusBackend(args[0]) === "v2" ? v2.listUnitTypes(...args) : legacy.listUnitTypes(...args);

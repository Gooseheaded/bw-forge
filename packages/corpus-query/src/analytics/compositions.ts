import { detectCorpusBackend } from "../db/backend.js";
import * as legacy from "./legacy_compositions.js";
import * as v2 from "./v2.js";
export * from "./legacy_compositions.js";
export const getCompositionSnapshot = (...args: Parameters<typeof legacy.getCompositionSnapshot>) =>
  detectCorpusBackend(args[0]) === "v2" ? v2.getCompositionSnapshot(...args) : legacy.getCompositionSnapshot(...args);
export const getEconomyDistribution = (...args: Parameters<typeof legacy.getEconomyDistribution>) =>
  detectCorpusBackend(args[0]) === "v2" ? v2.getEconomyDistribution(...args) : legacy.getEconomyDistribution(...args);

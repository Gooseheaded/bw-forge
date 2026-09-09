import { detectCorpusBackend } from "../db/backend.js";
import * as legacy from "./legacy_buildTimings.js";
import * as v2 from "./v2.js";
export * from "./legacy_buildTimings.js";
export const getEventTimingDistribution = (...args: Parameters<typeof legacy.getEventTimingDistribution>) =>
  detectCorpusBackend(args[0]) === "v2" ? v2.getEventTimingDistribution(...args) : legacy.getEventTimingDistribution(...args);
export const countReplaysWithEventBeforeEvent = (...args: Parameters<typeof legacy.countReplaysWithEventBeforeEvent>) =>
  detectCorpusBackend(args[0]) === "v2" ? v2.countReplaysWithEventBeforeEvent(...args) : legacy.countReplaysWithEventBeforeEvent(...args);

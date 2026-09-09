import { detectCorpusBackend } from "../db/backend.js";
import * as legacy from "./legacy_deaths.js";
import * as v2 from "./v2.js";
export * from "./legacy_deaths.js";
export const getDeathSummary = (...args: Parameters<typeof legacy.getDeathSummary>) =>
  detectCorpusBackend(args[0]) === "v2" ? v2.getDeathSummary(...args) : legacy.getDeathSummary(...args);

import { detectCorpusBackend } from "../db/backend.js";
import * as legacy from "./legacy_replayCard.js";
import * as v2 from "./v2.js";
export * from "./legacy_replayCard.js";
export const getPlayerReplayCard = (...args: Parameters<typeof legacy.getPlayerReplayCard>) =>
  detectCorpusBackend(args[0]) === "v2" ? v2.getPlayerReplayCard(...args) : legacy.getPlayerReplayCard(...args);

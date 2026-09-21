import rawCatalog from "./event-catalog.json" with { type: "json" };

export type ReplayEventKind = "unit" | "building" | "upgrade" | "tech";
export type ReplayRace = "terran" | "zerg" | "protoss";
export type ReplayEventSourceNamespace = "unit_type" | "upgrade" | "tech";

export interface ReplayEventCatalogEntry {
  key: string;
  displayName: string;
  kind: ReplayEventKind;
  race: ReplayRace | null;
  sourceId: number;
  sourceNamespace: ReplayEventSourceNamespace;
}

interface ReplayEventCatalogDocument {
  schemaVersion: number;
  events: ReplayEventCatalogEntry[];
}

export class UnknownReplayEventKeyError extends Error {
  readonly code = "UNKNOWN_EVENT_KEY";
  readonly eventKey: string;

  constructor(eventKey: string) {
    super(`Unknown canonical replay event key: ${JSON.stringify(eventKey)}`);
    this.name = "UnknownReplayEventKeyError";
    this.eventKey = eventKey;
  }
}

const document = rawCatalog as ReplayEventCatalogDocument;
if (document.schemaVersion !== 1) throw new Error(`Unsupported replay event catalog schema: ${document.schemaVersion}`);

const entries = document.events.map((entry) => Object.freeze({ ...entry }));
const entriesByKey = new Map<string, ReplayEventCatalogEntry>();
const entriesBySource = new Map<string, ReplayEventCatalogEntry>();
for (const entry of entries) {
  if (!/^[a-z0-9]+(?:_[a-z0-9]+)*$/u.test(entry.key)) {
    throw new Error(`Invalid canonical replay event key in catalog: ${JSON.stringify(entry.key)}`);
  }
  if (entriesByKey.has(entry.key)) throw new Error(`Duplicate canonical replay event key: ${entry.key}`);
  const sourceKey = `${entry.sourceNamespace}:${entry.sourceId}`;
  if (entriesBySource.has(sourceKey)) throw new Error(`Duplicate replay event source identity: ${sourceKey}`);
  entriesByKey.set(entry.key, entry);
  entriesBySource.set(sourceKey, entry);
}

/** Immutable authoritative vocabulary for replay events addressable by the fact layer. */
export const replayEventCatalog: readonly ReplayEventCatalogEntry[] = Object.freeze(entries);

/** Resolve a public canonical key. Display labels and unknown identifiers are programmer errors. */
export function resolveReplayEventKey(eventKey: string): ReplayEventCatalogEntry {
  const entry = entriesByKey.get(eventKey);
  if (!entry) throw new UnknownReplayEventKeyError(eventKey);
  return entry;
}

export interface ReplayManifest {
  schema_version: string;
  replay_id: string;
  source: {
    filename: string | null;
    path: string | null;
  };
  matchup: string | null;
  map: string | null;
  duration_seconds: number | null;
  players: ManifestPlayer[];
}

export interface ManifestPlayer {
  owner: number;
  name: string;
  race: string;
  zip_filename: string;
}

export interface PlayerBundle {
  player: {
    schema_version: string;
    owner: number;
    name: string;
    race: string;
    files?: Record<string, string>;
  };
  buildOrderText: string;
  economy: {
    schema_version: string;
    owner: number;
    race: string;
    samples: EconomySamplePayload[];
  };
  supply: {
    schema_version: string;
    owner: number;
    race: string;
    samples: SupplySamplePayload[];
  };
  unitCounts?: {
    schema_version: string;
    owner: number;
    race: string;
    samples: UnitCountSamplePayload[];
  };
  deaths?: {
    schema_version: string;
    owner: number;
    race: string;
    samples: DeathSamplePayload[];
  };
}

export interface EconomySamplePayload {
  frame: number;
  time_seconds: number;
  minerals: number;
  gas: number;
  gathered_minerals?: number;
  gathered_gas?: number;
  workers?: number;
}

export interface SupplySamplePayload {
  frame: number;
  time_seconds: number;
  current: number;
  max: number;
}

export interface UnitCountSamplePayload {
  frame: number;
  time_seconds: number;
  counts: Record<string, number>;
}

export interface DeathSamplePayload {
  frame: number;
  time_seconds: number;
  death: {
    id: number;
    owner: number;
    unit_type: string;
    unit_type_id?: number;
    category: string;
    pos_x?: number;
    pos_y?: number;
  };
}

export interface ReplayRow {
  replay_id: string;
  source_replay_filename: string | null;
  source_replay_path: string | null;
  matchup: string | null;
  map: string | null;
  duration_seconds: number | null;
  manifest_path: string;
}

export interface PlayerRow {
  replay_id: string;
  owner: number;
  name: string;
  race: string;
  zip_path: string;
}

export interface BuildOrderEventRow {
  replay_id: string;
  owner: number;
  time_seconds: number;
  supply_used: number | null;
  supply_max: number | null;
  item: string;
  raw_line: string;
}

export interface EconomySampleRow {
  replay_id: string;
  owner: number;
  time_seconds: number;
  minerals: number;
  gas: number;
  gathered_minerals: number | null;
  gathered_gas: number | null;
  workers: number | null;
}

export interface SupplySampleRow {
  replay_id: string;
  owner: number;
  time_seconds: number;
  current: number;
  max: number;
}

export interface UnitCountSampleRow {
  replay_id: string;
  owner: number;
  time_seconds: number;
  unit_type: string;
  count: number;
}

export interface DeathEventRow {
  replay_id: string;
  owner: number;
  frame: number;
  time_seconds: number;
  dead_owner: number;
  unit_type: string;
  category: string;
}

export interface IngestedReplayData {
  replay: ReplayRow;
  players: PlayerRow[];
  buildOrderEvents: BuildOrderEventRow[];
  economySamples: EconomySampleRow[];
  supplySamples: SupplySampleRow[];
  unitCountSamples: UnitCountSampleRow[];
  deathEvents: DeathEventRow[];
}

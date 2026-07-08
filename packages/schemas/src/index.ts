export interface LegacyReplayAnalysisManifest {
  schema_version: "replay-analysis-manifest-v1";
  replay_id: string;
  source: {
    filename: string | null;
    path: string | null;
  };
  matchup: string | null;
  map: string | null;
  duration_seconds: number | null;
  players: Array<{
    owner: number;
    name: string;
    race: string;
    zip_filename: string;
  }>;
}

export interface BwForgeReplayManifest {
  schema_version: "bw-forge-replay-manifest-v1";
  replay_id: string;
  source: {
    filename: string;
    original_path: string;
    copied_path: string;
  };
  legacy: {
    manifest_path: string;
    html_files: string[];
  };
  replay_analysis: {
    replay_id: string;
    matchup: string | null;
    map: string | null;
    duration_seconds: number | null;
  };
  players: Array<{
    owner: number;
    name: string;
    race: string;
    legacy_zip_filename: string;
    legacy_zip_path: string;
  }>;
  debug?: {
    snapshot_path: string;
  };
}

export interface BwForgeCorpusManifest {
  schema_version: "bw-forge-corpus-manifest-v1";
  generated_at: string;
  replay_count: number;
  replays: Array<{
    replay_id: string;
    replay_manifest_path: string;
    replay_dir: string;
    source_filename: string;
    matchup: string | null;
    duration_seconds: number | null;
  }>;
}


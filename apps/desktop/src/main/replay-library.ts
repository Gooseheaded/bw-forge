import { access, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type {
  ReplayLibrary,
  ReplayLibraryEntry,
  ReplayPlayerView
} from "../shared/contracts";
import { ensurePathWithin, isPathWithin } from "./path-policy";

interface CorpusManifest {
  schema_version: "bw-forge-corpus-manifest-v1";
  replays: Array<{
    replay_id: string;
    replay_manifest_path: string;
  }>;
}

interface ReplayManifest {
  schema_version: "bw-forge-replay-manifest-v1";
  replay_id: string;
  source: { filename: string };
  legacy: {
    html_files: string[];
  };
  replay_analysis: {
    matchup: string | null;
    map: string | null;
    duration_seconds: number | null;
  };
  players: Array<{
    owner: number;
    name: string;
    race: string;
  }>;
}

interface TrustedReplayArtifacts {
  reportPaths: Map<string, string>;
}

export class ReplayLibraryService {
  private trustedArtifacts = new Map<string, TrustedReplayArtifacts>();

  async load(outputRoot: string): Promise<ReplayLibrary> {
    const loadedAt = new Date().toISOString();
    const entries: ReplayLibraryEntry[] = [];
    const warnings: string[] = [];
    const nextTrustedArtifacts = new Map<string, TrustedReplayArtifacts>();
    const corpusPath = join(resolve(outputRoot), "corpus-manifest.json");

    let corpus: CorpusManifest;
    try {
      corpus = await readJson<CorpusManifest>(corpusPath);
      if (corpus.schema_version !== "bw-forge-corpus-manifest-v1" || !Array.isArray(corpus.replays)) {
        throw new Error("unsupported or malformed corpus manifest");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        warnings.push(`Could not load ${corpusPath}: ${formatError(error)}`);
      }
      this.trustedArtifacts = nextTrustedArtifacts;
      return { loadedAt, entries, warnings };
    }

    for (const corpusEntry of corpus.replays) {
      try {
        const manifestPath = ensurePathWithin(
          resolve(outputRoot, corpusEntry.replay_manifest_path),
          outputRoot,
          "Replay manifest"
        );
        const manifest = await readJson<ReplayManifest>(manifestPath);
        validateReplayManifest(manifest, manifestPath);
        if (manifest.replay_id !== corpusEntry.replay_id) {
          throw new Error("replay ID does not match corpus manifest");
        }

        const reports = new Map<string, string>();
        for (const declaredReport of manifest.legacy.html_files ?? []) {
          const reportPath = ensurePathWithin(
            resolve(dirname(manifestPath), declaredReport),
            outputRoot,
            "Replay report"
          );
          try {
            await access(reportPath);
            reports.set(declaredReport, reportPath);
          } catch {
            warnings.push(`${manifest.replay_id}: report is missing: ${declaredReport}`);
          }
        }

        const players: ReplayPlayerView[] = manifest.players.map((player) => ({
          owner: Number(player.owner),
          name: String(player.name),
          race: String(player.race)
        }));
        entries.push({
          replayId: manifest.replay_id,
          sourceFilename: manifest.source.filename,
          matchup: manifest.replay_analysis.matchup,
          map: manifest.replay_analysis.map,
          durationSeconds: manifest.replay_analysis.duration_seconds,
          players,
          reportNames: [...reports.keys()]
        });
        nextTrustedArtifacts.set(manifest.replay_id, { reportPaths: reports });
      } catch (error) {
        warnings.push(`${corpusEntry.replay_id}: ${formatError(error)}`);
      }
    }

    entries.sort((left, right) => left.sourceFilename.localeCompare(right.sourceFilename));
    this.trustedArtifacts = nextTrustedArtifacts;
    return { loadedAt, entries, warnings };
  }

  resolveTrustedReport(outputRoot: string, replayId: string, reportName: string): string {
    const reportPath = this.trustedArtifacts.get(replayId)?.reportPaths.get(reportName);
    if (!reportPath) {
      throw new Error("The requested report is not declared by the loaded replay manifest.");
    }
    if (!isPathWithin(reportPath, outputRoot)) {
      throw new Error("The requested report resolves outside the configured output directory.");
    }
    return reportPath;
  }
}

async function readJson<T>(pathValue: string): Promise<T> {
  return JSON.parse(await readFile(pathValue, "utf8")) as T;
}

function validateReplayManifest(manifest: ReplayManifest, manifestPath: string): void {
  if (
    manifest.schema_version !== "bw-forge-replay-manifest-v1" ||
    typeof manifest.replay_id !== "string" ||
    !manifest.source ||
    typeof manifest.source.filename !== "string" ||
    !manifest.legacy ||
    !Array.isArray(manifest.legacy.html_files) ||
    !manifest.replay_analysis ||
    !Array.isArray(manifest.players)
  ) {
    throw new Error(`${basename(manifestPath)} is not a valid bw-forge replay manifest`);
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

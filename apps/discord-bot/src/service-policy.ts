import { loadConfig } from "./config/index.ts";
import { createCorpusRegistry } from "./corpus/registry.ts";
import { posix } from "node:path";

function systemdPath(path: string): string {
  if (!path || /[\x00-\x1f\x7f]/.test(path) || !path.startsWith("/")) throw new Error("Invalid service policy path");
  return `"${path.replaceAll("\\", "\\x5c").replaceAll(" ", "\\x20").replaceAll('"', "\\x22").replaceAll("'", "\\x27").replaceAll("%", "%%")}"`;
}

/** Render only filesystem policy directives; no credentials or corpus IDs are emitted. */
export async function renderDiscordServicePolicy(env: Record<string, string | undefined> = process.env, options: { validateFilesystem?: boolean } = {}): Promise<string> {
  const config = loadConfig(env);
  const registry = createCorpusRegistry(config);
  if (options.validateFilesystem !== false) await registry.validateFilesystem();
  const dbPath = posix.resolve(config.storage.databasePath);
  const writable = new Set<string>([posix.dirname(dbPath)]);
  const readonly = new Set<string>();
  const uploadId = config.corpus?.defaultUploadCorpus;
  for (const [id, corpus] of registry.corpora) {
    if (id === uploadId && corpus.access === "read-write") {
      writable.add(posix.resolve(corpus.corpusRoot));
      writable.add(posix.dirname(posix.resolve(corpus.database)));
    } else {
      readonly.add(posix.resolve(corpus.corpusRoot));
      readonly.add(posix.dirname(posix.resolve(corpus.database)));
    }
  }
  for (const writePath of writable) for (const readPath of readonly) {
    if (readPath === writePath || readPath.startsWith(`${writePath}/`)) throw new Error("Bot writable state path contains a read-only corpus");
  }
  return [`ReadWritePaths=${[...writable].map(systemdPath).join(" ")}`, ...(readonly.size ? [`ReadOnlyPaths=${[...readonly].map(systemdPath).join(" ")}`] : [])].join("\n");
}

if (import.meta.main) {
  try { console.log(await renderDiscordServicePolicy()); } catch { process.exitCode = 1; }
}

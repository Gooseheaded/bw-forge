import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  resolve,
} from "node:path";

export interface ProcessLock {
  databasePath: string;
  release(): void;
}

/** Acquire a SQLite-backed single-process lease for a bot database. */
export function acquireProcessLock(databasePath: string): ProcessLock {
  if (
    !databasePath ||
    databasePath === ":memory:" ||
    databasePath.startsWith("file:")
  ) {
    throw new Error(
      "A file-backed database path is required for the process lock",
    );
  }
  const requested = normalize(
    isAbsolute(databasePath) ? databasePath : resolve(databasePath),
  );
  const parent = dirname(requested);
  mkdirSync(parent, { recursive: true });
  const canonicalDatabasePath = existsSync(requested)
    ? normalize(realpathSync(requested))
    : normalize(join(realpathSync(parent), basename(requested)));
  const lockPath = canonicalDatabasePath + ".owner.sqlite";
  let lock: Database | undefined;
  try {
    lock = new Database(lockPath, { create: true });
    lock.exec("PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=0;");
    lock.exec("BEGIN EXCLUSIVE;");
  } catch (error) {
    try {
      lock?.close();
    } catch {
      /* best effort */
    }
    throw new Error(
      "Bot database process lock is already held: " +
        (error instanceof Error ? error.message : "unavailable"),
    );
  }
  let released = false;
  return {
    databasePath: canonicalDatabasePath,
    release() {
      if (released) return;
      released = true;
      try {
        lock?.exec("ROLLBACK;");
      } catch {
        /* transaction may already be closed */
      }
      lock?.close();
    },
  };
}

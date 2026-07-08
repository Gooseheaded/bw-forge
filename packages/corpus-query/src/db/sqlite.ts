import { dirname, resolve } from "node:path";
import { mkdir } from "node:fs/promises";

export interface Statement {
  bind(values?: unknown[] | Record<string, unknown>): void;
  step(): boolean;
  getAsObject(): Record<string, unknown>;
  reset(): void;
  free(): void;
}

export interface Database {
  run(sql: string, params?: unknown[] | Record<string, unknown>): void;
  prepare(sql: string): Statement;
  close(): void;
}

export interface OpenDatabaseOptions {
  readOnly?: boolean;
  timeoutMs?: number;
}

type DatabaseSyncLike = {
  exec(sql: string): void;
  prepare(sql: string): StatementSyncLike;
  close(): void;
};

type StatementSyncLike = {
  run(...args: unknown[]): unknown;
  iterate(...args: unknown[]): Iterable<Record<string, unknown>>;
};

type DatabaseSyncConstructor = new (
  path: string,
  options?: {
    readOnly?: boolean;
    allowExtension?: boolean;
    defensive?: boolean;
    enableForeignKeyConstraints?: boolean;
    timeout?: number;
  }
) => DatabaseSyncLike;

let sqliteModulePromise: Promise<{ DatabaseSync: DatabaseSyncConstructor }> | undefined;

function getSqliteModule(): Promise<{ DatabaseSync: DatabaseSyncConstructor }> {
  if (!sqliteModulePromise) {
    const originalEmitWarning = process.emitWarning.bind(process);
    const filteredEmitWarning = ((warning: string | Error, ...args: unknown[]) => {
      if (isSqliteExperimentalWarning(warning, args)) {
        return;
      }
      return (originalEmitWarning as (...innerArgs: unknown[]) => void)(warning, ...args);
    }) as typeof process.emitWarning;

    process.emitWarning = filteredEmitWarning;
    sqliteModulePromise = (import("node:sqlite") as Promise<{ DatabaseSync: DatabaseSyncConstructor }>).finally(() => {
      process.emitWarning = originalEmitWarning;
    });
  }
  return sqliteModulePromise;
}

export async function openDatabase(databasePath: string, options: OpenDatabaseOptions = {}): Promise<{ db: Database }> {
  const resolvedPath = resolve(databasePath);
  if (!options.readOnly) {
    await mkdir(dirname(resolvedPath), { recursive: true });
  }
  const { DatabaseSync } = await getSqliteModule();
  const db = new NodeSqliteDatabase(
    new DatabaseSync(resolvedPath, {
      readOnly: options.readOnly ?? false,
      allowExtension: false,
      defensive: true,
      enableForeignKeyConstraints: true,
      timeout: options.timeoutMs ?? 3000
    })
  );
  return { db };
}

export async function saveDatabase(_db: Database, _databasePath: string): Promise<void> {
  // Native SQLite writes through on each committed transaction.
}

export function withTransaction<T>(db: Database, fn: () => T): T {
  db.run("BEGIN TRANSACTION;");
  try {
    const result = fn();
    db.run("COMMIT;");
    return result;
  } catch (error) {
    db.run("ROLLBACK;");
    throw error;
  }
}

class NodeSqliteDatabase implements Database {
  constructor(private readonly db: DatabaseSyncLike) {}

  run(sql: string, params?: unknown[] | Record<string, unknown>): void {
    if (params === undefined) {
      this.db.exec(sql);
      return;
    }

    const statement = this.db.prepare(sql);
    invokeStatementRun(statement, params);
  }

  prepare(sql: string): Statement {
    return new NodeSqliteStatement(this.db.prepare(sql));
  }

  close(): void {
    this.db.close();
  }
}

class NodeSqliteStatement implements Statement {
  private iterator: Iterator<Record<string, unknown>> | undefined;
  private currentRow: Record<string, unknown> | null = null;

  constructor(private readonly statement: StatementSyncLike) {}

  bind(values?: unknown[] | Record<string, unknown>): void {
    this.iterator = invokeStatementIterate(this.statement, values)[Symbol.iterator]();
    this.currentRow = null;
  }

  step(): boolean {
    if (!this.iterator) {
      this.currentRow = null;
      return false;
    }

    const next = this.iterator.next();
    if (next.done) {
      this.currentRow = null;
      return false;
    }

    this.currentRow = next.value;
    return true;
  }

  getAsObject(): Record<string, unknown> {
    return this.currentRow ?? {};
  }

  reset(): void {
    this.iterator = undefined;
    this.currentRow = null;
  }

  free(): void {
    this.reset();
  }
}

function invokeStatementRun(statement: StatementSyncLike, params: unknown[] | Record<string, unknown>): void {
  if (Array.isArray(params)) {
    statement.run(...params);
    return;
  }
  statement.run(params);
}

function invokeStatementIterate(
  statement: StatementSyncLike,
  params: unknown[] | Record<string, unknown> | undefined
): Iterable<Record<string, unknown>> {
  if (params === undefined) {
    return statement.iterate();
  }
  if (Array.isArray(params)) {
    return statement.iterate(...params);
  }
  return statement.iterate(params);
}

function isSqliteExperimentalWarning(warning: string | Error, args: unknown[]): boolean {
  const warningMessage = typeof warning === "string" ? warning : warning.message;
  const warningName =
    typeof warning === "string"
      ? (typeof args[1] === "string" ? args[1] : undefined)
      : warning.name;

  return warningName === "ExperimentalWarning" && warningMessage.includes("SQLite is an experimental feature");
}

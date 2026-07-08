declare module "sql.js" {
  export interface SqlJsConfig {
    locateFile?: (fileName: string) => string;
  }

  export interface QueryExecResult {
    columns: string[];
    values: Array<Array<string | number | null>>;
  }

  export interface Statement {
    bind(values?: unknown[] | Record<string, unknown>): void;
    step(): boolean;
    getAsObject(): Record<string, unknown>;
    reset(): void;
    free(): void;
  }

  export interface Database {
    run(sql: string, params?: unknown[]): void;
    exec(sql: string, params?: unknown[]): QueryExecResult[];
    prepare(sql: string): Statement;
    export(): Uint8Array;
  }

  export interface SqlJsStatic {
    Database: new (data?: ArrayLike<number> | Buffer | Uint8Array | number[]) => Database;
  }

  export default function initSqlJs(config?: SqlJsConfig): Promise<SqlJsStatic>;
}

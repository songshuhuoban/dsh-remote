/** The synchronous SQLite subset the relay uses: bun:sqlite locally, Durable Object storage on Cloudflare. */
export type SqlValue = string | number | null;
export interface SqlRunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}
export interface SqlStatement {
  get(...args: SqlValue[]): unknown;
  all(...args: SqlValue[]): unknown[];
  run(...args: SqlValue[]): SqlRunResult;
}
export interface SqlDatabase {
  query(sql: string): SqlStatement;
  exec(sql: string): void;
  /** Returns a function that runs `fn` atomically; a throw rolls the transaction back. */
  transaction<T>(fn: () => T): () => T;
}

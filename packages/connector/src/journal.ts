import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import type { RelayCommand, ConnectorResult, ConnectorEvent } from '../../protocol/src/index.ts';

/** Connector-owned command results survive physical reconnections and crashes. */
export class Journal {
  readonly db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY, digest TEXT NOT NULL, status TEXT NOT NULL, result TEXT); CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, frame TEXT NOT NULL); CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL)',
    );
  }
  bindInstance(id: string): void {
    const row = this.db.prepare("SELECT value FROM metadata WHERE key='instance'").get() as {
      value: string;
    } | null;
    if (row && row.value !== id) throw new Error('Connector journal belongs to another instance');
    this.db.prepare("INSERT OR IGNORE INTO metadata VALUES('instance',?)").run(id);
  }
  reserve(
    command: RelayCommand,
  ):
    | { kind: 'new' }
    | { kind: 'result'; result: ConnectorResult }
    | { kind: 'indeterminate' }
    | { kind: 'conflict' } {
    const digest = createHash('sha256')
      .update(
        JSON.stringify({
          instanceId: command.instanceId,
          action: command.action,
          args: command.args,
        }),
      )
      .digest('hex');
    const row = this.db
      .prepare('SELECT digest,status,result FROM commands WHERE id=?')
      .get(command.id) as { digest: string; status: string; result: string | null } | null;
    if (row) {
      if (row.digest !== digest) return { kind: 'conflict' };
      if (row.result) return { kind: 'result', result: JSON.parse(row.result) };
      return { kind: 'indeterminate' };
    }
    this.db.prepare("INSERT INTO commands VALUES(?,?,'pending',NULL)").run(command.id, digest);
    return { kind: 'new' };
  }
  results(): ConnectorResult[] {
    return (
      this.db
        .prepare("SELECT result FROM commands WHERE status='settled' AND result IS NOT NULL")
        .all() as { result: string }[]
    ).map((row) => JSON.parse(row.result));
  }
  acknowledgeResult(id: string): void {
    this.db.prepare("UPDATE commands SET status='acknowledged' WHERE id=?").run(id);
  }
  acknowledgeEvent(id: string): void {
    this.db.prepare('DELETE FROM events WHERE id=?').run(id);
  }
  complete(result: ConnectorResult): void {
    this.db
      .prepare("UPDATE commands SET status='settled',result=? WHERE id=?")
      .run(JSON.stringify(result), result.id);
  }
  event(event: ConnectorEvent): void {
    if (event.kind === 'assistant.stream' || event.kind === 'session.status') return;
    this.db.prepare('INSERT OR IGNORE INTO events VALUES(?,?)').run(event.id, JSON.stringify(event));
  }
  events(): ConnectorEvent[] {
    return (
      this.db.prepare('SELECT frame FROM events ORDER BY rowid').all() as { frame: string }[]
    ).map((row) => JSON.parse(row.frame));
  }
  close(): void {
    this.db.close();
  }
}

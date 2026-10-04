import { Database } from "bun:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
/** Durable single-node relay state. WAL leases/commands are transactionally fenced. */
export function openStore(path: string): Database {
  if (path !== ":memory:")
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path, { create: true });
  if (path !== ":memory:") chmodSync(path, 0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS controllers(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),name TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS auth_sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),controller_id TEXT NOT NULL REFERENCES controllers(id),expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS instances(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),name TEXT NOT NULL,token_hash TEXT UNIQUE NOT NULL,created_at INTEGER NOT NULL,boot_id TEXT,connection_epoch INTEGER NOT NULL DEFAULT 0,capabilities TEXT NOT NULL DEFAULT '[]');
    CREATE TABLE IF NOT EXISTS leases(instance_id TEXT PRIMARY KEY REFERENCES instances(id),controller_id TEXT NOT NULL REFERENCES controllers(id),epoch INTEGER NOT NULL,expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY,request_id TEXT,instance_id TEXT NOT NULL REFERENCES instances(id),user_id TEXT NOT NULL REFERENCES users(id),controller_id TEXT NOT NULL,action TEXT NOT NULL,payload TEXT NOT NULL,fingerprint TEXT NOT NULL,lease_epoch INTEGER,status TEXT NOT NULL,result TEXT,error TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS commands_instance_status ON commands(instance_id,status);
    CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,user_id TEXT NOT NULL,instance_id TEXT NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL,created_at INTEGER NOT NULL,source_id TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS event_source_unique ON events(instance_id,source_id) WHERE source_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS settled_approvals(instance_id TEXT NOT NULL REFERENCES instances(id),approval_id TEXT NOT NULL,PRIMARY KEY(instance_id,approval_id));
    CREATE TABLE IF NOT EXISTS pending_approvals(instance_id TEXT NOT NULL REFERENCES instances(id),approval_id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(instance_id,approval_id));
    CREATE INDEX IF NOT EXISTS event_user_seq ON events(user_id,seq);
  `);
  if (
    !(db.query("PRAGMA table_info(commands)").all() as { name: string }[]).some(
      (column) => column.name === "request_id",
    )
  )
    db.exec("ALTER TABLE commands ADD COLUMN request_id TEXT");
  if (
    !(db.query("PRAGMA table_info(commands)").all() as { name: string }[]).some(
      (column) => column.name === "repository_id",
    )
  )
    db.exec("ALTER TABLE commands ADD COLUMN repository_id TEXT");
  const instanceColumns = new Set(
    (db.query("PRAGMA table_info(instances)").all() as { name: string }[]).map((c) => c.name),
  );
  for (const column of ["last_seen_at", "connected_at", "disconnected_at"])
    if (!instanceColumns.has(column)) db.exec(`ALTER TABLE instances ADD COLUMN ${column} INTEGER`);
  return db;
}

import type { SqlDatabase } from "./db.ts";

/** Relay schema shared by every runtime. Leases/commands are transactionally fenced. */
export function initializeSchema(db: SqlDatabase): void {
  db.exec(`
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
    CREATE TABLE IF NOT EXISTS pairing_codes(code_hash TEXT PRIMARY KEY,instance_id TEXT NOT NULL REFERENCES instances(id),user_id TEXT NOT NULL REFERENCES users(id),expires_at INTEGER NOT NULL);
    DROP INDEX IF EXISTS event_created;
  `);
  // Additive migrations. PRAGMA introspection is not available on every runtime.
  for (const [table, column] of [
    ["commands", "request_id TEXT"],
    ["commands", "repository_id TEXT"],
    ["instances", "last_seen_at INTEGER"],
    ["instances", "connected_at INTEGER"],
    ["instances", "disconnected_at INTEGER"],
  ])
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column}`);
    } catch (error) {
      if (!/duplicate column/i.test(error instanceof Error ? error.message : String(error)))
        throw error;
    }
}

import type { SqlDatabase as Database } from './db.ts';

/**
 * GitHub grants are separate from DSH sessions and repository readiness. The sign-in identity
 * (github_identities) outlives the expiring access grant and is never re-pointed to another user.
 */
export function initializeGitHubStore(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS github_accounts(
      user_id TEXT PRIMARY KEY REFERENCES users(id), github_id INTEGER NOT NULL,
      login TEXT NOT NULL, token_ciphertext TEXT NOT NULL, token_expires_at INTEGER NOT NULL,
      controller_id TEXT NOT NULL REFERENCES controllers(id), connected_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS github_auth_states(
      state_hash TEXT PRIMARY KEY, browser_hash TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id), controller_id TEXT NOT NULL REFERENCES controllers(id),
      session_hash TEXT NOT NULL, consumed INTEGER NOT NULL DEFAULT 0, verifier_ciphertext TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS github_repository_refs(
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
      instance_id TEXT NOT NULL REFERENCES instances(id), controller_id TEXT NOT NULL REFERENCES controllers(id),
      source TEXT NOT NULL CHECK(source IN ('manual','github')),
      url TEXT NOT NULL, full_name TEXT NOT NULL, default_branch TEXT NOT NULL, local_path TEXT NOT NULL,
      github_id INTEGER, installation_id INTEGER, github_account_id INTEGER, authorized_at INTEGER,
      selected INTEGER NOT NULL DEFAULT 1, local_state TEXT NOT NULL DEFAULT 'declared',
      verified_at INTEGER, head TEXT, branch TEXT, created_at INTEGER NOT NULL,
      UNIQUE(instance_id,url,local_path)
    );
    CREATE INDEX IF NOT EXISTS github_refs_owner ON github_repository_refs(user_id,instance_id);
    CREATE TABLE IF NOT EXISTS github_identities(
      github_id INTEGER PRIMARY KEY, user_id TEXT UNIQUE NOT NULL REFERENCES users(id),
      login TEXT NOT NULL, linked_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS github_login_states(
      state_hash TEXT PRIMARY KEY, browser_hash TEXT NOT NULL, verifier_ciphertext TEXT NOT NULL,
      device_name TEXT NOT NULL, invited INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER NOT NULL
    );
  `);
}

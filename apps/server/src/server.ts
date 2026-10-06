import type { ServerWebSocket } from 'bun';
import { Database } from 'bun:sqlite';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { MAX_FRAME_BYTES } from '../../../packages/protocol/src/index.ts';
import type { SqlDatabase } from './db.ts';
import { isPbkdf2Hash, pbkdf2Passwords, type PasswordHasher } from './passwords.ts';
import {
  createRelayCore,
  type RelayOptions as CoreOptions,
  type SocketData,
} from './relay-core.ts';
import { initializeSchema } from './store.ts';

export interface RelayOptions extends CoreOptions {
  databasePath?: string;
  port?: number;
  hostname?: string;
  staticDir?: string;
}

/** Durable single-node relay state on local disk. */
export function openStore(path: string): Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path, { create: true });
  if (path !== ':memory:') chmodSync(path, 0o600);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  initializeSchema(db as unknown as SqlDatabase);
  return db;
}

/** argon2id for new accounts; PBKDF2 hashes from a Cloudflare deployment still verify. */
const bunPasswords: PasswordHasher = {
  hash: (password) => Bun.password.hash(password, { algorithm: 'argon2id' }),
  verify: (password, stored) =>
    isPbkdf2Hash(stored)
      ? pbkdf2Passwords.verify(password, stored)
      : Bun.password.verify(password, stored),
};

function staticFiles(dir: string) {
  const root = resolve(dir);
  return (path: string) => {
    const file = resolve(join(root, decodeURIComponent(path)));
    if (file !== root && !file.startsWith(root + sep))
      return Response.json(
        { error: { code: 'PATH_DENIED', message: 'Invalid path' } },
        { status: 403 },
      );
    const found = existsSync(file) && !path.endsWith('/');
    // Plugin downloads never fall back to the console page; see scripts/pack-plugin.ts.
    if (!found && path.startsWith('/plugin/')) return null;
    const selected = found ? file : join(root, 'index.html');
    return existsSync(selected) ? new Response(Bun.file(selected)) : null;
  };
}

/** Creates a single-process authenticated Bun relay. No DSH execution occurs on this host. */
export function createRelay(options: RelayOptions = {}) {
  const db = openStore(options.databasePath ?? '.data/relay.sqlite');
  const core = createRelayCore(db as unknown as SqlDatabase, options, {
    passwords: bunPasswords,
    staticFile: options.staticDir ? staticFiles(options.staticDir) : undefined,
  });
  const server = Bun.serve<SocketData>({
    hostname: options.hostname ?? '127.0.0.1',
    port: options.port ?? 3000,
    maxRequestBodySize: MAX_FRAME_BYTES,
    fetch: (req, server) =>
      core.fetch(req, {
        ip: server.requestIP(req)?.address ?? 'local',
        upgrade: (data) => (server.upgrade(req, { data }) ? undefined : false),
      }),
    websocket: {
      maxPayloadLength: MAX_FRAME_BYTES,
      idleTimeout: 60,
      sendPings: true,
      backpressureLimit: 4 * 1024 * 1024,
      closeOnBackpressureLimit: true,
      open: (ws: ServerWebSocket<SocketData>) => core.open(ws),
      message: (ws: ServerWebSocket<SocketData>, message) => core.message(ws, message),
      close: (ws: ServerWebSocket<SocketData>) => core.close(ws),
    },
  });
  const timer = setInterval(core.sweep, core.sweepIntervalMs);
  timer.unref();
  return {
    server,
    db,
    stop: async () => {
      clearInterval(timer);
      core.closeAll();
      await server.stop(true);
      db.close();
    },
  };
}

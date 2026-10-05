import { DurableObject } from 'cloudflare:workers';
import { MAX_FRAME_BYTES } from '../../../packages/protocol/src/index.ts';
import type { SqlDatabase, SqlValue } from '../src/db.ts';
import { gitHubOptionsFromEnv } from '../src/github.ts';
import { pbkdf2Passwords } from '../src/passwords.ts';
import {
  createRelayCore,
  type RelayCore,
  type RelaySocket,
  type SocketData,
} from '../src/relay-core.ts';
import { initializeSchema } from '../src/store.ts';

export interface Env {
  RELAY: DurableObjectNamespace<RelayObject>;
  ASSETS: Fetcher;
  /** "enabled" opens self-service registration; "invite" requires REGISTRATION_INVITE_CODE. */
  REGISTRATION?: string;
  /** Secret; when set, registration additionally requires this invite code. */
  REGISTRATION_INVITE_CODE?: string;
  /** Comma-separated extra browser origins; the deployment's own origin is always allowed. */
  ALLOWED_ORIGINS?: string;
  EVENT_RETENTION_DAYS?: string;
  GITHUB_APP_CLIENT_ID?: string;
  GITHUB_APP_CLIENT_SECRET?: string;
  GITHUB_APP_SLUG?: string;
  GITHUB_CALLBACK_URL?: string;
  GITHUB_TOKEN_ENCRYPTION_KEY?: string;
}

const RELAY_PATHS = /^\/(?:health$|api\/|ws\/|github\/)/;
const KEEPALIVE_MS = 30_000;

/** Durable Object SQLite behind the relay's synchronous database interface. */
function durableDatabase(storage: DurableObjectStorage): SqlDatabase {
  const sql = storage.sql;
  const scalar = (query: string) => Number(sql.exec(query).one().value);
  return {
    query: (query) => ({
      get: (...args: SqlValue[]) => sql.exec(query, ...args).toArray()[0] ?? null,
      all: (...args: SqlValue[]) => sql.exec(query, ...args).toArray(),
      run: (...args: SqlValue[]) => {
        sql.exec(query, ...args).toArray();
        return {
          changes: scalar('SELECT changes() AS value'),
          lastInsertRowid: scalar('SELECT last_insert_rowid() AS value'),
        };
      },
    }),
    exec: (query) => void sql.exec(query).toArray(),
    transaction: (fn) => () => storage.transactionSync(fn),
  };
}

/**
 * The whole relay lives in one Durable Object: like the Bun process, it is the single writer
 * for leases, fences and command admission, and owns every live WebSocket.
 */
export class RelayObject extends DurableObject<Env> {
  private readonly core: RelayCore;
  private readonly viewers = new Set<RelaySocket>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const db = durableDatabase(ctx.storage);
    initializeSchema(db);
    const retentionDays = Number(env.EVENT_RETENTION_DAYS ?? 7);
    this.core = createRelayCore(
      db,
      {
        allowedOrigins: (env.ALLOWED_ORIGINS ?? '')
          .split(',')
          .map((origin) => origin.trim())
          .filter(Boolean),
        // "invite" fails closed: without the secret, registration stays off.
        registration:
          env.REGISTRATION === 'enabled' ||
          (env.REGISTRATION === 'invite' && !!env.REGISTRATION_INVITE_CODE),
        inviteCode: env.REGISTRATION_INVITE_CODE || undefined,
        secureCookies: true,
        github: gitHubOptionsFromEnv(env as unknown as Record<string, string | undefined>),
        eventRetentionMs:
          Number.isFinite(retentionDays) && retentionDays > 0
            ? retentionDays * 24 * 60 * 60 * 1000
            : undefined,
      },
      { passwords: pbkdf2Passwords },
    );
    setInterval(() => this.core.sweep(), this.core.sweepIntervalMs);
    // Cloudflare sends no server pings; idle browser/app streams would otherwise be cut.
    setInterval(() => {
      for (const viewer of this.viewers) viewer.send('{"v":1,"type":"keepalive"}');
    }, KEEPALIVE_MS);
  }

  async fetch(request: Request): Promise<Response> {
    const response = await this.core.fetch(request, {
      ip: request.headers.get('CF-Connecting-IP') ?? 'unknown',
      upgrade: (data) => this.upgrade(request, data),
    });
    return response ?? new Response(null, { status: 500 });
  }

  private upgrade(request: Request, data: SocketData): Response | false {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return false;
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    server.accept();
    let closed = false;
    const relay: RelaySocket = {
      data,
      send(message) {
        if (!closed)
          try {
            server.send(message);
          } catch {
            // The peer is gone; the close event finishes cleanup.
          }
      },
      close(code, reason) {
        try {
          server.close(code, reason);
        } catch {
          // Already closing.
        }
        finish();
      },
    };
    // Like Bun, the core sees a close after the current handler returns, so a replacement
    // connector is registered before its predecessor's close is processed.
    const finish = () => {
      if (closed) return;
      closed = true;
      this.viewers.delete(relay);
      setTimeout(() => this.core.close(relay), 0);
    };
    server.addEventListener('message', (event) => {
      if (closed) return;
      const size =
        typeof event.data === 'string' ? event.data.length : (event.data as ArrayBuffer).byteLength;
      if (size > MAX_FRAME_BYTES) return relay.close(1009, 'Frame too large');
      this.core.message(relay, event.data as string | ArrayBuffer);
    });
    server.addEventListener('close', (event) => relay.close(event.code === 1005 ? 1000 : event.code, event.reason));
    server.addEventListener('error', () => finish());
    if (data.role === 'viewer') this.viewers.add(relay);
    this.core.open(relay);
    return new Response(null, { status: 101, webSocket: client });
  }
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (!RELAY_PATHS.test(pathname)) return env.ASSETS.fetch(request);
    return env.RELAY.get(env.RELAY.idFromName('relay')).fetch(request);
  },
} satisfies ExportedHandler<Env>;

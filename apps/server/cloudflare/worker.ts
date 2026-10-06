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
/** Connector heartbeats, answered by the runtime without waking the object. */
const HEARTBEAT = '{"v":1,"type":"ping"}';
const HEARTBEAT_REPLY = '{"v":1,"type":"pong"}';
const PRUNE_EVERY_MS = 24 * 60 * 60 * 1000;
/** Close codes a server may not send; a socket closed with one is closed normally instead. */
const RESERVED_CLOSE_CODES = new Set([1004, 1005, 1006, 1015]);

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
 *
 * Its sockets are hibernatable, and Cloudflare answers Host heartbeats itself: with no console
 * open and no command waiting, the object sleeps, accrues no duration, and Hosts stay connected.
 * Each socket's state is saved as its attachment, so a wake restores it before handling events.
 */
export class RelayObject extends DurableObject<Env> {
  private readonly core: RelayCore;
  private readonly sockets = new Map<
    WebSocket,
    { relay: RelaySocket; closed: boolean; saved: string }
  >();
  private sweeper?: ReturnType<typeof setInterval>;

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
      { passwords: pbkdf2Passwords, hibernates: true },
    );
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(HEARTBEAT, HEARTBEAT_REPLY));
    for (const ws of ctx.getWebSockets()) {
      const data = ws.deserializeAttachment() as SocketData | null;
      if (data) this.core.restore(this.wrap(ws, data));
      else ws.close(1011, 'Relay restarted');
    }
    this.core.recover();
    ctx.blockConcurrencyWhile(async () => {
      if ((await ctx.storage.getAlarm()) === null)
        await ctx.storage.setAlarm(Date.now() + 60 * 60 * 1000);
    });
    this.settle();
  }

  async fetch(request: Request): Promise<Response> {
    const response = await this.core.fetch(request, {
      ip: request.headers.get('CF-Connecting-IP') ?? 'unknown',
      upgrade: (data) => this.upgrade(request, data),
    });
    this.settle();
    return response ?? new Response(null, { status: 500 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const entry = this.sockets.get(ws);
    if (!entry || entry.closed) return;
    const size = typeof message === 'string' ? message.length : message.byteLength;
    if (size > MAX_FRAME_BYTES) entry.relay.close(1009, 'Frame too large');
    else this.core.message(entry.relay, message);
    this.settle();
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string) {
    try {
      ws.close(RESERVED_CLOSE_CODES.has(code) ? 1000 : code, reason);
    } catch {
      // Already closed.
    }
    this.finish(ws);
  }

  async webSocketError(ws: WebSocket) {
    this.finish(ws);
  }

  /** Daily pruning of old events and commands. */
  async alarm() {
    this.core.prune();
    await this.ctx.storage.setAlarm(Date.now() + PRUNE_EVERY_MS);
  }

  private upgrade(request: Request, data: SocketData): Response | false {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return false;
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    this.core.open(this.wrap(server, data));
    return new Response(null, { status: 101, webSocket: client });
  }

  private wrap(ws: WebSocket, data: SocketData): RelaySocket {
    const ctx = this.ctx;
    const entry = { closed: false, saved: '', relay: undefined as unknown as RelaySocket };
    entry.relay = {
      data,
      send(message) {
        if (!entry.closed)
          try {
            ws.send(message);
          } catch {
            // The peer is gone; the close event finishes cleanup.
          }
      },
      close: (code, reason) => {
        try {
          ws.close(code, reason);
        } catch {
          // Already closing.
        }
        this.finish(ws);
      },
      heardFrom: () => ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0,
    };
    this.sockets.set(ws, entry);
    return entry.relay;
  }

  // Like Bun, the core sees a close after the current handler returns, so a replacement
  // connector is registered before its predecessor's close is processed.
  private finish(ws: WebSocket) {
    const entry = this.sockets.get(ws);
    if (!entry || entry.closed) return;
    entry.closed = true;
    setTimeout(() => {
      this.sockets.delete(ws);
      this.core.close(entry.relay);
      this.settle();
    }, 0);
  }

  /**
   * After every event: saves changed socket state for the next wake, and keeps the sweep (whose
   * timer keeps the object awake) running only while an open console or a command needs it.
   */
  private settle() {
    for (const [ws, entry] of this.sockets) {
      if (entry.closed) continue;
      const saved = JSON.stringify(entry.relay.data);
      if (saved === entry.saved) continue;
      entry.saved = saved;
      try {
        ws.serializeAttachment(entry.relay.data);
      } catch {
        // Closing; nothing to restore.
      }
    }
    const needed = this.core.needsSweep();
    if (needed && !this.sweeper)
      this.sweeper = setInterval(() => {
        this.core.sweep();
        this.settle();
      }, this.core.sweepIntervalMs);
    else if (!needed && this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = undefined;
    }
  }
}

/** A missing plugin file must fail as such, not as the console page DSH's pnpm cannot unpack. */
async function pluginAsset(request: Request, env: Env): Promise<Response> {
  const response = await env.ASSETS.fetch(request);
  if (!response.headers.get('content-type')?.startsWith('text/html')) return response;
  return Response.json(
    { error: { code: 'NOT_FOUND', message: 'No such plugin file; see /plugin/manifest.json' } },
    { status: 404 },
  );
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith('/plugin/')) return pluginAsset(request, env);
    if (!RELAY_PATHS.test(pathname)) return env.ASSETS.fetch(request);
    try {
      return await env.RELAY.get(env.RELAY.idFromName('relay')).fetch(request);
    } catch (error) {
      // The object itself failed, e.g. the free plan's daily Durable Object quota ran out
      // ("Exceeded allowed ... in Durable Objects free tier"): say so instead of a bare 500.
      const message = error instanceof Error ? error.message : String(error);
      console.error('Relay object failed', message);
      const quota = /free tier|exceeded/i.test(message);
      return Response.json(
        {
          error: quota
            ? {
                code: 'RELAY_QUOTA',
                message: "The relay used up today's Cloudflare quota; it resets at 00:00 UTC",
              }
            : { code: 'RELAY_UNAVAILABLE', message: 'The relay is temporarily unavailable' },
        },
        { status: 503, headers: { 'Cache-Control': 'no-store' } },
      );
    }
  },
} satisfies ExportedHandler<Env>;

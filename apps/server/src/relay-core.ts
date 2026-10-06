import { createHash, randomBytes } from 'node:crypto';
import {
  CONNECTOR_EVENT_KINDS,
  MAX_FRAME_BYTES,
  isAction,
  isWriteAction,
  type Action,
  type Command,
  type Json,
  type RelayEvent,
  type RepositoryInspection,
} from '../../../packages/protocol/src/index.ts';
import type { SqlDatabase } from './db.ts';
import type { PasswordHasher } from './passwords.ts';
import { validateCommand } from './validation.ts';
import {
  createGitHubService,
  GitHubError,
  type GitHubOptions,
  type GitHubSignIn,
} from './github.ts';
import { githubCallback, githubRoutes } from './github-routes.ts';

type Row = Record<string, string | number | null>;
type Auth = { userId: string; controllerId: string; tokenHash: string };
export type SocketData =
  | {
      role: 'connector';
      instanceId: string;
      userId: string;
      epoch: number;
      ready: boolean;
      leaseEpoch: number;
      leaseExpiresAt: number;
      lastSeenAt: number;
      /** Heartbeats are kept in memory; the stored copy is refreshed at most once a minute. */
      persistedSeenAt: number;
      lastStatus: 'connecting' | 'online' | 'stale' | 'offline';
    }
  | {
      role: 'viewer';
      userId: string;
      controllerId: string;
      after: number;
      expiresAt: number;
    };
/** The runtime's WebSocket: Bun's ServerWebSocket or a Durable Object socket wrapper. */
export interface RelaySocket {
  data: SocketData;
  send(message: string): unknown;
  close(code?: number, reason?: string): void;
}
type Socket = RelaySocket;
/** Runtime services the core cannot provide portably. */
export interface RelayPlatform {
  passwords: PasswordHasher;
  /** Serves the web console for unmatched GET requests, if this runtime does so. */
  staticFile?: (path: string) => Response | null;
}
/** Per-request runtime hooks. `upgrade` returns false when the request cannot be upgraded. */
export interface RequestIO {
  ip: string;
  upgrade(data: SocketData): Response | undefined | false;
}
export interface RelayOptions {
  allowedOrigins?: string[];
  leaseMs?: number;
  sessionMs?: number;
  commandMs?: number;
  registration?: boolean;
  /** When set (and registration is enabled), sign-up requires this shared invite code. */
  inviteCode?: string;
  /** Public origin for pairing links when the relay sits behind a proxy; defaults to the request's. */
  publicOrigin?: string;
  secureCookies?: boolean;
  github?: GitHubOptions;
  /** GitHub network transport; injected only by deterministic protocol tests. */
  githubTransport?: typeof fetch;
  heartbeatStaleMs?: number;
  heartbeatDisconnectMs?: number;
  /** Durable event history kept for replay; older rows are pruned. */
  eventRetentionMs?: number;
}
class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const uid = (kind: string) => `${kind}_${crypto.randomUUID()}`;
/** Password hash of accounts created by "Sign in with GitHub"; no password can match it. */
const GITHUB_ONLY = '!github';
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
function string(value: unknown, name: string, max = 200): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max)
    throw new HttpError(
      400,
      'INVALID_INPUT',
      `${name} must be a nonempty string of at most ${max} characters`,
    );
  return value;
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (object(value))
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(value[k])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(data, { status, headers });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const SEEN_PERSIST_MS = 60_000;
const KEEPALIVE_MS = 25_000;
const PAIRING_MS = 10 * 60 * 1000;
// Crockford base32: no I, L, O or U, so codes survive being read aloud or retyped.
const PAIRING_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function pairingCode(): string {
  const bytes = randomBytes(8);
  let code = '';
  for (const byte of bytes) code += PAIRING_ALPHABET[byte & 31];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}
const normalizePairingCode = (value: string) =>
  value.toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');

/**
 * Single-writer relay logic shared by the Bun server and the Cloudflare Durable Object.
 * Exactly one core may own a database. No DSH execution occurs on this host.
 */
export function createRelayCore(
  db: SqlDatabase,
  options: RelayOptions,
  platform: RelayPlatform,
) {
  const github = createGitHubService(db, options.github, options.githubTransport);
  const leaseMs = options.leaseMs ?? 30_000;
  const sessionMs = options.sessionMs ?? 7 * 24 * 60 * 60 * 1000;
  const commandMs = options.commandMs ?? 30_000;
  const heartbeatStaleMs = options.heartbeatStaleMs ?? 30_000;
  const heartbeatDisconnectMs = options.heartbeatDisconnectMs ?? 60_000;
  const eventRetentionMs = options.eventRetentionMs ?? 7 * 24 * 60 * 60 * 1000;
  let nextPruneAt = 0,
    nextKeepaliveAt = 0;
  const registrationMode =
    options.registration !== true ? 'closed' : options.inviteCode ? 'invite' : 'open';
  if (heartbeatStaleMs < 100 || heartbeatDisconnectMs <= heartbeatStaleMs)
    throw new Error('Heartbeat deadlines must be positive and ordered');
  const allowedOrigins = new Set(
    options.allowedOrigins ?? [
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://localhost:3000',
      'http://127.0.0.1:3000',
    ],
  );
  const connectors = new Map<string, Socket>();
  const viewers = new Set<Socket>();
  const attempts = new Map<string, { count: number; until: number }>();
  const get = (sql: string, ...args: (string | number | null)[]) =>
    db.query(sql).get(...args) as Row | null;
  const all = (sql: string, ...args: (string | number | null)[]) =>
    db.query(sql).all(...args) as Row[];
  const run = (sql: string, ...args: (string | number | null)[]) => db.query(sql).run(...args);
  function connectionStatus(id: string): 'connecting' | 'online' | 'stale' | 'offline' {
    const data = connectors.get(id)?.data;
    if (data?.role !== 'connector') return 'offline';
    if (Date.now() - data.lastSeenAt > heartbeatStaleMs) return 'stale';
    return data.ready ? 'online' : 'connecting';
  }
  function connectorOnline(id: string): boolean {
    return connectionStatus(id) === 'online';
  }
  // A lost connection after dispatch has an unknown outcome, never safe automatic replay.
  run(
    "UPDATE commands SET status='indeterminate',error=?,updated_at=? WHERE status IN ('queued','dispatched')",
    JSON.stringify({
      code: 'RELAY_RESTARTED',
      message:
        'Relay restarted before a durable result; inspect DSH state before retrying with a new id',
    }),
    Date.now(),
  );
  function emit(
    userId: string,
    instanceId: string,
    kind: string,
    payload: Json,
    sourceId?: string,
    project?: () => void,
  ) {
    const row = db.transaction(() => {
      const result = run(
        'INSERT OR IGNORE INTO events(user_id,instance_id,kind,payload,created_at,source_id) VALUES(?,?,?,?,?,?)',
        userId,
        instanceId,
        kind,
        JSON.stringify(payload),
        Date.now(),
        sourceId ?? null,
      );
      if (result.changes === 0) return null;
      project?.();
      return get('SELECT * FROM events WHERE seq=?', Number(result.lastInsertRowid))!;
    })();
    if (!row) return;
    const event = eventView(row);
    for (const ws of viewers)
      if (ws.data.role === 'viewer' && ws.data.userId === userId) ws.send(JSON.stringify(event));
  }
  function eventView(row: Row): RelayEvent {
    return {
      v: 1,
      type: 'event',
      seq: Number(row.seq),
      instanceId: String(row.instance_id),
      kind: String(row.kind),
      payload: JSON.parse(String(row.payload)) as Json,
      createdAt: Number(row.created_at),
    };
  }
  function leaseView(instanceId: string) {
    const row = get(
      'SELECT * FROM leases WHERE instance_id=? AND expires_at>?',
      instanceId,
      Date.now(),
    );
    if (!row) return null;
    const data = connectors.get(instanceId)?.data;
    const acknowledged =
      data?.role === 'connector' &&
      data.ready &&
      connectorOnline(instanceId) &&
      data.leaseEpoch === Number(row.epoch) &&
      data.leaseExpiresAt > Date.now();
    // Renewals keep their previously acknowledged authority until its old expiry.
    // An extension cannot authorize longer deadlines until the Host ACKs it.
    return {
      controllerId: String(row.controller_id),
      epoch: Number(row.epoch),
      expiresAt: acknowledged
        ? Math.min(Number(row.expires_at), data.leaseExpiresAt)
        : Number(row.expires_at),
      pending: !acknowledged,
    };
  }

  function leaseConfirmed(id: string, epoch: number, expiresAt: number) {
    const data = connectors.get(id)?.data;
    return (
      data?.role === 'connector' &&
      data.ready &&
      connectorOnline(id) &&
      data.leaseEpoch === epoch &&
      data.leaseExpiresAt >= expiresAt
    );
  }
  async function waitFence(id: string, epoch: number, expiresAt: number) {
    const until = Date.now() + 3000;
    while (Date.now() < until) {
      if (leaseConfirmed(id, epoch, expiresAt)) return;
      await sleep(10);
    }
    throw new HttpError(
      409,
      'FENCE_PENDING',
      'Connector has not acknowledged control; no commands can be sent yet',
    );
  }
  function instanceView(row: Row) {
    const live = connectors.get(String(row.id))?.data;
    return {
      id: String(row.id),
      name: String(row.name),
      createdAt: Number(row.created_at),
      online: connectorOnline(String(row.id)),
      status: connectionStatus(String(row.id)),
      lastSeenAt: (live?.role === 'connector' ? live.lastSeenAt : null) ?? row.last_seen_at ?? null,
      connectedAt: row.connected_at ?? null,
      disconnectedAt: row.disconnected_at ?? null,
      observedAt: Date.now(),
      bootId: row.boot_id,
      connectionEpoch: Number(row.connection_epoch),
      capabilities: JSON.parse(String(row.capabilities)),
      lease: leaseView(String(row.id)),
    };
  }
  function commandView(row: Row): Command {
    return {
      id: String(row.request_id ?? row.id),
      instanceId: String(row.instance_id),
      controllerId: String(row.controller_id),
      action: String(row.action) as Action,
      status: row.status as Command['status'],
      result: row.result ? JSON.parse(String(row.result)) : null,
      error: row.error ? JSON.parse(String(row.error)) : null,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }
  function pendingApprovals(userId: string, instanceId?: string) {
    const rows = instanceId
      ? all(
          'SELECT a.* FROM pending_approvals a JOIN instances i ON i.id=a.instance_id WHERE i.user_id=? AND i.id=?',
          userId,
          instanceId,
        )
      : all(
          'SELECT a.* FROM pending_approvals a JOIN instances i ON i.id=a.instance_id WHERE i.user_id=?',
          userId,
        );
    return rows.map((row) => ({
      ...JSON.parse(String(row.payload)),
      instanceId: String(row.instance_id),
    }));
  }
  function controllerView(row: Row) {
    return {
      id: String(row.id),
      name: String(row.name),
      createdAt: Number(row.created_at),
      active: !!get(
        'SELECT 1 FROM auth_sessions WHERE controller_id=? AND expires_at>? LIMIT 1',
        String(row.id),
        Date.now(),
      ),
    };
  }
  function ownedInstance(id: string, userId: string) {
    const row = get('SELECT * FROM instances WHERE id=? AND user_id=?', id, userId);
    if (!row) throw new HttpError(404, 'NOT_FOUND', 'Instance not found');
    return row;
  }
  function authenticate(req: Request): Auth {
    const bearer = req.headers.get('authorization');
    const raw = bearer?.startsWith('Bearer ')
      ? bearer.slice(7)
      : req.headers
          .get('cookie')
          ?.split(';')
          .map((s) => s.trim())
          .find((s) => s.startsWith('dsh_session='))
          ?.slice(12);
    if (!raw) throw new HttpError(401, 'UNAUTHENTICATED', 'Sign in required');
    const row = get(
      'SELECT * FROM auth_sessions WHERE token_hash=? AND expires_at>?',
      digest(raw),
      Date.now(),
    );
    if (!row) throw new HttpError(401, 'UNAUTHENTICATED', 'Session expired');
    return {
      userId: String(row.user_id),
      controllerId: String(row.controller_id),
      tokenHash: digest(raw),
    };
  }
  function checkOrigin(req: Request) {
    const origin = req.headers.get('origin');
    if (origin && !allowedOrigins.has(origin) && origin !== new URL(req.url).origin)
      throw new HttpError(403, 'ORIGIN_DENIED', 'Origin is not allowed');
  }
  async function body(req: Request): Promise<Record<string, unknown>> {
    if (Number(req.headers.get('content-length') ?? 0) > MAX_FRAME_BYTES)
      throw new HttpError(413, 'TOO_LARGE', 'Request too large');
    const text = await req.text();
    if (new TextEncoder().encode(text).byteLength > MAX_FRAME_BYTES)
      throw new HttpError(413, 'TOO_LARGE', 'Request too large');
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new HttpError(400, 'INVALID_JSON', 'Malformed JSON');
    }
    if (!object(value)) throw new HttpError(400, 'INVALID_INPUT', 'Expected JSON object');
    return value;
  }
  function boundController(auth: Auth, value: unknown) {
    if (value !== auth.controllerId)
      throw new HttpError(
        403,
        'CONTROLLER_MISMATCH',
        'This login is bound to a different controller',
      );
  }
  /** Registers a controller for this sign-in and returns its new session secret. */
  function openSession(userId: string, deviceName: string, now = Date.now()) {
    const controllerId = uid('ctl'),
      raw = token();
    run(
      'INSERT INTO controllers(id,user_id,name,created_at) VALUES(?,?,?,?)',
      controllerId,
      userId,
      deviceName,
      now,
    );
    run(
      'INSERT INTO auth_sessions(token_hash,user_id,controller_id,expires_at) VALUES(?,?,?,?)',
      digest(raw),
      userId,
      controllerId,
      now + sessionMs,
    );
    return { raw, controllerId };
  }
  const sessionCookie = (raw: string, url: URL) =>
    `dsh_session=${raw}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${Math.floor(sessionMs / 1000)}${options.secureCookies === true || url.protocol === 'https:' ? '; Secure' : ''}`;
  const validInvite = (value: unknown) =>
    typeof value === 'string' && !!options.inviteCode && digest(value.trim()) === digest(options.inviteCode);
  /** Completes "Sign in with GitHub": a linked account signs in, an unknown one may register. */
  function githubSignIn(identity: GitHubSignIn, url: URL): string {
    const now = Date.now();
    let userId = github.identityUser(identity.githubId);
    if (!userId) {
      if (!identity.invited)
        throw new GitHubError(
          403,
          options.registration === true ? 'INVITE_REQUIRED' : 'REGISTRATION_DISABLED',
          'This GitHub account has no relay account yet',
        );
      userId = uid('usr');
      try {
        run(
          'INSERT INTO users(id,email,password_hash,created_at) VALUES(?,?,?,?)',
          userId,
          `${identity.githubId}+${identity.login}@users.noreply.github.com`.toLowerCase(),
          GITHUB_ONLY,
          now,
        );
      } catch {
        throw new GitHubError(409, 'ACCOUNT_EXISTS', 'Account already exists');
      }
    }
    const { raw, controllerId } = openSession(userId, identity.deviceName, now);
    github.storeGrant(userId, controllerId, identity);
    return sessionCookie(raw, url);
  }
  function limitAttempts(key: string) {
    const now = Date.now(),
      limit = attempts.get(key);
    if (limit && limit.until > now && limit.count >= 20)
      throw new HttpError(429, 'RATE_LIMITED', 'Too many attempts');
    attempts.set(key, { count: limit && limit.until > now ? limit.count + 1 : 1, until: now + 60_000 });
  }
  /** Issues a new connector credential, disconnecting the old one and fencing out its writer. */
  function rotateConnectorToken(instanceId: string): string {
    const raw = token();
    run('UPDATE instances SET token_hash=? WHERE id=?', digest(raw), instanceId);
    const socket = connectors.get(instanceId);
    if (socket) {
      if (socket.data.role === 'connector') socket.data.ready = false;
      socket.close(4003, 'Connector credential rotated');
    }
    run('UPDATE leases SET epoch=epoch+1,expires_at=0 WHERE instance_id=?', instanceId);
    const lease = get('SELECT * FROM leases WHERE instance_id=?', instanceId);
    if (lease) publishLease(lease);
    return raw;
  }
  function publishLease(row: Row) {
    const instance = ownedInstance(
      String(row.instance_id),
      String(get('SELECT user_id FROM instances WHERE id=?', String(row.instance_id))!.user_id),
    );
    const lease = {
      controllerId: String(row.controller_id),
      epoch: Number(row.epoch),
      expiresAt: Number(row.expires_at),
    };
    connectors
      .get(String(row.instance_id))
      ?.send(JSON.stringify({ v: 1, type: 'lease', ...lease }));
    emit(
      String(instance.user_id),
      String(instance.id),
      'lease.changed',
      leaseView(String(instance.id)) ?? { ...lease, pending: false },
    );
  }
  function finishPending(instanceId: string, code: string, message: string) {
    for (const row of all(
      "SELECT * FROM commands WHERE instance_id=? AND status='dispatched'",
      instanceId,
    )) {
      run(
        "UPDATE commands SET status='indeterminate',error=?,updated_at=? WHERE id=?",
        JSON.stringify({ code, message }),
        Date.now(),
        String(row.id),
      );
      emit(
        String(row.user_id),
        instanceId,
        'command.updated',
        commandView(get('SELECT * FROM commands WHERE id=?', String(row.id))!) as unknown as Json,
      );
    }
  }
  function revokeController(controllerId: string) {
    run('DELETE FROM auth_sessions WHERE controller_id=?', controllerId);
    for (const ws of viewers)
      if (ws.data.role === 'viewer' && ws.data.controllerId === controllerId) {
        viewers.delete(ws);
        ws.close(4003, 'Controller revoked');
      }
    for (const lease of all(
      'SELECT * FROM leases WHERE controller_id=? AND expires_at>?',
      controllerId,
      Date.now(),
    )) {
      run(
        'UPDATE leases SET epoch=epoch+1,expires_at=0 WHERE instance_id=?',
        String(lease.instance_id),
      );
      publishLease(get('SELECT * FROM leases WHERE instance_id=?', String(lease.instance_id))!);
    }
  }
  async function fetch(req: Request, io: RequestIO): Promise<Response | undefined> {
      try {
        const url = new URL(req.url),
          path = url.pathname;
        if (path === '/health')
          return json({
            ok: true,
            protocol: 1,
            registration: registrationMode,
            githubSignIn: github.signInAvailable,
          });
        checkOrigin(req);
        const githubReturn = await githubCallback(req, github, (identity) =>
          githubSignIn(identity, url),
        );
        if (githubReturn) return githubReturn;
        if (req.method === 'OPTIONS')
          return new Response(null, {
            status: 204,
            headers: {
              'Access-Control-Allow-Origin': req.headers.get('origin') ?? url.origin,
              'Access-Control-Allow-Credentials': 'true',
              'Access-Control-Allow-Headers': 'Content-Type,Authorization',
              'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
            },
          });
        if (path === '/ws/connector') {
          const header = req.headers.get('authorization');
          if (!header?.startsWith('Bearer '))
            throw new HttpError(401, 'UNAUTHENTICATED', 'Connector credential required');
          const instance = get(
            'SELECT * FROM instances WHERE token_hash=?',
            digest(header.slice(7)),
          );
          if (!instance)
            throw new HttpError(401, 'UNAUTHENTICATED', 'Invalid connector credential');
          const upgraded = io.upgrade({
            role: 'connector',
            instanceId: String(instance.id),
            userId: String(instance.user_id),
            epoch: 0,
            ready: false,
            leaseEpoch: 0,
            leaseExpiresAt: 0,
            lastSeenAt: Date.now(),
            persistedSeenAt: 0,
            lastStatus: 'connecting',
          });
          if (upgraded !== false) return upgraded;
          throw new HttpError(400, 'UPGRADE_REQUIRED', 'WebSocket upgrade required');
        }
        if (path === '/api/connector/me') {
          // Lets a connector distinguish a rejected credential from an unreachable relay.
          if (req.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'GET required');
          const header = req.headers.get('authorization');
          if (!header?.startsWith('Bearer '))
            throw new HttpError(401, 'UNAUTHENTICATED', 'Connector credential required');
          const instance = get('SELECT * FROM instances WHERE token_hash=?', digest(header.slice(7)));
          if (!instance)
            throw new HttpError(401, 'UNAUTHENTICATED', 'Invalid connector credential');
          return json({ instance: { id: String(instance.id), name: String(instance.name) } });
        }
        if (path === '/api/connector/pair') {
          if (req.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'POST required');
          limitAttempts(`pair:${io.ip}`);
          const input = await body(req),
            code = normalizePairingCode(string(input.code, 'code', 40));
          // Single use: the code is consumed together with issuing the credential.
          const claimed = db.transaction(() => {
            const row = get(
              'SELECT * FROM pairing_codes WHERE code_hash=? AND expires_at>?',
              digest(code),
              Date.now(),
            );
            if (!row) return null;
            run('DELETE FROM pairing_codes WHERE code_hash=?', digest(code));
            return row;
          })();
          if (!claimed)
            throw new HttpError(404, 'PAIRING_INVALID', 'Pairing code is invalid or has expired');
          const instance = get('SELECT * FROM instances WHERE id=?', String(claimed.instance_id))!;
          const connectorToken = rotateConnectorToken(String(instance.id));
          emit(String(instance.user_id), String(instance.id), 'instance.paired', { at: Date.now() });
          return json({
            instance: { id: String(instance.id), name: String(instance.name) },
            connectorToken,
          });
        }
        if (path === '/api/auth/github') {
          // Browser-only: the flow cookie must come back with GitHub's redirect.
          if (req.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'POST required');
          if (!req.headers.has('origin'))
            throw new HttpError(409, 'GITHUB_BROWSER_REQUIRED', 'Sign in with GitHub from a browser');
          limitAttempts(`signin:${io.ip}`);
          const input = await body(req),
            deviceName = string(input.deviceName ?? 'Controller', 'deviceName', 80);
          if (input.inviteCode !== undefined && input.inviteCode !== '' && !validInvite(input.inviteCode))
            throw new HttpError(403, 'INVITE_REQUIRED', 'A valid invite code is required');
          // Whether an unknown GitHub account may create a relay account at the callback.
          const mayRegister =
            options.registration === true && (!options.inviteCode || validInvite(input.inviteCode));
          const started = github.startSignIn(deviceName, mayRegister);
          return json(
            { authorizationUrl: started.authorizationUrl, expiresAt: started.expiresAt },
            200,
            { 'Set-Cookie': started.cookie, 'Cache-Control': 'no-store' },
          );
        }
        if (path === '/api/auth/register' || path === '/api/auth/login') {
          if (req.method !== 'POST')
            throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'POST required');
          const key = io.ip,
            now = Date.now(),
            limit = attempts.get(key);
          if (limit && limit.until > now && limit.count >= 20)
            throw new HttpError(429, 'RATE_LIMITED', 'Too many sign-in attempts');
          attempts.set(key, {
            count: limit && limit.until > now ? limit.count + 1 : 1,
            until: now + 60_000,
          });
          const input = await body(req),
            email = string(input.email, 'email', 254).trim().toLowerCase(),
            password = string(input.password, 'password', 1024),
            deviceName = string(input.deviceName ?? 'Controller', 'deviceName', 80);
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || password.length < 8)
            throw new HttpError(
              400,
              'INVALID_INPUT',
              'Use a valid email and password of at least 8 characters',
            );
          let user = get('SELECT * FROM users WHERE email=?', email);
          if (path.endsWith('register')) {
            if (options.registration !== true)
              throw new HttpError(403, 'REGISTRATION_DISABLED', 'Registration is disabled');
            if (options.inviteCode && !validInvite(input.inviteCode))
              throw new HttpError(403, 'INVITE_REQUIRED', 'A valid invite code is required');
            if (user) throw new HttpError(409, 'ACCOUNT_EXISTS', 'Account already exists');
            const hash = await platform.passwords.hash(password);
            try {
              run(
                'INSERT INTO users(id,email,password_hash,created_at) VALUES(?,?,?,?)',
                uid('usr'),
                email,
                hash,
                now,
              );
            } catch {
              throw new HttpError(409, 'ACCOUNT_EXISTS', 'Account already exists');
            }
            user = get('SELECT * FROM users WHERE email=?', email)!;
          } else if (
            !user ||
            user.password_hash === GITHUB_ONLY ||
            !(await platform.passwords.verify(password, String(user.password_hash)))
          )
            throw new HttpError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
          const { raw, controllerId } = openSession(String(user.id), deviceName, now);
          return json(
            {
              user: { id: user.id, email: user.email },
              controller: controllerView(
                get('SELECT * FROM controllers WHERE id=?', controllerId)!,
              ),
              // Browser callers get only an HttpOnly cookie; native clients have no Origin.
              ...(req.headers.has('origin') ? {} : { token: raw }),
            },
            path.endsWith('register') ? 201 : 200,
            { 'Set-Cookie': sessionCookie(raw, url) },
          );
        }
        if (path.startsWith('/api/') || path === '/ws/events') {
          const auth = authenticate(req);
          const githubResponse = await githubRoutes(req, auth, github, body);
          if (githubResponse) return githubResponse;
          if (path === '/ws/events') {
            const after = Number(url.searchParams.get('after') ?? 0);
            if (!Number.isSafeInteger(after) || after < 0)
              throw new HttpError(400, 'INVALID_CURSOR', 'Invalid event cursor');
            const expiresAt = Number(
              get('SELECT expires_at FROM auth_sessions WHERE token_hash=?', auth.tokenHash)!
                .expires_at,
            );
            const upgraded = io.upgrade({
              role: 'viewer',
              userId: auth.userId,
              controllerId: auth.controllerId,
              after,
              expiresAt,
            });
            if (upgraded !== false) return upgraded;
            throw new HttpError(400, 'UPGRADE_REQUIRED', 'WebSocket upgrade required');
          }
          if (path === '/api/auth/logout' && req.method === 'POST') {
            revokeController(auth.controllerId);
            return json({ ok: true }, 200, {
              'Set-Cookie': 'dsh_session=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0',
            });
          }
          if (path === '/api/me' && req.method === 'GET') {
            const user = get('SELECT id,email FROM users WHERE id=?', auth.userId)!;
            return json({
              user: { ...user, github: github.identityLogin(auth.userId) },
              controller: controllerView(
                get('SELECT * FROM controllers WHERE id=?', auth.controllerId)!,
              ),
            });
          }
          if (path === '/api/controllers' && req.method === 'GET')
            return json({
              controllers: all(
                'SELECT * FROM controllers WHERE user_id=? ORDER BY created_at',
                auth.userId,
              ).map(controllerView),
            });
          if (path === '/api/controllers' && req.method === 'POST')
            throw new HttpError(
              400,
              'LOGIN_DEVICE',
              'Sign in from a new device to register its authenticated controller',
            );
          if (path === '/api/instances' && req.method === 'GET')
            return json({
              instances: all(
                'SELECT * FROM instances WHERE user_id=? ORDER BY created_at',
                auth.userId,
              ).map(instanceView),
            });
          if (path === '/api/instances' && req.method === 'POST') {
            const input = await body(req),
              name = string(input.name, 'name', 80),
              id = uid('ins'),
              raw = token();
            run(
              'INSERT INTO instances(id,user_id,name,token_hash,created_at) VALUES(?,?,?,?,?)',
              id,
              auth.userId,
              name,
              digest(raw),
              Date.now(),
            );
            return json(
              {
                instance: instanceView(ownedInstance(id, auth.userId)),
                connectorToken: raw,
              },
              201,
            );
          }
          const stateMatch = path.match(/^\/api\/instances\/([^/]+)\/state$/);
          if (stateMatch && req.method === 'GET') {
            const instance = ownedInstance(stateMatch[1]!, auth.userId);
            return json({
              instance: instanceView(instance),
              pendingApprovals: pendingApprovals(auth.userId, String(instance.id)),
            });
          }
          const revokeMatch = path.match(/^\/api\/controllers\/([^/]+)\/revoke$/);
          if (revokeMatch && req.method === 'POST') {
            const controller = get(
              'SELECT * FROM controllers WHERE id=? AND user_id=?',
              revokeMatch[1]!,
              auth.userId,
            );
            if (!controller) throw new HttpError(404, 'NOT_FOUND', 'Controller not found');
            revokeController(String(controller.id));
            return json({ ok: true });
          }
          const rotateMatch = path.match(/^\/api\/instances\/([^/]+)\/rotate-credential$/);
          if (rotateMatch && req.method === 'POST') {
            const instance = ownedInstance(rotateMatch[1]!, auth.userId);
            return json({ connectorToken: rotateConnectorToken(String(instance.id)) });
          }
          const pairingMatch = path.match(/^\/api\/instances\/([^/]+)\/pairing$/);
          if (pairingMatch && req.method === 'POST') {
            const instance = ownedInstance(pairingMatch[1]!, auth.userId),
              code = pairingCode(),
              expiresAt = Date.now() + PAIRING_MS,
              origin = (options.publicOrigin ?? req.headers.get('origin') ?? url.origin).replace(/\/$/, '');
            // Only the newest code for an instance is valid.
            db.transaction(() => {
              run('DELETE FROM pairing_codes WHERE instance_id=?', String(instance.id));
              run(
                'INSERT INTO pairing_codes(code_hash,instance_id,user_id,expires_at) VALUES(?,?,?,?)',
                digest(normalizePairingCode(code)),
                String(instance.id),
                auth.userId,
                expiresAt,
              );
            })();
            return json({ code, expiresAt, pairingUrl: `${origin}/pair/${code}` }, 201);
          }
          const commandMatch = path.match(/^\/api\/commands\/([^/]+)$/);
          if (commandMatch && req.method === 'GET') {
            const row = get(
              'SELECT * FROM commands WHERE (id=? OR (id=? AND request_id IS NULL)) AND user_id=?',
              digest(`${auth.userId}:${commandMatch[1]!}`),
              commandMatch[1]!,
              auth.userId,
            );
            if (!row) throw new HttpError(404, 'NOT_FOUND', 'Command not found');
            return json(commandView(row));
          }
          const instanceMatch = path.match(/^\/api\/instances\/([^/]+)\/(lease|commands)$/);
          if (instanceMatch) {
            const id = instanceMatch[1]!,
              kind = instanceMatch[2]!;
            ownedInstance(id, auth.userId);
            if (kind === 'lease' && req.method === 'POST') {
              const input = await body(req);
              boundController(auth, input.controllerId);
              const connector = connectors.get(id);
              if (!connector || connector.data.role !== 'connector' || !connectorOnline(id))
                throw new HttpError(
                  409,
                  'INSTANCE_OFFLINE',
                  'Connect the DSH instance before acquiring control',
                );
              const result = db.transaction(() => {
                const old = get('SELECT * FROM leases WHERE instance_id=?', id),
                  now = Date.now();
                const held = old && Number(old.expires_at) > now;
                if (held && old.controller_id !== auth.controllerId && input.takeover !== true)
                  throw new HttpError(
                    409,
                    'LEASE_HELD',
                    'Another controller currently holds control',
                  );
                const epoch = old
                  ? Number(old.epoch) + (held && old.controller_id === auth.controllerId ? 0 : 1)
                  : 1;
                run(
                  'INSERT INTO leases(instance_id,controller_id,epoch,expires_at) VALUES(?,?,?,?) ON CONFLICT(instance_id) DO UPDATE SET controller_id=excluded.controller_id,epoch=excluded.epoch,expires_at=excluded.expires_at',
                  id,
                  auth.controllerId,
                  epoch,
                  now + leaseMs,
                );
                return get('SELECT * FROM leases WHERE instance_id=?', id)!;
              })();
              publishLease(result);
              await waitFence(id, Number(result.epoch), Number(result.expires_at));
              return json(leaseView(id));
            }
            if (kind === 'lease' && req.method === 'DELETE') {
              const input = await body(req);
              boundController(auth, input.controllerId);
              const old = get('SELECT * FROM leases WHERE instance_id=?', id);
              if (old && old.controller_id !== auth.controllerId)
                throw new HttpError(
                  409,
                  'LEASE_HELD',
                  'Only the current controller can release control',
                );
              if (old) {
                run('UPDATE leases SET epoch=epoch+1,expires_at=0 WHERE instance_id=?', id);
                publishLease(get('SELECT * FROM leases WHERE instance_id=?', id)!);
              }
              return json({ ok: true });
            }
            if (kind === 'commands' && req.method === 'POST') {
              const input = await body(req);
              boundController(auth, input.controllerId);
              const requestId = string(input.id, 'id', 120),
                commandId = digest(`${auth.userId}:${requestId}`);
              if (!/^[A-Za-z0-9_-]+$/.test(requestId))
                throw new HttpError(400, 'INVALID_INPUT', 'id has invalid characters');
              if (!isAction(input.action))
                throw new HttpError(400, 'ACTION_DENIED', 'Unknown command action');
              const action = input.action;
              if (!object(input.args))
                throw new HttpError(400, 'INVALID_INPUT', 'args must be an object');
              // Validate caller-controlled args before recursive canonical hashing.
              // Repository paths/context are exclusively resolved by the relay.
              if (Object.hasOwn(input.args, 'repositoryContext'))
                throw new HttpError(400, 'INVALID_ARGUMENTS', 'Repository context must be selected by reference IDs');
              if (Object.hasOwn(input, 'repositoryId') && action !== 'repository.inspect')
                throw new HttpError(400, 'INVALID_ARGUMENTS', 'repositoryId is only valid for repository.inspect');
              if (Object.hasOwn(input, 'repositoryIds') && action !== 'session.prompt')
                throw new HttpError(400, 'INVALID_ARGUMENTS', 'repositoryIds are only valid for session.prompt');
              const validation = validateCommand(action === 'repository.inspect' ? 'session.list' : action, input.args);
              if (validation) throw new HttpError(400, 'INVALID_ARGUMENTS', validation);
              let repositoryId: string | null = null;
              let repositoryIds: string[] | undefined;
              const referenceId = (value: unknown) => {
                const id = string(value, 'repository reference ID', 128);
                if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id))
                  throw new HttpError(400, 'INVALID_ARGUMENTS', 'Invalid repository reference ID');
                return id;
              };
              if (action === 'repository.inspect') repositoryId = referenceId(input.repositoryId);
              if (Object.hasOwn(input, 'repositoryIds')) {
                if (!Array.isArray(input.repositoryIds) || input.repositoryIds.length > 8)
                  throw new HttpError(400, 'INVALID_ARGUMENTS', 'Choose at most eight repository references');
                repositoryIds = input.repositoryIds.map(referenceId);
                if (new Set(repositoryIds).size !== repositoryIds.length)
                  throw new HttpError(400, 'INVALID_ARGUMENTS', 'Repository references must be unique');
              }
              const fingerprint = digest(
                stable({
                  instanceId: id,
                  controllerId: auth.controllerId,
                  action,
                  args: input.args,
                  ...(repositoryId === null ? {} : { repositoryId }),
                  ...(repositoryIds === undefined ? {} : { repositoryIds }),
                }),
              );
              const existing = get('SELECT * FROM commands WHERE id=?', commandId);
              if (existing) {
                if (existing.user_id !== auth.userId)
                  throw new HttpError(404, 'NOT_FOUND', 'Command not found');
                if (existing.fingerprint !== fingerprint)
                  throw new HttpError(
                    409,
                    'IDEMPOTENCY_CONFLICT',
                    'Command id already has different arguments',
                  );
                return json(commandView(existing));
              }
              if (
                Number(get("SELECT COUNT(*) AS count FROM commands WHERE user_id=? AND status='dispatched'", auth.userId)?.count ?? 0) >= 64
              ) throw new HttpError(429, 'COMMAND_QUOTA', 'Too many commands awaiting acknowledgement');
              let args = input.args;
              if (repositoryId !== null)
                args = github.inspectArguments(auth.userId, id, repositoryId);
              if (repositoryIds !== undefined && repositoryIds.length > 0)
                args = { ...args, repositoryContext: github.repositoryContext(auth.userId, id, repositoryIds) };
              const enrichedValidation = validateCommand(action, args);
              if (enrichedValidation) throw new HttpError(400, 'INVALID_ARGUMENTS', enrichedValidation);
              const payload = JSON.stringify(args);
              const connector = connectors.get(id);
              if (!connector || connector.data.role !== 'connector' || !connectorOnline(id))
                throw new HttpError(409, 'INSTANCE_OFFLINE', 'DSH instance is offline');
              let leaseEpoch: number | null = null;
              if (isWriteAction(action)) {
                const lease = leaseView(id);
                if (
                  !lease ||
                  lease.controllerId !== auth.controllerId ||
                  lease.epoch !== input.leaseEpoch ||
                  lease.pending
                )
                  throw new HttpError(
                    409,
                    'LEASE_REQUIRED',
                    'Acquire or renew control before changing this instance',
                  );
                leaseEpoch = lease.epoch;
              }
              const now = Date.now();
              run(
                'INSERT INTO commands(id,request_id,instance_id,user_id,controller_id,action,payload,fingerprint,lease_epoch,status,created_at,updated_at,repository_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
                commandId,
                requestId,
                id,
                auth.userId,
                auth.controllerId,
                action,
                payload,
                fingerprint,
                leaseEpoch,
                'dispatched',
                now,
                now,
                repositoryId,
              );
              connector.send(
                JSON.stringify({
                  v: 1,
                  type: 'command',
                  id: commandId,
                  instanceId: id,
                  connectionEpoch: connector.data.epoch,
                  leaseEpoch,
                  action,
                  args,
                  expiresAt: Math.min(
                    now + commandMs,
                    isWriteAction(action) ? leaseView(id)!.expiresAt : now + commandMs,
                  ),
                }),
              );
              const row = get('SELECT * FROM commands WHERE id=?', commandId)!;
              emit(auth.userId, id, 'command.updated', commandView(row) as unknown as Json);
              return json(commandView(row), 202);
            }
          }
          throw new HttpError(404, 'NOT_FOUND', 'Route not found');
        }
        if (platform.staticFile && req.method === 'GET') {
          const file = platform.staticFile(path);
          if (file) return file;
        }
        throw new HttpError(404, 'NOT_FOUND', 'Route not found');
      } catch (error) {
        if (error instanceof HttpError || error instanceof GitHubError)
          return json({ error: { code: error.code, message: error.message } }, error.status);
        console.error('Relay request failed', error);
        return json(
          {
            error: {
              code: 'INTERNAL_ERROR',
              message: 'Unexpected relay error',
            },
          },
          500,
        );
      }
  }
  function open(ws: Socket) {
        if (ws.data.role === 'viewer') {
          viewers.add(ws);
          const rows = all(
            'SELECT * FROM events WHERE user_id=? AND seq>? ORDER BY seq LIMIT 1001',
            ws.data.userId,
            ws.data.after,
          );
          if (rows.length > 1000) {
            const latest = get(
              'SELECT MAX(seq) AS seq FROM events WHERE user_id=?',
              ws.data.userId,
            );
            ws.send(
              JSON.stringify({
                v: 1,
                type: 'reset',
                reason: 'replay_window_exceeded',
                cursor: Number(latest?.seq ?? 0),
              }),
            );
          } else for (const row of rows) ws.send(JSON.stringify(eventView(row)));
          ws.send(
            JSON.stringify({
              v: 1,
              type: 'snapshot',
              instances: all(
                'SELECT * FROM instances WHERE user_id=? ORDER BY created_at',
                ws.data.userId,
              ).map(instanceView),
              pendingApprovals: pendingApprovals(ws.data.userId),
            }),
          );
          ws.send(JSON.stringify({ v: 1, type: 'ready' }));
          return;
        }
        const old = connectors.get(ws.data.instanceId);
        if (old) {
          finishPending(
            ws.data.instanceId,
            'CONNECTOR_REPLACED',
            'Connector reconnected before result acknowledgement',
          );
          old.close(4001, 'Connector replaced');
        }
        run(
          'UPDATE instances SET connection_epoch=connection_epoch+1,connected_at=? WHERE id=?',
          Date.now(),
          ws.data.instanceId,
        );
        ws.data.epoch = Number(
          get('SELECT connection_epoch FROM instances WHERE id=?', ws.data.instanceId)!
            .connection_epoch,
        );
        connectors.set(ws.data.instanceId, ws);
        emit(ws.data.userId, ws.data.instanceId, 'instance.status', {
          status: 'connecting', connectionEpoch: ws.data.epoch,
        });
        ws.send(
          JSON.stringify({
            v: 1,
            type: 'welcome',
            instanceId: ws.data.instanceId,
            connectionEpoch: ws.data.epoch,
          }),
        );
        const lease = get('SELECT * FROM leases WHERE instance_id=?', ws.data.instanceId);
        if (lease)
          ws.send(
            JSON.stringify({
              v: 1,
              type: 'lease',
              epoch: Number(lease.epoch),
              controllerId: String(lease.controller_id),
              expiresAt: Number(lease.expires_at),
            }),
          );
  }
  function message(ws: Socket, message: string | ArrayBuffer | Uint8Array) {
        try {
          if (ws.data.role !== 'connector') {
            // Viewers may only measure round-trip time; anything else is a protocol violation.
            const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
            const frame: unknown = text.length <= 256 ? JSON.parse(text) : null;
            if (object(frame) && frame.type === 'ping' && Number.isSafeInteger(frame.id)) {
              ws.send(JSON.stringify({ v: 1, type: 'pong', id: frame.id }));
              return;
            }
            ws.close(1008, 'Viewer sockets are receive-only');
            return;
          }
          if (connectors.get(ws.data.instanceId) !== ws) return;
          const frame: unknown = JSON.parse(
            typeof message === 'string' ? message : new TextDecoder().decode(message),
          );
          if (!object(frame) || frame.v !== 1 || typeof frame.type !== 'string')
            throw new Error('Invalid frame');
          if (frame.type === 'hello') {
            const bootId = string(frame.bootId, 'bootId', 120);
            if (
              !Array.isArray(frame.capabilities) ||
              !frame.capabilities.every((x) => typeof x === 'string' && x.length < 120)
            )
              throw new Error('Invalid capabilities');
            const oldBoot = get(
              'SELECT boot_id FROM instances WHERE id=?',
              ws.data.instanceId,
            )?.boot_id;
            if (oldBoot && oldBoot !== bootId) {
              const dropped = all(
                'SELECT payload FROM pending_approvals WHERE instance_id=?',
                ws.data.instanceId,
              );
              run('DELETE FROM pending_approvals WHERE instance_id=?', ws.data.instanceId);
              run('DELETE FROM settled_approvals WHERE instance_id=?', ws.data.instanceId);
              // A new boot cannot answer earlier handles; tell clients so stale cards disappear.
              for (const row of dropped) {
                const approval = JSON.parse(String(row.payload)) as Record<string, Json>;
                emit(ws.data.userId, ws.data.instanceId, 'approval.settled', {
                  sessionId: approval.sessionId ?? null,
                  data: { approvalId: approval.approvalId ?? null, outcome: 'expired', reason: 'host_restarted' },
                });
              }
            }
            run(
              'UPDATE instances SET boot_id=?,capabilities=? WHERE id=?',
              bootId,
              JSON.stringify(frame.capabilities),
              ws.data.instanceId,
            );
            ws.data.ready = true;
            ws.data.lastSeenAt = ws.data.persistedSeenAt = Date.now();
            ws.data.lastStatus = 'online';
            run('UPDATE instances SET last_seen_at=? WHERE id=?', ws.data.lastSeenAt, ws.data.instanceId);
            emit(ws.data.userId, ws.data.instanceId, 'instance.online', {
              bootId,
              capabilities: frame.capabilities as string[],
              connectionEpoch: ws.data.epoch,
            });
            return;
          }
          if (!ws.data.ready) throw new Error('Hello required');
          if (frame.type === 'lease.ack') {
            if (
              frame.connectionEpoch !== ws.data.epoch ||
              !Number.isSafeInteger(frame.epoch) ||
              !Number.isSafeInteger(frame.expiresAt)
            )
              throw new Error('Invalid lease acknowledgement');
            const current = get('SELECT * FROM leases WHERE instance_id=?', ws.data.instanceId);
            if (
              current &&
              Number(current.epoch) === frame.epoch &&
              Number(frame.expiresAt) >= 0 &&
              Number(frame.expiresAt) <= Number(current.expires_at) &&
              (ws.data.leaseEpoch !== frame.epoch ||
                Number(frame.expiresAt) >= ws.data.leaseExpiresAt)
            ) {
              const changed =
                ws.data.leaseEpoch !== frame.epoch || ws.data.leaseExpiresAt !== frame.expiresAt;
              ws.data.leaseEpoch = Number(frame.epoch);
              ws.data.leaseExpiresAt = Number(frame.expiresAt);
              if (changed)
                emit(ws.data.userId, ws.data.instanceId, 'lease.changed', {
                  controllerId: String(current.controller_id),
                  epoch: Number(frame.epoch),
                  expiresAt: Number(frame.expiresAt),
                  pending: false,
                });
            }
            return;
          }
          if (frame.type === 'result') {
            if (frame.connectionEpoch !== ws.data.epoch) throw new Error('Stale connection epoch');
            const id = string(frame.id, 'id', 120),
              row = get(
                'SELECT * FROM commands WHERE id=? AND instance_id=?',
                id,
                ws.data.instanceId,
              );
            if (!row) return;
            if (row.status === 'succeeded' || row.status === 'failed') {
              ws.send(JSON.stringify({ v: 1, type: 'result.ack', id }));
              return;
            }
            if (typeof frame.ok !== 'boolean') throw new Error('Invalid result');
            let ok = frame.ok;
            let result = frame.result ?? null;
            let error = ok
              ? null
              : object(frame.error)
                ? {
                    code: string(frame.error.code, 'error code', 120),
                    message: string(frame.error.message, 'error message', 2000),
                  }
                : { code: 'DSH_ERROR', message: 'DSH command failed' };
            db.transaction(() => {
              if (row.action === 'repository.inspect') {
                // The target is persisted at admission, never supplied by result data.
                if (typeof row.repository_id !== 'string') {
                  ok = false;
                  error = { code: 'REPOSITORY_VERIFICATION_MISMATCH', message: 'Inspection has no bound repository reference' };
                } else {
                  if (ok) {
                    try {
                      github.recordInspection(String(row.user_id), String(row.instance_id), row.repository_id, result);
                      // Do not persist any extra keys supplied by the Host.
                      const value = result as RepositoryInspection;
                      result = { path: value.path, name: value.name, remote: { owner: value.remote.owner, name: value.remote.name, url: value.remote.url }, branch: value.branch, commit: value.commit };
                    } catch {
                      ok = false;
                      error = { code: 'REPOSITORY_VERIFICATION_MISMATCH', message: 'Host inspection did not match the bound repository reference' };
                    }
                  }
                  if (!ok) github.markInspectionStale(String(row.user_id), String(row.instance_id), row.repository_id);
                }
              }
              run(
                'UPDATE commands SET status=?,result=?,error=?,updated_at=? WHERE id=?',
                ok ? 'succeeded' : 'failed',
                ok ? JSON.stringify(result) : null,
                error ? JSON.stringify(error) : null,
                Date.now(),
                id,
              );
            })();
            emit(
              ws.data.userId,
              ws.data.instanceId,
              'command.updated',
              commandView(get('SELECT * FROM commands WHERE id=?', id)!) as unknown as Json,
            );
            ws.send(JSON.stringify({ v: 1, type: 'result.ack', id }));
            return;
          }
          if (frame.type === 'event') {
            const id = string(frame.id, 'event id', 240),
              kind = string(frame.kind, 'event kind', 120);
            if (!('payload' in frame)) throw new Error('Missing payload');
            if (!(CONNECTOR_EVENT_KINDS as readonly string[]).includes(kind))
              throw new Error('Reserved or unknown event kind');
            let projection: (() => void) | undefined;
            const eventInstanceId = ws.data.instanceId;
            if (kind === 'approval.requested') {
              const p = frame.payload;
              if (
                !object(p) ||
                typeof p.approvalId !== 'string' ||
                p.sessionId !== frame.sessionId ||
                p.bootId !==
                  get('SELECT boot_id FROM instances WHERE id=?', ws.data.instanceId)?.boot_id ||
                typeof p.presentationHash !== 'string' ||
                typeof p.toolName !== 'string'
              )
                throw new Error('Invalid pending approval');
              if (
                get(
                  'SELECT 1 FROM settled_approvals WHERE instance_id=? AND approval_id=?',
                  ws.data.instanceId,
                  p.approvalId,
                )
              ) {
                ws.send(JSON.stringify({ v: 1, type: 'event.ack', id }));
                return;
              }
              const projected = {
                approvalId: p.approvalId,
                sessionId: p.sessionId,
                bootId: p.bootId,
                presentationHash: p.presentationHash,
                toolName: p.toolName,
                callId: p.callId ?? null,
                reason: p.reason ?? null,
              };
              projection = () =>
                run(
                  'INSERT INTO pending_approvals(instance_id,approval_id,payload) VALUES(?,?,?) ON CONFLICT(instance_id,approval_id) DO UPDATE SET payload=excluded.payload',
                  eventInstanceId,
                  p.approvalId as string,
                  JSON.stringify(projected),
                );
            }
            if (kind === 'approval.settled') {
              const p = frame.payload;
              if (!object(p) || typeof p.approvalId !== 'string')
                throw new Error('Invalid settled approval');
              projection = () => {
                run(
                  'DELETE FROM pending_approvals WHERE instance_id=? AND approval_id=?',
                  eventInstanceId,
                  p.approvalId as string,
                );
                run(
                  'INSERT OR IGNORE INTO settled_approvals VALUES(?,?)',
                  eventInstanceId,
                  p.approvalId as string,
                );
              };
            }
            emit(
              ws.data.userId,
              ws.data.instanceId,
              kind,
              {
                sessionId: typeof frame.sessionId === 'string' ? frame.sessionId : null,
                data: frame.payload as Json,
              },
              id,
              projection,
            );
            ws.send(JSON.stringify({ v: 1, type: 'event.ack', id }));
            return;
          }
          if (frame.type === 'ping') {
            if (frame.connectionEpoch !== ws.data.epoch) throw new Error('Stale heartbeat');
            ws.data.lastSeenAt = Date.now();
            if (ws.data.lastSeenAt - ws.data.persistedSeenAt >= SEEN_PERSIST_MS) {
              ws.data.persistedSeenAt = ws.data.lastSeenAt;
              run('UPDATE instances SET last_seen_at=? WHERE id=?', ws.data.lastSeenAt, ws.data.instanceId);
            }
            if (ws.data.lastStatus !== 'online')
              emit(ws.data.userId, ws.data.instanceId, 'instance.status', {
                status: 'online', lastSeenAt: ws.data.lastSeenAt, connectionEpoch: ws.data.epoch,
              });
            ws.data.lastStatus = 'online';
            ws.send(JSON.stringify({ v: 1, type: 'pong' }));
            return;
          }
          throw new Error('Unknown frame');
        } catch (error) {
          console.warn(
            'Rejected connector frame',
            error instanceof Error ? error.message : 'invalid',
          );
          ws.close(1008, 'Invalid connector frame');
        }
  }
  function close(ws: Socket) {
        if (ws.data.role === 'viewer') {
          viewers.delete(ws);
          return;
        }
        if (connectors.get(ws.data.instanceId) !== ws) return;
        connectors.delete(ws.data.instanceId);
        run(
          'UPDATE instances SET disconnected_at=?,last_seen_at=? WHERE id=?',
          Date.now(),
          ws.data.lastSeenAt,
          ws.data.instanceId,
        );
        finishPending(
          ws.data.instanceId,
          'CONNECTOR_DISCONNECTED',
          'Connector disconnected; command outcome is unknown until reconciled',
        );
        emit(ws.data.userId, ws.data.instanceId, 'instance.offline', {
          connectionEpoch: ws.data.epoch,
        });
  }
  /** Deadline housekeeping; the runtime calls this every `sweepIntervalMs`. */
  function sweep() {
    const now = Date.now();
    for (const ws of connectors.values()) {
      if (ws.data.role !== 'connector') continue;
      const status = connectionStatus(ws.data.instanceId);
      if (ws.data.lastStatus !== status) {
        ws.data.lastStatus = status;
        emit(ws.data.userId, ws.data.instanceId, 'instance.status', {
          status, lastSeenAt: ws.data.lastSeenAt, connectionEpoch: ws.data.epoch,
        });
      }
      if (now - ws.data.lastSeenAt > heartbeatDisconnectMs)
        ws.close(4002, 'DSH Host heartbeat expired');
    }
    for (const ws of viewers)
      if (ws.data.role === 'viewer' && ws.data.expiresAt <= now) ws.close(4003, 'Session expired');
    // Application-level keepalive: lets clients detect half-open sockets on every runtime.
    if (now >= nextKeepaliveAt) {
      nextKeepaliveAt = now + KEEPALIVE_MS;
      for (const ws of viewers) ws.send('{"v":1,"type":"keepalive"}');
    }
    for (const row of all(
      "SELECT * FROM commands WHERE status='dispatched' AND created_at<?",
      now - commandMs,
    )) {
      run(
        "UPDATE commands SET status='indeterminate',error=?,updated_at=? WHERE id=?",
        JSON.stringify({
          code: 'RESULT_TIMEOUT',
          message:
            'No final acknowledgement; inspect actual DSH state before submitting a different command id',
        }),
        now,
        String(row.id),
      );
      emit(
        String(row.user_id),
        String(row.instance_id),
        'command.updated',
        commandView(get('SELECT * FROM commands WHERE id=?', String(row.id))!) as unknown as Json,
      );
    }
    for (const [ip, limit] of attempts) if (limit.until < now) attempts.delete(ip);
    // Daily, unindexed: an extra index would cost a storage write on every event.
    if (now >= nextPruneAt) {
      nextPruneAt = now + 24 * 60 * 60 * 1000;
      run('DELETE FROM events WHERE created_at<?', now - eventRetentionMs);
      run('DELETE FROM pairing_codes WHERE expires_at<?', now);
    }
  }
  return {
    fetch,
    open,
    message,
    close,
    sweep,
    sweepIntervalMs: Math.min(1000, heartbeatStaleMs),
    /** Closes every socket; the runtime then stops its listener and storage. */
    closeAll() {
      for (const ws of [...viewers, ...connectors.values()]) ws.close(1001, 'Relay shutdown');
    },
  };
}
export type RelayCore = ReturnType<typeof createRelayCore>;

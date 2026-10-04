import type { Server, ServerWebSocket } from 'bun';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  CONNECTOR_EVENT_KINDS,
  MAX_FRAME_BYTES,
  isAction,
  isWriteAction,
  type Action,
  type Command,
  type Json,
  type RelayEvent,
} from '../../../packages/protocol/src/index.ts';
import { openStore } from './store.ts';
import { validateCommand } from './validation.ts';

type Row = Record<string, string | number | null>;
type Auth = { userId: string; controllerId: string; tokenHash: string };
type SocketData =
  | {
      role: 'connector';
      instanceId: string;
      userId: string;
      epoch: number;
      ready: boolean;
      leaseEpoch: number;
      leaseExpiresAt: number;
    }
  | {
      role: 'viewer';
      userId: string;
      controllerId: string;
      after: number;
      expiresAt: number;
    };
type Socket = ServerWebSocket<SocketData>;
export interface RelayOptions {
  databasePath?: string;
  port?: number;
  hostname?: string;
  allowedOrigins?: string[];
  leaseMs?: number;
  sessionMs?: number;
  commandMs?: number;
  staticDir?: string;
  registration?: boolean;
  secureCookies?: boolean;
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

/** Creates a single-process authenticated Bun relay. No DSH execution occurs on this host. */
export function createRelay(options: RelayOptions = {}) {
  const db = openStore(options.databasePath ?? '.data/relay.sqlite');
  const leaseMs = options.leaseMs ?? 30_000;
  const sessionMs = options.sessionMs ?? 7 * 24 * 60 * 60 * 1000;
  const commandMs = options.commandMs ?? 30_000;
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
      data.leaseEpoch === epoch &&
      data.leaseExpiresAt >= expiresAt
    );
  }
  async function waitFence(id: string, epoch: number, expiresAt: number) {
    const until = Date.now() + 3000;
    while (Date.now() < until) {
      if (leaseConfirmed(id, epoch, expiresAt)) return;
      await Bun.sleep(10);
    }
    throw new HttpError(
      409,
      'FENCE_PENDING',
      'Connector has not acknowledged control; no commands can be sent yet',
    );
  }
  function instanceView(row: Row) {
    return {
      id: String(row.id),
      name: String(row.name),
      createdAt: Number(row.created_at),
      online:
        connectors.get(String(row.id))?.data.role === 'connector' &&
        Boolean(
          (connectors.get(String(row.id))!.data as Extract<SocketData, { role: 'connector' }>)
            .ready,
        ),
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
    if (Buffer.byteLength(text) > MAX_FRAME_BYTES)
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
  const server: Bun.Server<SocketData> = Bun.serve<SocketData>({
    hostname: options.hostname ?? '127.0.0.1',
    port: options.port ?? 3000,
    maxRequestBodySize: MAX_FRAME_BYTES,
    async fetch(req, server) {
      try {
        const url = new URL(req.url),
          path = url.pathname;
        if (path === '/health') return json({ ok: true, protocol: 1 });
        checkOrigin(req);
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
          if (
            server.upgrade(req, {
              data: {
                role: 'connector',
                instanceId: String(instance.id),
                userId: String(instance.user_id),
                epoch: 0,
                ready: false,
                leaseEpoch: 0,
                leaseExpiresAt: 0,
              },
            })
          )
            return undefined;
          throw new HttpError(400, 'UPGRADE_REQUIRED', 'WebSocket upgrade required');
        }
        if (path === '/api/auth/register' || path === '/api/auth/login') {
          if (req.method !== 'POST')
            throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'POST required');
          const key = server.requestIP(req)?.address ?? 'local',
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
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || password.length < 12)
            throw new HttpError(
              400,
              'INVALID_INPUT',
              'Use a valid email and password of at least 12 characters',
            );
          let user = get('SELECT * FROM users WHERE email=?', email);
          if (path.endsWith('register')) {
            if (options.registration !== true)
              throw new HttpError(403, 'REGISTRATION_DISABLED', 'Registration is disabled');
            if (user) throw new HttpError(409, 'ACCOUNT_EXISTS', 'Account already exists');
            const hash = await Bun.password.hash(password, {
              algorithm: 'argon2id',
            });
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
          } else if (!user || !(await Bun.password.verify(password, String(user.password_hash))))
            throw new HttpError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
          const controllerId = uid('ctl');
          run(
            'INSERT INTO controllers(id,user_id,name,created_at) VALUES(?,?,?,?)',
            controllerId,
            String(user.id),
            deviceName,
            now,
          );
          const raw = token();
          run(
            'INSERT INTO auth_sessions(token_hash,user_id,controller_id,expires_at) VALUES(?,?,?,?)',
            digest(raw),
            String(user.id),
            controllerId,
            now + sessionMs,
          );
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
            {
              'Set-Cookie': `dsh_session=${raw}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${Math.floor(sessionMs / 1000)}${options.secureCookies === true || url.protocol === 'https:' ? '; Secure' : ''}`,
            },
          );
        }
        if (path.startsWith('/api/') || path === '/ws/events') {
          const auth = authenticate(req);
          if (path === '/ws/events') {
            const after = Number(url.searchParams.get('after') ?? 0);
            if (!Number.isSafeInteger(after) || after < 0)
              throw new HttpError(400, 'INVALID_CURSOR', 'Invalid event cursor');
            const expiresAt = Number(
              get('SELECT expires_at FROM auth_sessions WHERE token_hash=?', auth.tokenHash)!
                .expires_at,
            );
            if (
              server.upgrade(req, {
                data: {
                  role: 'viewer',
                  userId: auth.userId,
                  controllerId: auth.controllerId,
                  after,
                  expiresAt,
                },
              })
            )
              return undefined;
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
              user,
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
            const instance = ownedInstance(rotateMatch[1]!, auth.userId),
              raw = token();
            run('UPDATE instances SET token_hash=? WHERE id=?', digest(raw), String(instance.id));
            const socket = connectors.get(String(instance.id));
            if (socket) {
              if (socket.data.role === 'connector') socket.data.ready = false;
              socket.close(4003, 'Connector credential rotated');
            }
            run(
              'UPDATE leases SET epoch=epoch+1,expires_at=0 WHERE instance_id=?',
              String(instance.id),
            );
            const lease = get('SELECT * FROM leases WHERE instance_id=?', String(instance.id));
            if (lease) publishLease(lease);
            return json({ connectorToken: raw });
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
              if (!connector || connector.data.role !== 'connector' || !connector.data.ready)
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
              const validation = validateCommand(action, input.args);
              if (validation) throw new HttpError(400, 'INVALID_ARGUMENTS', validation);
              if (
                Number(
                  get(
                    "SELECT COUNT(*) AS count FROM commands WHERE user_id=? AND status='dispatched'",
                    auth.userId,
                  )?.count ?? 0,
                ) >= 64
              )
                throw new HttpError(
                  429,
                  'COMMAND_QUOTA',
                  'Too many commands awaiting acknowledgement',
                );
              const payload = JSON.stringify(input.args),
                fingerprint = digest(
                  stable({
                    instanceId: id,
                    controllerId: auth.controllerId,
                    action,
                    args: input.args,
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
              const connector = connectors.get(id);
              if (!connector || connector.data.role !== 'connector' || !connector.data.ready)
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
                'INSERT INTO commands(id,request_id,instance_id,user_id,controller_id,action,payload,fingerprint,lease_epoch,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
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
                  args: input.args,
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
        if (options.staticDir && req.method === 'GET') {
          const root = resolve(options.staticDir),
            file = resolve(join(root, decodeURIComponent(path)));
          if (file !== root && !file.startsWith(root + '/'))
            throw new HttpError(403, 'PATH_DENIED', 'Invalid path');
          const selected =
            existsSync(file) && !path.endsWith('/') ? file : join(root, 'index.html');
          if (existsSync(selected)) return new Response(Bun.file(selected));
        }
        throw new HttpError(404, 'NOT_FOUND', 'Route not found');
      } catch (error) {
        if (error instanceof HttpError)
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
    },
    websocket: {
      maxPayloadLength: MAX_FRAME_BYTES,
      idleTimeout: 60,
      sendPings: true,
      backpressureLimit: 4 * 1024 * 1024,
      closeOnBackpressureLimit: true,
      open(ws) {
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
          'UPDATE instances SET connection_epoch=connection_epoch+1 WHERE id=?',
          ws.data.instanceId,
        );
        ws.data.epoch = Number(
          get('SELECT connection_epoch FROM instances WHERE id=?', ws.data.instanceId)!
            .connection_epoch,
        );
        connectors.set(ws.data.instanceId, ws);
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
      },
      message(ws, message) {
        try {
          if (ws.data.role !== 'connector') {
            ws.close(1008, 'Viewer sockets are receive-only');
            return;
          }
          if (connectors.get(ws.data.instanceId) !== ws) return;
          const frame: unknown = JSON.parse(
            typeof message === 'string' ? message : message.toString(),
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
              run('DELETE FROM pending_approvals WHERE instance_id=?', ws.data.instanceId);
              run('DELETE FROM settled_approvals WHERE instance_id=?', ws.data.instanceId);
            }
            run(
              'UPDATE instances SET boot_id=?,capabilities=? WHERE id=?',
              bootId,
              JSON.stringify(frame.capabilities),
              ws.data.instanceId,
            );
            ws.data.ready = true;
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
            const error = frame.ok
              ? null
              : object(frame.error)
                ? {
                    code: string(frame.error.code, 'error code', 120),
                    message: string(frame.error.message, 'error message', 2000),
                  }
                : { code: 'DSH_ERROR', message: 'DSH command failed' };
            run(
              'UPDATE commands SET status=?,result=?,error=?,updated_at=? WHERE id=?',
              frame.ok ? 'succeeded' : 'failed',
              frame.ok ? JSON.stringify(frame.result ?? null) : null,
              error ? JSON.stringify(error) : null,
              Date.now(),
              id,
            );
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
      },
      close(ws) {
        if (ws.data.role === 'viewer') {
          viewers.delete(ws);
          return;
        }
        if (connectors.get(ws.data.instanceId) !== ws) return;
        connectors.delete(ws.data.instanceId);
        finishPending(
          ws.data.instanceId,
          'CONNECTOR_DISCONNECTED',
          'Connector disconnected; command outcome is unknown until reconciled',
        );
        emit(ws.data.userId, ws.data.instanceId, 'instance.offline', {
          connectionEpoch: ws.data.epoch,
        });
      },
    },
  });
  const timer = setInterval(() => {
    const now = Date.now();
    for (const ws of viewers)
      if (ws.data.role === 'viewer' && ws.data.expiresAt <= now) ws.close(4003, 'Session expired');
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
  }, 1000);
  timer.unref();
  return {
    server,
    db,
    stop: async () => {
      clearInterval(timer);
      for (const ws of [...viewers, ...connectors.values()]) ws.close(1001, 'Relay shutdown');
      await server.stop(true);
      db.close();
    },
  };
}

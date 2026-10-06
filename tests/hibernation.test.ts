import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { SqlDatabase } from '../apps/server/src/db.ts';
import { pbkdf2Passwords } from '../apps/server/src/passwords.ts';
import {
  createRelayCore,
  type RelayCore,
  type RelaySocket,
  type SocketData,
} from '../apps/server/src/relay-core.ts';
import { initializeSchema } from '../apps/server/src/store.ts';

// A Durable Object in miniature: sockets outlive the object, which hibernation rebuilds over
// the same storage before handing it the restored sockets. Fixture connector, not real DSH.
type Fake = RelaySocket & { sent: any[]; heard: number };
const db = new Database(':memory:');
initializeSchema(db as unknown as SqlDatabase);
const wake = () =>
  createRelayCore(
    db as unknown as SqlDatabase,
    { registration: true, leaseMs: 5000 },
    { passwords: pbkdf2Passwords, hibernates: true },
  );
let core: RelayCore = wake();
let upgraded: SocketData | undefined;
async function call(path: string, token?: string, body?: unknown) {
  const response = await core.fetch(
    new Request(`http://relay.test${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    {
      ip: '127.0.0.1',
      upgrade: (data) => {
        upgraded = data;
        return undefined;
      },
    },
  );
  return { status: response?.status, data: (await response?.json()) as any };
}
/** A Host connection whose lease frames are acknowledged like the real connector does. */
function hostSocket(data: SocketData): Fake {
  const socket: Fake = {
    data,
    sent: [],
    heard: 0,
    send(message) {
      const frame = JSON.parse(String(message));
      socket.sent.push(frame);
      if (frame.type === 'lease')
        queueMicrotask(() =>
          core.message(
            socket,
            JSON.stringify({
              v: 1,
              type: 'lease.ack',
              epoch: frame.epoch,
              expiresAt: frame.expiresAt,
              connectionEpoch: data.role === 'connector' ? data.epoch : 0,
            }),
          ),
        );
    },
    close() {},
    heardFrom: () => socket.heard,
  };
  return socket;
}

test('a hibernation wake keeps a surviving Host, its pending commands and its heartbeats', async () => {
  const user = (
    await call('/api/auth/register', undefined, {
      email: 'sleep@example.invalid',
      password: 'synthetic-password-only',
      deviceName: 'Console',
    })
  ).data;
  const created = (await call('/api/instances', user.token, { name: 'Sleeping host' })).data;
  const instanceId = created.instance.id as string;
  await call('/ws/connector', created.connectorToken);
  let host = hostSocket(upgraded!);
  core.open(host);
  core.message(host, JSON.stringify({ v: 1, type: 'hello', bootId: 'b', capabilities: [] }));
  // A constant heartbeat (no connection number) is what the runtime can answer by itself.
  core.message(host, '{"v":1,"type":"ping"}');
  expect(host.sent.at(-1)).toEqual({ v: 1, type: 'pong' });
  expect(core.needsSweep()).toBe(false);

  const lease = (await call(`/api/instances/${instanceId}/lease`, user.token, {
    controllerId: user.controller.id,
  })).data;
  const write = await call(`/api/instances/${instanceId}/commands`, user.token, {
    id: 'sleepy-write',
    controllerId: user.controller.id,
    action: 'session.cancel',
    args: { sessionId: 's' },
    leaseEpoch: lease.epoch,
  });
  expect(write.data.status).toBe('dispatched');
  expect(core.needsSweep()).toBe(true);
  const wire = host.sent.find((frame) => frame.type === 'command').id as string;
  expect(wire).toBe(createHash('sha256').update(`${user.user.id}:sleepy-write`).digest('hex'));

  // Hibernate: a new object over the same storage, the socket restored from its attachment.
  core = wake();
  host = hostSocket(JSON.parse(JSON.stringify(host.data)));
  core.restore(host);
  core.recover();
  expect(core.needsSweep()).toBe(true);
  expect((await call('/api/commands/sleepy-write', user.token)).data.status).toBe('dispatched');
  core.message(
    host,
    JSON.stringify({
      v: 1,
      type: 'result',
      id: wire,
      connectionEpoch: host.data.role === 'connector' ? host.data.epoch : 0,
      ok: true,
      result: null,
    }),
  );
  expect((await call('/api/commands/sleepy-write', user.token)).data.status).toBe('succeeded');
  expect(host.sent.at(-1)).toEqual({ v: 1, type: 'result.ack', id: wire });
  expect(core.needsSweep()).toBe(false);

  // Liveness counts heartbeats the runtime answered while the core slept.
  if (host.data.role === 'connector') host.data.lastSeenAt = Date.now() - 10 * 60_000;
  const status = async () =>
    (await call('/api/instances', user.token)).data.instances.find(
      (item: { id: string }) => item.id === instanceId,
    ).status;
  expect(await status()).toBe('stale');
  host.heard = Date.now();
  expect(await status()).toBe('online');

  // A Host that did not survive the restart leaves its pending commands indeterminate.
  const lost = await call(`/api/instances/${instanceId}/commands`, user.token, {
    id: 'lost-write',
    controllerId: user.controller.id,
    action: 'session.cancel',
    args: { sessionId: 's' },
    leaseEpoch: lease.epoch,
  });
  expect(lost.data.status).toBe('dispatched');
  core = wake();
  core.recover();
  const after = (await call('/api/commands/lost-write', user.token)).data;
  expect(after.status).toBe('indeterminate');
  expect(after.error.code).toBe('RELAY_RESTARTED');
});

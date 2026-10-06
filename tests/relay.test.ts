import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createRelay } from '../apps/server/src/server.ts';
import type { RelayCommand } from '../packages/protocol/src/index.ts';

type Identity = {
  token: string;
  controller: { id: string };
  user: { id: string };
};
let relay: ReturnType<typeof createRelay>,
  base: string,
  a: Identity,
  b: Identity,
  a2: Identity,
  instance: { id: string },
  connector: WebSocket;
let commands: RelayCommand[] = [];
let pauseLeaseAcks = false;
const delayedAcks: Array<() => void> = [];
const wireId = (id: string) => createHash('sha256').update(`${a.user.id}:${id}`).digest('hex');
const until = async (test: () => boolean, timeout = 2000) => {
  const start = Date.now();
  while (!test()) {
    if (Date.now() - start > timeout) throw new Error('Timed out');
    await Bun.sleep(10);
  }
};
async function request(
  path: string,
  identity?: Identity,
  body?: unknown,
  method = body === undefined ? 'GET' : 'POST',
) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(identity ? { Authorization: `Bearer ${identity.token}` } : {}),
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    headers: response.headers,
    data: (await response.json()) as any,
  };
}
async function send(action: string, args: unknown = {}, opts: Record<string, unknown> = {}) {
  return request(`/api/instances/${instance.id}/commands`, a, {
    id: `cmd_${crypto.randomUUID()}`,
    controllerId: a.controller.id,
    action,
    args,
    ...opts,
  });
}
async function openConnector(credential: string) {
  const socket = new WebSocket(base.replace('http', 'ws') + '/ws/connector', {
    headers: { Authorization: `Bearer ${credential}` },
  });
  let epoch = 0;
  socket.addEventListener('message', (event) => {
    const frame = JSON.parse(String(event.data));
    if (frame.type === 'welcome') {
      epoch = frame.connectionEpoch;
      socket.send(
        JSON.stringify({
          v: 1,
          type: 'hello',
          bootId: 'protocol-test-fixture',
          capabilities: ['session.list'],
        }),
      );
    }
    if (frame.type === 'lease') {
      const acknowledge = () =>
        socket.send(
          JSON.stringify({
            v: 1,
            type: 'lease.ack',
            epoch: frame.epoch,
            expiresAt: frame.expiresAt,
            connectionEpoch: epoch,
          }),
        );
      if (pauseLeaseAcks) delayedAcks.push(acknowledge);
      else acknowledge();
    }
    if (frame.type === 'command') commands.push(frame);
  });
  await until(() => socket.readyState === WebSocket.OPEN);
  await Bun.sleep(20);
  return {
    socket,
    get epoch() {
      return epoch;
    },
  };
}
let connection: Awaited<ReturnType<typeof openConnector>>, credential: string;
beforeAll(async () => {
  relay = createRelay({
    databasePath: ':memory:',
    port: 0,
    leaseMs: 5000,
    commandMs: 10000,
    registration: true,
  });
  base = String(relay.server.url).replace(/\/$/, '');
  a = (
    await request('/api/auth/register', undefined, {
      email: 'a@example.test',
      password: 'test-password-123456',
      deviceName: 'A web',
    })
  ).data;
  b = (
    await request('/api/auth/register', undefined, {
      email: 'b@example.test',
      password: 'test-password-123456',
      deviceName: 'B phone',
    })
  ).data;
  a2 = (
    await request('/api/auth/login', undefined, {
      email: 'a@example.test',
      password: 'test-password-123456',
      deviceName: 'A phone',
    })
  ).data;
  const created = await request('/api/instances', a, {
    name: 'Real connector target (test fixture)',
  });
  instance = created.data.instance;
  credential = created.data.connectorToken;
  connection = await openConnector(credential);
  connector = connection.socket;
});
afterAll(async () => {
  connector?.close();
  await relay.stop();
});

describe('Relay protocol and isolation (fixture connector; NOT DSH end-to-end)', () => {
  test('password validation, login failure and cookie attributes', async () => {
    expect(
      (
        await request('/api/auth/register', undefined, {
          email: 'bad@example.test',
          password: 'short',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request('/api/auth/login', undefined, {
          email: 'a@example.test',
          password: 'wrong-password-12345',
        })
      ).status,
    ).toBe(401);
    const login = await request('/api/auth/login', undefined, {
      email: 'a@example.test',
      password: 'test-password-123456',
      deviceName: 'test',
    });
    expect(login.headers.get('set-cookie')).toContain('HttpOnly');
    expect(login.headers.get('set-cookie')).toContain('SameSite=Strict');
  });
  test('browser-origin login never exposes its bearer token to JavaScript', async () => {
    const response = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({
        email: 'a@example.test',
        password: 'test-password-123456',
        deviceName: 'browser',
      }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
    expect(((await response.json()) as any).token).toBeUndefined();
  });
  test('rejects unauthenticated and malicious cross-origin requests', async () => {
    expect((await request('/api/instances')).status).toBe(401);
    expect(
      (
        await fetch(base + '/api/instances', {
          headers: {
            Authorization: `Bearer ${a.token}`,
            Origin: 'https://evil.example',
          },
        })
      ).status,
    ).toBe(403);
  });
  test('tenant cannot list or address another user instance', async () => {
    expect((await request('/api/instances', b)).data.instances).toHaveLength(0);
    expect(
      (
        await request(`/api/instances/${instance.id}/lease`, b, {
          controllerId: b.controller.id,
        })
      ).status,
    ).toBe(404);
  });
  test('login sessions are bound to controller identity', async () => {
    expect(
      (
        await request(`/api/instances/${instance.id}/lease`, a2, {
          controllerId: a.controller.id,
        })
      ).status,
    ).toBe(403);
  });
  test('one-time credential is not returned by later instance reads', async () => {
    const read = await request('/api/instances', a);
    expect(read.data.instances[0].online).toBe(true);
    expect(JSON.stringify(read.data)).not.toContain(credential);
    expect(JSON.stringify(read.data)).not.toContain('token_hash');
  });
  test('passive read needs no writer lease; mutations do', async () => {
    const read = await send('session.list');
    expect(read.status).toBe(202);
    await until(() => commands.some((c) => c.id === wireId(read.data.id)));
    connector.send(
      JSON.stringify({
        v: 1,
        type: 'result',
        id: wireId(read.data.id),
        connectionEpoch: connection.epoch,
        ok: true,
        result: { sessions: [] },
      }),
    );
    await Bun.sleep(10);
    expect((await send('session.create', { sessionId: 'new-session' })).status).toBe(409);
  });
  test('exclusive lease acquisition, renewal and explicit takeover increments fence', async () => {
    const path = `/api/instances/${instance.id}/lease`;
    const first = await request(path, a, { controllerId: a.controller.id });
    expect(first.status).toBe(200);
    const renew = await request(path, a, { controllerId: a.controller.id });
    expect(renew.data.epoch).toBe(first.data.epoch);
    expect((await request(path, a2, { controllerId: a2.controller.id })).status).toBe(409);
    const take = await request(path, a2, {
      controllerId: a2.controller.id,
      takeover: true,
    });
    expect(take.data.epoch).toBe(first.data.epoch + 1);
    expect(
      (await send('session.cancel', { sessionId: 'session' }, { leaseEpoch: first.data.epoch }))
        .status,
    ).toBe(409);
    const restore = await request(path, a, {
      controllerId: a.controller.id,
      takeover: true,
    });
    expect(restore.data.epoch).toBe(take.data.epoch + 1);
  });
  test('same-epoch renewal preserves old acknowledged authority without extending command deadlines', async () => {
    const path = `/api/instances/${instance.id}/lease`;
    const original = await request(path, a, { controllerId: a.controller.id });
    await Bun.sleep(10);
    pauseLeaseAcks = true;
    const renewal = request(path, a, { controllerId: a.controller.id });
    await until(() => delayedAcks.length > 0);
    const current = (await request('/api/instances', a)).data.instances[0].lease;
    expect(current.pending).toBe(false);
    expect(current.expiresAt).toBe(original.data.expiresAt);
    const submitted = await send(
      'session.cancel',
      { sessionId: 'session' },
      { leaseEpoch: original.data.epoch },
    );
    expect(submitted.status).toBe(202);
    await until(() => commands.some((c) => c.id === wireId(submitted.data.id)));
    const wire = commands.find((c) => c.id === wireId(submitted.data.id))!;
    expect(wire.expiresAt).toBe(original.data.expiresAt);
    connector.send(
      JSON.stringify({
        v: 1,
        type: 'result',
        id: wire.id,
        connectionEpoch: connection.epoch,
        ok: true,
        result: null,
      }),
    );
    pauseLeaseAcks = false;
    for (const ack of delayedAcks.splice(0)) ack();
    const extended = await renewal;
    expect(extended.status).toBe(200);
    expect(extended.data.epoch).toBe(original.data.epoch);
    expect(extended.data.expiresAt).toBeGreaterThan(original.data.expiresAt);
  });
  test('repeated id dispatches once; changed payload conflicts', async () => {
    const id = `idem_${crypto.randomUUID()}`;
    const first = await send('session.list', {}, { id });
    const again = await send('session.list', {}, { id });
    expect(first.status).toBe(202);
    expect(again.status).toBe(200);
    await until(() => commands.some((c) => c.id === wireId(id)));
    expect(commands.filter((c) => c.id === wireId(id))).toHaveLength(1);
    expect((await send('capabilities', {}, { id })).status).toBe(409);
    expect((await request(`/api/commands/${id}`, b)).status).toBe(404);
  });
  test('reads stay out of storage, and Prefer: wait answers with the result', async () => {
    const id = `read_${crypto.randomUUID()}`;
    const answered = fetch(`${base}/api/instances/${instance.id}/commands`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${a.token}`,
        'Content-Type': 'application/json',
        Prefer: 'wait=5',
      },
      body: JSON.stringify({ id, controllerId: a.controller.id, action: 'session.list', args: {} }),
    });
    await until(() => commands.some((c) => c.id === wireId(id)));
    connector.send(
      JSON.stringify({
        v: 1,
        type: 'result',
        id: wireId(id),
        connectionEpoch: connection.epoch,
        ok: true,
        result: { sessions: ['kept'] },
      }),
    );
    const response = await answered;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id,
      status: 'succeeded',
      result: { sessions: ['kept'] },
    });
    expect((await request(`/api/commands/${id}`, a)).data.status).toBe('succeeded');
    expect((await request(`/api/commands/${id}`, b)).status).toBe(404);
    expect(relay.db.query('SELECT COUNT(*) AS n FROM commands WHERE request_id=?').get(id)).toEqual({
      n: 0,
    });
    expect(
      relay.db
        .query("SELECT COUNT(*) AS n FROM events WHERE kind='command.updated' AND payload LIKE ?")
        .get(`%${id}%`),
    ).toEqual({ n: 0 });
  });
  test('lease renewals are pushed to viewers, never stored', async () => {
    const path = `/api/instances/${instance.id}/lease`;
    const held = await request(path, a, { controllerId: a.controller.id, takeover: true });
    const frames: any[] = [];
    const viewer = new WebSocket(base.replace('http', 'ws') + '/ws/events?after=0', {
      headers: { Authorization: `Bearer ${a.token}` },
    });
    viewer.onmessage = (e) => frames.push(JSON.parse(String(e.data)));
    await until(() => viewer.readyState === WebSocket.OPEN);
    const stored = () =>
      (relay.db.query("SELECT COUNT(*) AS n FROM events WHERE kind='lease.changed'").get() as {
        n: number;
      }).n;
    const before = stored();
    await Bun.sleep(5);
    const renewed = await request(path, a, { controllerId: a.controller.id });
    expect(renewed.data.epoch).toBe(held.data.epoch);
    await until(() =>
      frames.some(
        (f) => f.type === 'lease' && f.instanceId === instance.id && f.lease.expiresAt === renewed.data.expiresAt,
      ),
    );
    expect(stored()).toBe(before);
    viewer.close();
  });
  test('housekeeping never reads the commands table', async () => {
    const query = relay.db.query.bind(relay.db),
      seen: string[] = [];
    relay.db.query = ((sql: string) => (seen.push(sql), query(sql))) as typeof relay.db.query;
    try {
      await Bun.sleep(1200);
    } finally {
      relay.db.query = query;
    }
    expect(seen.filter((sql) => /\bcommands\b/.test(sql))).toEqual([]);
  });
  test('allowlist rejects arbitrary RPC and admin calls', async () => {
    expect((await send('exec', { command: 'echo nope' })).status).toBe(400);
    expect((await send('settings.rawUpdate')).status).toBe(400);
  });
  test('event replay is tenant-scoped and source IDs deduplicate', async () => {
    const sourceId = crypto.randomUUID();
    const frame = {
      v: 1,
      type: 'event',
      id: sourceId,
      sessionId: 'one',
      kind: 'session.event',
      payload: { text: 'private' },
    };
    connector.send(JSON.stringify(frame));
    connector.send(JSON.stringify(frame));
    await Bun.sleep(30);
    const aEvents: unknown[] = [],
      bEvents: unknown[] = [];
    const aa = new WebSocket(base.replace('http', 'ws') + '/ws/events?after=0', {
      headers: { Authorization: `Bearer ${a.token}` },
    });
    const bb = new WebSocket(base.replace('http', 'ws') + '/ws/events?after=0', {
      headers: { Authorization: `Bearer ${b.token}` },
    });
    aa.onmessage = (e) => aEvents.push(JSON.parse(String(e.data)));
    bb.onmessage = (e) => bEvents.push(JSON.parse(String(e.data)));
    await Bun.sleep(60);
    expect(aEvents.filter((e: any) => e.kind === 'session.event')).toHaveLength(1);
    expect(bEvents.filter((e: any) => e.type === 'event')).toHaveLength(0);
    aa.close();
    bb.close();
  });
  let indeterminate = '';
  test('disconnect marks dispatched commands indeterminate and offline fails', async () => {
    const pending = await send('session.list');
    indeterminate = pending.data.id;
    connector.close();
    await until(() => connection.socket.readyState === WebSocket.CLOSED);
    await Bun.sleep(30);
    const state = await request(`/api/commands/${pending.data.id}`, a);
    expect(state.data.status).toBe('indeterminate');
    expect((await send('session.list')).status).toBe(409);
  });
  test('reconnection increments epoch and accepts durable result reconciliation', async () => {
    const publicId = indeterminate,
      pending = { id: wireId(publicId) };
    const oldEpoch = connection.epoch;
    connection = await openConnector(credential);
    connector = connection.socket;
    expect(connection.epoch).toBeGreaterThan(oldEpoch);
    connector.send(
      JSON.stringify({
        v: 1,
        type: 'result',
        id: pending.id,
        connectionEpoch: connection.epoch,
        ok: true,
        result: { sessions: [] },
      }),
    );
    await Bun.sleep(30);
    expect((await request(`/api/commands/${publicId}`, a)).data.status).toBe('succeeded');
  });
  test('pending approvals survive replay reset via authoritative snapshot', async () => {
    const pending = {
      approvalId: 'live-approval',
      sessionId: 'one',
      bootId: 'protocol-test-fixture',
      presentationHash: 'verified-hash',
      toolName: 'shell',
    };
    connector.send(
      JSON.stringify({
        v: 1,
        type: 'event',
        id: 'approval-pending',
        sessionId: 'one',
        kind: 'approval.requested',
        payload: pending,
      }),
    );
    await Bun.sleep(20);
    const state = await request(`/api/instances/${instance.id}/state`, a);
    expect(state.data.pendingApprovals).toHaveLength(1);
    expect(state.data.pendingApprovals[0].presentationHash).toBe('verified-hash');
    expect((await request(`/api/instances/${instance.id}/state`, b)).status).toBe(404);
    connector.send(
      JSON.stringify({
        v: 1,
        type: 'event',
        id: 'approval-settled',
        sessionId: 'one',
        kind: 'approval.settled',
        payload: { approvalId: 'live-approval', outcome: 'rejected' },
      }),
    );
    await Bun.sleep(20);
    expect(
      (await request(`/api/instances/${instance.id}/state`, a)).data.pendingApprovals,
    ).toHaveLength(0);
    connector.send(
      JSON.stringify({
        v: 1,
        type: 'event',
        id: 'approval-pending',
        sessionId: 'one',
        kind: 'approval.requested',
        payload: pending,
      }),
    );
    await Bun.sleep(10);
    expect(
      (await request(`/api/instances/${instance.id}/state`, a)).data.pendingApprovals,
    ).toHaveLength(0);
  });
  test('strict argument schemas reject privileged keys and excessive depth', async () => {
    expect((await send('session.create', { sessionId: 's', exec: 'arbitrary' })).status).toBe(400);
    let nested: any = {};
    for (let i = 0; i < 20; i++) nested = { nested };
    expect(
      (
        await send('session.prompt', {
          sessionId: 's',
          requestId: 'r',
          mode: 'queue',
          content: [{ type: 'text', text: 'hello', nested }],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await send('approval.respond', {
          sessionId: 's',
          approvalId: 'a',
          bootId: 'b',
          outcome: 'allowed-once',
        })
      ).status,
    ).toBe(400);
  });
  test('identical caller IDs are isolated across different accounts', async () => {
    const created = await request('/api/instances', b, {
      name: 'B independent instance',
    });
    const other = await openConnector(created.data.connectorToken);
    try {
      const id = `shared_${crypto.randomUUID()}`;
      const first = await send('session.list', {}, { id });
      const second = await request(`/api/instances/${created.data.instance.id}/commands`, b, {
        id,
        controllerId: b.controller.id,
        action: 'session.list',
        args: {},
      });
      expect(first.status).toBe(202);
      expect(second.status).toBe(202);
      expect((await request(`/api/commands/${id}`, a)).data.instanceId).toBe(instance.id);
      expect((await request(`/api/commands/${id}`, b)).data.instanceId).toBe(
        created.data.instance.id,
      );
    } finally {
      other.socket.close();
    }
  });
  test('logout revokes active writer lease and device sessions', async () => {
    await request(`/api/instances/${instance.id}/lease`, a2, {
      controllerId: a2.controller.id,
      takeover: true,
    });
    expect((await request('/api/auth/logout', a2, {})).status).toBe(200);
    expect((await request('/api/instances', a)).data.instances[0].lease).toBeNull();
    expect((await request('/api/instances', a2)).status).toBe(401);
  });
  test('credential rotation closes the old connector and invalidates its token', async () => {
    const oldToken = credential;
    const rotated = await request(`/api/instances/${instance.id}/rotate-credential`, a, {});
    expect(rotated.status).toBe(200);
    expect(rotated.data.connectorToken).not.toBe(oldToken);
    expect((await request('/api/instances', a)).data.instances[0].online).toBe(false);
    const rejected = new WebSocket(base.replace('http', 'ws') + '/ws/connector', {
      headers: { Authorization: `Bearer ${oldToken}` },
    });
    rejected.addEventListener('error', () => {});
    await until(() => rejected.readyState === WebSocket.CLOSED);
    credential = rotated.data.connectorToken;
    connection = await openConnector(credential);
    connector = connection.socket;
    expect((await request('/api/instances', a)).data.instances[0].online).toBe(true);
    const controllers = (await request('/api/controllers', a)).data.controllers;
    expect(controllers.find((c: any) => c.id === a2.controller.id).active).toBe(false);
  });
  test('logout revokes bearer and cookie session', async () => {
    expect((await request('/api/auth/logout', b, {})).status).toBe(200);
    expect((await request('/api/instances', b)).status).toBe(401);
  });
});

test('registration requires explicit operator enablement and offline instance cannot take control', async () => {
  const locked = createRelay({ databasePath: ':memory:', port: 0 });
  try {
    const r = await fetch(String(locked.server.url) + 'api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'closed@example.test',
        password: 'test-password-123456',
      }),
    });
    expect(r.status).toBe(403);
  } finally {
    await locked.stop();
  }
  const created = await request('/api/instances', a, {
    name: 'Offline target',
  });
  expect(
    (
      await request(`/api/instances/${created.data.instance.id}/lease`, a, {
        controllerId: a.controller.id,
      })
    ).status,
  ).toBe(409);
});

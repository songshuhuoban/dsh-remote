import { expect, test } from 'bun:test';
import { createRelay } from '../apps/server/src/server.ts';

// Transport/state regression with explicit connector fixtures, not real DSH evidence.
test('instance status distinguishes connecting, online, stale and offline with tenant-scoped timestamps', async () => {
  const relay = createRelay({ databasePath: ':memory:', port: 0, registration: true,
    heartbeatStaleMs: 400, heartbeatDisconnectMs: 1400 });
  const base = String(relay.server.url).replace(/\/$/, '');
  const api = async (path: string, token?: string, body?: unknown) => {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() as any };
  };
  const until = async (predicate: () => boolean | Promise<boolean>) => {
    const deadline = Date.now() + 2500;
    while (!(await predicate())) { if (Date.now() > deadline) throw new Error('State timed out'); await Bun.sleep(10); }
  };
  let ws: WebSocket | undefined;
  try {
    const a = (await api('/api/auth/register', undefined, { email: 'status-a@example.invalid', password: 'synthetic-password-only', deviceName: 'A' })).data;
    const b = (await api('/api/auth/register', undefined, { email: 'status-b@example.invalid', password: 'synthetic-password-only', deviceName: 'B' })).data;
    const created = (await api('/api/instances', a.token, { name: 'Status fixture' })).data;
    const path = `/api/instances/${created.instance.id}/state`;
    const state = async () => (await api(path, a.token)).data.instance;
    expect((await state()).status).toBe('offline');
    expect((await state()).lastSeenAt).toBeNull();
    expect((await api(path, b.token)).status).toBe(404);
    ws = new WebSocket(base.replace('http', 'ws') + '/ws/connector', { headers: { Authorization: `Bearer ${created.connectorToken}` } });
    let epoch = 0;
    ws.addEventListener('message', e => { const f = JSON.parse(String(e.data)); if (f.type === 'welcome') epoch = f.connectionEpoch; });
    await until(() => epoch > 0);
    expect((await state()).status).toBe('connecting');
    expect((await state()).online).toBe(false);
    ws.send(JSON.stringify({ v: 1, type: 'hello', bootId: 'status-fixture', capabilities: ['session.list'] }));
    await until(async () => (await state()).status === 'online');
    const seen = (await state()).lastSeenAt;
    expect(seen).toBeGreaterThan(0);
    expect((await state()).connectedAt).toBeGreaterThan(0);
    await until(async () => (await state()).status === 'stale');
    expect((await state()).online).toBe(false);
    const blocked = await api(`/api/instances/${created.instance.id}/commands`, a.token, {
      id: 'stale-status-read', controllerId: a.controller.id, action: 'session.list', args: {},
    });
    expect(blocked.status).toBe(409);
    ws.send(JSON.stringify({ v: 1, type: 'ping', connectionEpoch: epoch }));
    await until(async () => (await state()).status === 'online');
    expect((await state()).lastSeenAt).toBeGreaterThan(seen);
    await until(async () => (await state()).status === 'offline');
    expect((await state()).disconnectedAt).toBeGreaterThan(seen);
    expect((await state()).lastSeenAt).toBeGreaterThan(seen);
  } finally { ws?.close(); await relay.stop(); }
});

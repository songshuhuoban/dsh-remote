import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createRelay } from '../apps/server/src/server.ts';

// Relay pairing protocol with a fixture connector socket, not DSH end-to-end.
let relay: ReturnType<typeof createRelay>, base: string;
const call = async (path: string, token?: string, body?: unknown) => {
  const response = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: (await response.json()) as any };
};
const account = async (email: string) =>
  (
    await call('/api/auth/register', undefined, {
      email,
      password: 'synthetic-password-only',
      deviceName: 'Pairing test',
    })
  ).data;
function welcome(token: string): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(base.replace('http', 'ws') + '/ws/connector', {
      headers: { Authorization: `Bearer ${token}` },
    } as any);
    const done = (value: boolean) => {
      ws.close();
      resolve(value);
    };
    ws.onmessage = (e) => done(JSON.parse(String(e.data)).type === 'welcome');
    ws.onerror = () => done(false);
    ws.onclose = () => done(false);
  });
}
beforeAll(() => {
  relay = createRelay({ databasePath: ':memory:', port: 0, registration: true });
  base = String(relay.server.url).replace(/\/$/, '');
});
afterAll(() => relay.stop());

test('a pairing code is single use, exchanges for a fresh credential and revokes the old one', async () => {
  const owner = await account('pair-owner@example.invalid');
  const created = (await call('/api/instances', owner.token, { name: 'Paired host' })).data;
  const pairing = await call(`/api/instances/${created.instance.id}/pairing`, owner.token, {});
  expect(pairing.status).toBe(201);
  expect(pairing.data.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  expect(pairing.data.pairingUrl).toBe(`${base}/pair/${pairing.data.code}`);
  // Codes tolerate case, missing separators and look-alike letters.
  const typed = pairing.data.code.replace('-', '').toLowerCase().replaceAll('1', 'l').replaceAll('0', 'o');
  const exchanged = await call('/api/connector/pair', undefined, { code: typed });
  expect(exchanged.status).toBe(200);
  expect(exchanged.data.instance).toEqual({ id: created.instance.id, name: 'Paired host' });
  expect(await welcome(exchanged.data.connectorToken)).toBe(true);
  expect(await welcome(created.connectorToken)).toBe(false);
  const me = await call('/api/connector/me', exchanged.data.connectorToken);
  expect(me.data.instance).toEqual({ id: created.instance.id, name: 'Paired host' });
  expect((await call('/api/connector/me', created.connectorToken)).status).toBe(401);
  const reused = await call('/api/connector/pair', undefined, { code: pairing.data.code });
  expect(reused.status).toBe(404);
  expect(reused.data.error.code).toBe('PAIRING_INVALID');
});

test('only the newest unexpired code of the owning account is valid', async () => {
  const owner = await account('pair-latest@example.invalid');
  const other = await account('pair-other@example.invalid');
  const created = (await call('/api/instances', owner.token, { name: 'Host' })).data;
  const path = `/api/instances/${created.instance.id}/pairing`;
  expect((await call(path, other.token, {})).status).toBe(404);
  const first = (await call(path, owner.token, {})).data;
  const second = (await call(path, owner.token, {})).data;
  expect((await call('/api/connector/pair', undefined, { code: first.code })).status).toBe(404);
  relay.db.query('UPDATE pairing_codes SET expires_at=?').run(Date.now() - 1);
  expect((await call('/api/connector/pair', undefined, { code: second.code })).status).toBe(404);
});

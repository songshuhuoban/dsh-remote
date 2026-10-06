import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createRelay } from '../../../apps/server/src/server.ts';
import { exchangePairing, PairingError, parsePairingLink } from '../src/pairing.ts';

// Plugin-side pairing client against a real relay; no DSH Host is involved.
let relay: ReturnType<typeof createRelay>, base: string;
beforeAll(() => {
  relay = createRelay({ databasePath: ':memory:', port: 0, registration: true });
  base = String(relay.server.url).replace(/\/$/, '');
});
afterAll(() => relay.stop());

test('pairing links resolve to the relay connector endpoint', () => {
  expect(parsePairingLink('https://dsh.example.com/pair/ABCD-EFGH')).toEqual({
    origin: 'https://dsh.example.com',
    code: 'ABCD-EFGH',
    relayUrl: 'wss://dsh.example.com/ws/connector',
  });
  expect(parsePairingLink('  dsh.example.com:8443/pair/abcdefgh/ ').relayUrl).toBe(
    'wss://dsh.example.com:8443/ws/connector',
  );
  expect(parsePairingLink('http://127.0.0.1:3000/pair/ABCD-EFGH').relayUrl).toBe(
    'ws://127.0.0.1:3000/ws/connector',
  );
  for (const bad of [
    'http://dsh.example.com/pair/ABCD-EFGH',
    'https://dsh.example.com/other/ABCD-EFGH',
    'https://user:pw@dsh.example.com/pair/ABCD-EFGH',
    'https://dsh.example.com/pair/ABCD-EFGH?x=1',
    'not a link',
  ])
    expect(() => parsePairingLink(bad)).toThrow(PairingError);
});

test('exchanging a relay pairing link yields a working credential, once', async () => {
  const api = async (path: string, token?: string, body?: unknown) =>
    (await (
      await fetch(base + path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body ?? {}),
      })
    ).json()) as any;
  const owner = await api('/api/auth/register', undefined, {
    email: 'plugin-pair@example.invalid',
    password: 'synthetic-password-only',
    deviceName: 'Plugin pairing test',
  });
  const created = await api('/api/instances', owner.token, { name: 'Plugin host' });
  const pairing = await api(`/api/instances/${created.instance.id}/pairing`, owner.token);
  const result = await exchangePairing(pairing.pairingUrl);
  expect(result.instance).toEqual({ id: created.instance.id, name: 'Plugin host' });
  expect(result.relayUrl).toBe(`${base.replace('http', 'ws')}/ws/connector`);
  const ws = new WebSocket(result.relayUrl, {
    headers: { Authorization: `Bearer ${result.connectorToken}` },
  } as any);
  const first = await new Promise<string>((resolve) => {
    ws.onmessage = (e) => resolve(JSON.parse(String(e.data)).type);
    ws.onclose = () => resolve('closed');
  });
  // Finish the close handshake before more requests (avoids a Bun-on-Windows crash).
  const closed = new Promise((resolve) => (ws.onclose = resolve));
  ws.close();
  await closed;
  expect(first).toBe('welcome');
  await expect(exchangePairing(pairing.pairingUrl)).rejects.toMatchObject({ code: 'invalid_code' });
});

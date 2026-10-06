import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createRelay } from '../apps/server/src/server.ts';

// Viewer stream liveness: application keepalives and round-trip pings, nothing else accepted.
let relay: ReturnType<typeof createRelay>, base: string, token: string;
beforeAll(async () => {
  relay = createRelay({ databasePath: ':memory:', port: 0, registration: true });
  base = String(relay.server.url).replace(/\/$/, '');
  const response = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'viewer-liveness@example.invalid',
      password: 'synthetic-password-only',
      deviceName: 'Liveness',
    }),
  });
  token = ((await response.json()) as { token: string }).token;
});
afterAll(() => relay.stop());

function open() {
  const frames: Array<Record<string, unknown>> = [];
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws/events?after=0`, {
    headers: { Authorization: `Bearer ${token}` },
  } as any);
  ws.onmessage = (e) => frames.push(JSON.parse(String(e.data)));
  const ready = new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (frames.some((f) => f.type === 'ready')) {
        clearInterval(check);
        resolve();
      }
    }, 10);
  });
  const closed = new Promise<number>((resolve) => (ws.onclose = (e) => resolve(e.code)));
  return { ws, frames, ready, closed };
}
const until = async (predicate: () => boolean) => {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out');
    await Bun.sleep(10);
  }
};

test('a viewer ping is answered with the matching pong and a keepalive follows', async () => {
  const viewer = open();
  await viewer.ready;
  viewer.ws.send(JSON.stringify({ v: 1, type: 'ping', id: 7 }));
  await until(() => viewer.frames.some((f) => f.type === 'pong' && f.id === 7));
  await until(() => viewer.frames.some((f) => f.type === 'keepalive'));
  viewer.ws.close();
  await viewer.closed;
});

test('any other viewer frame still closes the stream', async () => {
  const viewer = open();
  await viewer.ready;
  viewer.ws.send(JSON.stringify({ v: 1, type: 'command', id: 'x' }));
  expect(await viewer.closed).toBe(1008);
});

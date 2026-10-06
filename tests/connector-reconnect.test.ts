import { afterAll, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createRelay } from '../apps/server/src/server.ts';

// Connector process against a relay that goes away and comes back on the same port.
const dir = mkdtempSync(join(tmpdir(), 'dsh-reconnect-'));
const databasePath = join(dir, 'relay.sqlite');
let relay = createRelay({ databasePath, port: 0, registration: true });
const port = relay.server.port;
const base = `http://127.0.0.1:${port}`;
const child = spawn(
  process.execPath,
  [join(import.meta.dir, '../packages/connector/src/index.ts')],
  {
    stdio: ['pipe', 'pipe', 'inherit'],
  },
);
const frames: any[] = [];
const waiters = new Set<() => void>();
createInterface({ input: child.stdout! }).on('line', (line) => {
  frames.push(JSON.parse(line));
  for (const wake of waiters) wake();
});
const send = (value: unknown) => child.stdin!.write(JSON.stringify(value) + '\n');
function next(match: (frame: any) => boolean, timeoutMs: number): Promise<any> {
  const start = frames.length;
  return new Promise((resolve, reject) => {
    const check = () => {
      const found = frames.slice(start).find(match);
      if (!found) return;
      waiters.delete(check);
      clearTimeout(timer);
      resolve(found);
    };
    const timer = setTimeout(() => {
      waiters.delete(check);
      reject(new Error(`no matching frame within ${timeoutMs} ms`));
    }, timeoutMs);
    waiters.add(check);
  });
}
afterAll(async () => {
  send({ type: 'shutdown' });
  await new Promise((resolve) => child.once('exit', resolve));
  await relay.stop();
  Bun.gc(true);
  rmSync(dir, { recursive: true, force: true });
});

test('a dropped relay is retried with a published countdown, and "retry" skips the wait', async () => {
  const call = async (path: string, token?: string, body?: unknown) =>
    (
      await fetch(base + path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body ?? {}),
      })
    ).json() as Promise<any>;
  const owner = await call('/api/auth/register', undefined, {
    email: 'reconnect@example.invalid',
    password: 'synthetic-password-only',
    deviceName: 'Reconnect test',
  });
  const created = await call('/api/instances', owner.token, { name: 'Flaky host' });
  const online = next((f) => f.type === 'connection' && f.online, 10_000);
  send({
    type: 'init',
    config: {
      relayUrl: `ws://127.0.0.1:${port}/ws/connector`,
      connectorToken: created.connectorToken,
      journalPath: join(dir, 'journal.sqlite'),
      bootId: crypto.randomUUID(),
      capabilities: [],
    },
  });
  await online;

  const dropped = next((f) => f.type === 'connection' && !f.online, 10_000);
  await relay.stop();
  await dropped;
  // Backoff grows while the relay stays away; every scheduled attempt announces its time.
  const waiting = await next(
    (f) => f.type === 'status' && f.nextRetryAt - Date.now() > 2500,
    20_000,
  );
  expect(waiting.state).toBe('unreachable');
  expect(waiting.attempt).toBeGreaterThan(1);

  relay = createRelay({ databasePath, port, registration: true });
  const back = next((f) => f.type === 'connection' && f.online, 10_000);
  const retriedAt = Date.now();
  send({ type: 'retry' });
  await back;
  expect(Date.now()).toBeLessThan(waiting.nextRetryAt);
  expect(Date.now() - retriedAt).toBeLessThan(2000);
}, 60_000);

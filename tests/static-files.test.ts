import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRelay } from '../apps/server/src/server.ts';

// The Bun relay's static console, including the packed plugin (scripts/pack-plugin.ts).
const dir = mkdtempSync(join(tmpdir(), 'dsh-static-'));
mkdirSync(join(dir, 'plugin'));
writeFileSync(join(dir, 'index.html'), '<!doctype html><title>console</title>');
writeFileSync(join(dir, 'plugin/manifest.json'), '{"version":"0.0.0","file":"p-0.0.0-abcd1234.tgz"}');
writeFileSync(join(dir, 'plugin/p-0.0.0-abcd1234.tgz'), Buffer.from([0x1f, 0x8b, 8, 0]));
const relay = createRelay({ databasePath: ':memory:', port: 0, staticDir: dir });
const base = String(relay.server.url).replace(/\/$/, '');
afterAll(async () => {
  await relay.stop();
  rmSync(dir, { recursive: true, force: true });
});

test('console routes fall back to the app, plugin files never do', async () => {
  const route = await fetch(`${base}/pair/ABCD-EFGH`);
  expect(route.status).toBe(200);
  expect(await route.text()).toContain('console');
  const manifest = await fetch(`${base}/plugin/manifest.json`);
  expect(manifest.headers.get('content-type')).toContain('json');
  const tarball = await fetch(`${base}/plugin/p-0.0.0-abcd1234.tgz`);
  expect(new Uint8Array(await tarball.arrayBuffer()).subarray(0, 2)).toEqual(
    new Uint8Array([0x1f, 0x8b]),
  );
  expect((await fetch(`${base}/plugin/p-0.0.0-stale000.tgz`)).status).toBe(404);
  expect((await fetch(`${base}/plugin/manifest.json`, { method: 'HEAD' })).status).toBe(200);
});

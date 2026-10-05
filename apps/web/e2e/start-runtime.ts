/** Readiness wrapper for the real DSH test fixture; no mock connector/adapter. */
import { resolve } from 'node:path';
const root = resolve(import.meta.dir, '../../..');
const child = Bun.spawn([process.execPath, 'packages/dsh-plugin/tests/runtime-smoke.ts'], {
  cwd: root,
  env: { ...process.env, LIVE_PROVIDER_E2E: '0', DSH_E2E_PORT: '3108', DSH_E2E_KEEP_RUNNING: '1' },
  stdout: 'pipe',
  stderr: 'inherit',
});
let ready = false,
  stopping = false,
  tail = '';
const readiness = Bun.serve({
  hostname: '127.0.0.1',
  port: 3110,
  fetch: () => new Response(ready ? 'ready' : 'starting', { status: ready ? 200 : 503 }),
});
const stop = async () => {
  if (stopping) return;
  stopping = true;
  child.kill('SIGTERM');
  await child.exited;
  readiness.stop();
  process.exit(0);
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
for await (const bytes of child.stdout) {
  const text = new TextDecoder().decode(bytes);
  process.stdout.write(text);
  tail = (tail + text).slice(-16000);
  if (tail.includes('FIXTURE_READY ')) ready = true;
}
const code = await child.exited;
readiness.stop();
process.exit(stopping ? 0 : code || 1);

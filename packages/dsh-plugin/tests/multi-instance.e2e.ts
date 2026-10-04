/** Actual three-process DSH topology. Only the external model HTTP replies are scripted. */
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createRelay } from '../../../apps/server/src/server.ts';
const root = resolve(import.meta.dir, '../../..');
const upstream = process.env.DSH_UPSTREAM ?? join(root, '.tools/dsh-upstream');
if (!existsSync(join(upstream, 'node_modules/tsx')))
  throw new Error(
    'BLOCKED: prepare the pinned DSH source with packages/dsh-plugin/scripts/bootstrap-upstream.sh',
  );
if (process.env.LIVE_PROVIDER_E2E === '1')
  throw new Error(
    'This isolated topology lane always uses a deterministic local provider; use the separate authorized live-provider runner',
  );
const { startMockLlmServer } = await import(
  pathToFileURL(join(upstream, 'packages/test-support/llm-mock-server/src/index.ts')).href
);
const model = await startMockLlmServer({
  sequence: ['success'],
  repeatLast: true,
  apiKey: 'mock-key',
  successText: 'THREE_REAL_DSH_HOSTS_OK',
});
const temp = mkdtempSync(join(tmpdir(), 'dsh-three-hosts-'));
const relay = createRelay({
  databasePath: join(temp, 'relay.sqlite'),
  port: 0,
  registration: true,
  leaseMs: 120000,
});
const base = String(relay.server.url).replace(/\/$/, '');
type Identity = { token: string; user: { id: string }; controller: { id: string } };
type Host = {
  name: string;
  instanceId: string;
  work: string;
  child: ChildProcess;
  logs: string;
  owner: Identity;
  controller: Identity;
  lease: { epoch: number };
  marker: string;
};
const hosts: Host[] = [],
  sockets: WebSocket[] = [],
  assertions: string[] = [];
async function call(identity: Identity | undefined, path: string, body?: unknown) {
  const response = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(identity ? { Authorization: `Bearer ${identity.token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, value: (await response.json()) as any };
}
async function ok(identity: Identity | undefined, path: string, body?: unknown) {
  const r = await call(identity, path, body);
  if (r.status >= 400) throw new Error(`${path}: ${r.status} ${JSON.stringify(r.value)}`);
  return r.value;
}
async function waitFor<T>(
  read: () => Promise<T | undefined>,
  label: string,
  timeout = 120000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await Bun.sleep(100);
  }
  throw new Error(
    `Timed out: ${label}\n${hosts.map((h) => h.name + ': ' + h.logs.slice(-1500)).join('\n')}`,
  );
}
async function command(host: Host, action: string, args: unknown, id = crypto.randomUUID()) {
  const submitted = await ok(host.controller, `/api/instances/${host.instanceId}/commands`, {
    id,
    controllerId: host.controller.controller.id,
    leaseEpoch: host.lease?.epoch,
    action,
    args,
  });
  return waitFor(async () => {
    const state = await ok(host.controller, `/api/commands/${submitted.id}`);
    if (state.status === 'failed' || state.status === 'indeterminate')
      throw new Error(`${host.name}/${action}: ${JSON.stringify(state.error)}`);
    return state.status === 'succeeded' ? state.result : undefined;
  }, `${host.name}/${action}`);
}
async function start(name: string, owner: Identity, controller: Identity) {
  const registered = await ok(owner, '/api/instances', { name });
  const dir = join(temp, name);
  mkdirSync(dir, { mode: 0o700 });
  const work = join(dir, 'work');
  mkdirSync(work);
  const credentials = join(dir, 'credentials');
  mkdirSync(credentials, { mode: 0o700 });
  const tokenFile = join(credentials, 'connector.token');
  writeFileSync(tokenFile, registered.connectorToken, { mode: 0o600 });
  const patch = join(dir, 'remote.patch.yml');
  writeFileSync(
    patch,
    JSON.stringify([
      { id: 'typert-loader', disabled: true },
      { id: 'modules', disabled: true },
      { id: 'client-hmr', disabled: true },
      {
        insert: [
          {
            id: 'dsh-remote-topology',
            name: pathToFileURL(join(root, 'packages/dsh-plugin/dist/index.js')).href,
            config: {
              relayUrl: base.replace('http', 'ws') + '/ws/connector',
              connectorTokenFile: tokenFile,
              connectorPath: join(root, 'packages/connector/src/index.ts'),
              journalPath: join(dir, 'connector', 'journal.sqlite'),
              bunPath: process.execPath,
              allowedWorkspaceRoots: [work],
            },
          },
        ],
      },
    ]),
  );
  const child = spawn(
    'node',
    [
      '--import',
      'tsx/esm',
      'apps/cli/src/bin.ts',
      'web',
      '--patch',
      patch,
      '--no-open',
      '--host',
      '127.0.0.1',
      '--port',
      '0',
    ],
    {
      cwd: upstream,
      env: {
        ...process.env,
        DSH_HOME: join(dir, 'home'),
        DSH_AGENTS_HOME: join(dir, 'agents'),
        DSH_TELEMETRY_DISABLED: '1',
        DEEPSEEK_API_KEY: 'mock-key',
        DEEPSEEK_BASE_URL: model.baseURL,
        ALL_PROXY: '',
        all_proxy: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const host: Host = {
    name,
    instanceId: registered.instance.id,
    work,
    child,
    logs: '',
    owner,
    controller,
    lease: { epoch: 0 },
    marker: `PRIVATE_${name}_${crypto.randomUUID()}`,
  };
  hosts.push(host);
  child.stdout!.on('data', (d) => {
    host.logs += String(d);
  });
  child.stderr!.on('data', (d) => {
    host.logs += String(d);
  });
  return host;
}
try {
  const password = 'isolated-topology-password-only';
  const a: Identity = await ok(undefined, '/api/auth/register', {
    email: 'topology-a@example.invalid',
    password,
    deviceName: 'A web',
  });
  const aPhone: Identity = await ok(undefined, '/api/auth/login', {
    email: 'topology-a@example.invalid',
    password,
    deviceName: 'A phone',
  });
  const b: Identity = await ok(undefined, '/api/auth/register', {
    email: 'topology-b@example.invalid',
    password,
    deviceName: 'B web',
  });
  const a1 = await start('A1', a, a),
    a2 = await start('A2', a, aPhone),
    b1 = await start('B1', b, b);
  await waitFor(async () => {
    const aa = await ok(a, '/api/instances'),
      bb = await ok(b, '/api/instances');
    return aa.instances.filter((i: any) => i.online).length === 2 &&
      bb.instances.filter((i: any) => i.online).length === 1
      ? true
      : undefined;
  }, 'three real DSH hosts online');
  assertions.push(
    'Two users own three actual isolated DSH processes with separate homes, workspaces and journals',
  );
  const fleetA = await ok(a, '/api/instances'),
    fleetB = await ok(b, '/api/instances');
  if (
    fleetA.instances.length !== 2 ||
    fleetB.instances.length !== 1 ||
    fleetA.instances.some((i: any) => i.id === b1.instanceId)
  )
    throw new Error('Tenant fleet leak');
  assertions.push('Real fleet enumeration is tenant scoped');
  const seenA: string[] = [],
    seenB: string[] = [];
  for (const [identity, seen] of [
    [a, seenA],
    [b, seenB],
  ] as const) {
    const ws = new WebSocket(base.replace('http', 'ws') + '/ws/events?after=0', {
      headers: { Authorization: `Bearer ${identity.token}` },
    });
    ws.onmessage = (e) => {
      const frame = JSON.parse(String(e.data));
      if (frame.type === 'event') seen.push(frame.instanceId);
    };
    ws.addEventListener('error', () => {});
    sockets.push(ws);
  }
  for (const host of hosts) {
    host.lease = await ok(host.controller, `/api/instances/${host.instanceId}/lease`, {
      controllerId: host.controller.controller.id,
    });
    await command(host, 'session.create', { sessionId: 'same-session-id', cwd: host.work });
  }
  assertions.push(
    'One account controls A1 and A2 concurrently through different controllers, with real Host-fenced leases',
  );
  await Promise.all(
    hosts.map((host) =>
      command(host, 'session.prompt', {
        sessionId: 'same-session-id',
        requestId: crypto.randomUUID(),
        mode: 'queue',
        content: [{ type: 'text', text: host.marker }],
      }),
    ),
  );
  for (const host of hosts) {
    const read = await waitFor(async () => {
      const value = await command(host, 'session.read', { sessionId: 'same-session-id' });
      return !value.running && value.events.some((e: any) => e.type === 'assistant/message')
        ? value
        : undefined;
    }, `${host.name} durable reply`);
    const serialized = JSON.stringify(read.events);
    if (
      read.header.cwd !== host.work ||
      !serialized.includes(host.marker) ||
      hosts.some((other) => other !== host && serialized.includes(other.marker))
    )
      throw new Error(`Cross-instance session routing: ${host.name}`);
  }
  assertions.push(
    'Identical session IDs route to distinct real DSH stores and never mix prompts or workspaces',
  );
  if ((await call(b, `/api/instances/${a1.instanceId}/state`)).status !== 404)
    throw new Error('Cross-tenant state disclosed');
  if (
    (
      await call(b, `/api/instances/${a1.instanceId}/commands`, {
        id: crypto.randomUUID(),
        controllerId: b.controller.id,
        action: 'session.read',
        args: { sessionId: 'same-session-id' },
      })
    ).status !== 404
  )
    throw new Error('Cross-tenant command allowed');
  if (
    seenA.some((id) => id !== a1.instanceId && id !== a2.instanceId) ||
    seenB.some((id) => id !== b1.instanceId) ||
    seenA.length === 0 ||
    seenB.length === 0
  )
    throw new Error('Cross-tenant event disclosure');
  assertions.push(
    'Authenticated HTTP command/state access and WebSocket replay/events stay tenant scoped with actual DSH output',
  );
  const oldLease = a1.lease;
  const taken = await ok(aPhone, `/api/instances/${a1.instanceId}/lease`, {
    controllerId: aPhone.controller.id,
    takeover: true,
  });
  if (taken.epoch <= oldLease.epoch) throw new Error('Lease epoch did not advance');
  const stale = await call(a, `/api/instances/${a1.instanceId}/commands`, {
    id: crypto.randomUUID(),
    controllerId: a.controller.id,
    leaseEpoch: oldLease.epoch,
    action: 'session.cancel',
    args: { sessionId: 'same-session-id' },
  });
  if (stale.status !== 409) throw new Error('Stale writer admitted');
  a1.controller = aPhone;
  a1.lease = taken;
  await command(a1, 'session.cancel', { sessionId: 'same-session-id' });
  await command(a2, 'session.cancel', { sessionId: 'same-session-id' });
  assertions.push(
    'Explicit takeover fences the old actual Host controller without disturbing control of another instance',
  );
  const evidence = {
    kind: 'real-dsh-multi-user-multi-instance',
    upstreamCommit: '5badb15009ae1756c3afe0ae0cef1faafc290ccc',
    users: 2,
    controllers: 3,
    realDshProcesses: 3,
    realProvider: false,
    providerRequests: model.requests.length,
    passed: assertions,
  };
  writeFileSync(
    join(root, 'docs/multi-instance-result.json'),
    JSON.stringify(evidence, null, 2) + '\n',
  );
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  for (const socket of sockets) socket.close();
  await Promise.all(
    hosts.map(async (host) => {
      if (host.child.exitCode !== null) return;
      const ended = new Promise<void>((resolve) => host.child.once('exit', () => resolve()));
      host.child.kill('SIGTERM');
      await Promise.race([ended, Bun.sleep(7000)]);
      if (host.child.exitCode === null) {
        host.child.kill('SIGKILL');
        await ended;
      }
    }),
  );
  await model.close();
  await relay.stop();
}

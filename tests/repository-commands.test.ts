/** Real relay admission/result projection; connector responses are protocol fixtures. */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createRelay } from '../apps/server/src/server.ts';
import type { RelayCommand } from '../packages/protocol/src/index.ts';

let relay: ReturnType<typeof createRelay>, base: string, owner: any, foreign: any;
const sockets: WebSocket[] = [];
async function api(path: string, who: any, input?: unknown) {
  const response = await fetch(base + path, {
    method: input === undefined ? 'GET' : 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(who ? { Authorization: `Bearer ${who.token}` } : {}),
    },
    body: input === undefined ? undefined : JSON.stringify(input),
  });
  return { status: response.status, data: (await response.json()) as any };
}
async function until<T>(read: () => Promise<T | undefined> | T | undefined): Promise<T> {
  const end = Date.now() + 3000;
  while (Date.now() < end) {
    const value = await read();
    if (value !== undefined) return value;
    await Bun.sleep(5);
  }
  throw new Error('Timed out awaiting relay projection');
}
beforeAll(async () => {
  relay = createRelay({ databasePath: ':memory:', port: 0, registration: true, leaseMs: 60_000 });
  base = String(relay.server.url).replace(/\/$/, '');
  owner = (
    await api('/api/auth/register', null, {
      email: 'repositories@example.invalid',
      password: 'fixture-password-only',
      deviceName: 'fixture',
    })
  ).data;
  foreign = (
    await api('/api/auth/register', null, {
      email: 'foreign-repositories@example.invalid',
      password: 'fixture-password-only',
      deviceName: 'foreign fixture',
    })
  ).data;
});
afterAll(async () => {
  for (const socket of sockets) socket.close();
  await relay.stop();
});
async function target(who = owner) {
  const created = (await api('/api/instances', who, { name: 'Repository protocol fixture' })).data;
  const id = created.instance.id,
    messages: RelayCommand[] = [];
  const socket = new WebSocket(base.replace('http', 'ws') + '/ws/connector', {
    headers: { Authorization: `Bearer ${created.connectorToken}` },
  });
  sockets.push(socket);
  let epoch = 0;
  socket.addEventListener('message', (event) => {
    const frame = JSON.parse(String(event.data));
    if (frame.type === 'welcome') {
      epoch = frame.connectionEpoch;
      socket.send(
        JSON.stringify({
          v: 1,
          type: 'hello',
          bootId: crypto.randomUUID(),
          capabilities: ['repository.inspect', 'session.prompt'],
        }),
      );
    }
    if (frame.type === 'lease')
      socket.send(
        JSON.stringify({
          v: 1,
          type: 'lease.ack',
          connectionEpoch: epoch,
          epoch: frame.epoch,
          expiresAt: frame.expiresAt,
        }),
      );
    if (frame.type === 'command') messages.push(frame);
  });
  await until(async () =>
    (await api('/api/instances', who)).data.instances.find((v: any) => v.id === id && v.online),
  );
  const lease = (await api(`/api/instances/${id}/lease`, who, { controllerId: who.controller.id }))
    .data;
  const send = (action: string, args: unknown, extras: Record<string, unknown> = {}) =>
    api(`/api/instances/${id}/commands`, who, {
      id: crypto.randomUUID(),
      controllerId: who.controller.id,
      leaseEpoch: lease.epoch,
      action,
      args,
      ...extras,
    });
  const map = async (name: string) =>
    (
      await api(`/api/instances/${id}/repositories`, who, {
        controllerId: who.controller.id,
        source: 'manual',
        url: `https://github.com/fixture/${name}`,
        defaultBranch: 'main',
        localPath: `/workspace/${name}`,
      })
    ).data.repository;
  const result = async (commandId: string, value: unknown, ok = true) => {
    const command = await until(() => messages.find((m) => m.id === commandId));
    socket.send(
      JSON.stringify({
        v: 1,
        type: 'result',
        connectionEpoch: epoch,
        id: command.id,
        ok,
        ...(ok
          ? { result: value }
          : { error: { code: 'repository_mismatch', message: 'Local origin changed' } }),
      }),
    );
  };
  return { id, socket, lease, messages, send, map, result, who };
}
function inspection(ref: any) {
  return {
    path: ref.localPath,
    name: ref.fullName,
    remote: { owner: 'fixture', name: ref.fullName.split('/')[1], url: ref.url },
    branch: 'main',
    commit: 'a'.repeat(40),
  };
}
async function settle(
  t: Awaited<ReturnType<typeof target>>,
  response: any,
  value: unknown,
  ok = true,
) {
  const wireId = createHash('sha256').update(`${t.who.user.id}:${response.data.id}`).digest('hex');
  const wire = await until(() => t.messages.find((m) => m.id === wireId));
  await t.result(wire.id, value, ok);
  return until(async () => {
    const result = (await api(`/api/commands/${response.data.id}`, t.who)).data;
    return ['succeeded', 'failed'].includes(result.status) ? result : undefined;
  });
}

test('relay owns paths/context, checks ownership, counts and readiness before dispatch', async () => {
  const a = await target(),
    b = await target(),
    other = await target(foreign);
  const ref = await a.map('alpha'),
    wrongInstance = await b.map('beta'),
    wrongOwner = await other.map('gamma');
  const content = {
    sessionId: 's',
    requestId: 'r',
    mode: 'queue',
    content: [{ type: 'text', text: 'Read code' }],
  };
  for (const args of [{ path: '/etc' }, { expectedRemoteUrl: ref.url }, { repositoryContext: [] }])
    expect((await a.send('repository.inspect', args, { repositoryId: ref.id })).status).toBe(400);
  expect((await a.send('repository.inspect', {})).status).toBe(400);
  expect(
    (await a.send('repository.inspect', {}, { repositoryId: ref.id, leaseEpoch: 999 })).status,
  ).toBe(409);
  for (const id of [wrongInstance.id, wrongOwner.id])
    expect((await a.send('repository.inspect', {}, { repositoryId: id })).status).toBe(404);
  expect(
    (
      await a.send('session.prompt', {
        ...content,
        repositoryContext: [
          { referenceId: ref.id, path: ref.localPath, expectedRemoteUrl: ref.url },
        ],
      })
    ).status,
  ).toBe(400);
  expect(
    (await a.send('session.prompt', content, { repositoryIds: [ref.id] })).data.error.code,
  ).toBe('REPOSITORY_NOT_VERIFIED');
  for (const repositoryIds of [
    [ref.id, ref.id],
    Array.from({ length: 9 }, (_, i) => `r-${i}`),
    ['<unsafe>'],
    null,
  ])
    expect((await a.send('session.prompt', content, { repositoryIds })).status).toBe(400);
  expect(a.messages).toHaveLength(0);
  const accepted = await a.send('repository.inspect', {}, { repositoryId: ref.id });
  expect(accepted.status).toBe(202);
  const wire = await until(() => a.messages.at(-1));
  expect(wire.args).toEqual({ path: ref.localPath, expectedRemoteUrl: ref.url });
  expect(
    (relay.db.query('SELECT repository_id FROM commands WHERE id=?').get(wire.id) as any)
      .repository_id,
  ).toBe(ref.id);
  const settled = await settle(a, accepted, { ...inspection(ref), token: 'MUST_NOT_PERSIST' });
  expect(settled.status).toBe('succeeded');
  expect(JSON.stringify(settled.result)).not.toContain('MUST_NOT_PERSIST');
  const prompt = await a.send('session.prompt', content, { repositoryIds: [ref.id] });
  expect(prompt.status).toBe(202);
  const enriched = await until(() => a.messages.find((m) => m.action === 'session.prompt'));
  expect(enriched.args.repositoryContext).toEqual([
    { referenceId: ref.id, path: ref.localPath, expectedRemoteUrl: ref.url },
  ]);
});

test('result projection cannot verify another reference and retries keep original caller identity', async () => {
  const a = await target(),
    first = await a.map('first'),
    second = await a.map('second');
  const requestId = crypto.randomUUID();
  const accepted = await a.send(
    'repository.inspect',
    {},
    { id: requestId, repositoryId: first.id },
  );
  expect((await settle(a, accepted, inspection(first))).status).toBe('succeeded');
  const requestCount = a.messages.length;
  const conflicting = await a.send(
    'repository.inspect',
    {},
    { id: requestId, repositoryId: second.id },
  );
  expect(conflicting.data.error.code).toBe('IDEMPOTENCY_CONFLICT');
  // A later inspection returns a second repository's metadata, but it remains bound to first.
  const changed = await a.send('repository.inspect', {}, { repositoryId: first.id });
  const rejected = await settle(a, changed, { ...inspection(second), repositoryId: second.id });
  expect(rejected.status).toBe('failed');
  expect(rejected.result).toBeNull();
  const refs = (await api(`/api/instances/${a.id}/repositories`, owner)).data.repositories;
  expect(refs.find((r: any) => r.id === first.id).localState).toBe('stale');
  expect(refs.find((r: any) => r.id === second.id).localState).toBe('declared');
  const retry = await a.send(
    'repository.inspect',
    {},
    { id: requestId, repositoryId: first.id, leaseEpoch: -1 },
  );
  expect(retry.status).toBe(200);
  expect(retry.data.status).toBe('succeeded');
  expect(a.messages.length).toBe(requestCount + 1);
  const failed = await a.send('repository.inspect', {}, { repositoryId: second.id });
  expect((await settle(a, failed, null, false)).status).toBe('failed');
  expect(
    (await api(`/api/instances/${a.id}/repositories`, owner)).data.repositories.find(
      (r: any) => r.id === second.id,
    ).localState,
  ).toBe('stale');
});

test('prompt idempotency survives changed reference readiness and raw recursive input stays bounded', async () => {
  const a = await target(),
    ref = await a.map('prompt');
  const check = await a.send('repository.inspect', {}, { repositoryId: ref.id });
  await settle(a, check, inspection(ref));
  const requestId = crypto.randomUUID(),
    args = {
      sessionId: 's',
      requestId: 'prompt',
      mode: 'queue',
      content: [{ type: 'text', text: 'hello' }],
    };
  const prompt = await a.send('session.prompt', args, { id: requestId, repositoryIds: [ref.id] });
  await settle(a, prompt, { accepted: true });
  const stale = await a.send('repository.inspect', {}, { repositoryId: ref.id });
  await settle(a, stale, null, false);
  const count = a.messages.length;
  expect(
    (await a.send('session.prompt', args, { id: requestId, repositoryIds: [ref.id] })).data.status,
  ).toBe('succeeded');
  expect(a.messages).toHaveLength(count);
  expect((await a.send('session.prompt', args, { repositoryIds: [ref.id] })).data.error.code).toBe(
    'REPOSITORY_NOT_VERIFIED',
  );
  let deep: unknown = 'x';
  for (let i = 0; i < 20; i++) deep = { nested: deep };
  expect(
    (
      await a.send(
        'session.prompt',
        { ...args, content: [{ type: 'text', text: deep }] },
        { repositoryIds: [ref.id] },
      )
    ).status,
  ).toBe(400);
});

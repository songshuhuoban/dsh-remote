/** Real shipped DSH source profile -> installed plugin -> Bun connector -> relay.
 * The only simulated component is the external Messages model endpoint.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createRelay } from '../../../apps/server/src/server.ts';
const root = resolve(import.meta.dir, '../../..');
const upstream = process.env.DSH_UPSTREAM ?? resolve(root, '.tools/dsh-upstream');
if (
  !existsSync(join(upstream, 'apps/cli/src/bin.ts')) ||
  !existsSync(join(upstream, 'node_modules/tsx'))
)
  throw new Error(
    'BLOCKED: run packages/dsh-plugin/scripts/bootstrap-upstream.sh or set DSH_UPSTREAM to the prepared pinned source checkout',
  );
const temp = mkdtempSync(join(tmpdir(), 'dsh-remote-real-'));
const work = join(temp, 'work');
mkdirSync(work);
const home = join(temp, 'home');
const { startMockLlmServer } = await import(
  pathToFileURL(join(upstream, 'packages/test-support/llm-mock-server/src/index.ts')).href
);
const live = process.env.LIVE_PROVIDER_E2E === '1';
if (live && !process.env.DEEPSEEK_API_KEY)
  throw new Error(
    'BLOCKED: LIVE_PROVIDER_E2E needs an operator-supplied DEEPSEEK_API_KEY; no test was run',
  );
const model = live
  ? {
      baseURL: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/anthropic',
      requests: [],
      close: async () => {},
    }
  : await startMockLlmServer({
      sequence: ['slow_success'],
      repeatLast: true,
      apiKey: 'mock-key',
      successText: 'REAL_DSH_PIPELINE_OK',
      chunkSize: 2,
      chunkDelayMs: 60,
    });
const relay = createRelay({
  databasePath: join(temp, 'relay.sqlite'),
  port: Number(process.env.DSH_E2E_PORT ?? 0),
  staticDir: join(root, 'apps/web/dist'),
  registration: true,
  leaseMs: 120000,
});
const base = String(relay.server.url).replace(/\/$/, '');
let auth: any,
  instance: any,
  lease: any,
  child: ReturnType<typeof spawn> | undefined,
  logs = '';
async function request(path: string, body?: unknown) {
  const response = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(auth ? { Authorization: `Bearer ${auth.token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = (await response.json()) as any;
  if (!response.ok) throw new Error(`${path}: ${response.status} ${JSON.stringify(value)}`);
  return value;
}
async function until<T>(read: () => Promise<T | undefined>, label: string, ms = 60000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await read();
    if (value !== undefined) return value;
    await Bun.sleep(100);
  }
  throw new Error(`Timeout: ${label}\n${logs.slice(-10000)}`);
}
async function command(action: string, args: unknown) {
  const cmd = await request(`/api/instances/${instance.id}/commands`, {
    id: crypto.randomUUID(),
    controllerId: auth.controller.id,
    leaseEpoch: lease?.epoch,
    action,
    args,
  });
  return until(async () => {
    const value = await request(`/api/commands/${cmd.id}`);
    if (value.status === 'failed') throw new Error(`${action}: ${JSON.stringify(value.error)}`);
    return value.status === 'succeeded' ? value.result : undefined;
  }, action);
}
const assertions: string[] = [];
try {
  auth = await request('/api/auth/register', {
    email: 'real-runtime@example.invalid',
    password: 'local-fixture-password-only',
    deviceName: 'runtime-e2e',
  });
  const created = await request('/api/instances', { name: 'Actual upstream source' });
  instance = created.instance;
  const patch = join(temp, 'remote.patch.yml');
  const tokenFile = join(temp, 'connector-token');
  writeFileSync(tokenFile, created.connectorToken, { mode: 0o600 });
  const approvalFixture = join(temp, 'approval-fixture.mjs');
  writeFileSync(
    approvalFixture,
    `import {writeFile} from 'node:fs/promises';import {join} from 'node:path';export const inject=['approval'];export function apply(ctx){ctx.on('agent/pre-step',async({agent,messages,signal},next)=>{if(messages.some(message=>message.content.some(part=>part.type==='text'&&part.text.includes('APPROVAL_INTEGRATION')))){const outcome=await ctx.approval.request({agent,toolName:'remote-e2e-fixture',reason:'Write approved.txt in the isolated E2E workspace',signal});if(outcome!=='allowed-once')return {kind:'reject'};signal.throwIfAborted();await writeFile(join(agent.session.header.cwd,'approved.txt'),'approved through real DSH service');}return next()},{global:true})}`,
  );
  writeFileSync(
    patch,
    JSON.stringify([
      ...(live
        ? [
            {
              id: 'llm-deepseek',
              config: { apiKeyEnv: 'DEEPSEEK_API_KEY', maxTokens: 512, thinking: 'disabled' },
            },
          ]
        : []),
      { id: 'typert-loader', disabled: true },
      { id: 'modules', disabled: true },
      { id: 'client-hmr', disabled: true },
      {
        insert: [
          { id: 'approval-e2e-fixture', name: pathToFileURL(approvalFixture).href },
          {
            id: 'remote-e2e',
            name: pathToFileURL(join(root, 'packages/dsh-plugin/dist/index.js')).href,
            config: {
              relayUrl: base.replace('http', 'ws') + '/ws/connector',
              connectorTokenFile: tokenFile,
              connectorPath: join(root, 'packages/connector/src/index.ts'),
              journalPath: join(temp, 'connector', 'journal.sqlite'),
              bunPath: process.execPath,
              allowedWorkspaceRoots: [work],
            },
          },
        ],
      },
    ]),
    { mode: 0o600 },
  );
  const startHost = () => {
    child = spawn(
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
          DSH_HOME: home,
          DSH_AGENTS_HOME: join(temp, 'agents'),
          DSH_TELEMETRY_DISABLED: '1',
          DEEPSEEK_API_KEY: live ? process.env.DEEPSEEK_API_KEY : 'mock-key',
          DEEPSEEK_BASE_URL: model.baseURL,
          ALL_PROXY: '',
          all_proxy: '',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    child.stdout!.on('data', (value) => {
      logs += String(value);
    });
    child.stderr!.on('data', (value) => {
      logs += String(value);
    });
  };
  const stopHost = async () => {
    if (!child || child.exitCode !== null) return;
    const ended = new Promise<void>((resolve) => child!.once('exit', () => resolve()));
    child.kill('SIGTERM');
    await Promise.race([ended, Bun.sleep(7000)]);
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await ended;
    }
  };
  startHost();
  await until(async () => {
    const value = await request('/api/instances');
    return value.instances.find((item: any) => item.id === instance.id && item.online);
  }, 'DSH connector online');
  assertions.push('Real Node DSH source profile and Bun connector connect');
  lease = await request(`/api/instances/${instance.id}/lease`, {
    controllerId: auth.controller.id,
  });
  assertions.push('Writer lease acknowledged by Host fence');
  const a = 'remote-e2e-a',
    b = 'remote-e2e-b';
  await command('session.create', { sessionId: a, cwd: work });
  await command('session.create', { sessionId: b, cwd: work });
  const list = await command('session.list', {});
  if (![a, b].every((id) => list.items.some((row: any) => row.sessionId === id)))
    throw new Error('Sessions missing from actual DSH list');
  assertions.push('Create and list two independent real DSH sessions');
  const requestId = crypto.randomUUID();
  await command('session.prompt', {
    sessionId: a,
    requestId,
    mode: 'queue',
    content: [
      { type: 'text', text: 'Reply with exactly REAL_DSH_PIPELINE_OK, no tools or extra words.' },
    ],
  });
  await command('session.prompt', {
    sessionId: a,
    requestId: crypto.randomUUID(),
    mode: 'steer',
    content: [
      { type: 'text', text: 'Prioritize the next step and reply exactly REAL_DSH_PIPELINE_OK.' },
    ],
  });
  await command('session.prompt', {
    sessionId: b,
    requestId: crypto.randomUUID(),
    mode: 'queue',
    content: [{ type: 'text', text: 'Independent background session.' }],
  });
  const complete = await until(async () => {
    const value = await command('session.read', { sessionId: a });
    return !value.running && value.events.some((event: any) => event.type === 'assistant/message')
      ? value
      : undefined;
  }, 'real DSH assistant completion');
  if (!JSON.stringify(complete.events).includes('REAL_DSH_PIPELINE_OK'))
    throw new Error('Missing actual adapter settlement');
  if (
    !complete.events.some(
      (event: any) => event.type === 'agent/inbox/spliced' && event.data.target === 'next-step',
    )
  )
    throw new Error('No real steering inbox event');
  assertions.push('Prompt, true next-step steering, durable assistant settlement');
  await command('session.prompt', {
    sessionId: a,
    requestId,
    mode: 'queue',
    content: [
      { type: 'text', text: 'Reply with exactly REAL_DSH_PIPELINE_OK, no tools or extra words.' },
    ],
  });
  const dedup = await command('session.read', { sessionId: a });
  if (
    dedup.events.filter(
      (event: any) => event.type === 'user/message' && event.data.source?.rpcId === requestId,
    ).length !== 1
  )
    throw new Error('Prompt duplicated');
  assertions.push('Repeated requestId remains one durable user message');
  const upload = await command('attachment.upload', {
    sessionId: a,
    data: Buffer.from('attachment fixture').toString('base64'),
    name: 'fixture.txt',
  });
  if (!upload.receiptId) throw new Error('Missing actual file upload receipt');
  await command('session.prompt', {
    sessionId: a,
    requestId: crypto.randomUUID(),
    mode: 'queue',
    content: [
      { type: 'text', text: 'Read the attached file.' },
      { type: 'file', receiptId: upload.receiptId },
    ],
  });
  assertions.push('Upload and admit actual DSH staged attachment');
  const settings = await command('settings.describe', { sessionId: a });
  if (!settings.modelCatalog || !settings.projections)
    throw new Error('Missing actual model/session config');
  assertions.push('Read actual model catalog and session projections');
  await command('session.cancel', { sessionId: a });
  assertions.push('Cancel live DSH turn');
  await until(async () => {
    const value = await command('session.read', { sessionId: a });
    return !value.running ? value : undefined;
  }, 'cancel settles');
  await command('session.prompt', {
    sessionId: a,
    requestId: crypto.randomUUID(),
    mode: 'queue',
    content: [{ type: 'text', text: 'APPROVAL_INTEGRATION reject this test action.' }],
  });
  const rejected = await until(async () => {
    const value = await request(`/api/instances/${instance.id}/state`);
    return value.pendingApprovals[0];
  }, 'real DSH approval request');
  await command('session.prompt', {
    sessionId: a,
    requestId: crypto.randomUUID(),
    mode: 'queue',
    content: [{ type: 'text', text: 'QUEUED_ONE' }],
  });
  await command('session.prompt', {
    sessionId: a,
    requestId: crypto.randomUUID(),
    mode: 'queue',
    content: [{ type: 'text', text: 'QUEUED_TWO' }],
  });
  const queued = await command('session.projections', { sessionId: a });
  const pendingQueue = queued.values.inbox['next-turn'];
  if (pendingQueue.length !== 2) throw new Error('Expected actual pending turn queue');
  await command('session.queue.update', {
    sessionId: a,
    itemId: pendingQueue[0].id,
    action: { kind: 'edit', content: [{ type: 'text', text: 'EDITED_QUEUE' }] },
  });
  await command('session.queue.update', {
    sessionId: a,
    itemId: pendingQueue[0].id,
    action: { kind: 'steer' },
  });
  await command('session.queue.update', {
    sessionId: a,
    itemId: pendingQueue[1].id,
    action: { kind: 'remove' },
  });
  const changedQueue = await command('session.projections', { sessionId: a });
  if (
    changedQueue.values.inbox['next-turn'].length !== 0 ||
    !JSON.stringify(changedQueue.values.inbox['next-step']).includes('EDITED_QUEUE')
  )
    throw new Error('Real queue mutations not applied');
  assertions.push('Edit, steer and remove actual pending DSH inbox entries');
  const imageRequestId = crypto.randomUUID();
  const imageData =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
  await command('session.prompt', {
    sessionId: a,
    requestId: imageRequestId,
    mode: 'queue',
    content: [{ type: 'image', mediaType: 'image/png', data: imageData, name: 'pixel.png' }],
  });
  const imageQueue = await command('session.projections', { sessionId: a });
  const imageMessage = imageQueue.values.inbox['next-turn'].find(
    (message: any) => message.source?.rpcId === imageRequestId,
  );
  const imageRef = imageMessage?.content.find((part: any) => part.type === 'image')?.attachment;
  if (!imageRef?.attachmentId) throw new Error('Image admission did not store durable reference');
  const downloaded = await command('attachment.read', {
    sessionId: a,
    attachmentId: imageRef.attachmentId,
  });
  if (!downloaded.data || downloaded.attachment.width !== 1 || downloaded.attachment.height !== 1)
    throw new Error('Image roundtrip failed');
  await command('session.queue.update', {
    sessionId: a,
    itemId: imageMessage.id,
    action: { kind: 'remove' },
  });
  assertions.push('Admit image into real DSH inbox and retrieve session-authorized stored pixels');
  await command('approval.respond', {
    approvalId: rejected.approvalId,
    bootId: rejected.bootId,
    sessionId: rejected.sessionId,
    presentationHash: rejected.presentationHash,
    outcome: 'rejected',
  });
  await until(async () => {
    const value = await command('session.read', { sessionId: a });
    return !value.running ? value : undefined;
  }, 'rejection settles');
  if (existsSync(join(work, 'approved.txt')))
    throw new Error('Rejected approval performed side effect');
  await command('session.prompt', {
    sessionId: a,
    requestId: crypto.randomUUID(),
    mode: 'queue',
    content: [{ type: 'text', text: 'APPROVAL_INTEGRATION allow this isolated test action.' }],
  });
  const accepted = await until(async () => {
    const value = await request(`/api/instances/${instance.id}/state`);
    return value.pendingApprovals[0];
  }, 'second real approval');
  await command('approval.respond', {
    approvalId: accepted.approvalId,
    bootId: accepted.bootId,
    sessionId: accepted.sessionId,
    presentationHash: accepted.presentationHash,
    outcome: 'allowed-once',
  });
  const settled = await until(async () => {
    const value = await command('session.read', { sessionId: a });
    return !value.running ? value : undefined;
  }, 'approved turn settles');
  if (readFileSync(join(work, 'approved.txt'), 'utf8') !== 'approved through real DSH service')
    throw new Error('Approved side effect missing');
  if (
    !settled.events.some(
      (event: any) => event.type === 'approval/decided' && event.data.outcome === 'allowed-once',
    )
  )
    throw new Error('Missing durable approval decision');
  assertions.push(
    'Real DSH approval waterfall rejects without side effect and allows exactly once with durable audit',
  );
  const configBefore = await command('settings.describe', { sessionId: a });
  const selection = configBefore.modelCatalog.default;
  await command('model.select', {
    sessionId: a,
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
  });
  const configAfter = await command('settings.describe', { sessionId: a });
  if (configAfter.projections.values.modelSelection.next.model !== selection.model)
    throw new Error('Model selection not persisted');
  assertions.push('Select actual DSH model and verify durable next-request configuration');
  await command('settings.update', {
    sessionId: a,
    permissionPreset: 'read-only',
    expectedRevision: configAfter.projections.asOfSeq,
  });
  const permissions = await command('settings.describe', { sessionId: a });
  if (permissions.projections.values.permissions.currentValue !== 'read-only')
    throw new Error('Session permission update did not apply');
  await command('settings.update', {
    sessionId: a,
    permissionPreset: 'workspace-write',
    expectedRevision: permissions.projections.asOfSeq,
  });
  assertions.push(
    'Revise actual session permission preset with optimistic revision and verify projection',
  );
  await stopHost();
  startHost();
  await until(async () => {
    const value = await request('/api/instances');
    return value.instances.find((item: any) => item.id === instance.id && item.online);
  }, 'connector restart');
  lease = await request(`/api/instances/${instance.id}/lease`, {
    controllerId: auth.controller.id,
  });
  const cold = await command('session.read', { sessionId: a });
  if (cold.agentAvailable || cold.running) throw new Error('Passive cold read activated session');
  if (!cold.events.some((event: any) => event.type === 'assistant/message'))
    throw new Error('Durable history missing after restart');
  await command('session.resume', { sessionId: a });
  const resumed = await command('session.read', { sessionId: a });
  if (!resumed.agentAvailable) throw new Error('Explicit resume did not attach Agent');
  assertions.push(
    'Restart DSH, recover persisted history without activation, then explicitly resume',
  );
  const evidence = {
    kind: live ? 'real-dsh-pipeline-live-provider' : 'real-dsh-pipeline-with-local-model',
    upstreamCommit: '5badb15009ae1756c3afe0ae0cef1faafc290ccc',
    passed: assertions,
    providerRequests: live ? null : model.requests.length,
    realProvider: live,
    sourceOnlyOmissions: ['typert-loader generated artifacts', 'bundled DSH browser assets'],
    temp,
  };
  writeFileSync(
    join(root, 'docs', live ? 'live-provider-result.json' : 'runtime-smoke-result.json'),
    JSON.stringify(evidence, null, 2),
  );
  console.log(JSON.stringify(evidence, null, 2));
  if (process.env.DSH_E2E_KEEP_RUNNING === '1') {
    console.log(
      'FIXTURE_READY ' +
        JSON.stringify({
          base,
          email: 'real-runtime@example.invalid',
          password: 'local-fixture-password-only',
          instanceId: instance.id,
          workspace: work,
        }),
    );
    await new Promise<void>((resolve) => {
      process.once('SIGTERM', resolve);
      process.once('SIGINT', resolve);
    });
  }
} finally {
  if (child) {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise<void>((resolve) => child!.once('exit', () => resolve())),
      Bun.sleep(7000),
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  await model.close();
  await relay.stop();
  writeFileSync(join(temp, 'host.log'), logs);
}

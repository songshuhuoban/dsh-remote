import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DshAdapter } from '../src/adapter.ts';
import type { DshHostContext, SessionEvent } from '../src/host.ts';
const root = mkdtempSync(join(tmpdir(), 'dsh-adapter-')),
  outside = mkdtempSync(join(tmpdir(), 'dsh-outside-'));
function harness() {
  const listeners = new Map<string, Function>();
  let resumes = 0,
    prompts = 0;
  const agent = {
    id: 'session',
    status: 'idle' as const,
    session: {
      id: 'session',
      header: { id: 'session', cwd: root },
      snapshotEvents: () => [] as SessionEvent[],
    },
  };
  const ctx = {
    sessionController: {
      list: async () => ({
        items: [
          { sessionId: 'session', cwd: root },
          { sessionId: 'other', cwd: outside },
        ],
      }),
      inspect: async () => ({ meta: agent.session.header, events: [], inheritedEventCount: 0 }),
      page: async () => ({ records: [], hasMore: false }),
      projections: async () => ({ asOfSeq: 0, values: {} }),
      resolveAgent: async () => {
        resumes++;
        return { agent };
      },
      prompt: async () => {
        prompts++;
        return { accepted: true };
      },
      cancel: () => ({ accepted: true }),
    },
    agents: { get: () => undefined },
    fileUploads: {},
    get: () => undefined,
    on: (name: string, listener: Function) => {
      listeners.set(name, listener);
      return () => {
        listeners.delete(name);
      };
    },
    logger: { warn: () => {}, error: () => {} },
  } as unknown as DshHostContext;
  const events: any[] = [];
  const adapter = new DshAdapter(ctx, (event) => events.push(event), {
    allowedWorkspaceRoots: [root],
    approvalTimeoutMs: 1000,
  });
  return {
    ctx,
    agent,
    events,
    listeners,
    adapter,
    get resumes() {
      return resumes;
    },
    get prompts() {
      return prompts;
    },
  };
}
test('cold read and list never activate Agents and hide unauthorized roots', async () => {
  const h = harness();
  expect(await h.adapter.execute('session.list', {})).toEqual({
    items: [{ sessionId: 'session', cwd: root }],
  });
  const detail = (await h.adapter.execute('session.read', { sessionId: 'session' })) as any;
  expect(detail.pendingApprovals).toEqual([]);
  expect(h.resumes).toBe(0);
  h.adapter.dispose();
});
test('fence revoked during async inspection prevents model prompt admission', async () => {
  const h = harness();
  let release: () => void = () => {},
    admitted = true;
  const held = new Promise<void>((r) => {
    release = r;
  });
  h.ctx.sessionController.inspect = async () => {
    await held;
    return { meta: h.agent.session.header, events: [], inheritedEventCount: 0 };
  };
  const running = h.adapter.execute(
    'session.prompt',
    {
      sessionId: 'session',
      requestId: 'request',
      mode: 'queue',
      content: [{ type: 'text', text: 'hello' }],
    },
    () => {
      if (!admitted) throw new Error('stale fence');
    },
  );
  admitted = false;
  release();
  await expect(running).rejects.toThrow('stale fence');
  expect(h.prompts).toBe(0);
  h.adapter.dispose();
});
test('approval binds exact live process, session and displayed payload', async () => {
  const h = harness();
  h.adapter.setAvailable(true);
  const controller = new AbortController();
  const answer = h.listeners.get('approval/request')!(
    { agent: h.agent, toolName: 'test-tool', reason: 'test reason', signal: controller.signal },
    async () => 'unavailable',
  );
  const pending = h.events.find((e) => e.kind === 'approval.requested').payload;
  await expect(
    h.adapter.execute('approval.respond', {
      ...pending,
      toolName: undefined,
      outcome: 'allowed-once',
    }),
  ).rejects.toThrow();
  await expect(
    h.adapter.execute('approval.respond', {
      approvalId: pending.approvalId,
      bootId: pending.bootId,
      sessionId: 'foreign',
      presentationHash: pending.presentationHash,
      outcome: 'allowed-once',
    }),
  ).rejects.toThrow('another session');
  await h.adapter.execute('approval.respond', {
    approvalId: pending.approvalId,
    bootId: pending.bootId,
    sessionId: pending.sessionId,
    presentationHash: pending.presentationHash,
    outcome: 'allowed-once',
  });
  expect(await answer).toBe('allowed-once');
  await expect(
    h.adapter.execute('approval.respond', {
      approvalId: pending.approvalId,
      bootId: pending.bootId,
      sessionId: pending.sessionId,
      presentationHash: pending.presentationHash,
      outcome: 'allowed-once',
    }),
  ).rejects.toThrow('no longer pending');
  h.adapter.dispose();
});
test('aborted approval cannot be answered and unload fails pending requests closed', async () => {
  const h = harness();
  h.adapter.setAvailable(true);
  const controller = new AbortController();
  const first = h.listeners.get('approval/request')!(
    { agent: h.agent, toolName: 'first', signal: controller.signal },
    async () => 'unavailable',
  );
  controller.abort();
  expect(await first).toBe('cancelled');
  const second = h.listeners.get('approval/request')!(
    { agent: h.agent, toolName: 'second' },
    async () => 'unavailable',
  );
  h.adapter.dispose();
  expect(await second).toBe('unavailable');
});
test('reject nested prompt fields and foreign workspace without DSH mutation', async () => {
  const h = harness();
  await expect(
    h.adapter.execute('session.prompt', {
      sessionId: 'session',
      requestId: 'r',
      mode: 'queue',
      content: [{ type: 'text', text: 'hello', source: { kind: 'system' } }],
    }),
  ).rejects.toThrow('Unsupported text part field');
  await expect(
    h.adapter.execute('session.create', { sessionId: 'new', cwd: outside }),
  ).rejects.toThrow('outside configured roots');
  expect(h.prompts).toBe(0);
  h.adapter.dispose();
});

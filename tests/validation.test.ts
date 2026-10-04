import { describe, expect, test } from 'bun:test';
import { ACTIONS, type Action } from '../packages/protocol/src/index.ts';
import { validateCommand, WIRE_LIMITS } from '../packages/protocol/src/validation.ts';
const valid: Record<Action, Record<string, unknown>> = {
  capabilities: {},
  'session.list': {},
  'session.read': { sessionId: 's' },
  'session.projections': { sessionId: 's' },
  'session.page': { address: { kind: 'session', sessionId: 's' }, throughSeq: -1 },
  'session.create': { sessionId: 'stable-create-id', cwd: '/workspace' },
  'session.prompt': {
    sessionId: 's',
    requestId: 'stable-request-id',
    mode: 'queue',
    content: [{ type: 'text', text: 'hello' }],
  },
  'session.cancel': { sessionId: 's' },
  'session.resume': { sessionId: 's' },
  'session.queue.update': { sessionId: 's', itemId: 'item', action: { kind: 'remove' } },
  'model.select': { sessionId: 's', provider: 'fixture', model: 'model', reasoningEffort: 'high' },
  'attachment.upload': { sessionId: 's', data: 'AA==', name: '试验 file.txt' },
  'attachment.read': { sessionId: 's', attachmentId: 'attachment-id' },
  'approval.respond': {
    sessionId: 's',
    approvalId: 'request',
    bootId: 'boot',
    presentationHash: 'a'.repeat(64),
    outcome: 'rejected',
  },
  'settings.describe': {},
  'settings.update': { sessionId: 's', permissionPreset: 'read-only', expectedRevision: 1 },
};
const copy = (value: unknown) => JSON.parse(JSON.stringify(value));
const accepts = (action: unknown, args: unknown) =>
  expect(validateCommand(action, args)).toBeNull();
const rejects = (action: unknown, args: unknown) =>
  expect(validateCommand(action, args)).toBeString();
const prompt = (parts: unknown) => ({ ...valid['session.prompt'], content: parts });

describe('Shared relay/Host command wire validation (unit tests, not DSH E2E)', () => {
  for (const action of ACTIONS) {
    test(`${action}: accepted source-shaped arguments`, () => accepts(action, copy(valid[action])));
    test(`${action}: unknown authority fields rejected`, () =>
      rejects(action, { ...copy(valid[action]), userId: 'other-owner' }));
    test(`${action}: nonobject roots rejected`, () => {
      for (const value of [null, [], 0, 'x', true]) rejects(action, value);
    });
  }
  test('no unknown actions or unsafe root object shapes', () => {
    for (const action of ['exec', '__proto__', null, 1]) rejects(action, {});
    rejects('session.list', new Date());
    rejects('session.read', Object.create({ sessionId: 's' }));
  });
  test('required scalar/session/create identities are enforced', () => {
    for (const action of ACTIONS) {
      if ('sessionId' in valid[action]) {
        const args = copy(valid[action]);
        delete args.sessionId;
        rejects(action, args);
      }
    }
    for (const value of ['', ' ', 1, null, 'x'.repeat(4097), 's\0'])
      rejects('session.read', { sessionId: value });
    rejects('session.create', { sessionId: 's', cwd: '/a', workspaceId: 'w' });
    accepts('session.create', { sessionId: 's', workspaceId: 'w' });
    accepts('settings.describe', { sessionId: 's' });
  });
  test('no prototype properties, accessors, cyclic or excessive-depth trees', () => {
    for (const key of ['__proto__', 'constructor', 'prototype'])
      rejects('session.list', JSON.parse(`{"${key}":{}}`));
    const cyclic: any = {};
    cyclic.self = cyclic;
    rejects('session.list', cyclic);
    let getterCalled = false;
    const getter = {};
    Object.defineProperty(getter, 'sessionId', {
      enumerable: true,
      get() {
        getterCalled = true;
        return 's';
      },
    });
    rejects('session.read', getter);
    expect(getterCalled).toBe(false);
    let deep: unknown = 'leaf';
    for (let i = 0; i < 20; i++) deep = { nested: deep };
    rejects('session.list', deep);
    rejects('session.list', { many: Array(20_001).fill(null) });
    for (const value of [NaN, Infinity, -0, undefined, () => {}, 1n])
      rejects('settings.update', { ...valid['settings.update'], expectedRevision: value });
  });
  test('queue and steer modes preserve exact prompt shape', () => {
    accepts('session.prompt', {
      ...valid['session.prompt'],
      mode: 'steer',
      clientTimeZone: 'Asia/Shanghai',
    });
    for (const mode of ['interrupt', 'priority', '', 0])
      rejects('session.prompt', { ...valid['session.prompt'], mode });
    for (const timezone of ['PST', 'not/a-zone', '', 42])
      rejects('session.prompt', { ...valid['session.prompt'], clientTimeZone: timezone });
    accepts('session.prompt', { ...valid['session.prompt'], clientTimeZone: 'UTC' });
  });
  test('content types and fields are strict; whitespace-only input fails', () => {
    for (const parts of [
      undefined,
      [],
      [null],
      [{}],
      [{ type: 'tool', text: 'x' }],
      [{ type: 'text', text: 1 }],
      [{ type: 'text', text: 'x', role: 'system' }],
      [{ type: 'text', text: ' \n' }],
    ])
      rejects('session.prompt', prompt(parts));
    accepts(
      'session.prompt',
      prompt([
        { type: 'text', text: '' },
        { type: 'file', receiptId: 'r' },
      ]),
    );
    for (const receipt of ['', null, 3])
      rejects('session.prompt', prompt([{ type: 'file', receiptId: receipt }]));
    rejects('session.prompt', prompt([{ type: 'file', receiptId: 'r', path: '/secret' }]));
  });
  test('content/text/attachment aggregate limits', () => {
    accepts(
      'session.prompt',
      prompt([{ type: 'text', text: 'x'.repeat(WIRE_LIMITS.textCharacters) }]),
    );
    rejects(
      'session.prompt',
      prompt([
        { type: 'text', text: 'x'.repeat(WIRE_LIMITS.textCharacters) },
        { type: 'text', text: 'x' },
      ]),
    );
    rejects(
      'session.prompt',
      prompt(Array.from({ length: 33 }, () => ({ type: 'text', text: 'x' }))),
    );
    accepts(
      'session.prompt',
      prompt(Array.from({ length: 4 }, () => ({ type: 'file', receiptId: 'r' }))),
    );
    rejects(
      'session.prompt',
      prompt(Array.from({ length: 5 }, () => ({ type: 'file', receiptId: 'r' }))),
    );
  });
  test('canonical base64 including padding bits and empty files', () => {
    for (const data of ['', 'AA==', 'AAA=', 'AAAA', 'SGVsbG8='])
      accepts('attachment.upload', { sessionId: 's', data });
    for (const data of [
      'A',
      'AA',
      'AAA',
      'A===',
      'AA=A',
      'AB==',
      'AAB=',
      'AA==\n',
      'AA-_',
      '====',
      null,
      4,
    ])
      rejects('attachment.upload', { sessionId: 's', data });
    rejects('attachment.upload', {
      sessionId: 's',
      data: 'A'.repeat(WIRE_LIMITS.encodedAttachmentCharacters + 4),
    });
    const boundary = 'A'.repeat(WIRE_LIMITS.encodedAttachmentCharacters);
    accepts('attachment.upload', { sessionId: 's', data: boundary });
  });
  test('image media/bytes/name shape is strict', () => {
    for (const mediaType of ['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
      accepts(
        'session.prompt',
        prompt([{ type: 'image', mediaType, data: 'AA==', name: 'photo.png' }]),
      );
    for (const part of [
      { type: 'image', mediaType: 'image/png', data: '' },
      { type: 'image', mediaType: 'image/svg+xml', data: 'AA==' },
      { type: 'image', data: 'AA==' },
      { type: 'image', mediaType: 'image/png' },
      { type: 'image', mediaType: 'image/png', data: 'AA==', url: 'https://example.test' },
    ])
      rejects('session.prompt', prompt([part]));
  });
  test('display filenames cannot select paths or controls', () => {
    for (const name of [
      '../secret',
      '/tmp/x',
      'a\\b',
      'C:secret',
      '.',
      '..',
      'x\0',
      'x\n',
      'x'.repeat(256),
    ])
      rejects('attachment.upload', { sessionId: 's', data: '', name });
    accepts('attachment.upload', { sessionId: 's', data: '', name: '中文 report 01.pdf' });
  });
  test('source QueueAction variants; edits text-only and nonempty', () => {
    for (const action of [
      { kind: 'remove' },
      { kind: 'steer' },
      { kind: 'edit', content: [{ type: 'text', text: 'new text' }] },
    ])
      accepts('session.queue.update', { sessionId: 's', itemId: 'i', action });
    for (const action of [
      'remove',
      { kind: 'queue' },
      { kind: 'steer', content: [] },
      { kind: 'edit' },
      { kind: 'edit', content: [] },
      { kind: 'edit', content: [{ type: 'image', mediaType: 'image/png', data: 'AA==' }] },
      { kind: 'edit', content: [{ type: 'text', text: ' ' }] },
    ])
      rejects('session.queue.update', { sessionId: 's', itemId: 'i', action });
  });
  test('ordinary and subagent addresses require exact fields', () => {
    accepts('session.page', {
      address: { kind: 'subagent', parentSessionId: 'p', childSessionId: 'c', mode: 'continuable' },
      throughSeq: 0,
    });
    for (const address of [
      { kind: 'session' },
      { kind: 'session', sessionId: 's', childSessionId: 'c' },
      { kind: 'subagent', childSessionId: 'c', mode: 'unknown' },
      { kind: 'subagent', parentSessionId: 'p', childSessionId: 'c', mode: 'anything' },
      { kind: 'session', sessionId: 1 },
    ])
      rejects('session.page', { address, throughSeq: 0 });
  });
  test('history bounds exactly match upstream positive windows and -1 empty cursor', () => {
    const page = { address: { kind: 'session', sessionId: 's' }, throughSeq: -1 };
    accepts('session.page', page);
    for (const value of [undefined, -2, -0, 0.5, NaN, Number.MAX_SAFE_INTEGER + 1])
      rejects('session.page', { ...page, throughSeq: value });
    for (const maxMessages of [0, -1, 501, 1.5]) rejects('session.page', { ...page, maxMessages });
    accepts('session.page', {
      ...page,
      beforeSeq: 0,
      maxMessages: 500,
      turnWindow: { minMessages: 500, minTurns: 1 },
    });
    for (const window of [
      {},
      { minMessages: 1 },
      { minTurns: 1 },
      { minMessages: 0, minTurns: 1 },
      { minMessages: 1, minTurns: 0 },
      { minMessages: 51, minTurns: 1 },
      { minMessages: 1, minTurns: 1, extra: 1 },
    ])
      rejects('session.page', { ...page, turnWindow: window });
  });
  test('approval response requires exact live identity and digest', () => {
    for (const key of ['approvalId', 'bootId', 'sessionId', 'presentationHash', 'outcome']) {
      const args = copy(valid['approval.respond']);
      delete args[key];
      rejects('approval.respond', args);
    }
    for (const outcome of ['allowed-always', 'cancelled', 'unavailable', true])
      rejects('approval.respond', { ...valid['approval.respond'], outcome });
    for (const hash of ['abc', 'A'.repeat(64), 'g'.repeat(64), null])
      rejects('approval.respond', { ...valid['approval.respond'], presentationHash: hash });
    accepts('approval.respond', { ...valid['approval.respond'], outcome: 'allowed-once' });
  });
  test('one revision-checked setting, never arbitrary namespace update', () => {
    accepts('settings.update', { sessionId: 's', agentPreset: 'fixture', expectedRevision: -1 });
    for (const args of [
      { sessionId: 's', expectedRevision: 0 },
      { sessionId: 's', permissionPreset: 'read-only' },
      { sessionId: 's', permissionPreset: 'read-only', agentPreset: 'x', expectedRevision: 0 },
      { sessionId: 's', permissionPreset: 'read-only', expectedRevision: -2 },
      {
        sessionId: 's',
        expectedRevision: 0,
        namespace: 'credentials',
        patch: { apiKey: 'sentinel' },
      },
    ])
      rejects('settings.update', args);
  });
});

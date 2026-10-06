/** Runtime wire validation shared by the relay and the in-process DSH adapter.
 * Shapes follow DSH 5badb150: SessionPromptRequest, QueueAction, SessionAddress,
 * SessionPageRequest and canonical attachment admission. No Host API is invoked.
 */
import { isAction, MAX_FRAME_BYTES, type Action } from './index.ts';

export const WIRE_LIMITS = Object.freeze({
  depth: 16,
  nodes: 20_000,
  textCharacters: 100_000,
  contentParts: 32,
  attachments: 4,
  encodedAttachmentCharacters: 6 * 1024 * 1024,
  nameCharacters: 255,
  scalarCharacters: 4096,
  pageMessages: 500,
  repositories: 8,
});

const fields: Record<Action, readonly string[]> = {
  capabilities: [],
  'repository.inspect': ['path', 'expectedRemoteUrl'],
  'session.list': [],
  'session.read': ['sessionId'],
  'session.projections': ['sessionId'],
  'session.page': ['address', 'throughSeq', 'beforeSeq', 'maxMessages', 'turnWindow'],
  'session.create': ['sessionId', 'cwd', 'workspaceId', 'agentPreset'],
  'session.prompt': [
    'sessionId',
    'requestId',
    'mode',
    'content',
    'clientTimeZone',
    'repositoryContext',
  ],
  'session.cancel': ['sessionId'],
  'session.resume': ['sessionId'],
  'session.queue.update': ['sessionId', 'itemId', 'action'],
  'model.select': ['sessionId', 'provider', 'model', 'reasoningEffort'],
  'attachment.upload': ['sessionId', 'data', 'name'],
  'attachment.read': ['sessionId', 'attachmentId'],
  'approval.respond': ['sessionId', 'approvalId', 'bootId', 'presentationHash', 'outcome'],
  'settings.describe': ['sessionId'],
  'settings.update': ['sessionId', 'permissionPreset', 'agentPreset', 'expectedRevision'],
  'workspace.list': [],
  'workspace.browse': ['path'],
};
class InvalidArguments extends Error {}
function fail(message: string): never {
  throw new InvalidArguments(message);
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) fail(`Unsupported ${label} field: ${key}`);
}
function text(
  value: unknown,
  label: string,
  max: number = WIRE_LIMITS.scalarCharacters,
): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) {
    fail(`${label} must be a nonempty string of at most ${max} characters without NUL`);
  }
}
function integer(
  value: unknown,
  label: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): asserts value is number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    value < minimum ||
    value > maximum
  ) {
    fail(`${label} must be a safe integer from ${minimum} through ${maximum}`);
  }
}
function displayName(value: unknown, label: string): void {
  text(value, label, WIRE_LIMITS.nameCharacters);
  if (/[\\/\u0000-\u001f\u007f:]/.test(value) || value === '.' || value === '..') {
    fail(`${label} must be a display filename, not a path or control string`);
  }
}
function sextet(code: number): number {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 71;
  if (code >= 48 && code <= 57) return code + 4;
  return code === 43 ? 62 : code === 47 ? 63 : -1;
}
/** Canonical padded base64, including zero pad bits. Avoid decoding a second copy. */
function base64(value: unknown, label: string, allowEmpty: boolean): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length > WIRE_LIMITS.encodedAttachmentCharacters ||
    value.length % 4 !== 0 ||
    (!allowEmpty && value.length === 0)
  ) {
    fail(`${label} must be canonical base64 within the encoded attachment limit`);
  }
  if (value.length === 0) return;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const end = value.length - padding;
  for (let i = 0; i < end; i++)
    if (sextet(value.charCodeAt(i)) < 0) fail(`${label} must be canonical base64`);
  const last = sextet(value.charCodeAt(end - 1));
  if ((padding === 2 && (last & 15) !== 0) || (padding === 1 && (last & 3) !== 0))
    fail(`${label} has noncanonical base64 pad bits`);
}
/** Bound and validate the JSON tree before recursive hashing or action decoding. */
function boundedJson(root: unknown): void {
  const stack: Array<[unknown, number]> = [[root, 0]];
  const seen = new WeakSet<object>();
  let visited = 0,
    characters = 0;
  while (stack.length) {
    const [value, depth] = stack.pop()!;
    if (++visited > WIRE_LIMITS.nodes || depth > WIRE_LIMITS.depth)
      fail('Arguments are too large or deeply nested');
    if (value === null || typeof value === 'boolean') continue;
    if (typeof value === 'string') {
      characters += value.length;
      if (characters > MAX_FRAME_BYTES) fail('Arguments exceed the aggregate character limit');
      continue;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || Object.is(value, -0))
        fail('Arguments contain a non-JSON number');
      continue;
    }
    if (typeof value !== 'object') fail('Arguments must contain JSON values only');
    if (seen.has(value)) fail('Arguments contain cyclic or shared object references');
    seen.add(value);
    const prototype = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null)
      fail('Arguments must contain plain JSON objects');
    for (const key of Object.keys(value)) {
      if (key === '__proto__' || key === 'prototype' || key === 'constructor')
        fail('Arguments contain a reserved property');
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!('value' in descriptor)) fail('Arguments cannot contain accessor properties');
      if (visited + stack.length >= WIRE_LIMITS.nodes) fail('Arguments contain too many values');
      stack.push([descriptor.value, depth + 1]);
    }
  }
}
function content(value: unknown, textOnly: boolean): void {
  if (!Array.isArray(value) || value.length < 1 || value.length > WIRE_LIMITS.contentParts)
    fail('content needs 1–32 parts');
  let meaningful = false,
    characters = 0,
    attachments = 0,
    encoded = 0;
  for (const raw of value) {
    const part = object(raw, 'content part');
    if (part.type === 'text') {
      exact(part, ['type', 'text'], 'text part');
      if (typeof part.text !== 'string') fail('text part text must be a string');
      characters += part.text.length;
      if (characters > WIRE_LIMITS.textCharacters)
        fail('Message text exceeds 100,000 characters in aggregate');
      meaningful ||= part.text.trim().length > 0;
    } else if (part.type === 'image' && !textOnly) {
      exact(part, ['type', 'data', 'mediaType', 'name'], 'image part');
      if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(String(part.mediaType)))
        fail('Unsupported image mediaType');
      base64(part.data, 'image data', false);
      if (part.name !== undefined) displayName(part.name, 'image name');
      attachments++;
      encoded += part.data.length;
      meaningful = true;
    } else if (part.type === 'file' && !textOnly) {
      exact(part, ['type', 'receiptId'], 'file part');
      text(part.receiptId, 'receiptId');
      attachments++;
      meaningful = true;
    } else fail(textOnly ? 'Queue edits accept text parts only' : 'Unsupported content part type');
  }
  if (!meaningful) fail('content must contain non-whitespace text or an attachment');
  if (attachments > WIRE_LIMITS.attachments || encoded > WIRE_LIMITS.encodedAttachmentCharacters)
    fail('Message exceeds attachment count or aggregate encoded-byte limit');
}
function page(args: Record<string, unknown>): void {
  const address = object(args.address, 'address');
  if (address.kind === 'session') {
    exact(address, ['kind', 'sessionId'], 'session address');
    text(address.sessionId, 'address.sessionId');
  } else if (address.kind === 'subagent') {
    exact(address, ['kind', 'parentSessionId', 'childSessionId', 'mode'], 'subagent address');
    text(address.parentSessionId, 'address.parentSessionId');
    text(address.childSessionId, 'address.childSessionId');
    if (!['one-shot', 'continuable', 'unknown'].includes(String(address.mode)))
      fail('Invalid subagent address mode');
  } else fail('address.kind must be session or subagent');
  integer(args.throughSeq, 'throughSeq', -1);
  if (args.beforeSeq !== undefined) integer(args.beforeSeq, 'beforeSeq', 0);
  if (args.maxMessages !== undefined)
    integer(args.maxMessages, 'maxMessages', 1, WIRE_LIMITS.pageMessages);
  if (args.turnWindow !== undefined) {
    const window = object(args.turnWindow, 'turnWindow');
    exact(window, ['minMessages', 'minTurns'], 'turnWindow');
    integer(window.minMessages, 'turnWindow.minMessages', 1, Number(args.maxMessages ?? 50));
    integer(window.minTurns, 'turnWindow.minTurns', 1);
  }
}
function repositoryPath(value: unknown): void {
  text(value, 'repository path');
  if (
    /[\u0000-\u001f\u007f]/.test(value) ||
    !value.startsWith('/') ||
    value.split('/').includes('..')
  )
    fail('repository path must be an absolute path without traversal or controls');
}
function repositoryUrl(value: unknown): void {
  text(value, 'expectedRemoteUrl', 256);
  if (
    !/^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(value) ||
    ['.', '..'].includes(value.split('/').at(-1)!)
  )
    fail('expectedRemoteUrl must be a canonical credential-free GitHub HTTPS URL');
}
function repositories(value: unknown): void {
  if (!Array.isArray(value) || value.length < 1 || value.length > WIRE_LIMITS.repositories)
    fail('repositoryContext needs 1–8 references');
  const ids = new Set<string>();
  for (const raw of value) {
    const entry = object(raw, 'repository context');
    exact(entry, ['referenceId', 'path', 'expectedRemoteUrl'], 'repository context');
    text(entry.referenceId, 'referenceId', 128);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(entry.referenceId) || ids.has(entry.referenceId))
      fail('Repository reference IDs must be unique safe identifiers');
    ids.add(entry.referenceId);
    repositoryPath(entry.path);
    repositoryUrl(entry.expectedRemoteUrl);
  }
}
/** Returns a safe validation message, or null. Both relay and adapter must call it. */
export function validateCommand(action: unknown, raw: unknown): string | null {
  try {
    if (!isAction(action)) fail('Unknown command action');
    boundedJson(raw);
    const args = object(raw, 'args');
    exact(args, fields[action], 'argument');
    for (const key of [
      'sessionId',
      'cwd',
      'workspaceId',
      'agentPreset',
      'provider',
      'model',
      'reasoningEffort',
      'permissionPreset',
      'requestId',
      'itemId',
      'clientTimeZone',
    ]) {
      if (args[key] !== undefined) text(args[key], key);
    }
    if (fields[action].includes('sessionId') && action !== 'settings.describe')
      text(args.sessionId, 'sessionId');
    switch (action) {
      case 'repository.inspect':
        repositoryPath(args.path);
        repositoryUrl(args.expectedRemoteUrl);
        break;
      case 'session.create':
        if (args.cwd !== undefined && args.workspaceId !== undefined)
          fail('create accepts cwd or workspaceId, not both');
        break;
      case 'session.prompt':
        text(args.requestId, 'requestId');
        if (args.mode !== 'queue' && args.mode !== 'steer') fail('mode must be queue or steer');
        content(args.content, false);
        if (args.repositoryContext !== undefined) repositories(args.repositoryContext);
        if (args.clientTimeZone !== undefined) {
          const zone = args.clientTimeZone as string;
          if (zone !== 'UTC' && !zone.includes('/'))
            fail('clientTimeZone must be UTC or an IANA Area/Location');
          try {
            new Intl.DateTimeFormat('en', { timeZone: zone });
          } catch {
            fail('Invalid clientTimeZone');
          }
        }
        break;
      case 'session.queue.update': {
        text(args.itemId, 'itemId');
        const update = object(args.action, 'queue action');
        if (update.kind === 'edit') {
          exact(update, ['kind', 'content'], 'queue edit');
          content(update.content, true);
        } else if (update.kind === 'remove' || update.kind === 'steer')
          exact(update, ['kind'], 'queue action');
        else fail('queue action kind must be edit, remove or steer');
        break;
      }
      case 'model.select':
        text(args.provider, 'provider');
        text(args.model, 'model');
        break;
      case 'attachment.read':
        text(args.attachmentId, 'attachmentId');
        break;
      case 'attachment.upload':
        base64(args.data, 'upload data', true);
        if (args.name !== undefined) displayName(args.name, 'upload name');
        break;
      case 'approval.respond':
        text(args.approvalId, 'approvalId');
        text(args.bootId, 'bootId');
        if (
          typeof args.presentationHash !== 'string' ||
          !/^[a-f0-9]{64}$/.test(args.presentationHash)
        )
          fail('presentationHash must be a SHA-256 hex digest');
        if (args.outcome !== 'allowed-once' && args.outcome !== 'rejected')
          fail('Approval outcome must be allowed-once or rejected');
        break;
      case 'settings.update':
        integer(args.expectedRevision, 'expectedRevision', -1);
        if ((args.permissionPreset !== undefined) === (args.agentPreset !== undefined))
          fail('Change exactly one permission or agent preset');
        break;
      case 'session.page':
        page(args);
        break;
      case 'workspace.browse':
        // Absent: the starting places. The Host decides what may be listed.
        if (args.path !== undefined) {
          text(args.path, 'path', 4096);
          if (/[\x00-\x1f]/.test(args.path)) fail('path must not contain control characters');
        }
        break;
    }
    return null;
  } catch (error) {
    if (error instanceof InvalidArguments) return error.message;
    return 'Invalid command arguments';
  }
}

import { describe, expect, it } from 'vitest';
import {
  contentText,
  eventMessage,
  historyEvents,
  mergeEvents,
  sessionLabel,
  sessionsFrom,
  toolCallForApproval,
} from './session';
import { leaseActive, type RemoteEvent } from './api';
describe('actual DSH wire presentation', () => {
  it('reads only valid session rows from the items envelope', () =>
    expect(sessionsFrom({ items: [{ sessionId: 's1', running: false }, {}] })).toEqual([
      { sessionId: 's1', running: false },
    ]));
  it('extracts nested assistant content and direct user content', () => {
    expect(
      eventMessage({
        type: 'assistant/message',
        seq: 1,
        data: { message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] } },
      }),
    ).toEqual({ role: 'DSH', text: 'Hello' });
    expect(
      eventMessage({
        type: 'user/message',
        seq: 2,
        data: { content: [{ type: 'text', text: '世界' }] },
      }),
    ).toEqual({ role: '你', text: '世界' });
  });
  it('does not treat transient frames as durable conversation', () =>
    expect(eventMessage({ type: 'step/start', seq: 1, data: {} })).toBeNull());
  it('merges wrapped events only for the selected session, deduplicated by sequence', () => {
    const history = [{ type: 'user/message', seq: 1, data: { content: 'hello' } }];
    const make = (seq: number, sid: string, eventSeq: number): RemoteEvent => ({
      v: 1,
      type: 'event',
      seq,
      instanceId: 'i',
      kind: 'session.event',
      payload: {
        sessionId: sid,
        data: {
          type: 'assistant/message',
          seq: eventSeq,
          data: { message: { content: 'answer' } },
        },
      },
      createdAt: 1,
    });
    expect(
      mergeEvents(history, [make(2, 'other', 2), make(3, 's', 2), make(4, 's', 2)], 's'),
    ).toHaveLength(2);
  });
  it('uses a durable projected title and safe path label', () => {
    expect(sessionLabel({ sessionId: 's', cwd: '/repo/project' })).toBe('project');
    expect(sessionLabel({ sessionId: 's', projections: { values: { title: 'Task title' } } })).toBe(
      'Task title',
    );
  });
  it('never exposes base64 image bytes as transcript text', () =>
    expect(contentText([{ type: 'image', data: 'secret', name: 'photo.png' }])).toBe(
      '[图片：photo.png]',
    ));
  it('rejects malformed event collections safely', () =>
    expect(historyEvents({ events: [null, {}, 'wrong'] })).toEqual([]));
});
describe('fenced write availability', () => {
  it('rejects missing, expired and unacknowledged leases', () => {
    expect(leaseActive(null, 100)).toBe(false);
    expect(leaseActive({ controllerId: 'c', epoch: 1, expiresAt: 99 }, 100)).toBe(false);
    expect(leaseActive({ controllerId: 'c', epoch: 1, expiresAt: 200, pending: true }, 100)).toBe(
      false,
    );
    expect(leaseActive({ controllerId: 'c', epoch: 1, expiresAt: 200, pending: false }, 100)).toBe(
      true,
    );
  });
});

describe('approval argument binding', () => {
  it('matches only immutable tool calls by exact call ID and name', () => {
    const rows = [
      {
        type: 'tool/call',
        seq: 1,
        data: { callId: 'c1', name: 'shell', arguments: '{"command":"echo <script>"}' },
      },
    ];
    expect(toolCallForApproval({ callId: 'c1', toolName: 'shell' }, rows)?.arguments).toBe(
      '{"command":"echo <script>"}',
    );
    expect(toolCallForApproval({ callId: 'c2', toolName: 'shell' }, rows)).toBeNull();
    expect(toolCallForApproval({ callId: 'c1', toolName: 'other' }, rows)).toBeNull();
    expect(toolCallForApproval({ toolName: 'shell' }, rows)).toBeNull();
  });
});

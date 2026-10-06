import { test, expect, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../src/journal.ts';
import type { RelayCommand, ConnectorResult } from '../../protocol/src/index.ts';
const command: RelayCommand = {
  v: 1,
  type: 'command',
  id: 'stable-command',
  instanceId: 'instance',
  connectionEpoch: 1,
  leaseEpoch: 1,
  action: 'session.prompt',
  args: {
    sessionId: 'session',
    requestId: 'request',
    mode: 'queue',
    content: [{ type: 'text', text: 'hello' }],
  },
  expiresAt: Date.now() + 10000,
};
const owned: string[] = [];
afterAll(() => {
  // node:sqlite finalizes statements on GC; Windows keeps the files locked until then.
  Bun.gc(true);
  for (const dir of owned) rmSync(dir, { recursive: true, force: true });
});
function filename() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-journal-'));
  owned.push(dir);
  return join(dir, 'journal.sqlite');
}
test('admitted command is indeterminate after crash until a result is recovered', () => {
  const path = filename();
  let journal = new Journal(path);
  journal.bindInstance('instance');
  expect(journal.reserve(command).kind).toBe('new');
  journal.close();
  journal = new Journal(path);
  expect(journal.reserve({ ...command, connectionEpoch: 2 }).kind).toBe('indeterminate');
  const result: ConnectorResult = {
    v: 1,
    type: 'result',
    id: command.id,
    connectionEpoch: 1,
    ok: true,
    result: { accepted: true },
  };
  journal.complete(result);
  journal.close();
  journal = new Journal(path);
  expect(journal.reserve({ ...command, connectionEpoch: 3 })).toEqual({ kind: 'result', result });
  expect(journal.results()).toHaveLength(1);
  journal.acknowledgeResult(command.id);
  expect(journal.results()).toHaveLength(0);
  expect(journal.reserve(command).kind).toBe('result');
  journal.close();
});
test('same command identity with different arguments and cross-instance journal reuse are rejected', () => {
  const journal = new Journal(filename());
  journal.bindInstance('instance');
  journal.reserve(command);
  expect(
    journal.reserve({ ...command, args: { ...command.args, sessionId: 'another' } }).kind,
  ).toBe('conflict');
  expect(() => journal.bindInstance('another')).toThrow('another instance');
  journal.close();
});
test('durable event outbox deduplicates and acknowledges while transient tokens stay ephemeral', () => {
  const path = filename();
  let journal = new Journal(path);
  const event = {
    v: 1 as const,
    type: 'event' as const,
    id: 'session:session:1',
    sessionId: 'session',
    kind: 'session.event',
    payload: { seq: 1, type: 'turn/end' },
  };
  journal.event(event);
  journal.event(event);
  journal.event({ ...event, id: 'chunk', kind: 'assistant.stream' });
  journal.close();
  journal = new Journal(path);
  expect(journal.events()).toEqual([event]);
  journal.acknowledgeEvent(event.id);
  expect(journal.events()).toEqual([]);
  journal.close();
});

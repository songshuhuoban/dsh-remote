import { test, expect, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, chmodSync, symlinkSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConnectorToken, manualConfigIssues, Config } from '../src/index.ts';
const token = 'a'.repeat(43);
const owned: string[] = [];
const temporary = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  owned.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of owned) rmSync(dir, { recursive: true, force: true });
});
test.skipIf(process.platform === 'win32')(
  'private token file is read without entering plugin config',
  () => {
    const dir = temporary('dsh-token-');
    const path = join(dir, 'token');
    writeFileSync(path, token, { mode: 0o600 });
    expect(readConnectorToken(path)).toBe(token);
    expect(
      manualConfigIssues({
        relayUrl: 'ws://localhost/ws/connector',
        connectorToken: token,
        connectorTokenFile: path,
        connectorPath: '/connector.ts',
        journalPath: '/private/journal',
        allowedWorkspaceRoots: [dir],
      }),
    ).toContain('Inline connectorToken is forbidden; pair from the Plugins page or use connectorTokenFile');
  },
);
test.skipIf(process.platform === 'win32')(
  'token files reject unsafe mode, newline, symlink and public parent',
  () => {
    const dir = temporary('dsh-token-invalid-');
    const path = join(dir, 'token');
    writeFileSync(path, token, { mode: 0o644 });
    expect(() => readConnectorToken(path)).toThrow('owner-only');
    chmodSync(path, 0o600);
    writeFileSync(path, token + '\n');
    expect(() => readConnectorToken(path)).toThrow('owner-only');
    writeFileSync(path, token);
    const link = join(dir, 'link');
    symlinkSync(path, link);
    expect(() => readConnectorToken(link)).toThrow('owner-only');
    chmodSync(dir, 0o755);
    expect(() => readConnectorToken(path)).toThrow('owner-only');
  },
);

test.skipIf(process.platform !== 'win32')(
  'Windows hosts pair through DSH credentials instead of token files',
  () => {
    expect(() => readConnectorToken('C:\\private\\token')).toThrow('pair from the DSH Plugins page');
  },
);

test('pairing mode needs no manual fields, while partial manual settings are rejected', () => {
  expect(manualConfigIssues({ allowedWorkspaceRoots: [] })).toEqual([]);
  expect(manualConfigIssues({ relayUrl: 'wss://relay/ws/connector' })).toContain(
    'connectorTokenFile must be an absolute private credential file',
  );
  expect(manualConfigIssues({ journalPath: 'relative.sqlite' })).toContain(
    'journalPath must be absolute',
  );
  // Unset profile lists resolve empty and defer to the values edited on the Plugins page.
  expect(Config({}).allowedWorkspaceRoots).toEqual([]);
});

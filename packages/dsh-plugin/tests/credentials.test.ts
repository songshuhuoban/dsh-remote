import { test, expect, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, chmodSync, symlinkSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConnectorToken, Config } from '../src/index.ts';
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
      Config['~standard'].validate({
        relayUrl: 'ws://localhost/ws/connector',
        connectorToken: token,
        connectorTokenFile: path,
        connectorPath: '/connector.ts',
        journalPath: '/private/journal',
        allowedWorkspaceRoots: [dir],
      }),
    ).toHaveProperty('issues');
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
  'Windows credential storage is blocked until an ACL adapter is verified',
  () => {
    expect(() => readConnectorToken('C:\\private\\token')).toThrow('Windows Credential Manager');
  },
);

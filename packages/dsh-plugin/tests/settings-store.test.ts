import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  validateSettings,
} from '../src/settings-store.ts';

const dir = mkdtempSync(join(tmpdir(), 'dsh-remote-settings-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const absolute = process.platform === 'win32' ? 'C:\\work' : '/work';

test('updates accept only known fields with bounded, unique, absolute workspace folders', () => {
  expect(validateSettings({ allowedWorkspaceRoots: [absolute] })).toEqual({
    value: { allowedWorkspaceRoots: [absolute] },
  });
  for (const bad of [
    null,
    [],
    { other: [] },
    { allowedWorkspaceRoots: 'x' },
    { allowedWorkspaceRoots: ['relative/path'] },
    { allowedWorkspaceRoots: [absolute, absolute] },
    { allowedPermissionPresets: [''] },
    { allowedAgentPresets: ['a\nb'] },
    { allowedAgentPresets: Array.from({ length: 65 }, (_, i) => `p${i}`) },
  ])
    expect(validateSettings(bad)).toHaveProperty('error');
});

test('settings round-trip, and missing or corrupt files fall back to defaults', () => {
  const path = join(dir, 'nested', 'settings.json');
  const warnings: string[] = [];
  expect(loadSettings(path, (m) => warnings.push(m))).toEqual(DEFAULT_SETTINGS);
  const next = { ...DEFAULT_SETTINGS, allowedWorkspaceRoots: [absolute] };
  saveSettings(path, next);
  expect(loadSettings(path, (m) => warnings.push(m))).toEqual(next);
  writeFileSync(path, '{"allowedWorkspaceRoots": ["relative"]}');
  expect(loadSettings(path, (m) => warnings.push(m))).toEqual(DEFAULT_SETTINGS);
  expect(warnings).toHaveLength(1);
});

import { describe, expect, test } from 'bun:test';
import {
  hostPathCrumbs,
  hostPathName,
  hostPathStyle,
  isCanonicalHostPath,
  toHostPath,
} from '../packages/protocol/src/host-path.ts';

// Host paths across operating systems: the controller and the DSH host may differ.
describe('host path styles', () => {
  test('recognises POSIX, Windows drive and UNC paths, nothing relative', () => {
    expect(hostPathStyle('/home/me/repo')).toBe('posix');
    expect(hostPathStyle('E:\\work\\repo')).toBe('windows');
    expect(hostPathStyle('e:/work/repo')).toBe('windows');
    expect(hostPathStyle('\\\\nas\\share\\repo')).toBe('windows');
    expect(hostPathStyle('work/repo')).toBeNull();
    expect(hostPathStyle('C:repo')).toBeNull();
  });

  test('accepts only canonical absolute paths in one style', () => {
    for (const ok of ['/home/me/repo', 'E:\\work\\repo', 'c:\\Users\\me', '\\\\nas\\share\\repo'])
      expect(isCanonicalHostPath(ok), ok).toBe(true);
    for (const bad of [
      '/',
      '/home/me/',
      '/home//me',
      '/home/./me',
      '/home/../etc',
      '/home\\me',
      'E:\\',
      'E:\\work\\',
      'E:/work/repo',
      'E:\\work\\..\\x',
      'E:\\work\\a<b',
      'E:\\work\\trailing.',
      'relative\\path',
      '/bad\u0000byte',
    ])
      expect(isCanonicalHostPath(bad), JSON.stringify(bad)).toBe(false);
    expect(isCanonicalHostPath('/', { allowRoot: true })).toBe(true);
    expect(isCanonicalHostPath('E:\\', { allowRoot: true })).toBe(true);
    expect(isCanonicalHostPath('\\\\nas\\share', { allowRoot: true })).toBe(true);
  });
});

describe('converting pasted paths to the host style', () => {
  test('Windows hosts take forward slashes, quotes, file URLs and lower-case drives', () => {
    expect(toHostPath('e:/work/repo/', 'windows')).toBe('E:\\work\\repo');
    expect(toHostPath('"E:\\work\\\\repo"', 'windows')).toBe('E:\\work\\repo');
    expect(toHostPath('file:///C:/Users/me/My%20Docs', 'windows')).toBe('C:\\Users\\me\\My Docs');
    expect(toHostPath('//nas/share/repo', 'windows')).toBe('\\\\nas\\share\\repo');
    expect(toHostPath('C:\\work\\..\\other\\.\\x', 'windows')).toBe('C:\\other\\x');
    expect(toHostPath('C:', 'windows')).toBe('C:\\');
    expect(toHostPath('~/projects', 'windows')).toBe('~\\projects');
    expect(toHostPath('/home/me', 'windows')).toBeNull();
    expect(toHostPath('repo', 'windows')).toBeNull();
  });

  test('POSIX hosts normalise slashes and refuse Windows paths', () => {
    expect(toHostPath(' /home//me/./repo/ ', 'posix')).toBe('/home/me/repo');
    expect(toHostPath("'/srv/a b'", 'posix')).toBe('/srv/a b');
    expect(toHostPath('file:///home/me/x', 'posix')).toBe('/home/me/x');
    expect(toHostPath('/a/../../b', 'posix')).toBe('/b');
    expect(toHostPath('~/projects/', 'posix')).toBe('~/projects');
    expect(toHostPath('E:\\work', 'posix')).toBeNull();
    expect(toHostPath('relative', 'posix')).toBeNull();
  });
});

describe('breadcrumbs and names', () => {
  test('split each style at its own separator', () => {
    expect(hostPathCrumbs('/home/me')).toEqual([
      { name: '/', path: '/' },
      { name: 'home', path: '/home' },
      { name: 'me', path: '/home/me' },
    ]);
    expect(hostPathCrumbs('E:\\work\\repo')).toEqual([
      { name: 'E:', path: 'E:\\' },
      { name: 'work', path: 'E:\\work' },
      { name: 'repo', path: 'E:\\work\\repo' },
    ]);
    expect(hostPathCrumbs('E:\\')).toEqual([{ name: 'E:', path: 'E:\\' }]);
    expect(hostPathCrumbs('\\\\nas\\share\\repo').map((c) => c.name)).toEqual([
      '\\\\nas\\share',
      'repo',
    ]);
    expect(hostPathName('E:\\work\\repo')).toBe('repo');
    expect(hostPathName('/')).toBe('/');
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  canonicalPathError,
  contextPreview,
  mapRepository,
  repositoryIdsForPrompt,
  selectRepository,
  type RepositoryReference,
} from './repositories';
import { instanceStatus, isOnline, runCommand } from './api';
afterEach(() => vi.unstubAllGlobals());
const reference: RepositoryReference = {
  id: 'repo_1',
  instanceId: 'ins_1',
  source: 'manual',
  url: 'https://github.com/owner/repo',
  fullName: 'owner/repo',
  defaultBranch: 'main',
  localPath: '/allowed/repo',
  authorization: 'manual',
  authorizationCheckedAt: null,
  selected: true,
  localState: 'verified',
  verifiedAt: 20,
  head: 'abc',
  branch: 'work',
  cloned: false,
};
describe('instance status authority', () => {
  it('never uses old online boolean to override stale, connecting, or offline status', () => {
    for (const status of ['stale', 'connecting', 'offline']) {
      expect(isOnline({ id: 'i', name: 'host', status, online: true })).toBe(false);
      expect(instanceStatus({ id: 'i', name: 'host', status })).toBe(status);
    }
    expect(isOnline({ id: 'i', name: 'host', status: 'online' })).toBe(true);
  });
});
describe('repository admission and context boundary', () => {
  it('uses top-level reference IDs, an empty inspect args object, and current fence', async () => {
    const fetch = vi
      .fn()
      .mockImplementation(async () =>
        Response.json({ id: 'command', status: 'succeeded', result: {} }),
      );
    vi.stubGlobal('fetch', fetch);
    await runCommand('ins_1', 'ctl_1', 'repository.inspect', {}, 4, undefined, 'command', {
      repositoryId: 'repo_1',
    });
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
      id: 'command',
      controllerId: 'ctl_1',
      action: 'repository.inspect',
      args: {},
      leaseEpoch: 4,
      repositoryId: 'repo_1',
    });
    await runCommand(
      'ins_1',
      'ctl_1',
      'session.prompt',
      { sessionId: 's', content: [{ type: 'text', text: 'work' }] },
      4,
      undefined,
      'prompt',
      { repositoryIds: ['repo_1'] },
    );
    const body = JSON.parse(fetch.mock.calls[1][1].body);
    expect(body.repositoryIds).toEqual(['repo_1']);
    expect(body.args.repositoryContext).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('/allowed/repo');
  });
  it('maps GitHub selection using source page identity, never client repository metadata', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ repository: reference }));
    vi.stubGlobal('fetch', fetch);
    await mapRepository('ins_1', 'ctl_1', {
      source: 'github',
      installationId: 81,
      repositoryId: 101,
      page: 2,
      installationPage: 3,
      localPath: '/allowed/repo',
    });
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
      controllerId: 'ctl_1',
      source: 'github',
      installationId: 81,
      repositoryId: 101,
      page: 2,
      installationPage: 3,
      localPath: '/allowed/repo',
    });
    await selectRepository('ins_1', 'ctl_1', 'repo_1', false);
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({
      controllerId: 'ctl_1',
      selected: false,
    });
  });
  it('requires verified owned references and at most eight unique IDs', () => {
    expect(repositoryIdsForPrompt([reference], ['repo_1'], 'ins_1')).toEqual(['repo_1']);
    for (const refs of [
      [],
      [{ ...reference, localState: 'stale' as const }],
      [{ ...reference, localState: 'declared' as const }],
      [{ ...reference, instanceId: 'other' }],
    ])
      expect(() => repositoryIdsForPrompt(refs, ['repo_1'], 'ins_1')).toThrow();
    expect(() => repositoryIdsForPrompt([reference], ['repo_1', 'repo_1'], 'ins_1')).toThrow();
    expect(() =>
      repositoryIdsForPrompt(
        [],
        Array.from({ length: 9 }, (_, i) => `r${i}`),
        'ins_1',
      ),
    ).toThrow();
  });
  it('does not confuse GitHub grant expiry with verified local availability', () => {
    expect(
      repositoryIdsForPrompt(
        [{ ...reference, authorization: 'github_expired' }],
        ['repo_1'],
        'ins_1',
      ),
    ).toEqual(['repo_1']);
  });
  it('previews only bounded metadata, excluding injected tokens and contents', () => {
    const preview = contextPreview({
      ...reference,
      token: 'secret',
      contents: 'file contents',
    } as RepositoryReference);
    expect(preview).toMatchObject({
      repository: 'owner/repo',
      localPath: '/allowed/repo',
      branch: 'work',
    });
    expect(JSON.stringify(preview)).not.toContain('secret');
    expect(JSON.stringify(preview)).not.toContain('file contents');
  });
  it('checks canonical path syntax without pretending to verify the host filesystem', () => {
    expect(canonicalPathError('/allowed/existing')).toBeNull();
    for (const path of [
      'relative',
      '/',
      '/repo/',
      '/repo//sub',
      '/repo/../other',
      '/repo/./sub',
      '/repo\\evil',
      '/repo\nname',
    ])
      expect(canonicalPathError(path)).not.toBeNull();
  });
});

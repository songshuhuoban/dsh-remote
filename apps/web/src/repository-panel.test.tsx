// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api, post, runCommand } from './api';
import { RepositoryPanel } from './repository-panel';
import { OperationsProvider } from './operations';
import type { GitHubStatus, RepositoryReference } from './repositories';
vi.mock('./api', async (original) => ({
  ...(await original<typeof import('./api')>()),
  api: vi.fn(),
  post: vi.fn(),
  runCommand: vi.fn(),
}));
beforeAll(() =>
  Object.assign(HTMLDialogElement.prototype, {
    showModal(this: HTMLDialogElement) {
      this.setAttribute('open', '');
    },
    close(this: HTMLDialogElement) {
      this.removeAttribute('open');
    },
  }),
);
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  localStorage.clear();
  vi.clearAllMocks();
});
const status: GitHubStatus = {
  configured: true,
  missingConfiguration: [],
  configurationError: null,
  state: 'connected',
  account: { id: 1, login: 'fixture-user', connectedAt: 1, expiresAt: Date.now() + 30000 },
  browserOAuthSupported: true,
  nativeOAuthSupported: false,
  cloningSupported: false,
};
const reference: RepositoryReference = {
  id: 'ref',
  instanceId: 'ins',
  source: 'github',
  fullName: 'fixture/one',
  url: 'https://github.com/fixture/one',
  defaultBranch: 'main',
  localPath: '/allowed/one',
  authorization: 'github_authorized',
  authorizationCheckedAt: 1,
  localState: 'declared',
  selected: true,
  verifiedAt: null,
  branch: null,
  head: null,
  cloned: false,
};
function setup(github = status, refs: RepositoryReference[] = [], instanceStatus = 'online') {
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === '/api/github/status') return github as never;
    if (path.startsWith('/api/github/installations'))
      return {
        installations: [
          { id: 81, account: { id: 1, login: 'fixture' }, repositorySelection: 'selected' },
        ],
        hasMore: false,
      } as never;
    if (path.startsWith('/api/github/repositories'))
      return {
        repositories: [1, 2].map((id) => ({
          id,
          installationId: 81,
          fullName: `fixture/${id === 1 ? 'one' : 'two'}`,
          defaultBranch: 'main',
          url: `https://github.com/fixture/${id}`,
          private: true,
          archived: false,
        })),
        hasMore: false,
      } as never;
    if (path.endsWith('/repositories')) return { repositories: refs } as never;
    throw new Error(`Unexpected route ${path}`);
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <OperationsProvider accountId="user">
        <RepositoryPanel
          instance={{ id: 'ins', name: 'Host', status: instanceStatus }}
          controller={{ id: 'ctl', name: 'Device' }}
          lease={{ controllerId: 'ctl', epoch: 7, expiresAt: Date.now() + 30000 }}
          onClose={vi.fn()}
        />
      </OperationsProvider>
    </QueryClientProvider>,
  );
}
describe('GitHub repository UI contract fixtures (no external OAuth)', () => {
  it('selects multiple discovered repositories and sends page-bound existing-path mappings', async () => {
    const refs: RepositoryReference[] = [];
    setup(status, refs);
    vi.mocked(post).mockImplementation(async (_path, data) => {
      const input = data as { repositoryId: number; localPath: string };
      const row = {
        ...reference,
        id: `ref${input.repositoryId}`,
        fullName: `fixture/${input.repositoryId === 1 ? 'one' : 'two'}`,
        localPath: input.localPath,
      };
      refs.push(row);
      return { repository: row } as never;
    });
    // The only installation is picked automatically; its repositories list at once.
    fireEvent.click(await screen.findByLabelText(/fixture\/one/));
    expect(screen.queryByLabelText('GitHub 安装')).toBeNull();
    fireEvent.click(screen.getByLabelText(/fixture\/two/));
    fireEvent.click(screen.getByRole('button', { name: '映射到 Host' }));
    fireEvent.change(screen.getByLabelText('fixture/one · 已有工作树绝对路径'), {
      target: { value: '/allowed/one' },
    });
    fireEvent.change(screen.getByLabelText('fixture/two · 已有工作树绝对路径'), {
      target: { value: '/allowed/two' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存映射' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(post).toHaveBeenCalledTimes(2);
    expect(vi.mocked(post).mock.calls.map(([, body]) => body)).toEqual(
      [1, 2].map((repositoryId) => ({
        controllerId: 'ctl',
        source: 'github',
        installationId: 81,
        repositoryId,
        page: 1,
        installationPage: 1,
        localPath: `/allowed/${repositoryId === 1 ? 'one' : 'two'}`,
      })),
    );
    expect(screen.getAllByText('待主机验证 · GitHub 最近授权检查通过')).toHaveLength(2);
  });
  it('ignores a late authorization start after explicit cancellation', async () => {
    setup({ ...status, state: 'disconnected', account: null });
    let resolve!: (data: unknown) => void;
    vi.mocked(post).mockImplementation(async (path) =>
      path === '/api/github/authorize'
        ? new Promise((done) => {
            resolve = done;
          })
        : ({ ok: true } as never),
    );
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: '连接 GitHub' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole('button', { name: '连接 GitHub' }));
    fireEvent.click(await screen.findByRole('button', { name: '取消授权请求' }));
    await screen.findByText('授权请求已取消，可继续使用手动工作树映射');
    await act(async () => {
      resolve({ authorizationUrl: 'https://github.com/login/oauth/authorize', expiresAt: 100 });
    });
    expect(sessionStorage.getItem('dsh.githubFlow')).toBeNull();
    expect(post).toHaveBeenCalledWith('/api/github/cancel', { controllerId: 'ctl' });
  });
  it('does not permit stale instance status to verify a declared local reference', async () => {
    setup(status, [reference], 'stale');
    const button = await screen.findByRole('button', { name: '验证工作树' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(runCommand).not.toHaveBeenCalled();
  });
  it('host verification uses the current fence and only the top-level reference identity', async () => {
    setup(status, [reference]);
    vi.mocked(runCommand).mockResolvedValue({});
    fireEvent.click(await screen.findByRole('button', { name: '验证工作树' }));
    await waitFor(() => expect(runCommand).toHaveBeenCalledTimes(1));
    expect(vi.mocked(runCommand).mock.calls[0]).toEqual([
      'ins',
      'ctl',
      'repository.inspect',
      {},
      7,
      expect.any(AbortSignal),
      expect.any(String),
      { repositoryId: 'ref' },
    ]);
  });
});

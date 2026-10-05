// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError, CommandAdmissionError, CommandError, queryCommand, runCommand } from './api';
import { OperationsProvider, RecoveryPanel, uncertainError, useOperations } from './operations';
vi.mock('./api', async (original) => ({
  ...(await original<typeof import('./api')>()),
  runCommand: vi.fn(),
  queryCommand: vi.fn(),
}));
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  localStorage.clear();
  vi.clearAllMocks();
});
const body = {
  instanceId: 'ins_1',
  controllerId: 'ctl_1',
  action: 'session.prompt',
  args: {
    sessionId: 's',
    requestId: 'request',
    content: [{ type: 'text', text: 'exact admitted message' }],
  },
  leaseEpoch: 2,
  references: { repositoryIds: ['repo_1'] },
};
function Harness() {
  const ops = useOperations();
  return (
    <>
      <button
        onClick={() => {
          void ops.run(body, 'original-id').catch(() => {});
        }}
      >
        Submit
      </button>
      <span>{ops.operations.length}</span>
      <RecoveryPanel instanceId="ins_1" />
    </>
  );
}
function setup() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <OperationsProvider accountId="user">
        <Harness />
      </OperationsProvider>
    </QueryClientProvider>,
  );
}
describe('safe command outcomes', () => {
  it('distinguishes a definitive admission rejection from a later read or transport failure', () => {
    expect(uncertainError(new CommandAdmissionError('rejected', 409))).toBe(false);
    for (const error of [
      new TypeError('network'),
      new ApiError('expired while polling', 401),
      new ApiError('not visible yet', 404),
      new CommandError('unknown', { id: 'x', status: 'indeterminate' }),
    ])
      expect(uncertainError(error)).toBe(true);
    expect(uncertainError(new CommandError('failed', { id: 'x', status: 'failed' }))).toBe(false);
  });
  it('persists the original ID and exact body before dispatch and keeps 404 as unknown', async () => {
    vi.mocked(runCommand).mockImplementation(async () => {
      expect(JSON.parse(sessionStorage.getItem('dsh.operations.user')!)[0]).toMatchObject({
        ...body,
        id: 'original-id',
        state: 'pending',
      });
      throw new TypeError('network lost');
    });
    setup();
    fireEvent.click(screen.getByText('Submit'));
    await screen.findByText('原命令结果尚未确认');
    vi.mocked(queryCommand).mockRejectedValue(new ApiError('missing', 404));
    fireEvent.click(screen.getByText('查询原命令'));
    await screen.findByText('暂未查到原命令；它可能仍在提交。保留原 ID，稍后再查');
    fireEvent.click(screen.getByText('Submit'));
    await waitFor(() => expect(runCommand).toHaveBeenCalledTimes(1));
    expect(JSON.parse(sessionStorage.getItem('dsh.operations.user')!)[0].id).toBe('original-id');
    vi.mocked(queryCommand).mockResolvedValue({
      id: 'original-id',
      status: 'succeeded',
      result: { accepted: true },
    });
    fireEvent.click(screen.getByText('查询原命令'));
    await waitFor(() => expect(screen.queryByLabelText('命令恢复')).toBeNull());
    expect(runCommand).toHaveBeenCalledTimes(1);
  });
  it('restores interrupted operations as uncertain after remount without posting again', async () => {
    sessionStorage.setItem(
      'dsh.operations.user',
      JSON.stringify([{ ...body, id: 'original-id', state: 'pending' }]),
    );
    setup();
    expect(screen.getByText('原命令结果尚未确认')).toBeTruthy();
    expect(runCommand).not.toHaveBeenCalled();
  });
  it('recovers metadata after closing the original tab without persisting prompt text or paths', async () => {
    vi.mocked(runCommand).mockRejectedValue(new TypeError('network lost'));
    const first = setup();
    fireEvent.click(screen.getByText('Submit'));
    await screen.findByText('原命令结果尚未确认');
    const saved = localStorage.getItem('dsh.unresolved.user')!;
    expect(JSON.parse(saved)).toEqual([
      { id: 'original-id', instanceId: 'ins_1', controllerId: 'ctl_1', action: 'session.prompt' },
    ]);
    expect(saved).not.toContain('exact admitted message');
    expect(saved).not.toContain('repositoryIds');
    first.unmount();
    sessionStorage.clear();
    setup();
    expect(
      screen.getByText('从其他浏览器标签页恢复的原命令。只会查询此 ID，不会重新发送'),
    ).toBeTruthy();
    fireEvent.click(screen.getByText('Submit'));
    expect(runCommand).toHaveBeenCalledTimes(1);
    vi.mocked(queryCommand).mockResolvedValue({
      id: 'original-id',
      status: 'succeeded',
      result: {},
    });
    fireEvent.click(screen.getByText('查询原命令'));
    await waitFor(() => expect(screen.queryByLabelText('命令恢复')).toBeNull());
    expect(localStorage.getItem('dsh.unresolved.user')).toBeNull();
  });
  it('lets stop-waiting abort only local waiting while retaining the recovery ID', async () => {
    vi.mocked(runCommand).mockImplementation(
      (...args) =>
        new Promise((_, reject) =>
          args[5]?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          ),
        ),
    );
    setup();
    fireEvent.click(screen.getByText('Submit'));
    await screen.findByText('停止等待');
    fireEvent.click(screen.getByText('停止等待'));
    await screen.findByText('原命令结果尚未确认');
    expect(runCommand).toHaveBeenCalledTimes(1);
  });
});

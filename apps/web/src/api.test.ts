import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, runCommand } from './api';
afterEach(() => vi.unstubAllGlobals());
describe('relay HTTP client', () => {
  it('sends cookie credentials and no bearer token', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetch);
    await api('/api/me');
    expect(fetch.mock.calls[0][1].credentials).toBe('include');
    expect(fetch.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });
  it('preserves structured API error messages', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { error: { code: 'LEASE_REQUIRED', message: 'Acquire control' } },
            { status: 409 },
          ),
        ),
    );
    await expect(api('/api/me')).rejects.toMatchObject({ status: 409, message: 'Acquire control' });
  });
  it('never treats indeterminate command status as success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          id: '1',
          status: 'indeterminate',
          error: { code: 'UNKNOWN', message: 'Result unknown' },
        }),
      ),
    );
    await expect(runCommand('i', 'c', 'session.prompt', {}, 1)).rejects.toThrow('Result unknown');
  });
  it('passes explicit fence epoch with write command', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        Response.json({ id: '1', status: 'succeeded', result: { accepted: true } }),
      );
    vi.stubGlobal('fetch', fetch);
    expect(await runCommand('i', 'c', 'session.prompt', { sessionId: 's' }, 7)).toEqual({
      accepted: true,
    });
    const sent = JSON.parse(fetch.mock.calls[0][1].body);
    expect(sent).toMatchObject({ controllerId: 'c', leaseEpoch: 7, action: 'session.prompt' });
  });
});

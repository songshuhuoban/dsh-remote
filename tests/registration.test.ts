import { expect, test } from 'bun:test';
import { createRelay } from '../apps/server/src/server.ts';

const account = (email: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ email, password: 'synthetic-password-only', deviceName: 'Test', ...extra });

async function withRelay(
  options: Parameters<typeof createRelay>[0],
  run: (base: string) => Promise<void>,
) {
  const relay = createRelay({ databasePath: ':memory:', port: 0, ...options });
  try {
    await run(String(relay.server.url).replace(/\/$/, ''));
  } finally {
    await relay.stop();
  }
}
const register = (base: string, body: string) =>
  fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

test('health reports the registration mode', async () => {
  await withRelay({}, async (base) =>
    expect(((await (await fetch(`${base}/health`)).json()) as any).registration).toBe('closed'),
  );
  await withRelay({ registration: true }, async (base) =>
    expect(((await (await fetch(`${base}/health`)).json()) as any).registration).toBe('open'),
  );
  await withRelay({ registration: true, inviteCode: 'invite-fixture' }, async (base) =>
    expect(((await (await fetch(`${base}/health`)).json()) as any).registration).toBe('invite'),
  );
});

test('invite mode admits only the configured code and does not reveal existing accounts', async () => {
  await withRelay({ registration: true, inviteCode: 'invite-fixture' }, async (base) => {
    const missing = await register(base, account('invite-a@example.invalid'));
    expect(missing.status).toBe(403);
    expect(((await missing.json()) as any).error.code).toBe('INVITE_REQUIRED');
    const wrong = await register(base, account('invite-a@example.invalid', { inviteCode: 'nope' }));
    expect(wrong.status).toBe(403);
    const ok = await register(
      base,
      account('invite-a@example.invalid', { inviteCode: ' invite-fixture ' }),
    );
    expect(ok.status).toBe(201);
    const existing = await register(base, account('invite-a@example.invalid'));
    expect(((await existing.json()) as any).error.code).toBe('INVITE_REQUIRED');
  });
});

test('closed mode rejects registration even with an invite code', async () => {
  await withRelay({ inviteCode: 'invite-fixture' }, async (base) => {
    const response = await register(
      base,
      account('closed@example.invalid', { inviteCode: 'invite-fixture' }),
    );
    expect(response.status).toBe(403);
    expect(((await response.json()) as any).error.code).toBe('REGISTRATION_DISABLED');
  });
});

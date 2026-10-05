import { afterEach, expect, test } from 'bun:test';
import { openStore } from '../apps/server/src/store.ts';
import { createGitHubService, type GitHubAuth } from '../apps/server/src/github.ts';
import { githubCallback } from '../apps/server/src/github-routes.ts';

const stores: ReturnType<typeof openStore>[] = [];
afterEach(() => {
  for (const db of stores.splice(0)) db.close();
});
function fixture(transport?: typeof fetch) {
  const db = openStore(':memory:');
  stores.push(db);
  db.query('INSERT INTO users VALUES(?,?,?,?)').run('alice', 'alice@example.invalid', 'fixture', 1);
  db.query('INSERT INTO controllers VALUES(?,?,?,?)').run('controller', 'alice', 'Fixture', 1);
  db.query('INSERT INTO auth_sessions VALUES(?,?,?,?)').run(
    'session',
    'alice',
    'controller',
    Date.now() + 60_000,
  );
  const auth: GitHubAuth = { userId: 'alice', controllerId: 'controller', tokenHash: 'session' };
  const github = createGitHubService(
    db,
    {
      clientId: 'Iv1_fixture',
      clientSecret: 'fixture-secret',
      appSlug: 'fixture',
      callbackUrl: 'https://relay.example.invalid/github/callback',
      tokenEncryptionKey: Buffer.alloc(32, 7).toString('base64'),
    },
    transport,
  );
  return { db, auth, github };
}
function callback(
  flow: { authorizationUrl: string; cookie: string },
  suffix = '&error=access_denied',
) {
  const state = new URL(flow.authorizationUrl).searchParams.get('state');
  return new Request(`https://relay.example.invalid/github/callback?state=${state}${suffix}`, {
    headers: { cookie: flow.cookie.split(';')[0]! },
  });
}

test('a stale callback cannot expire the replacement flow browser cookie', async () => {
  const f = fixture();
  const older = f.github.authorize(f.auth);
  const newer = f.github.authorize(f.auth);
  // Browsers send the newest shared cookie even when returning from an old OAuth tab.
  const stale = callback({ ...older, cookie: newer.cookie });
  const response = (await githubCallback(stale, f.github))!;
  expect(response.headers.get('location')).toEndWith('github=GITHUB_INVALID_STATE');
  expect(response.headers.get('set-cookie')).toBeNull();
  const completed = (await githubCallback(callback(newer), f.github))!;
  expect(completed.headers.get('location')).toEndWith('github=cancelled');
});

test('a superseded in-flight callback cannot expire a newer flow cookie', async () => {
  let entered!: () => void, resume!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const f = fixture((async (input) => {
    if (String(input).includes('/access_token')) {
      entered();
      await gate;
      return Response.json({ access_token: 'ghu_FIXTURE', expires_in: 28800 });
    }
    return Response.json({ id: 1, login: 'fixture' });
  }) as typeof fetch);
  const older = f.github.authorize(f.auth);
  const pending = githubCallback(callback(older, '&code=fixture'), f.github);
  await started;
  const newer = f.github.authorize(f.auth);
  resume();
  const response = (await pending)!;
  expect(response.headers.get('location')).toEndWith('github=GITHUB_AUTH_CHANGED');
  expect(response.headers.get('set-cookie')).toBeNull();
  expect(f.github.status('alice').state).toBe('disconnected');
  const completed = (await githubCallback(callback(newer), f.github))!;
  expect(completed.headers.get('location')).toEndWith('github=cancelled');
});

test('a newer flow on another controller wins for the user-global GitHub account', async () => {
  let entered!: () => void, resume!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const f = fixture((async (input, init) => {
    if (String(input).includes('/access_token')) {
      const code = new URLSearchParams(String(init?.body)).get('code');
      if (code === 'older') {
        entered();
        await gate;
      }
      return Response.json({ access_token: `ghu_${code}`, expires_in: 28800 });
    }
    const older = new Headers(init?.headers).get('Authorization') === 'Bearer ghu_older';
    return Response.json({ id: older ? 1 : 2, login: older ? 'older-account' : 'newer-account' });
  }) as typeof fetch);
  f.db.query('INSERT INTO controllers VALUES(?,?,?,?)').run('second', 'alice', 'Second', 1);
  f.db
    .query('INSERT INTO auth_sessions VALUES(?,?,?,?)')
    .run('second-session', 'alice', 'second', Date.now() + 60_000);
  const second: GitHubAuth = {
    userId: 'alice',
    controllerId: 'second',
    tokenHash: 'second-session',
  };
  const older = f.github.authorize(f.auth);
  const pending = githubCallback(callback(older, '&code=older'), f.github);
  await started;
  const newer = f.github.authorize(second);
  expect(
    (await githubCallback(callback(newer, '&code=newer'), f.github))!.headers.get('location'),
  ).toEndWith('github=connected');
  expect(f.github.status('alice').account?.login).toBe('newer-account');
  resume();
  expect((await pending)!.headers.get('location')).toEndWith('github=GITHUB_AUTH_CHANGED');
  expect(f.github.status('alice').account?.login).toBe('newer-account');
});

test('cancellation stays login-scoped while disconnect invalidates all user flows', async () => {
  const f = fixture();
  f.db.query('INSERT INTO controllers VALUES(?,?,?,?)').run('second', 'alice', 'Second', 1);
  f.db
    .query('INSERT INTO auth_sessions VALUES(?,?,?,?)')
    .run('second-session', 'alice', 'second', Date.now() + 60_000);
  const second: GitHubAuth = {
    userId: 'alice',
    controllerId: 'second',
    tokenHash: 'second-session',
  };
  f.github.authorize(f.auth);
  const newer = f.github.authorize(second);
  f.github.cancelAuthorization(f.auth);
  expect((await githubCallback(callback(newer), f.github))!.headers.get('location')).toEndWith(
    'github=cancelled',
  );
  const pending = f.github.authorize(second);
  f.github.disconnect(f.auth);
  expect((await githubCallback(callback(pending), f.github))!.headers.get('location')).toEndWith(
    'github=GITHUB_INVALID_STATE',
  );
});
